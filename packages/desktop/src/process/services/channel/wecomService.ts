/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import WebSocket from 'ws';
import AiBot from '@wecom/aibot-node-sdk';
import { ProcessConfig } from '@process/utils/initStorage';
import { ipcBridge } from '@/common';
import type {
  IChannelAssistantBindingRead,
  IChannelAssistantBindingWrite,
  IChannelDefaultModelSetting,
  IChannelPairingRequest,
  IChannelPlatformSettings,
  IChannelPluginStatus,
  IChannelUser,
} from '@/common/types/channel/channel';

export interface WecomPersistedConfig {
  botId?: string;
  secret?: string;
  enabled?: boolean;
  assistant?: IChannelAssistantBindingRead | null;
  defaultModel?: IChannelDefaultModelSetting | null;
  authorizedUsers?: IChannelUser[];
  pendingPairings?: IChannelPairingRequest[];
  userConversations?: Record<string, string>;
}

export interface WecomWsClient {
  connect: () => void;
  disconnect: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  reply: (frame: unknown, body: unknown, cmd?: string) => Promise<unknown>;
  replyStream: (
    frame: unknown,
    streamId: string,
    content: string,
    finish?: boolean,
    msgItem?: unknown[],
    feedback?: unknown
  ) => Promise<unknown>;
}

export interface QueuedUserMessage {
  frame: unknown;
  userText: string;
  userId: string;
  displayName: string;
  retryCount?: number;
}

export interface ActiveStreamContext {
  frame: unknown;
  streamId: string;
  conversationId: string;
  assignedTurnId?: string;
  assignedMsgId?: string;
  accumulatedText: string;
  lastSentText: string;
  streamFinished: boolean; // True once WeCom stream is finished (e.g. wall time limit)
  throttleTimer?: NodeJS.Timeout;
  idleTimeoutTimer?: NodeJS.Timeout;
  wallTimeoutTimer?: NodeJS.Timeout;
  streamStartedAt: number;
}

// Physical and protocol timing constants
export const IDLE_TIMEOUT_MS = 90_000; // 90s idle without chunks implies dead backend stream
export const MAX_STREAM_WALL_TIME_MS = 330_000; // 5.5 min WeCom WebSocket stream safety limit (hard limit 6 min)

/**
 * Split text safely by UTF-8 byte length to prevent exceeding WeCom byte limits.
 * WeCom single text message limit is 2048 bytes; default max safe byte limit is 1800.
 * Preserves code-point integrity (surrogate pairs / multi-byte characters).
 */
export function safeChunkText(text: string, maxBytes = 1800): string[] {
  if (!text) return [''];
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  if (totalBytes <= maxBytes) {
    return [text]; // No-op on Valid
  }

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of Array.from(text)) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (currentBytes + charBytes > maxBytes) {
      if (current) chunks.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [''];
}

export class WecomService {
  private botId = '';
  private secret = '';
  private enabled = false;
  private connected = false;
  private lastError = '';

  private authorizedUsers: IChannelUser[] = [];
  private pendingPairings: IChannelPairingRequest[] = [];
  private assistant: IChannelAssistantBindingRead | null = null;
  private defaultModel: IChannelDefaultModelSetting | null = null;

  // Persisted user -> conversation mapping
  public readonly userConversations = new Map<string, string>();

  // Backend dynamic port resolution
  private backendPortReadyPromise: Promise<number> | null = null;
  private resolveBackendPort?: (port: number) => void;

  private client: WecomWsClient | null = null;
  private backendWs: WebSocket | null = null;
  private backendWsReconnectTimer: NodeJS.Timeout | null = null;

  // Concurrency & stream management
  public readonly activeStreams = new Map<string, ActiveStreamContext>();
  public readonly conversationQueues = new Map<string, QueuedUserMessage[]>();

  constructor() {
    this.loadPersistedConfig();
  }

