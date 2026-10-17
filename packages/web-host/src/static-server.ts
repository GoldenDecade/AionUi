/**
 * WebUI static server.
 *
 * Serves out/renderer/ as the SPA and reverse-proxies /api/*, /ws, /api/stt/stream,
 * /login and /logout to aioncore. All auth goes to backend's aionui-auth crate;
 * /login and /logout are aionui-auth's top-level paths, the rest live under
 * /api/auth/*. /ws and /api/stt/stream are WebSocket/stream upgrades spliced at
 * TCP level; /api/stt/stream is the STT streaming endpoint.
 *
 * Access gate: aioncore runs with `--local` (auth disabled) because the desktop
 * renderer talks to it directly without credentials. Only WebUI browser clients
 * come through this server, so it enforces login itself: desktop-only management
 * routes are denied, and every other /api/* call or upgrade must carry a session
 * that aioncore's /api/auth/user accepts.
 *
 * Design: Node native http + serve-handler. No Express. No business routes.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import net, { type Socket } from 'node:net';
import serveHandler from 'serve-handler';

export type StaticServerOptions = {
  staticDir: string;
  backendPort: number;
  port?: number;
  allowRemote?: boolean;
};

export type StaticServerHandle = {
  port: number;
  url: string;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  stop: () => Promise<void>;
};

const DEFAULT_PORT = 25808;

// Ranges that are non-internal IPv4 yet never a reachable LAN address, so we
// must never advertise them as the WebUI access URL even when they are the only
// non-loopback interface present:
//   169.254.0.0/16  link-local / APIPA (host got no DHCP lease)
//   198.18.0.0/15   RFC 2544 benchmarking range — handed out by utility tunnels
//                   such as Cloudflare WARP; this is the address that showed up
//                   on a multi-NIC machine instead of the real LAN IP.
const isUnreachableLanRange = (addr: string): boolean => addr.startsWith('169.254.') || /^198\.(18|19)\./.test(addr);

// Rank candidate LAN addresses by how likely they are the network the user
// actually reaches the desktop on. Lower is better. Private (RFC 1918) home /
// office ranges win over anything else; 192.168/16 is the most common LAN, then
// the 172.16/12 block, then 10/8 (frequently carved up by VPNs / corp routing).
const rankLanCandidate = (addr: string): number => {
  if (addr.startsWith('192.168.')) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 1;
  if (addr.startsWith('10.')) return 2;
  return 3;
};

// Pick the best LAN IPv4 to advertise. Pure over the interface map so it can be
// unit-tested against real multi-NIC layouts. Iterating and returning the first
// non-internal hit (the old behavior) picks whatever the OS lists first, which
// on a multi-NIC box can be a VPN / benchmark adapter rather than the LAN.
export function pickLanIP(nets: ReturnType<typeof networkInterfaces>): string | null {
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (isUnreachableLanRange(iface.address)) continue;
      candidates.push(iface.address);
    }
  }
  // Stable sort keeps OS interface order among equally-ranked addresses (e.g. a
  // physical NIC listed before a VPN when both are 10/8).
  candidates.sort((a, b) => rankLanCandidate(a) - rankLanCandidate(b));
  return candidates[0] ?? null;
}

function getLanIP(): string | null {
  return pickLanIP(networkInterfaces());
}

export type AccessPolicy = 'public' | 'session' | 'deny';

// Reachable without a session: the login flow and the session probe itself.
const PUBLIC_PATHS = new Set(['/login', '/logout', '/api/auth/status', '/api/auth/user', '/api/auth/refresh']);
// Desktop-only routes (password reset, QR tokens, internal user admin) and the
// QR login exchange. aioncore answers them unauthenticated in `--local` mode,
// so WebUI clients must never reach them.
const DENY_PREFIXES = ['/api/webui', '/api/auth/internal', '/api/auth/qr-login'];

const UNAUTHORIZED_BODY = JSON.stringify({ success: false, error: 'Authentication required', code: 'UNAUTHORIZED' });
const FORBIDDEN_BODY = JSON.stringify({ success: false, error: 'Forbidden.', code: 'FORBIDDEN' });
const RATE_LIMITED_BODY = JSON.stringify({ success: false, error: 'Rate limited', code: 'RATE_LIMITED' });

/**
 * Classify a request URL for the WebUI access gate. The path is decoded and
 * slash-collapsed first so encoded or doubled segments cannot dodge the deny list.
 */
