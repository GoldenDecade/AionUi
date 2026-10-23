/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN_FILE_NAME = 'jdcloud_auth.enc';

export function getAuthStoragePath(): string {
  try {
    const userData = app?.getPath ? app.getPath('userData') : path.join(os.tmpdir(), 'aionui-userdata');
    return path.join(userData, TOKEN_FILE_NAME);
  } catch {
    return path.join(os.tmpdir(), 'aionui-userdata', TOKEN_FILE_NAME);
  }
}

/**
 * Encrypt and persist the JDCloud desktop token using OS keychain / DPAPI.
 */
export function saveDesktopToken(token: string): void {
  const filePath = getAuthStoragePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (safeStorage?.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token);
    fs.writeFileSync(filePath, encrypted);
  } else {
    // Fallback for environments without OS keychain (e.g. CI, headless)
    fs.writeFileSync(filePath, Buffer.from(token, 'utf-8'));
  }
}

/**
 * Decrypt and retrieve the stored JDCloud desktop token.
 */
export function readDesktopToken(): string | null {
  try {
    const filePath = getAuthStoragePath();
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    if (safeStorage?.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buffer);
    }
    return buffer.toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Remove the stored desktop token file on logout or auth invalidation.
 */
export function clearDesktopToken(): void {
  try {
    const filePath = getAuthStoragePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup error
  }
}

/**
 * Check if a stored desktop token exists.
 */
export function hasDesktopToken(): boolean {
  try {
    const filePath = getAuthStoragePath();
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
