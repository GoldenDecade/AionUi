/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import {
  MessageListProvider,
  useAddOrUpdateMessage,
  useMessageList,
} from '@/renderer/pages/conversation/Messages/hooks';

// Every frame of one turn shares this msg_id (IResponseMessage.msg_id is required, backend logs show a single msg_id per turn).
const TURN = 'e78e6f1b';
const base = { conversation_id: 'conv-1', msg_id: TURN } as const;

const tip = (id: string): TMessage =>
  ({
    ...base,
    id,
    type: 'tips',
    position: 'center',
    content: { content: 'Cache full miss: TtlExpiry', type: 'success' },
  }) as TMessage;

const toolCall = (callId: string): TMessage =>
  ({
    ...base,
    id: callId,
    type: 'tool_call',
    position: 'left',
    content: { call_id: callId, name: 'Write', args: {}, status: 'completed' },
  }) as TMessage;

const finalText = (): TMessage =>
  ({
    ...base,
    id: 'text-1',
    type: 'text',
    position: 'left',
    content: { content: '已经将前半段完整行程全盘融入……' },
  }) as TMessage;

let push: (m: TMessage) => void;
let snapshot: () => TMessage[];

const Probe: React.FC = () => {
  const add = useAddOrUpdateMessage();
  const list = useMessageList();
  push = (m) => add(m);
  snapshot = () => list;
  return <div data-count={list.length} />;
};

const flush = () =>
  act(() => {
    vi.advanceTimersByTime(50);
  });

describe('tips vs final text sharing one msg_id', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not overwrite the final assistant text when a trailing tip shares its msg_id', () => {
    const { rerender } = render(
      <MessageListProvider value={[]}>
        <Probe />
      </MessageListProvider>
    );

    // real order of the failing turn: tip(first request) -> tools -> final text -> tip(end of turn)
    for (const m of [tip('tip-1'), toolCall('c1'), toolCall('c2'), finalText(), tip('tip-2')]) {
      act(() => push(m));
      flush();
    }
    rerender(
      <MessageListProvider value={[]}>
        <Probe />
      </MessageListProvider>
    );

    const types = snapshot().map((m) => m.type);
    expect(types).toEqual(['tips', 'tool_call', 'tool_call', 'text', 'tips']);
  });
});