export function classifyRequest(url: string): AccessPolicy {
  let path = url.split('?')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return 'deny';
  }
  path = path.replace(/\/{2,}/g, '/').toLowerCase();
  if (DENY_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'deny';
  if (PUBLIC_PATHS.has(path)) return 'public';
  if (path === '/api' || path.startsWith('/api/') || path === '/ws') return 'session';
  return 'public';
}

/** Ask aioncore's /api/auth/user about a credential; resolves to its HTTP status (401 on transport failure). */
function probeSession(forwarded: http.OutgoingHttpHeaders, backendPort: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = http.request(
      {
        hostname: '127.0.0.1',
        port: backendPort,
        path: '/api/auth/user',
        method: 'GET',
        headers: forwarded,
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 401);
      }
    );
    probe.on('timeout', () => probe.destroy());
    probe.on('error', () => resolve(401));
    probe.end();
  });
}

// aioncore rate-limits /api/auth/user, so a page load's burst of parallel calls
// must not each probe it: requests with the same credential share one in-flight
// probe, and a confirmed session is trusted for a short window.
const SESSION_CACHE_TTL_MS = 10_000;
const SESSION_CACHE_MAX = 500;

type SessionChecker = (headers: http.IncomingHttpHeaders) => Promise<number>;

function createSessionChecker(backendPort: number): SessionChecker {
  const cache = new Map<string, { status: Promise<number>; expiresAt: number }>();
  return (headers) => {
    const forwarded: http.OutgoingHttpHeaders = {};
    if (headers.cookie) forwarded.cookie = headers.cookie;
    if (headers.authorization) forwarded.authorization = headers.authorization;
    if (!forwarded.cookie && !forwarded.authorization) return Promise.resolve(401);

    const key = `${headers.cookie ?? ''}\n${headers.authorization ?? ''}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.status;

    if (cache.size >= SESSION_CACHE_MAX) {
      for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    }
    const entry = { status: probeSession(forwarded, backendPort), expiresAt: now + SESSION_CACHE_TTL_MS };
    cache.set(key, entry);
    // Only a confirmed session stays cached; a failure must re-probe so a fresh
    // login or a retry after rate limiting takes effect immediately.
    void entry.status.then((status) => {
      if (status !== 200 && cache.get(key) === entry) cache.delete(key);
    });
    return entry.status;
  };
}

/** Map a failed session probe to the gate's response: keep 429 so clients back off instead of re-logging in. */
function rejectionFor(status: number): { status: number; body: string } {
  return status === 429 ? { status: 429, body: RATE_LIMITED_BODY } : { status: 401, body: UNAUTHORIZED_BODY };
}

/** Parse the header block of a peeked raw HTTP request (keys lower-cased). */
function parseRawHeaders(buf: Buffer): http.IncomingHttpHeaders {
  const end = buf.indexOf('\r\n\r\n');
  const lines = buf
    .slice(0, end < 0 ? buf.length : end)
    .toString('latin1')
    .split('\r\n')
    .slice(1);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function writeJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function forwardToBackend(req: IncomingMessage, res: ServerResponse, backendPort: number): void {
  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port: backendPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'BACKEND_UNREACHABLE' }));
    } else {
      res.destroy();
    }
  });
  req.pipe(proxy);
}

// Max bytes we peek before forcing a routing decision. An HTTP request-line
// on its own is typically < 100 bytes; a full header block is < 2 KB. If we
// haven't seen a newline after 4 KB the client is sending something weird —
// hand it to the internal HTTP server and let it return 400.
const PEEK_LIMIT_BYTES = 4096;

/**
 * Splice `client` to a TCP endpoint on `targetPort`. Any bytes already read
 * from `client` during peek are replayed to the upstream as the first write,
 * so the endpoint sees the full HTTP request as-sent.
 */
function spliceToTcpEndpoint(client: Socket, targetPort: number, initialBytes: Buffer): void {
  client.setNoDelay(true);
  client.setKeepAlive(true);
  client.setTimeout(0);
  // The peek phase left `client` in flowing mode (it had a 'data' listener),
  // but that listener is now removed and the real consumer — `client.pipe(upstream)`
  // — is only wired inside the async 'connect' handler below. Pause here so any
  // body bytes arriving in the gap are buffered by the socket instead of being
  // dropped for lack of a consumer; `pipe()` resumes the socket once connected.
  // Without this, large/buffered uploads (e.g. reverse-proxied POST bodies that
  // span multiple TCP segments) lose their tail bytes and the backend hangs
  // forever waiting for the missing Content-Length (issue #4058).
  client.pause();
  const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
  upstream.setNoDelay(true);
  upstream.setKeepAlive(true);
  upstream.once('connect', () => {
    if (initialBytes.length > 0) upstream.write(initialBytes);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const tearDown = (): void => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', tearDown);
  client.on('error', tearDown);
  upstream.on('close', tearDown);
  client.on('close', tearDown);
}

/**
 * Decide routing from the first chunk of an incoming HTTP connection:
 *  - `true`  → `GET /ws[...] HTTP/1.x` or `GET /api/stt/stream[...] HTTP/1.x` (WebSocket/stream upgrades), splice to backend
 *  - `false` → any other HTTP method / path, hand to internal HTTP server
 *  - `null`  → need more bytes (no CRLF yet)
 *
 * We only check the request-line; `Upgrade: websocket` is not strictly
 * required — the backend will reject a non-upgrade GET on these paths on its own.
 * Keeping the rule simple means we can decide after the first ~50 bytes
 * instead of waiting for the full header block.
 */
function peekWsRoute(buf: Buffer): boolean | null {
  const newlineIdx = buf.indexOf(0x0a); // \n
  if (newlineIdx < 0) return null;
  const firstLine = buf.slice(0, newlineIdx).toString('ascii');
  return /^GET\s+\/(?:ws|api\/stt\/stream)(?:\?[^\s]*)?\s+HTTP\/1\.[01]\r?$/.test(firstLine);
}

export async function startStaticServer(opts: StaticServerOptions): Promise<StaticServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const allowRemote = opts.allowRemote === true;
  const host = allowRemote ? '0.0.0.0' : '127.0.0.1';
  const checkSession = createSessionChecker(opts.backendPort);

  // The HTTP server listens only on loopback — user traffic hits the outer
  // net.Server first. We route to this server for everything except WS
  // upgrades and STT stream upgrades, which go straight to the backend via a raw TCP splice.
  //
  // Why two listeners instead of using `http.Server`'s native `upgrade` event:
  // bun 1.3's http-compat layer does not faithfully forward writes on the
  // socket delivered to the `upgrade` handler, so the backend's 101 response
  // never reaches the browser (see #2824). Making the outer listener pure
  // TCP avoids touching that code path on both bun and node.
  const http_server: Server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        res.writeHead(400).end();
        return;
      }

      const policy = classifyRequest(req.url);
      if (policy === 'deny') {
        writeJson(res, 403, FORBIDDEN_BODY);
        return;
      }
      if (policy === 'session') {
        const sessionStatus = await checkSession(req.headers);
        if (sessionStatus !== 200) {
          const rejection = rejectionFor(sessionStatus);
          writeJson(res, rejection.status, rejection.body);
          return;
        }
      }

      // /api/* — reverse proxy to backend (includes /api/auth/*).
      // /login and /logout are aionui-auth's top-level auth endpoints: proxy them too
      // so WebUI browser clients reach the backend without a path-rewrite.
      if (req.url.startsWith('/api/') || req.url.startsWith('/api?') || req.url === '/login' || req.url === '/logout') {
        forwardToBackend(req, res, opts.backendPort);
        return;
      }

      // static files + SPA fallback
      await serveHandler(req, res, {
        public: opts.staticDir,
        rewrites: [{ source: '**', destination: '/index.html' }],
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
      } else {
        res.destroy();
      }
    }
  });

  // Internal HTTP server — 127.0.0.1 ephemeral port, never visible to the user.
  await new Promise<void>((resolve, reject) => {
    http_server.once('error', reject);
    http_server.listen(0, '127.0.0.1', () => {
      http_server.off('error', reject);
      resolve();
    });
  });
  const internalPort = (http_server.address() as { port: number } | null)?.port;
  if (!internalPort) {
    throw new Error('internal HTTP server failed to bind to a port');
  }

  // User-facing listener: inspect the first line of every TCP connection and
  // route to either the backend (for /ws and /api/stt/stream upgrades) or the internal HTTP
  // server (everything else). Both routes use raw TCP splice — no reliance
  // on http.Server's upgrade event.
  const tcp_server = net.createServer((client: Socket) => {
    let peeked = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      client.removeListener('data', onData);
      client.removeListener('error', onEarlyError);
      client.removeListener('end', onEarlyEnd);
    };
    const onData = (chunk: Buffer): void => {
      peeked = Buffer.concat([peeked, chunk]);
      const decision = peekWsRoute(peeked);
      if (decision === null && peeked.length < PEEK_LIMIT_BYTES) return;
      // Upgrades skip the internal HTTP server, so wait for the full header
      // block and check the session here before splicing to the backend.
      if (decision === true && peeked.indexOf('\r\n\r\n') < 0 && peeked.length < PEEK_LIMIT_BYTES) return;
      cleanup();
      if (decision !== true) {
        spliceToTcpEndpoint(client, internalPort, peeked);
        return;
      }
      client.pause();
      client.on('error', () => client.destroy());
      void checkSession(parseRawHeaders(peeked)).then((sessionStatus) => {
        if (sessionStatus === 200) {
          spliceToTcpEndpoint(client, opts.backendPort, peeked);
          return;
        }
        const rejection = rejectionFor(sessionStatus);
        client.end(
          `HTTP/1.1 ${rejection.status} ${http.STATUS_CODES[rejection.status]}\r\n` +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(rejection.body)}\r\n` +
            'Connection: close\r\n\r\n' +
            rejection.body
        );
      });
    };
    const onEarlyError = (): void => {
      cleanup();
      client.destroy();
    };
    const onEarlyEnd = (): void => {
      // Client closed before we saw a request line — nothing to route.
      cleanup();
      client.destroy();
    };
    client.on('data', onData);
    client.on('error', onEarlyError);
    client.on('end', onEarlyEnd);
  });

  await new Promise<void>((resolve, reject) => {
    tcp_server.once('error', reject);
    tcp_server.listen(port, host, () => {
      tcp_server.off('error', reject);
      resolve();
    });
  });

  const actualPort = (tcp_server.address() as { port: number } | null)?.port ?? port;
  const lanIP = allowRemote ? (getLanIP() ?? undefined) : undefined;
  const localUrl = `http://127.0.0.1:${actualPort}`;
  const networkUrl = lanIP ? `http://${lanIP}:${actualPort}` : undefined;

  return {
    port: actualPort,
    url: networkUrl ?? localUrl,
    localUrl,
    networkUrl,
    lanIP,
    stop: () =>
      new Promise<void>((resolve) => {
        tcp_server.close(() => {
          http_server.close(() => resolve());
        });
      }),
  };
}

export async function stopStaticServer(handle: StaticServerHandle): Promise<void> {
  await handle.stop();
}
