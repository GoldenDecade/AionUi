/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import QQMailToolCallCard, { isQQMailTool } from '@/renderer/pages/conversation/Messages/components/QQMailToolCallCard';
import MessageToolCall from '@/renderer/pages/conversation/Messages/components/MessageToolCall';
import type { IMessageToolCall } from '@/common/chat/chatLib';

describe('QQMailToolCallCard UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('correctly detects QQ Mail tool names via isQQMailTool', () => {
    expect(isQQMailTool('qq_mail__list_messages')).toBe(true);
    expect(isQQMailTool('qq_mail__send_message')).toBe(true);
    expect(isQQMailTool('qqmail_search')).toBe(true);
    expect(isQQMailTool('mcp__qq_mail__get')).toBe(true);
    expect(isQQMailTool('read_file')).toBe(false);
    expect(isQQMailTool('execute_command')).toBe(false);
    expect(isQQMailTool('')).toBe(false);
  });

  it('renders running status with spinner and animation', () => {
    render(<QQMailToolCallCard name='qq_mail__list_messages' status='running' input='{"limit": 10}' />);

    expect(screen.getByTestId('qq-mail-tool-call-card')).toBeDefined();
    expect(screen.getByText('QQ 邮箱')).toBeDefined();
    expect(screen.getByText('获取邮件列表')).toBeDefined();
    expect(screen.getByTestId('tool-status-running')).toBeDefined();
  });

  it('renders completed status with checkmark', () => {
    render(
      <QQMailToolCallCard
        name='qq_mail__send_message'
        status='completed'
        input='{"to": "user@test.com"}'
        output='{"success": true}'
      />
    );

    expect(screen.getByTestId('tool-status-completed')).toBeDefined();
  });

  it('renders error status with error indicator', () => {
    render(<QQMailToolCallCard name='qq_mail__get_message' status='error' output='IMAP authentication failed' />);

    expect(screen.getByTestId('tool-status-error')).toBeDefined();
  });

  it('expands and collapses input and output details on click', () => {
    render(
      <QQMailToolCallCard
        name='qq_mail__search'
        status='completed'
        input='{"query": "invoice"}'
        output='Found 3 messages'
      />
    );

    expect(screen.queryByTestId('qq-mail-tool-detail')).toBeNull();

    // Click header to expand
    fireEvent.click(screen.getByTestId('qq-mail-tool-call-header'));
    expect(screen.getByTestId('qq-mail-tool-detail')).toBeDefined();
    expect(screen.getByText('{"query": "invoice"}')).toBeDefined();
    expect(screen.getByText('Found 3 messages')).toBeDefined();

    // Click again to collapse
    fireEvent.click(screen.getByTestId('qq-mail-tool-call-header'));
    expect(screen.queryByTestId('qq-mail-tool-detail')).toBeNull();
  });

  it('MessageToolCall automatically delegates QQ Mail tools to QQMailToolCallCard', () => {
    const mockMessage: IMessageToolCall = {
      id: 'msg-1',
      conversation_id: 'conv-1',
      type: 'tool_call',
      role: 'assistant',
      created_at: Date.now(),
      content: {
        call_id: 'call-123',
        name: 'qq_mail__send_message',
        status: 'completed',
        input: { to: 'leader@jd.com', subject: 'Report' },
        output: 'Email delivered',
      },
    };

    render(<MessageToolCall message={mockMessage} />);

    expect(screen.getByTestId('qq-mail-tool-call-card')).toBeDefined();
    expect(screen.getByText('QQ 邮箱')).toBeDefined();
    expect(screen.getByText('发送邮件')).toBeDefined();
  });
});
