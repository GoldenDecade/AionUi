/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeChunkText, WecomService } from '@/process/services/channel/wecomService';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    getSync: vi.fn(() => ({})),
    set: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    channel: {
      pluginStatusChanged: { emit: vi.fn() },
      pairingRequested: { emit: vi.fn() },
      userAuthorized: { emit: vi.fn() },
    },
  },
}));

vi.mock('@wecom/aibot-node-sdk', () => ({
  default: {
    WSClient: class MockWSClient {
      connect = vi.fn();
      disconnect = vi.fn();
      on = vi.fn();
      reply = vi.fn(() => Promise.resolve({ errcode: 0 }));
      replyStream = vi.fn(() => Promise.resolve({ errcode: 0 }));
    },
  },
}));

describe('WeCom Channel Service & safeChunkText', () => {
  describe('safeChunkText physical byte splitting', () => {
    it('No-op on Valid: returns identical single string when within byte limit', () => {
      const text = 'Hello WeCom, this is within byte limit!';
      const chunks = safeChunkText(text, 1800);
      expect(chunks).toEqual([text]);
      expect(chunks.length).toBe(1);
    });

    it('returns single string when exactly equal to maxBytes', () => {
      const asciiText = 'A'.repeat(100);
      const chunks = safeChunkText(asciiText, 100);
      expect(chunks).toEqual([asciiText]);
    });

    it('splits text exceeding limit without splitting multi-byte characters', () => {
      const chineseText = '你好世界企业微信智能机器人'; // 13 chars = 39 bytes
      const limit = 15; // exactly 5 chars (15 bytes)
      const chunks = safeChunkText(chineseText, limit);

      // Verify no chunk exceeds maxBytes
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk, 'utf-8')).toBeLessThanOrEqual(limit);
      }
      // Verify lossless concatenation
      expect(chunks.join('')).toBe(chineseText);
    });

    it('handles 4-byte surrogate pairs and emojis without breaking characters', () => {
      const emojiText = '🎉🚀🔥💻🌟🤖';
      const limit = 8; // 2 emojis per chunk (4 bytes each)
      const chunks = safeChunkText(emojiText, limit);

      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk, 'utf-8')).toBeLessThanOrEqual(limit);
      }
      expect(chunks.join('')).toBe(emojiText);
    });
  });

  describe('WecomService Queue & Concurrency Management', () => {
    let service: WecomService;
    let mockClient: any;

    beforeEach(() => {
      vi.clearAllMocks();
      service = new WecomService();
      mockClient = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        reply: vi.fn(() => Promise.resolve({ errcode: 0 })),
        replyStream: vi.fn(() => Promise.resolve({ errcode: 0 })),
      };
      (service as any).client = mockClient;
      vi.spyOn(service, 'getBackendPort').mockResolvedValue(12345);
      vi.spyOn(service, 'ensureBackendWs').mockResolvedValue();
    });

    it('FIFO Queue: enqueues subsequent messages when stream is currently active', async () => {
      const convId = 'conv-test-1';
      // Simulate active stream
      (service as any).activeStreams.set(convId, {
        frame: { headers: { req_id: '1' } },
        streamId: 'stream-1',
        conversationId: convId,
        accumulatedText: 'Thinking...',
        lastSentText: '',
        streamFinished: false,
        streamStartedAt: Date.now(),
      });

      // User sends a second message while first is generating
      const incomingFrame = {
        body: {
          from: { userid: 'user-1', name: 'User 1' },
          msgtype: 'text',
          text: { content: 'Next Question' },
        },
      };

      // Mock user as authorized
      (service as any).authorizedUsers = [{ platformUserId: 'user-1' }];
      (service as any).userConversations.set('user-1', convId);

      await service.handleIncomingMessage(incomingFrame);

      // Verify second message was queued in conversationQueues
      const queue = service.conversationQueues.get(convId);
      expect(queue).toBeDefined();
      expect(queue?.length).toBe(1);
      expect(queue?.[0].userText).toBe('Next Question');
    });

    it('Turn attribution: discards orphaned chunks from previous turn', () => {
      const convId = 'conv-test-2';
      const streamContext: any = {
        frame: { headers: { req_id: '1' } },
        streamId: 'stream-2',
        conversationId: convId,
        assignedTurnId: 'turn-current',
        accumulatedText: 'Initial',
        lastSentText: '',
        streamFinished: false,
        streamStartedAt: Date.now(),
      };
      service.activeStreams.set(convId, streamContext);

      // Chunk from old orphaned turn
      service.handleBackendStreamChunk({
        conversation_id: convId,
        turn_id: 'turn-old-orphaned',
        data: ' SHOULD_NOT_BE_ADDED',
        status: 'generating',
      });

      expect(streamContext.accumulatedText).toBe('Initial');

      // Chunk from valid current turn
      service.handleBackendStreamChunk({
        conversation_id: convId,
        turn_id: 'turn-current',
        data: ' ValidChunk',
        status: 'generating',
      });

      expect(streamContext.accumulatedText).toBe('Initial ValidChunk');
    });

    it('Re-queues message on backend 409 active_turn conflict without dropping message', async () => {
      const convId = 'conv-test-3';
      const item = {
        frame: { headers: { req_id: 'req-409' } },
        userText: 'Hello 409',
        userId: 'user-1',
        displayName: 'User 1',
      };

      // Mock global fetch returning 409
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 409,
        ok: false,
        statusText: 'Conflict',
      } as Response);

      try {
        await service.dispatchUserMessage(convId, item);

        // Verify active stream was cleared so it doesn't block future turns
        expect(service.activeStreams.has(convId)).toBe(false);

        // Verify item was unshifted back into conversationQueues with retryCount incremented
        const queue = service.conversationQueues.get(convId);
        expect(queue).toBeDefined();
        expect(queue?.length).toBe(1);
        expect(queue?.[0].userText).toBe('Hello 409');
        expect(queue?.[0].retryCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('Idle timeout triggers completion when no chunks arrive within IDLE_TIMEOUT_MS', () => {
      vi.useFakeTimers();
      const convId = 'conv-test-timeout';
      const streamContext: any = {
        frame: { headers: { req_id: '1' } },
        streamId: 'stream-timeout',
        conversationId: convId,
        accumulatedText: 'Partial output',
        lastSentText: '',
        streamFinished: false,
        streamStartedAt: Date.now(),
      };
      service.activeStreams.set(convId, streamContext);
      (service as any).resetIdleTimeout(streamContext);

      // Advance time by 90s
      vi.advanceTimersByTime(90_000);

      // Verify stream was terminated and activeStreams cleared
      expect(service.activeStreams.has(convId)).toBe(false);
      expect(mockClient.replyStream).toHaveBeenCalledWith(
        streamContext.frame,
        streamContext.streamId,
        expect.stringContaining('[提示：生成超时，未收到后端响应]'),
        true
      );
      vi.useRealTimers();
    });

    it('Sequential await for overflow chunks in handleStreamTermination', async () => {
      const convId = 'conv-test-overflow';
      const longText = 'A'.repeat(2500); // Exceeds 1800 limit
      const streamContext: any = {
        frame: { headers: { req_id: 'overflow-req' } },
        streamId: 'stream-overflow',
        conversationId: convId,
        accumulatedText: longText,
        lastSentText: '',
        streamFinished: false,
        streamStartedAt: Date.now(),
      };
      service.activeStreams.set(convId, streamContext);

      (service as any).handleStreamTermination(streamContext, longText);

      // Wait tick
      await new Promise((r) => setTimeout(r, 10));

      expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
      expect(mockClient.replyStream).toHaveBeenCalledWith(
        streamContext.frame,
        streamContext.streamId,
        expect.any(String),
        true
      );

      // Subsequent chunk sent via reply
      expect(mockClient.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.reply).toHaveBeenCalledWith(
        streamContext.frame,
        {
          msgtype: 'text',
          text: { content: expect.any(String) },
        }
      );
    });
  });
});
