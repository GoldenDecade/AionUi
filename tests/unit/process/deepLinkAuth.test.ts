/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const handleAuthCallbackMock = vi.fn();
const deepLinkEmitMock = vi.fn();

vi.mock('@/process/services/auth', () => ({
  handleAuthCallback: (...args: unknown[]) => handleAuthCallbackMock(...args),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    deepLink: {
      received: { emit: (...args: unknown[]) => deepLinkEmitMock(...args) },
    },
  },
}));

import { handleDeepLinkUrl, parseDeepLinkUrl } from '@/process/utils/deepLink';

beforeEach(() => {
  handleAuthCallbackMock.mockClear();
  deepLinkEmitMock.mockClear();
});

describe('deepLink auth/callback', () => {
  it('parses aionui://auth/callback URL correctly', () => {
    const parsed = parseDeepLinkUrl('aionui://auth/callback?code=my-code-123&state=my-state-456');
    expect(parsed).toEqual({
      action: 'auth/callback',
      params: {
        code: 'my-code-123',
        state: 'my-state-456',
      },
    });
  });

  it('intercepts auth/callback in handleDeepLinkUrl and triggers handleAuthCallback', () => {
    handleDeepLinkUrl('aionui://auth/callback?code=test-code&state=test-state');
    expect(handleAuthCallbackMock).toHaveBeenCalledWith({
      code: 'test-code',
      state: 'test-state',
    });
  });
});
