/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { listMock, statusChangedOnMock, navigateMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  statusChangedOnMock: vi.fn(() => vi.fn()),
  navigateMock: vi.fn(),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  connectors: {
    list: { invoke: listMock },
    statusChanged: { on: statusChangedOnMock },
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import ConnectorCapsule from '@/renderer/components/chat/ConnectorCapsule';

describe('ConnectorCapsule UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when QQ Mail is disconnected', async () => {
    listMock.mockResolvedValue([
      {
        service: 'qq_mail',
        displayName: 'QQ 邮箱',
        status: 'disconnected',
        authType: 'custom_credential',
      },
    ]);

    render(<ConnectorCapsule conversation_id='conv-123' />);

    await waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('connector-capsule-qq-mail')).toBeNull();
  });

  it('renders capsule when QQ Mail is connected', async () => {
    listMock.mockResolvedValue([
      {
        service: 'qq_mail',
        displayName: 'QQ 邮箱',
        status: 'connected',
        authType: 'custom_credential',
        connectedAccount: 'test@qq.com',
      },
    ]);

    render(<ConnectorCapsule conversation_id='conv-123' />);

    await waitFor(() => {
      expect(screen.getByTestId('connector-capsule-qq-mail')).toBeDefined();
    });

    expect(screen.getByText(/conversation\.connectors\.qqMailReady/)).toBeDefined();
  });

  it('opens popover when clicking capsule and allows toggling session enablement', async () => {
    listMock.mockResolvedValue([
      {
        service: 'qq_mail',
        displayName: 'QQ 邮箱',
        status: 'connected',
        authType: 'custom_credential',
        connectedAccount: 'admin@qq.com',
      },
    ]);

    render(<ConnectorCapsule conversation_id='conv-456' />);

    const capsule = await screen.findByTestId('connector-capsule-qq-mail');
    fireEvent.click(capsule);

    await waitFor(() => {
      expect(screen.getByTestId('connector-capsule-popover')).toBeDefined();
    });

    expect(screen.getByText('admin@qq.com')).toBeDefined();

    const toggle = screen.getByTestId('switch-session-qq-mail');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    // Toggle off
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByText(/conversation\.connectors\.qqMailPaused/)).toBeDefined();
    });

    // Manage connectors link
    const manageBtn = screen.getByTestId('btn-manage-connectors');
    fireEvent.click(manageBtn);
    expect(navigateMock).toHaveBeenCalledWith('/settings/connectors');
  });

  it('subscribes to statusChanged IPC event on mount', async () => {
    listMock.mockResolvedValue([]);
    render(<ConnectorCapsule conversation_id='conv-789' />);

    expect(statusChangedOnMock).toHaveBeenCalledTimes(1);
  });
});