  public loadPersistedConfig(): void {
    try {
      const data = ProcessConfig.getSync('channel.wecom' as never) as WecomPersistedConfig | undefined;
      if (data) {
        this.botId = data.botId || '';
        this.secret = data.secret || '';
        this.enabled = data.enabled || false;
        this.assistant = data.assistant || null;
        this.defaultModel = data.defaultModel || null;
        this.authorizedUsers = Array.isArray(data.authorizedUsers) ? data.authorizedUsers : [];
        this.pendingPairings = Array.isArray(data.pendingPairings) ? data.pendingPairings : [];
        if (data.userConversations && typeof data.userConversations === 'object') {
          for (const [userId, convId] of Object.entries(data.userConversations)) {
            if (typeof userId === 'string' && typeof convId === 'string') {
              this.userConversations.set(userId, convId);
            }
          }
        }
      }
    } catch (error) {
      console.error('[WecomService] Failed to load config:', error);
    }
  }

  public async savePersistedConfig(): Promise<void> {
    try {
      const userConversationsObj: Record<string, string> = {};
      for (const [userId, convId] of this.userConversations.entries()) {
        userConversationsObj[userId] = convId;
      }

      const data: WecomPersistedConfig = {
        botId: this.botId,
        secret: this.secret,
        enabled: this.enabled,
        assistant: this.assistant,
        defaultModel: this.defaultModel,
        authorizedUsers: this.authorizedUsers,
        pendingPairings: this.pendingPairings,
        userConversations: userConversationsObj,
      };
      await ProcessConfig.set('channel.wecom' as never, data as never);
    } catch (error) {
      console.error('[WecomService] Failed to save config:', error);
    }
  }

  /**
   * Asynchronously wait for globalThis.__backendPort to be dynamically assigned.
   * Never falls back to a hardcoded port.
   * Rejection resets the cached promise so subsequent attempts can succeed.
   */
  public async getBackendPort(): Promise<number> {
    const g = globalThis as typeof globalThis & { __backendPort?: number };
    if (typeof g.__backendPort === 'number' && g.__backendPort > 0) {
      return g.__backendPort;
    }

    if (!this.backendPortReadyPromise) {
      this.backendPortReadyPromise = new Promise<number>((resolve, reject) => {
        this.resolveBackendPort = resolve;
        const timer = setTimeout(() => {
          this.backendPortReadyPromise = null;
          this.resolveBackendPort = undefined;
          reject(new Error('[WecomService] Timed out waiting for backend port to be assigned'));
        }, 60000);
        timer.unref?.();
      }).catch((err) => {
        this.backendPortReadyPromise = null;
        this.resolveBackendPort = undefined;
        throw err;
      });
    }

    return this.backendPortReadyPromise;
  }

  /**
   * Called by main process index.ts once backendManager is fully running and healthy.
   */
  public async onBackendReady(port: number): Promise<void> {
    console.log('[WecomService] Backend ready event received with dynamic port:', port);
    if (this.resolveBackendPort) {
      this.resolveBackendPort(port);
      this.resolveBackendPort = undefined;
    }

    if (this.enabled && this.botId && this.secret) {
      await this.autoRestore();
    }
  }

  public getStatus(): IChannelPluginStatus {
    return {
      id: 'wecom',
      type: 'wecom',
      name: 'WeCom',
      enabled: this.enabled,
      connected: this.connected,
      status: this.enabled ? (this.connected ? 'running' : 'starting') : 'stopped',
      activeUsers: this.authorizedUsers.length,
      hasToken: Boolean(this.botId && this.secret),
      error: this.lastError || undefined,
    };
  }

  private broadcastStatus(): void {
    const status = this.getStatus();
    try {
      ipcBridge.channel.pluginStatusChanged.emit({
        plugin_id: 'wecom',
        status,
      });
    } catch (error) {
      console.warn('[WecomService] Failed to broadcast status:', error);
    }
  }

  public async autoRestore(): Promise<void> {
    if (this.enabled && this.botId && this.secret) {
      console.log('[WecomService] Auto-restoring WeCom channel on startup...');
      await this.start();
    }
  }

