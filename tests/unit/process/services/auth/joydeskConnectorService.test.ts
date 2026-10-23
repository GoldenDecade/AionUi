/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusChangedEmitMock = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    connectors: {
      list: { provider: vi.fn() },
      submitQQMail: { provider: vi.fn() },
      testQQMail: { provider: vi.fn() },
      disconnect: { provider: vi.fn() },
      getRuntimeToken: { provider: vi.fn() },
      statusChanged: { emit: (...args: unknown[]) => statusChangedEmitMock(...args) },
    },
  },
}));

import {
  ANTI_PENETRATION_SENTINEL_ID,
  buildStrictAllowedConnections,
  clearManagedConnections,
  disconnectConnector,
  getNamespacedConnectionName,
  getTenantRuntimeToken,
  listConnectors,
  submitQQMailConfig,
  testQQMailConfig,
  validateQQMailCredentials,
} from '@/process/services/auth/joydeskConnectorService';

beforeEach(() => {
  clearManagedConnections();
  statusChangedEmitMock.mockClear();
});

describe('joydeskConnectorService', () => {
  describe('Anti-Penetration Sentinel (防穿透哨兵防御机制)', () => {
    it('MUST inject sentinel ID when tenant has NO active connections to prevent OpenConnector allow-all bypass', () => {
      // OpenConnector flaw: allowedConnections.length === 0 results in evaluateConnection returning allowed: true for ALL connections!
      const emptyResult = buildStrictAllowedConnections([]);
      expect(emptyResult).toHaveLength(1);
      expect(emptyResult[0]).toBe(ANTI_PENETRATION_SENTINEL_ID);
      expect(emptyResult[0]).toBe('conn_void_anti_penetration_sentinel_00000000');

      // Null or undefined should also fail closed to the sentinel
      expect(buildStrictAllowedConnections(null as unknown as string[])).toEqual([ANTI_PENETRATION_SENTINEL_ID]);
      expect(buildStrictAllowedConnections(['', '   '])).toEqual([ANTI_PENETRATION_SENTINEL_ID]);
    });

    it('returns exact tenant connection IDs without sentinel when connections exist', () => {
      const realConnections = ['conn_uuid_aaa', 'conn_uuid_bbb'];
      const result = buildStrictAllowedConnections(realConnections);
      expect(result).toEqual(['conn_uuid_aaa', 'conn_uuid_bbb']);
      expect(result).not.toContain(ANTI_PENETRATION_SENTINEL_ID);
    });
  });

  describe('Multi-tenant Namespacing (连接 ID 强制隔离)', () => {
    it('enforces physical isolation format conn_jd_${pin}_${service}', () => {
      const name1 = getNamespacedConnectionName('wangqiang506', 'qq_mail');
      expect(name1).toBe('conn_jd_wangqiang506_qq_mail');

      const name2 = getNamespacedConnectionName('tenant_user_2', 'github');
      expect(name2).toBe('conn_jd_tenant_user_2_github');

      const nameWithAlias = getNamespacedConnectionName('wangqiang506', 'qq_mail', 'work');
      expect(nameWithAlias).toBe('conn_jd_wangqiang506_qq_mail_work');
    });

    it('sanitizes unsafe characters in pin or service', () => {
      const sanitized = getNamespacedConnectionName('user@jd.com', 'qq_mail/special');
      expect(sanitized).toBe('conn_jd_userjdcom_qq_mailspecial');
    });
  });

  describe('QQ Mail Credentials Validation & Custody (凭据代管与校验)', () => {
    it('validates QQ mail address and 16-character authorization code', () => {
      expect(validateQQMailCredentials({ email: '', authorizationCode: '' }).valid).toBe(false);
      expect(validateQQMailCredentials({ email: 'test@gmail.com', authorizationCode: '1234567812345678' }).valid).toBe(
        false
      );
      expect(validateQQMailCredentials({ email: 'test@qq.com', authorizationCode: 'short' }).valid).toBe(false);
      expect(validateQQMailCredentials({ email: 'test@qq.com', authorizationCode: 'abcdefghijklmnop' }).valid).toBe(
        true
      );
    });

    it('tests QQ mail credentials format', async () => {
      const badRes = await testQQMailConfig({ email: 'bad-email', authorizationCode: 'short' });
      expect(badRes.success).toBe(false);

      const goodRes = await testQQMailConfig({
        email: 'user123@qq.com',
        authorizationCode: 'abcdefghijklmnop',
      });
      expect(goodRes.success).toBe(true);
    });

    it('submits and stores namespaced connection and emits statusChanged event', async () => {
      const res = await submitQQMailConfig(
        { email: 'developer@qq.com', authorizationCode: '1234567812345678' },
        'wangqiang506'
      );

      expect(res.success).toBe(true);
      expect(res.connectionId).toBeDefined();

      expect(statusChangedEmitMock).toHaveBeenCalledWith({
        service: 'qq_mail',
        status: 'connected',
      });

      const connectors = await listConnectors('wangqiang506');
      const qq = connectors.find((c) => c.service === 'qq_mail');
      expect(qq?.status).toBe('connected');
      expect(qq?.connectedAccount).toBe('developer@qq.com');
    });

    it('disconnects connector cleanly', async () => {
      await submitQQMailConfig({ email: 'developer@qq.com', authorizationCode: '1234567812345678' }, 'wangqiang506');

      const discRes = await disconnectConnector('qq_mail', 'wangqiang506');
      expect(discRes.success).toBe(true);

      expect(statusChangedEmitMock).toHaveBeenCalledWith({
        service: 'qq_mail',
        status: 'disconnected',
      });

      const connectors = await listConnectors('wangqiang506');
      const qq = connectors.find((c) => c.service === 'qq_mail');
      expect(qq?.status).toBe('disconnected');
    });
  });

  describe('Scoped Runtime Token Issuance (受限 Runtime Token 签发)', () => {
    it('issues token containing anti-penetration sentinel when tenant has no active connections', async () => {
      const res = await getTenantRuntimeToken('empty_user', 'seat_001');

      expect(res.token).toMatch(/^oct_rt_[a-f0-9]{32}$/);
      expect(res.serverUrl).toContain('/mcp');
      // Sentinel MUST be present to fail closed
      expect(res.allowedConnections).toEqual([ANTI_PENETRATION_SENTINEL_ID]);
    });

    it('issues token containing active tenant connection IDs when connections are active', async () => {
      const subRes = await submitQQMailConfig(
        { email: 'active@qq.com', authorizationCode: '1234567812345678' },
        'active_user'
      );

      const res = await getTenantRuntimeToken('active_user', 'seat_002');
      expect(res.token).toBeDefined();
      expect(res.allowedConnections).toEqual([subRes.connectionId]);
      expect(res.allowedConnections).not.toContain(ANTI_PENETRATION_SENTINEL_ID);
    });
  });
});
