/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Alert, Badge, Button, Form, Input, Message, Modal, Space } from '@arco-design/web-react';
import { Mail, CheckOne, CloseOne } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { QQMailConfigModalProps } from './types';

const QQMailConfigModal: React.FC<QQMailConfigModalProps> = ({ visible, connector, onClose, onSuccess }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();

  const [email, setEmail] = useState('');
  const [authorizationCode, setAuthorizationCode] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (visible) {
      const initialEmail = connector?.connectedAccount || '';
      setEmail(initialEmail);
      setAuthorizationCode('');
      setTestResult(null);
      form.setFieldsValue({
        email: initialEmail,
        authorizationCode: '',
      });
    }
  }, [visible, connector, form]);

  const validateInputs = (): { valid: boolean; error?: string } => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      return { valid: false, error: t('settings.connectorsConfig.qqMailEmailRequired') };
    }
    const emailRegex = /^[a-zA-Z0-9._%+-]+@qq\.com$/i;
    if (!emailRegex.test(trimmedEmail)) {
      return { valid: false, error: t('settings.connectorsConfig.qqMailEmailInvalid') };
    }
    const trimmedCode = authorizationCode.trim();
    if (!trimmedCode) {
      return { valid: false, error: t('settings.connectorsConfig.qqMailAuthCodeRequired') };
    }
    if (trimmedCode.length < 16) {
      return { valid: false, error: t('settings.connectorsConfig.qqMailAuthCodeInvalid') };
    }
    return { valid: true };
  };

  const handleTestConnection = async () => {
    const validation = validateInputs();
    if (!validation.valid) {
      Message.warning(validation.error || t('settings.connectorsConfig.testFailed'));
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const result = await ipcBridge.connectors.testQQMail.invoke({
        email: email.trim(),
        authorizationCode: authorizationCode.trim(),
      });

      if (result.success) {
        const msg = result.message || t('settings.connectorsConfig.testSuccess');
        setTestResult({ success: true, message: msg });
        Message.success(msg);
      } else {
        const msg = result.message || t('settings.connectorsConfig.testFailed');
        setTestResult({ success: false, message: msg });
        Message.error(msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.connectorsConfig.testFailed');
      setTestResult({ success: false, message: msg });
      Message.error(msg);
    } finally {
      setTesting(false);
    }
  };

  const handleSaveAndConnect = async () => {
    const validation = validateInputs();
    if (!validation.valid) {
      Message.warning(validation.error || t('settings.connectorsConfig.saveFailed'));
      return;
    }

    setSaving(true);

    try {
      const result = await ipcBridge.connectors.submitQQMail.invoke({
        email: email.trim(),
        authorizationCode: authorizationCode.trim(),
      });

      if (result.success) {
        Message.success(result.message || t('settings.connectorsConfig.saveSuccess'));
        onSuccess();
        onClose();
      } else {
        Message.error(result.message || t('settings.connectorsConfig.saveFailed'));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.connectorsConfig.saveFailed');
      Message.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const isConnected = connector?.status === 'connected';

  return (
    <Modal
      title={
        <div className='flex items-center justify-between w-full pr-24px'>
          <div className='flex items-center gap-8px'>
            <Mail theme='outline' size='18' className='text-primary-6' />
            <span className='font-600 text-16px text-t-primary'>{t('settings.connectorsConfig.qqMailModalTitle')}</span>
          </div>
          <Badge
            status={isConnected ? 'success' : 'default'}
            text={
              isConnected
                ? t('settings.connectorsConfig.statusConnected')
                : t('settings.connectorsConfig.statusDisconnected')
            }
          />
        </div>
      }
      visible={visible}
      onCancel={onClose}
      footer={
        <div className='flex items-center justify-between w-full'>
          <Button type='secondary' loading={testing} onClick={handleTestConnection} data-testid='btn-test-qq-mail'>
            {testing ? t('settings.connectorsConfig.testingConnection') : t('settings.connectorsConfig.testConnection')}
          </Button>
          <Space>
            <Button onClick={onClose} data-testid='btn-cancel-qq-mail'>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type='primary' loading={saving} onClick={handleSaveAndConnect} data-testid='btn-save-qq-mail'>
              {saving ? t('settings.connectorsConfig.saving') : t('settings.connectorsConfig.saveAndConnect')}
            </Button>
          </Space>
        </div>
      }
      style={{ width: 520 }}
      mountOnEnter
      unmountOnExit
    >
      <div className='flex flex-col gap-16px py-8px'>
        <Alert
          type='info'
          showIcon
          content={
            <div className='text-12px leading-relaxed text-t-secondary'>
              {t('settings.connectorsConfig.qqMailAuthCodeTip')}
            </div>
          }
        />

        <Form form={form} layout='vertical'>
          <Form.Item
            label={t('settings.connectorsConfig.qqMailEmailLabel')}
            required
            extra={
              <span className='text-12px text-t-tertiary'>{t('settings.connectorsConfig.qqMailEmailPlaceholder')}</span>
            }
          >
            <Input
              value={email}
              placeholder={t('settings.connectorsConfig.qqMailEmailPlaceholder')}
              onChange={(val) => {
                setEmail(val);
                setTestResult(null);
              }}
              allowClear
              data-testid='input-qq-mail-email'
            />
          </Form.Item>

          <Form.Item
            label={t('settings.connectorsConfig.qqMailAuthCodeLabel')}
            required
            extra={
              <span className='text-12px text-t-tertiary'>
                {t('settings.connectorsConfig.qqMailAuthCodePlaceholder')}
              </span>
            }
          >
            <Input.Password
              value={authorizationCode}
              placeholder={t('settings.connectorsConfig.qqMailAuthCodePlaceholder')}
              onChange={(val) => {
                setAuthorizationCode(val);
                setTestResult(null);
              }}
              visibilityToggle
              data-testid='input-qq-mail-auth-code'
            />
          </Form.Item>
        </Form>

        {testResult && (
          <div
            className={`p-10px rounded-8px flex items-center gap-8px text-13px ${
              testResult.success
                ? 'bg-success-1 text-success-6 border border-success-2'
                : 'bg-danger-1 text-danger-6 border border-danger-2'
            }`}
            data-testid='test-result-alert'
          >
            {testResult.success ? <CheckOne theme='filled' size='16' /> : <CloseOne theme='filled' size='16' />}
            <span className='flex-1'>{testResult.message}</span>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default QQMailConfigModal;
