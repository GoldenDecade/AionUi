/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testDir = '';
let encryptionAvailable = true;

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => testDir),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => encryptionAvailable),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`, 'utf-8')),
    decryptString: vi.fn((cipher: Buffer) => {
      const str = cipher.toString('utf-8');
      if (str.startsWith('enc:')) return str.slice(4);
      return str;
    }),
  },
}));

import {
  clearDesktopToken,
  hasDesktopToken,
  readDesktopToken,
  saveDesktopToken,
} from '@/process/services/auth/credentialStorage';

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-auth-test-'));
  encryptionAvailable = true;
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('credentialStorage', () => {
  it('encrypts and persists token when safeStorage encryption is available', () => {
    saveDesktopToken('test-secret-token-123');
    expect(hasDesktopToken()).toBe(true);

    const token = readDesktopToken();
    expect(token).toBe('test-secret-token-123');
  });

  it('falls back to plain buffer when safeStorage is not available', () => {
    encryptionAvailable = false;
    saveDesktopToken('fallback-token-456');
    expect(hasDesktopToken()).toBe(true);

    const token = readDesktopToken();
    expect(token).toBe('fallback-token-456');
  });

  it('returns null when no token file exists', () => {
    expect(readDesktopToken()).toBeNull();
    expect(hasDesktopToken()).toBe(false);
  });

  it('removes token file cleanly on clearDesktopToken', () => {
    saveDesktopToken('token-to-delete');
    expect(hasDesktopToken()).toBe(true);

    clearDesktopToken();
    expect(hasDesktopToken()).toBe(false);
    expect(readDesktopToken()).toBeNull();
  });
});
