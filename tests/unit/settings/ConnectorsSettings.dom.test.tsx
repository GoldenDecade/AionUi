/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConnectorItem } from '@/common/adapter/ipcBridge';

const {
  listMock,
  submitQQMailMock,
  testQQMailMock,
  disconnectMock,
  statusChangedOnMock,
  messageSuccessMock,
  messageErrorMock,
  messageWarningMock,
} = vi.hoisted(() => ({
  listMock: vi.fn(),
  submitQQMailMock: vi.fn(),
  testQQMailMock: vi.fn(),
  disconnectMock: vi.fn(),
  statusChangedOnMock: vi.fn(() => vi.fn()),
  messageSuccessMock: vi.fn(),
  messageErrorMock: vi.fn(),
  messageWarningMock: vi.fn(),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: {
      ...actual.Message,
      info: vi.fn(),
      success: messageSuccessMock,
      error: messageErrorMock,
      warning: messageWarningMock,
    },
  };
});

vi.mock('@/common/adapter/ipcBridge', () => ({
  connectors: {
    list: { invoke: listMock },
    submitQQMail: { invoke: submitQQMailMock },
    testQQMail: { invoke: testQQMailMock },
    disconnect: { invoke: disconnectMock },
    statusChanged: { on: statusChangedOnMock },
  },
}));

const stableT = (key: string, opts?: { name?: string; defaultValue?: string }) => {
  if (opts?.name) {
    return `${key}:${opts.name}`;
  }
  return key;
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: stableT,
  }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  resolveExtensionAssetUrl: (url: string) => url,
}));

vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({
  useExtensionSettingsTabs: () => [],
}));

vi.mock('@/renderer/hooks/system/useExtI18n', () => ({
  useExtI18n: () => ({ resolveExtTabName: () => '' }),
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid='settings-page-wrapper'>{children}</div>,
}));

import ConnectorsSettings from '@/renderer/pages/settings/ConnectorsSettings';

const mockConnectors: ConnectorItem[] = [
  {
    service: 'qq_mail',
    displayName: 'QQ 邮箱 (QQ Mail)',
    description: '通过 IMAP/SMTP 协议收发与检索邮件，支持读取文件夹、下载附件与标记已读。',
    status: 'disconnected',
    authType: 'custom_credential',
  },
  {
    service: 'github',
    displayName: 'GitHub',
    description: '代码仓库、Issue、Pull Request 与 Release 管理。',
    status: 'disconnected',
    authType: 'oauth2',
  },
  {
    service: 'feishu',
    displayName: '飞书 (Feishu)',
    description: '飞书多维表格、即时消息与文档协作。',
    status: 'disconnected',
    authType: 'oauth2',
  },
];

describe('ConnectorsSettings UI', () => {
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
    listMock.mockResolvedValue([...mockConnectors]);
    submitQQMailMock.mockResolvedValue({ success: true, message: 'QQ 邮箱已连接' });
    testQQMailMock.mockResolvedValue({ success: true, message: '凭据校验通过' });
    disconnectMock.mockResolvedValue({ success: true, message: '连接已断开' });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders header, tabs, and all connector cards on mount', async () => {
    render(<ConnectorsSettings />);

    expect(screen.getByTestId('connectors-header')).toBeDefined();

    await waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByTestId('connector-card-qq_mail')).toBeDefined();
    expect(screen.getByTestId('connector-card-github')).toBeDefined();
    expect(screen.getByTestId('connector-card-feishu')).toBeDefined();

    expect(screen.getByTestId('btn-configure-qq_mail')).toBeDefined();
    expect(screen.getByTestId('btn-disabled-github')).toBeDefined();
    expect(screen.getByTestId('btn-disabled-feishu')).toBeDefined();
  });

  it('opens QQ Mail config modal when clicking configure', async () => {
    render(<ConnectorsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-configure-qq_mail')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('btn-configure-qq_mail'));

    await waitFor(() => {
      expect(screen.getByTestId('input-qq-mail-email')).toBeDefined();
      expect(screen.getByTestId('input-qq-mail-auth-code')).toBeDefined();
      expect(screen.getByTestId('btn-test-qq-mail')).toBeDefined();
      expect(screen.getByTestId('btn-save-qq-mail')).toBeDefined();
    });
  });

  it('invokes testQQMail IPC when clicking test connection with valid credentials', async () => {
    render(<ConnectorsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-configure-qq_mail')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('btn-configure-qq_mail'));

    const emailInput = await screen.findByTestId('input-qq-mail-email');
    const authCodeInput = await screen.findByTestId('input-qq-mail-auth-code');

    fireEvent.change(emailInput, { target: { value: 'test@qq.com' } });
    fireEvent.change(authCodeInput, { target: { value: '12345678abcdefgh' } });

    fireEvent.click(screen.getByTestId('btn-test-qq-mail'));

    await waitFor(() => {
      expect(testQQMailMock).toHaveBeenCalledWith({
        email: 'test@qq.com',
        authorizationCode: '12345678abcdefgh',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-result-alert')).toBeDefined();
    });
    expect(messageSuccessMock).toHaveBeenCalled();
  });

  it('submits QQ Mail config, updates state, and closes modal', async () => {
    render(<ConnectorsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-configure-qq_mail')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('btn-configure-qq_mail'));

    const emailInput = await screen.findByTestId('input-qq-mail-email');
    const authCodeInput = await screen.findByTestId('input-qq-mail-auth-code');

    fireEvent.change(emailInput, { target: { value: 'developer@qq.com' } });
    fireEvent.change(authCodeInput, { target: { value: 'abcdefghijklmnop' } });

    fireEvent.click(screen.getByTestId('btn-save-qq-mail'));

    await waitFor(() => {
      expect(submitQQMailMock).toHaveBeenCalledWith({
        email: 'developer@qq.com',
        authorizationCode: 'abcdefghijklmnop',
      });
    });

    // Modal closes and list is reloaded
    await waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
    expect(messageSuccessMock).toHaveBeenCalled();
  });

  it('renders connected account and reconfigure/disconnect actions when connected', async () => {
    listMock.mockResolvedValue([
      {
        ...mockConnectors[0],
        status: 'connected',
        connectedAccount: 'admin@qq.com',
      },
      mockConnectors[1],
      mockConnectors[2],
    ]);

    render(<ConnectorsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('connected-account-qq_mail')).toBeDefined();
    });

    expect(screen.getByText('admin@qq.com')).toBeDefined();
    expect(screen.getByTestId('btn-reconfigure-qq_mail')).toBeDefined();
    expect(screen.getByTestId('btn-disconnect-qq_mail')).toBeDefined();
  });

  it('filters connectors by search query', async () => {
    render(<ConnectorsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('connector-card-qq_mail')).toBeDefined();
    });

    const searchInput = screen.getByTestId('input-search-connectors');
    fireEvent.change(searchInput, { target: { value: 'github' } });

    await waitFor(() => {
      expect(screen.queryByTestId('connector-card-qq_mail')).toBeNull();
      expect(screen.getByTestId('connector-card-github')).toBeDefined();
    });
  });

  it('subscribes to statusChanged IPC event on mount', async () => {
    render(<ConnectorsSettings />);

    expect(statusChangedOnMock).toHaveBeenCalledTimes(1);
  });
});