  public async start(botId?: string, secret?: string): Promise<void> {
    if (botId !== undefined && secret !== undefined) {
      this.botId = botId.trim();
      this.secret = secret.trim();
    }

    if (!this.botId || !this.secret) {
      throw new Error('Bot ID and Secret are required to start WeCom channel');
    }

    this.enabled = true;
    this.connected = false;
    this.lastError = '';
    await this.savePersistedConfig();
    this.broadcastStatus();

    this.stopClient();

    try {
      const WSClientCtor =
        (AiBot as unknown as { WSClient?: new (opts: Record<string, unknown>) => WecomWsClient }).WSClient ||
        (AiBot as unknown as { default?: { WSClient?: new (opts: Record<string, unknown>) => WecomWsClient } })?.default
          ?.WSClient;

      if (!WSClientCtor) {
        throw new Error('WSClient constructor not found in @wecom/aibot-node-sdk');
      }

      const client = new WSClientCtor({
        botId: this.botId,
        secret: this.secret,
      });

      client.on('authenticated', () => {
        console.log('[WecomService] Authenticated with WeCom successfully');
        this.connected = true;
        this.lastError = '';
        this.broadcastStatus();
        void this.ensureBackendWs();
      });

      client.on('error', (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[WecomService] WeCom client error:', message);
        this.connected = false;
        this.lastError = message;
        this.broadcastStatus();
      });

      client.on('disconnected', () => {
        console.warn('[WecomService] WeCom client disconnected');
        this.connected = false;
        this.broadcastStatus();
      });

      const handleInbound = (frame: unknown) => {
        void this.handleIncomingMessage(frame).catch((error) => {
          console.error('[WecomService] Failed to handle incoming message:', error);
        });
      };

      client.on('message.text', handleInbound);
      client.on('message.voice', handleInbound);
      client.on('message.mixed', handleInbound);
      client.on('message.image', handleInbound);
      client.on('message.file', handleInbound);
      client.on('message.video', handleInbound);

      client.connect();
      this.client = client;
    } catch (error) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.broadcastStatus();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.enabled = false;
    this.connected = false;
    this.lastError = '';
    this.stopClient();
    this.closeBackendWs();
    this.cleanupAllStreams('WeCom 渠道已被主动停用');
    await this.savePersistedConfig();
    this.broadcastStatus();
  }

  private stopClient(): void {
    if (this.client) {
      try {
        this.client.disconnect();
      } catch (error) {
        console.warn('[WecomService] Error disconnecting client:', error);
      }
      this.client = null;
    }
  }

