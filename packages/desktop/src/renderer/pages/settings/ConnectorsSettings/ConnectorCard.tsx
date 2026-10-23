/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Badge, Button, Card, Popconfirm, Space, Tag, Tooltip } from '@arco-design/web-react';
import { Connection, Github, Lark, Mail, SettingTwo } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { ConnectorCardProps } from './types';

const getServiceIcon = (service: string) => {
  switch (service) {
    case 'qq_mail':
      return <Mail theme='outline' size='22' className='text-primary-6' />;
    case 'github':
      return <Github theme='outline' size='22' className='text-t-primary' />;
    case 'feishu':
      return <Lark theme='outline' size='22' className='text-[#00D6B9]' />;
    default:
      return <Connection theme='outline' size='22' className='text-primary-6' />;
  }
};

const ConnectorCard: React.FC<ConnectorCardProps> = ({
  connector,
  onConfigure,
  onDisconnect,
  isDisconnecting = false,
}) => {
  const { t } = useTranslation();

  const isConnected = connector.status === 'connected';

  const getAuthTypeTag = () => {
    switch (connector.authType) {
      case 'custom_credential':
        return (
          <Tag size='small' color='arcoblue'>
            {t('settings.connectorsConfig.authTypeCustom')}
          </Tag>
        );
      case 'oauth2':
        return (
          <Tag size='small' color='purple'>
            {t('settings.connectorsConfig.authTypeOAuth2')}
          </Tag>
        );
      case 'api_key':
        return (
          <Tag size='small' color='gold'>
            {t('settings.connectorsConfig.authTypeApiKey')}
          </Tag>
        );
      default:
        return null;
    }
  };

  const getStatusBadge = () => {
    switch (connector.status) {
      case 'connected':
        return (
          <Badge
            status='success'
            text={t('settings.connectorsConfig.statusConnected')}
            data-testid={`badge-status-${connector.service}`}
          />
        );
      case 'reauth_required':
        return (
          <Badge
            status='warning'
            text={t('settings.connectorsConfig.statusReauthRequired')}
            data-testid={`badge-status-${connector.service}`}
          />
        );
      case 'error':
        return (
          <Badge
            status='error'
            text={t('settings.connectorsConfig.statusError')}
            data-testid={`badge-status-${connector.service}`}
          />
        );
      case 'disconnected':
      default:
        return (
          <Badge
            status='default'
            text={t('settings.connectorsConfig.statusDisconnected')}
            data-testid={`badge-status-${connector.service}`}
          />
        );
    }
  };

  const isConfigurable = connector.service === 'qq_mail';

  return (
    <Card
      data-testid={`connector-card-${connector.service}`}
      className='rounded-12px border border-border-2 bg-2 transition-all hover:shadow-sm flex flex-col justify-between'
      bodyStyle={{ padding: '16px', display: 'flex', flexDirection: 'column', height: '100%', gap: '12px' }}
    >
      {/* Top row: Icon + Title + Status */}
      <div className='flex items-start justify-between gap-12px'>
        <div className='flex items-center gap-12px min-w-0'>
          <div className='size-42px rounded-10px bg-fill-2 flex items-center justify-center shrink-0 border border-border-1'>
            {getServiceIcon(connector.service)}
          </div>
          <div className='min-w-0 flex flex-col gap-2px'>
            <div className='flex items-center gap-8px flex-wrap'>
              <span className='font-600 text-15px text-t-primary truncate' title={connector.displayName}>
                {connector.displayName}
              </span>
              {getAuthTypeTag()}
            </div>
          </div>
        </div>
        <div className='shrink-0 pt-2px'>{getStatusBadge()}</div>
      </div>

      {/* Description */}
      <div className='text-13px text-t-secondary leading-relaxed line-clamp-2 min-h-36px'>{connector.description}</div>

      {/* Connected Account metadata if connected */}
      {isConnected && connector.connectedAccount && (
        <div className='py-6px px-10px rounded-6px bg-fill-1 border border-border-1 flex items-center justify-between text-12px text-t-tertiary'>
          <span className='truncate'>
            {t('settings.connectorsConfig.account')}:{' '}
            <span className='text-t-primary font-500' data-testid={`connected-account-${connector.service}`}>
              {connector.connectedAccount}
            </span>
          </span>
        </div>
      )}

      {/* Footer Actions */}
      <div className='pt-8px border-t border-border-1 flex items-center justify-end gap-8px mt-auto'>
        {isConfigurable ? (
          isConnected ? (
            <Space>
              <Button
                size='small'
                type='secondary'
                icon={<SettingTwo />}
                onClick={() => onConfigure(connector)}
                data-testid={`btn-reconfigure-${connector.service}`}
              >
                {t('settings.connectorsConfig.reconfigure')}
              </Button>
              <Popconfirm
                title={t('settings.connectorsConfig.disconnectConfirmTitle')}
                content={t('settings.connectorsConfig.disconnectConfirmContent', { name: connector.displayName })}
                onOk={() => onDisconnect(connector)}
                okText={t('common.confirm', { defaultValue: 'Confirm' })}
                cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
              >
                <Button
                  size='small'
                  type='text'
                  status='danger'
                  loading={isDisconnecting}
                  data-testid={`btn-disconnect-${connector.service}`}
                >
                  {t('settings.connectorsConfig.disconnect')}
                </Button>
              </Popconfirm>
            </Space>
          ) : (
            <Button
              size='small'
              type='primary'
              onClick={() => onConfigure(connector)}
              data-testid={`btn-configure-${connector.service}`}
            >
              {t('settings.connectorsConfig.configure')}
            </Button>
          )
        ) : (
          <Tooltip content={t('settings.connectorsConfig.comingSoonTip')}>
            <Button size='small' type='secondary' disabled data-testid={`btn-disabled-${connector.service}`}>
              {t('settings.connectorsConfig.comingSoon')}
            </Button>
          </Tooltip>
        )}
      </div>
    </Card>
  );
};

export default ConnectorCard;
