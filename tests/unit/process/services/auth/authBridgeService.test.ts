/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testDir = '';
const openExternalMock = vi.fn();
const statusChangedEmitMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => testDir),
  },
  shell: {
    openExternal: (...args: unknown[]) => openExternalMock(...args),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    auth: {
      openLogin: { provider: vi.fn() },
      checkStatus: { provider: vi.fn() },
      logout: { provider: vi.fn() },
      statusChanged: { emit: (...args: unknown[]) => statusChangedEmitMock(...args) },
    },
  },
}));

import {
  checkAuthStatus,
  getPendingState,
  handleAuthCallback,
  initAuthBridge,
  logout,
  openJDCloudLogin,
  setPendingState,
} from '@/process/services/auth/authBridgeService';
import { readDesktopToken, saveDesktopToken } from '@/process/services/auth/credentialStorage';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-auth-bridge-test-'));
  openExternalMock.mockClear();
  statusChangedEmitMock.mockClear();
  setPendingState(null);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('authBridgeService', () => {
  describe('openJDCloudLogin', () => {
    it('generates a 128-bit random state with 10-minute TTL and launches system browser', async () => {
      const now = Date.now();
      const res = await openJDCloudLogin();

      expect(res.success).toBe(true);
      expect(res.state).toBeDefined();
      expect(res.state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      const pending = getPendingState();
      expect(pending).not.toBeNull();
      expect(pending?.value).toBe(res.state);
      expect(pending?.expiresAt).toBeGreaterThanOrEqual(now + 9 * 60 * 1000);

      expect(openExternalMock).toHaveBeenCalledTimes(1);
      const openedUrl = openExternalMock.mock.calls[0][0] as string;
      expect(openedUrl).toContain('https://joydesk.jdcloud.com/desktop/auth');
      expect(openedUrl).toContain(`state=${encodeURIComponent(res.state)}`);
    });
  });

  describe('handleAuthCallback', () => {
    it('rejects callback if state does not match or is expired', async () => {
      setPendingState({ value: 'correct-state', expiresAt: Date.now() + 60000 });

      const resMismatch = await handleAuthCallback({ code: 'valid-code', state: 'wrong-state' });
      expect(resMismatch.success).toBe(false);
      expect(resMismatch.error).toBe('state_mismatch_or_expired');
      expect(getPendingState()).toBeNull(); // Consumed/invalidated

      // Expired state
      setPendingState({ value: 'expired-state', expiresAt: Date.now() - 1000 });
      const resExpired = await handleAuthCallback({ code: 'valid-code', state: 'expired-state' });
      expect(resExpired.success).toBe(false);
      expect(resExpired.error).toBe('state_mismatch_or_expired');
    });

    it('enforces atomic one-time consumption to prevent replay attacks', async () => {
      setPendingState({ value: 'once-state', expiresAt: Date.now() + 60000 });

      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            code: 200,
            message: 'ok',
            data: {
              token: 'jwt-token-xyz',
              user: { pin: 'wangqiang506', role: 'developer' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const firstCall = await handleAuthCallback({ code: 'auth-code-1', state: 'once-state' });
      expect(firstCall.success).toBe(true);

      // Replay attack with same state should be rejected
      const replayCall = await handleAuthCallback({ code: 'auth-code-1', state: 'once-state' });
      expect(replayCall.success).toBe(false);
      expect(replayCall.error).toBe('state_mismatch_or_expired');
    });

    it('successfully exchanges code for token and persists it to safeStorage', async () => {
      setPendingState({ value: 'valid-state', expiresAt: Date.now() + 60000 });

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({ code: 'auth-code-abc', state: 'valid-state' });
        return new Response(
          JSON.stringify({
            code: 200,
            message: 'ok',
            data: {
              token: 'desktop-token-secret-jwt',
              user: { pin: 'wangqiang506', role: 'admin', enterpriseId: 'ent_999' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await handleAuthCallback({ code: 'auth-code-abc', state: 'valid-state' });
      expect(res.success).toBe(true);
      expect(res.user?.pin).toBe('wangqiang506');

      expect(readDesktopToken()).toBe('desktop-token-secret-jwt');
      expect(statusChangedEmitMock).toHaveBeenCalledWith({
        authenticated: true,
        user: { pin: 'wangqiang506', role: 'admin', enterpriseId: 'ent_999', seatId: undefined },
      });
    });
  });

  describe('checkAuthStatus and auto-healing', () => {
    it('returns unauthenticated when no token is stored', async () => {
      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
    });

    it('probes profile successfully with valid stored token', async () => {
      saveDesktopToken('existing-valid-token');

      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.headers).toEqual({ Authorization: 'Bearer existing-valid-token' });
        return new Response(
          JSON.stringify({
            code: 200,
            data: { jd_pin: 'wangqiang506', role: 'developer', enterprise_id: 'ent_100' },
          }),
          { status: 200 }
        );
      });

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.user?.pin).toBe('wangqiang506');
    });

    it('auto-heals by wiping token and emitting unauthenticated on HTTP 401', async () => {
      saveDesktopToken('expired-token');

      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ code: 401, message: 'Token expired' }), { status: 401 });
      });

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(readDesktopToken()).toBeNull(); // Token cleared!
      expect(statusChangedEmitMock).toHaveBeenCalledWith({ authenticated: false });
    });
  });

  describe('logout', () => {
    it('wipes token, pending state, and emits unauthenticated', async () => {
      saveDesktopToken('active-token');
      setPendingState({ value: 'some-state', expiresAt: Date.now() + 60000 });

      await logout();
      expect(readDesktopToken()).toBeNull();
      expect(getPendingState()).toBeNull();
      expect(statusChangedEmitMock).toHaveBeenCalledWith({ authenticated: false });
    });
  });
});