  public async ensureBackendWs(): Promise<void> {
    if (
      this.backendWs &&
      (this.backendWs.readyState === WebSocket.OPEN || this.backendWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const port = await this.getBackendPort();
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      const ws = new WebSocket(wsUrl);
      this.backendWs = ws;

      ws.on('open', () => {
        console.log('[WecomService] Connected to backend WebSocket on dynamic port', port);
      });

      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString()) as {
            event?: string;
            name?: string;
            data?: Record<string, unknown>;
            payload?: Record<string, unknown>;
          };
          const eventName = parsed.event || parsed.name;
          const payload = (parsed.data || parsed.payload || {}) as {
            conversation_id?: string;
            turn_id?: string;
            type?: string;
            data?: unknown;
            status?: string;
          };

          if (eventName === 'message.stream' && payload.conversation_id) {
            this.handleBackendStreamChunk(payload);
          }
        } catch {
          // Ignore non-json frames
        }
      });

      ws.on('close', () => {
        console.warn('[WecomService] Backend WebSocket closed');
        this.backendWs = null;
        this.cleanupAllStreams('与本地 AionUi 守护内核连接中断');
        if (this.enabled) {
          if (this.backendWsReconnectTimer) clearTimeout(this.backendWsReconnectTimer);
          this.backendWsReconnectTimer = setTimeout(() => {
            void this.ensureBackendWs();
          }, 3000);
        }
      });

      ws.on('error', (err) => {
        console.warn('[WecomService] Backend WebSocket error:', err.message);
        this.cleanupAllStreams(`本地 AionUi 连接异常: ${err.message}`);
      });
    } catch (e) {
      console.warn('[WecomService] Failed to establish backend WebSocket:', e);
    }
  }

  private closeBackendWs(): void {
    if (this.backendWsReconnectTimer) {
      clearTimeout(this.backendWsReconnectTimer);
      this.backendWsReconnectTimer = null;
    }
    if (this.backendWs) {
      try {
        this.backendWs.close();
      } catch {}
      this.backendWs = null;
    }
  }

  /**
   * Release and cleanly terminate all hanging active streams & queued messages.
   */
  public cleanupAllStreams(reason: string): void {
    for (const [, streamContext] of this.activeStreams.entries()) {
      if (streamContext.throttleTimer) {
        clearTimeout(streamContext.throttleTimer);
      }
      if (streamContext.idleTimeoutTimer) {
        clearTimeout(streamContext.idleTimeoutTimer);
      }
      if (streamContext.wallTimeoutTimer) {
        clearTimeout(streamContext.wallTimeoutTimer);
      }

      if (this.client) {
        const fallbackText = (streamContext.accumulatedText || '') + `\n\n[提示: ${reason}]`;
        const chunks = safeChunkText(fallbackText, 1800);
        if (!streamContext.streamFinished) {
          void this.client
            .replyStream(streamContext.frame, streamContext.streamId, chunks[0] || '服务异常', true)
            .catch(() => {});
        } else {
          void this.client
            .reply(streamContext.frame, {
              msgtype: 'text',
              text: { content: chunks[0] || '服务异常' },
            })
            .catch(() => {});
        }
      }
    }
    this.activeStreams.clear();

    for (const queue of this.conversationQueues.values()) {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item && this.client) {
          void this.client
            .reply(item.frame, {
              msgtype: 'text',
              text: { content: `[提示] 本地连接重置，上一条排队消息未能发送，请重新发送。` },
            })
            .catch(() => {});
        }
      }
    }
    this.conversationQueues.clear();
  }

  private resetIdleTimeout(streamContext: ActiveStreamContext): void {
    if (streamContext.idleTimeoutTimer) {
      clearTimeout(streamContext.idleTimeoutTimer);
    }

    streamContext.idleTimeoutTimer = setTimeout(() => {
      console.warn(
        `[WecomService] Idle timeout (${IDLE_TIMEOUT_MS}ms without chunks) on stream ${streamContext.streamId}`
      );
      this.handleStreamTermination(
        streamContext,
        (streamContext.accumulatedText || '') + '\n\n[提示：生成超时，未收到后端响应]'
      );
    }, IDLE_TIMEOUT_MS);
    streamContext.idleTimeoutTimer.unref?.();
  }

  private handleStreamTermination(streamContext: ActiveStreamContext, finalContent: string): void {
    if (streamContext.throttleTimer) {
      clearTimeout(streamContext.throttleTimer);
    }
    if (streamContext.idleTimeoutTimer) {
      clearTimeout(streamContext.idleTimeoutTimer);
    }
    if (streamContext.wallTimeoutTimer) {
      clearTimeout(streamContext.wallTimeoutTimer);
    }

    const convId = streamContext.conversationId;
    this.activeStreams.delete(convId);

    void (async () => {
      if (this.client) {
        const chunks = safeChunkText(finalContent, 1800);
        if (!streamContext.streamFinished) {
          // Finish stream with first chunk
          try {
            await this.client.replyStream(streamContext.frame, streamContext.streamId, chunks[0], true);
          } catch (err) {
            console.error('[WecomService] Failed to send finish stream reply:', err);
          }
          // Serial await for remaining overflow chunks to strictly preserve delivery order
          if (chunks.length > 1) {
            for (let i = 1; i < chunks.length; i++) {
              try {
                await this.client.reply(streamContext.frame, {
                  msgtype: 'text',
                  text: { content: chunks[i] },
                });
              } catch (err) {
                console.error('[WecomService] Failed to send extra text chunk:', err);
              }
            }
          }
        } else {
          // Stream was already closed by wall-time limit, send all chunks via sequential replies
          for (let i = 0; i < chunks.length; i++) {
            try {
              await this.client.reply(streamContext.frame, {
                msgtype: 'text',
                text: { content: chunks[i] },
              });
            } catch (err) {
              console.error('[WecomService] Failed to send sequel text chunk:', err);
            }
          }
        }
      }

      // Backend turn is now truly finished, process next queued message for this conversation
      this.processNextQueuedMessage(convId);
    })();
  }

  public handleBackendStreamChunk(chunk: {
    conversation_id?: string;
    turn_id?: string;
    type?: string;
    data?: unknown;
    status?: string;
  }): void {
    const convId = chunk.conversation_id;
    if (!convId) return;

    const streamContext = this.activeStreams.get(convId);
    if (!streamContext || !this.client) return;

    // Turn attribution verification: if stream is assigned to a turn_id, discard orphaned chunks from other turns
    const chunkTurnId =
      chunk.turn_id ||
      (chunk.data && typeof chunk.data === 'object' && 'turn_id' in chunk.data
        ? (chunk.data as { turn_id?: string }).turn_id
        : undefined);

    if (streamContext.assignedTurnId && chunkTurnId && chunkTurnId !== streamContext.assignedTurnId) {
      console.warn(
        `[WecomService] Discarding orphaned chunk from turn ${chunkTurnId}, current stream bound to ${streamContext.assignedTurnId}`
      );
      return;
    }

    // Reset idle timeout upon receipt of valid chunk
    this.resetIdleTimeout(streamContext);

    if (typeof chunk.data === 'string' && chunk.data) {
      streamContext.accumulatedText += chunk.data;
    }

    const isFinish = chunk.status === 'finish' || chunk.status === 'error';

    if (isFinish) {
      const finalContent =
        streamContext.accumulatedText || (chunk.status === 'error' ? '生成异常，请重试' : '（无回复内容）');
      this.handleStreamTermination(streamContext, finalContent);
    } else {
      // Throttle intermediate updates if WeCom stream is still open
      if (!streamContext.streamFinished) {
        if (!streamContext.throttleTimer) {
          streamContext.throttleTimer = setTimeout(() => {
            streamContext.throttleTimer = undefined;
            if (
              !streamContext.streamFinished &&
              streamContext.accumulatedText !== streamContext.lastSentText &&
              this.client
            ) {
              streamContext.lastSentText = streamContext.accumulatedText;
              const previewChunks = safeChunkText(streamContext.accumulatedText, 1800);
              void this.client
                .replyStream(streamContext.frame, streamContext.streamId, previewChunks[0], false)
                .catch(() => {});
            }
          }, 300);
        }
      }
    }
  }

  public processNextQueuedMessage(conversationId: string): void {
    const queue = this.conversationQueues.get(conversationId);
    if (!queue || queue.length === 0) return;

    // Ensure no active stream is running before popping next
    if (this.activeStreams.has(conversationId)) {
      return;
    }

    const nextItem = queue.shift();
    if (!nextItem) return;

    void this.dispatchUserMessage(conversationId, nextItem).catch((err) => {
      console.error('[WecomService] Failed to dispatch next queued message:', err);
      this.processNextQueuedMessage(conversationId);
    });
  }

  private extractTextFromFrameBody(body: Record<string, unknown>): string {
    const msgType = typeof body.msgtype === 'string' ? body.msgtype : 'text';
    if (msgType === 'text') {
      const textObj = body.text as { content?: string } | undefined;
      return textObj?.content || '';
    }
    if (msgType === 'voice') {
      const voiceObj = body.voice as { content?: string } | undefined;
      return voiceObj?.content || '';
    }
    if (msgType === 'mixed') {
      const mixed = body.mixed as { msg_item?: Array<Record<string, unknown>> } | undefined;
      const items = Array.isArray(mixed?.msg_item) ? mixed.msg_item : [];
      return items
        .map((item) => {
          if (item?.msgtype === 'text') {
            const t = item.text as { content?: string } | undefined;
            return t?.content || '';
          }
          if (item?.msgtype === 'image') {
            const im = item.image as { url?: string } | undefined;
            return im?.url ? `[图片] ${im.url}` : '';
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (msgType === 'image') {
      const image = body.image as { url?: string } | undefined;
      return image?.url ? `[图片] ${image.url}` : '[图片]';
    }
    if (msgType === 'file') {
      const file = body.file as { name?: string } | undefined;
      return file?.name ? `[文件] ${file.name}` : '[文件]';
    }
    return '';
  }

  public async handleIncomingMessage(frame: unknown): Promise<void> {
    if (!this.client || !frame || typeof frame !== 'object') return;

    const body = ((frame as { body?: unknown }).body || {}) as Record<string, unknown>;
    const from = (body.from || {}) as { userid?: string; name?: string };
    const userId = from.userid || (body.from_userid as string) || (body.userid as string) || 'wecom-user';
    const displayName = from.name || userId;
    const userText = this.extractTextFromFrameBody(body).trim();

    if (!userText) return;

    // Check authorization
    const isAuthorized = this.authorizedUsers.some((u) => u.platformUserId === userId);
    if (!isAuthorized) {
      let pairing = this.pendingPairings.find((p) => p.platformUserId === userId && p.expiresAt > Date.now());

      if (!pairing) {
        const code = crypto.randomBytes(3).toString('hex').toUpperCase();
        pairing = {
          code,
          platformUserId: userId,
          platformType: 'wecom',
          display_name: displayName,
          requestedAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000,
        };
        this.pendingPairings = [pairing, ...this.pendingPairings.filter((p) => p.platformUserId !== userId)];
        await this.savePersistedConfig();
        ipcBridge.channel.pairingRequested.emit(pairing);
      }

      const pairingNotice = `您好，${displayName}！\n为了保障系统安全，初次对话需要管理员授权配对。\n\n您的配对码为：${pairing.code}\n（有效期 10 分钟）\n\n请在 AionUi 桌面端「设置 → 渠道 → 企业微信」中批准该请求后即可开始对话。`;
      const safeNotices = safeChunkText(pairingNotice, 1800);

      await this.client.reply(frame, {
        msgtype: 'text',
        text: { content: safeNotices[0] },
      });
      return;
    }

    // Authorized: route to conversation
    const port = await this.getBackendPort();
    let conversationId = this.userConversations.get(userId);

    if (!conversationId) {
      try {
        const modelPayload =
          this.defaultModel?.id && this.defaultModel?.use_model
            ? {
                provider_id: this.defaultModel.id,
                model: this.defaultModel.use_model,
              }
            : undefined;

        const createRes = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `WeCom: ${displayName}`,
            assistant: this.assistant?.assistant_id || undefined,
            model: modelPayload,
            extra: {
              source: 'wecom',
              channel: 'wecom',
              channelUserId: userId,
            },
          }),
        });

        if (createRes.ok) {
          const createJson = (await createRes.json()) as { data?: { id: string }; id?: string };
          conversationId = createJson.data?.id || createJson.id;
          if (conversationId) {
            this.userConversations.set(userId, conversationId);
            await this.savePersistedConfig();
          }
        }
      } catch (err) {
        console.error('[WecomService] Failed to create conversation:', err);
      }
    }

    if (!conversationId) {
      await this.client.reply(frame, {
        msgtype: 'text',
        text: { content: '抱歉，本地会话初始化失败，请稍后重试。' },
      });
      return;
    }

    await this.ensureBackendWs();

    const incomingItem: QueuedUserMessage = {
      frame,
      userText,
      userId,
      displayName,
    };

    // If an active stream is generating for this conversation, enqueue and wait
    if (this.activeStreams.has(conversationId)) {
      console.log(`[WecomService] Conversation ${conversationId} is currently busy, enqueuing message.`);
      let queue = this.conversationQueues.get(conversationId);
      if (!queue) {
        queue = [];
        this.conversationQueues.set(conversationId, queue);
      }
      queue.push(incomingItem);
      return;
    }

    await this.dispatchUserMessage(conversationId, incomingItem);
  }

  public async dispatchUserMessage(conversationId: string, item: QueuedUserMessage): Promise<void> {
    if (!this.client) return;

    const streamId = `wecom-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const streamStartedAt = Date.now();

    // Wall-time timeout: WeCom stream connection caps at 6 minutes; at 5.5 min close stream & continue via text
    const wallTimeoutTimer = setTimeout(() => {
      console.warn(
        `[WecomService] Stream ${streamId} reached ${MAX_STREAM_WALL_TIME_MS}ms wall limit. Transitioning to text mode.`
      );
      const streamContext = this.activeStreams.get(conversationId);
      if (streamContext && streamContext.streamId === streamId && !streamContext.streamFinished) {
        streamContext.streamFinished = true;
        const currentChunks = safeChunkText(streamContext.accumulatedText || '...', 1800);
        void this.client?.replyStream(streamContext.frame, streamId, currentChunks[0], true).catch(() => {});
      }
    }, MAX_STREAM_WALL_TIME_MS);
    wallTimeoutTimer.unref?.();

    const streamContext: ActiveStreamContext = {
      frame: item.frame,
      streamId,
      conversationId,
      accumulatedText: '',
      lastSentText: '',
      streamFinished: false,
      wallTimeoutTimer,
      streamStartedAt,
    };

    // Start idle timer immediately
    this.resetIdleTimeout(streamContext);

    this.activeStreams.set(conversationId, streamContext);

    try {
      const port = await this.getBackendPort();
      const sendRes = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: item.userText,
        }),
      });

      if (sendRes.status === 409) {
        // Backend active_turn conflict: re-enqueue message to front and retry later
        console.warn(`[WecomService] Received 409 active_turn for conversation ${conversationId}, requeuing message.`);
        if (streamContext.idleTimeoutTimer) clearTimeout(streamContext.idleTimeoutTimer);
        if (streamContext.wallTimeoutTimer) clearTimeout(streamContext.wallTimeoutTimer);
        this.activeStreams.delete(conversationId);

        let queue = this.conversationQueues.get(conversationId);
        if (!queue) {
          queue = [];
          this.conversationQueues.set(conversationId, queue);
        }
        item.retryCount = (item.retryCount || 0) + 1;
        queue.unshift(item);

        // Schedule delayed retry to wait for previous turn to clear
        setTimeout(() => {
          this.processNextQueuedMessage(conversationId);
        }, 1500);
        return;
      }

      if (!sendRes.ok) {
        throw new Error(`HTTP error ${sendRes.status}: ${sendRes.statusText}`);
      }

      const sendJson = (await sendRes.json()) as {
        turn_id?: string;
        msg_id?: string;
        data?: { turn_id?: string; msg_id?: string };
      };
      const turnId = sendJson.turn_id || sendJson.data?.turn_id;
      const msgId = sendJson.msg_id || sendJson.data?.msg_id;
      if (turnId) {
        streamContext.assignedTurnId = turnId;
      }
      if (msgId) {
        streamContext.assignedMsgId = msgId;
      }
    } catch (err) {
      console.error('[WecomService] Failed to send message to conversation:', err);
      if (streamContext.idleTimeoutTimer) clearTimeout(streamContext.idleTimeoutTimer);
      if (streamContext.wallTimeoutTimer) clearTimeout(streamContext.wallTimeoutTimer);
      this.activeStreams.delete(conversationId);

      await this.client.reply(item.frame, {
        msgtype: 'text',
        text: { content: '发送消息到本地助手失败，请检查 AionUi 状态。' },
      });
      this.processNextQueuedMessage(conversationId);
    }
  }

  // Pairing management
  public getPendingPairings(): IChannelPairingRequest[] {
    const now = Date.now();
    this.pendingPairings = this.pendingPairings.filter((p) => p.expiresAt > now);
    return [...this.pendingPairings];
  }

  public async approvePairing(code: string): Promise<void> {
    const pairing = this.pendingPairings.find((p) => p.code === code);
    if (!pairing) {
      throw new Error(`Pairing request ${code} not found or expired`);
    }

    const newUser: IChannelUser = {
      id: `wecom-${pairing.platformUserId}`,
      platformUserId: pairing.platformUserId,
      platformType: 'wecom',
      display_name: pairing.display_name,
      authorizedAt: Date.now(),
    };

    this.authorizedUsers = [
      newUser,
      ...this.authorizedUsers.filter((u) => u.platformUserId !== pairing.platformUserId),
    ];
    this.pendingPairings = this.pendingPairings.filter((p) => p.code !== code);
    await this.savePersistedConfig();
    ipcBridge.channel.userAuthorized.emit(newUser);
    this.broadcastStatus();
  }

  public async rejectPairing(code: string): Promise<void> {
    this.pendingPairings = this.pendingPairings.filter((p) => p.code !== code);
    await this.savePersistedConfig();
  }

  // User management
  public getAuthorizedUsers(): IChannelUser[] {
    return [...this.authorizedUsers];
  }

  public async revokeUser(userId: string): Promise<void> {
    this.authorizedUsers = this.authorizedUsers.filter((u) => u.id !== userId && u.platformUserId !== userId);
    this.userConversations.delete(userId);
    const cleanId = userId.startsWith('wecom-') ? userId.replace('wecom-', '') : userId;
    this.userConversations.delete(cleanId);
    await this.savePersistedConfig();
    this.broadcastStatus();
  }

  // Settings
  public getSettings(): IChannelPlatformSettings {
    return {
      platform: 'wecom',
      assistant: this.assistant,
      default_model: this.defaultModel,
    };
  }

  public async setAssistant(assistant: IChannelAssistantBindingWrite): Promise<void> {
    this.assistant = {
      assistant_id: assistant.assistant_id,
    };
    await this.savePersistedConfig();
  }

  public async setDefaultModel(model: IChannelDefaultModelSetting): Promise<void> {
    this.defaultModel = model;
    await this.savePersistedConfig();
  }
}

export const wecomService = new WecomService();
