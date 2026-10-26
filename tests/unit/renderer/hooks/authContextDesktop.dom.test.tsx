/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/renderer/hooks/context/AuthContext';

let statusChangeCallback:
  | ((payload: { authenticated: boolean; user?: { pin: string; role?: string } }) => void)
  | null = null;
const mockCheckStatus = vi.fn();
const mockOpenLogin = vi.fn();
const mockLogout = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    auth: {
      checkStatus: {
        invoke: () => mockCheckStatus(),
      },
      openLogin: {
        invoke: () => mockOpenLogin(),
      },
      logout: {
        invoke: () => mockLogout(),
      },
      statusChanged: {
        on: (cb: (payload: { authenticated: boolean; user?: { pin: string; role?: string } }) => void) => {
          statusChangeCallback = cb;
          return () => {
            statusChangeCallback = null;
          };
        },
      },
    },
  },
}));

function ConsumerComponent() {
  const { status, ready, isDesktop, isJDCloudAuthenticated, jdCloudUser, user, logout } = useAuth();
  return (
    <div>
      <span data-testid='status'>{status}</span>
      <span data-testid='ready'>{String(ready)}</span>
      <span data-testid='isDesktop'>{String(isDesktop)}</span>
      <span data-testid='isJDCloudAuthenticated'>{String(isJDCloudAuthenticated)}</span>
      <span data-testid='username'>{user?.username || 'none'}</span>
      <span data-testid='jdPin'>{jdCloudUser?.pin || 'none'}</span>
      <button data-testid='btn-logout' onClick={() => void logout()}>
        Logout
      </button>
    </div>
  );
}

describe('AuthContext in Desktop runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusChangeCallback = null;
    // Simulate desktop runtime with window.electronAPI
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    mockCheckStatus.mockResolvedValue({ authenticated: false });
  });

  it('defaults to authenticated status for desktop users even when not logged in to JDCloud', async () => {
    render(
      <AuthProvider>
        <ConsumerComponent />
      </AuthProvider>
    );

    // Initial render must already be authenticated and ready (no loading flash / no login bounce)
    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    expect(screen.getByTestId('ready').textContent).toBe('true');
    expect(screen.getByTestId('isDesktop').textContent).toBe('true');
    expect(screen.getByTestId('isJDCloudAuthenticated').textContent).toBe('false');
    expect(screen.getByTestId('username').textContent).toBe('none');

    // Wait for checkStatus to complete
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    expect(screen.getByTestId('isJDCloudAuthenticated').textContent).toBe('false');
  });

  it('updates JDCloud user and remains authenticated when statusChanged emits login', async () => {
    render(
      <AuthProvider>
        <ConsumerComponent />
      </AuthProvider>
    );

    expect(statusChangeCallback).not.toBeNull();

    // Settle initial refresh() first
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      statusChangeCallback!({
        authenticated: true,
        user: { pin: 'wangqiang506', role: 'admin' },
      });
    });

    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    expect(screen.getByTestId('isJDCloudAuthenticated').textContent).toBe('true');
    expect(screen.getByTestId('username').textContent).toBe('wangqiang506');
    expect(screen.getByTestId('jdPin').textContent).toBe('wangqiang506');
  });

  it('keeps status as authenticated when logout is executed in desktop runtime', async () => {
    mockLogout.mockResolvedValue(undefined);
    render(
      <AuthProvider>
        <ConsumerComponent />
      </AuthProvider>
    );

    // Settle initial refresh() first
    await act(async () => {
      await Promise.resolve();
    });

    // First login
    await act(async () => {
      statusChangeCallback!({
        authenticated: true,
        user: { pin: 'wangqiang506' },
      });
    });
    expect(screen.getByTestId('isJDCloudAuthenticated').textContent).toBe('true');

    // Then logout
    await act(async () => {
      screen.getByTestId('btn-logout').click();
      await Promise.resolve();
    });

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('isJDCloudAuthenticated').textContent).toBe('false');
    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    expect(screen.getByTestId('username').textContent).toBe('none');
  });
});
