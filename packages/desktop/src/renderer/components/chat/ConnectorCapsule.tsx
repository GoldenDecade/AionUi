/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Popover, Switch, Tag } from '@arco-design/web-react';
import { Mail } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ipcBridge } from '@/common';

export type ConnectorCapsuleProps = {
  conversation_id?: string;
};

// In-memory session enablement map
const sessionEnabledCache = new Map<string, boolean>();

const ConnectorCapsule: React.FC<ConnectorCapsuleProps> = ({ conversation_id }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<string | undefined>();
  const [enabled, setEnabled] = useState(true);

  // Sync enablement state for this conversation
  useEffect(() => {
    if (conversation_id) {
      const cached = sessionEnabledCache.get(conversation_id);
      setEnabled(cached !== undefined ? cached : true);
    }
  }, [conversation_id]);

  const fetchStatus = useCallback(async () => {
    try {
      const list = await ipcBridge.connectors.list.invoke();
      const qq = list?.find((c) => c.service === 'qq_mail');
      if (qq && qq.status === 'connected') {
        setConnected(true);
        setAccount(qq.connectedAccount);
      } else {
        setConnected(false);
        setAccount(undefined);
      }
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();

    const unsubscribe = ipcBridge.connectors.statusChanged.on(() => {
      void fetchStatus();
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [fetchStatus]);

  const handleToggle = (checked: boolean) => {
    setEnabled(checked);
    if (conversation_id) {
      sessionEnabledCache.set(conversation_id, checked);
    }
  };

  if (!connected) {
    return null;
  }

  const popoverContent = (
    <div className='w-240px flex flex-col gap-8px p-2px' data-testid='connector-capsule-popover'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-6px'>
          <Mail theme='outline' size='16' className='text-primary-6' />
          <span className='font-600 text-13px text-t-primary'>QQ 邮箱</span>
        </div>
        <Tag color='green' size='small'>
          {t('settings.connectorsConfig.statusConnected')}
        </Tag>
      </div>

      {account && (
        <div className='text-12px text-t-secondary truncate' title={account}>
          {t('settings.connectorsConfig.account')}: <span className='font-500 text-t-primary'>{account}</span>
        </div>
      )}

      <div className='pt-8px border-t border-border-1 flex flex-col gap-4px'>
        <div className='flex items-center justify-between'>
          <span className='text-13px font-500 text-t-primary'>{t('conversation.connectors.sessionEnable')}</span>
          <Switch size='small' checked={enabled} onChange={handleToggle} data-testid='switch-session-qq-mail' />
        </div>
        <p className='m-0 text-11px text-t-tertiary leading-normal'>{t('conversation.connectors.sessionEnableTip')}</p>
      </div>

      <div className='pt-6px border-t border-border-1 flex justify-end'>
        <Button
          type='text'
          size='mini'
          onClick={() => navigate('/settings/connectors')}
          data-testid='btn-manage-connectors'
        >
          {t('conversation.connectors.manageConnectors')}
        </Button>
      </div>
    </div>
  );

  return (
    <Popover content={popoverContent} trigger='click' position='top'>
      <span
        data-testid='connector-capsule-qq-mail'
        className={`inline-flex items-center gap-6px rounded-full px-10px py-2px text-12px font-500 cursor-pointer select-none transition-all border ${
          enabled
            ? 'bg-primary-1 border-primary-2 text-primary-6 hover:bg-primary-2'
            : 'bg-fill-2 border-border-2 text-t-tertiary hover:bg-fill-3'
        }`}
      >
        <span className={`size-6px rounded-full ${enabled ? 'bg-success-6 animate-pulse' : 'bg-fill-4'}`} />
        <span>🔌 {enabled ? t('conversation.connectors.qqMailReady') : t('conversation.connectors.qqMailPaused')}</span>
      </span>
    </Popover>
  );
};

export default ConnectorCapsule;
