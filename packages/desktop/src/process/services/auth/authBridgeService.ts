/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { shell } from 'electron';
import crypto from 'node:crypto';
import { ipcBridge } from '@/common';
import type { JDCloudAuthStatus, JDCloudUserProfile } from '@/common/adapter/ipcBridge';
import { clearDesktopToken, readDesktopToken, saveDesktopToken } from './credentialStorage';

const JOYDESK_BASE_URL = process.env.AIONUI_JOYDESK_URL || 'https://joydesk.jdcloud.com';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface PendingAuthState {
  value: string;
  expiresAt: number;
}

let pendingState: PendingAuthState | null = null;

export function getPendingState(): PendingAuthState | null {
  return pendingState;
}

export function setPendingState(state: PendingAuthState | null): void {
  pendingState = state;
}

export async function openJDCloudLogin(): Promise<{ success: boolean; state: string }> {
  const state = crypto.randomUUID();
  pendingState = {
    value: state,
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const targetUrl = `${JOYDESK_BASE_URL}/desktop/auth?state=${encodeURIComponent(state)}`;
  await shell.openExternal(targetUrl);
  return { success: true, state };
}

export interface AuthCallbackResult {
  success: boolean;
  user?: JDCloudUserProfile;
  error?: string;
}

export async function handleAuthCallback({
  code,
  state,
}: {
  code: string;
  state: string;
}): Promise<AuthCallbackResult> {
  // 1. Anti-replay & CSRF verification
  if (!pendingState || Date.now() > pendingState.expiresAt || pendingState.value !== state) {
    pendingState = null;
    console.error('[JDCloud Auth] State verification failed: mismatch or expired');
    return { success: false, error: 'state_mismatch_or_expired' };
  }

  // Atomic one-time consumption: immediately invalidate pending state
  pendingState = null;

  // 2. Token exchange with JoyDesk BFF
  try {
    const exchangeUrl = `${JOYDESK_BASE_URL}/api/console/public/desktop/exchange-token`;
    const response = await fetch(exchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });

    if (!response.ok) {
      console.error(`[JDCloud Auth] Exchange failed with HTTP ${response.status}`);
      return { success: false, error: `HTTP ${response.status}` };
    }

    const json = (await response.json()) as {
      code: number;
      message?: string;
      data?: {
        token: string;
        user?: {
          pin: string;
          role?: string;
          enterpriseId?: string;
          seatId?: string;
        };
      };
    };

    if (json.code === 200 && json.data?.token) {
      // 3. Encrypt and persist token
      saveDesktopToken(json.data.token);

      const user: JDCloudUserProfile = {
        pin: json.data.user?.pin || 'unknown',
        role: json.data.user?.role,
        enterpriseId: json.data.user?.enterpriseId,
        seatId: json.data.user?.seatId,
      };

      // 4. Notify renderer via IPC emitter
      ipcBridge.auth.statusChanged.emit({
        authenticated: true,
        user,
      });

      return { success: true, user };
    }

    console.error('[JDCloud Auth] Exchange response error:', json.message);
    return { success: false, error: json.message || 'token_exchange_failed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[JDCloud Auth] Exchange request failed:', message);
    return { success: false, error: message };
  }
}

export async function checkAuthStatus(): Promise<JDCloudAuthStatus> {
  const token = readDesktopToken();
  if (!token) {
    return { authenticated: false };
  }

  try {
    const profileUrl = `${JOYDESK_BASE_URL}/api/console/me/profile`;
    const response = await fetch(profileUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      const json = (await response.json()) as {
        code: number;
        data?: {
          jd_pin?: string;
          role?: string;
          enterprise_id?: string;
          seat_id?: string;
          points?: number;
        };
      };

      if (json.code === 200 && json.data?.jd_pin) {
        return {
          authenticated: true,
          user: {
            pin: json.data.jd_pin,
            role: json.data.role,
            enterpriseId: json.data.enterprise_id,
            seatId: json.data.seat_id,
            points: json.data.points,
          },
        };
      }
    }

    // Auto-healing: Token expired or revoked on server
    if (response.status === 401) {
      console.warn('[JDCloud Auth] Profile probe returned 401: clearing invalid token');
      clearDesktopToken();
      ipcBridge.auth.statusChanged.emit({ authenticated: false });
      return { authenticated: false };
    }
  } catch (err) {
    console.warn('[JDCloud Auth] Profile probe network error:', err);
  }

  return { authenticated: false };
}

export async function logout(): Promise<void> {
  clearDesktopToken();
  pendingState = null;
  ipcBridge.auth.statusChanged.emit({ authenticated: false });
}

export function initAuthBridge(): void {
  ipcBridge.auth.openLogin.provider(async () => {
    return openJDCloudLogin();
  });

  ipcBridge.auth.checkStatus.provider(async () => {
    return checkAuthStatus();
  });

  ipcBridge.auth.logout.provider(async () => {
    return logout();
  });
}
