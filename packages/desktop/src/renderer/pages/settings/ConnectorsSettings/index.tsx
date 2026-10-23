/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Message, Spin } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { ConnectorItem } from '@/common/adapter/ipcBridge';
import { AionSearchInput } from '@/renderer/components/base';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import SettingsPageHeader from '../components/SettingsPageHeader';
import ConnectorCard from './ConnectorCard';
import QQMailConfigModal from './QQMailConfigModal';

type ConnectorsTab = 'all' | 'connected' | 'available';

const ConnectorsSettings: React.FC = () => {
  const { t } = useTranslation();

  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ConnectorsTab>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [modalVisible, setModalVisible] = useState(false);
  const [activeConnector, setActiveConnector] = useState<ConnectorItem | null>(null);
  const [disconnectingService, setDisconnectingService] = useState<string | null>(null);

  const fetchConnectors = useCallback(async () => {
    try {
      setLoading(true);
      const list = await ipcBridge.connectors.list.invoke();
      setConnectors(list || []);
    } catch (err) {
      console.error('Failed to load connectors:', err);
      Message.error(t('settings.connectorsConfig.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConnectors();

    const unsubscribe = ipcBridge.connectors.statusChanged.on(() => {
      void fetchConnectors();
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [fetchConnectors]);

  const handleConfigure = (connector: ConnectorItem) => {
    if (connector.service === 'qq_mail') {
      setActiveConnector(connector);
      setModalVisible(true);
    }
  };

  const handleDisconnect = async (connector: ConnectorItem) => {
    try {
      setDisconnectingService(connector.service);
      const res = await ipcBridge.connectors.disconnect.invoke({ service: connector.service });
      if (res.success) {
        Message.success(res.message || t('settings.connectorsConfig.disconnectSuccess'));
        await fetchConnectors();
      } else {
        Message.error(res.message || t('settings.connectorsConfig.disconnectFailed'));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.connectorsConfig.disconnectFailed');
      Message.error(msg);
    } finally {
      setDisconnectingService(null);
    }
  };

  const filteredConnectors = useMemo(() => {
    return connectors.filter((item) => {
      // Tab filter
      if (activeTab === 'connected' && item.status !== 'connected') {
        return false;
      }
      if (activeTab === 'available' && item.status === 'connected') {
        return false;
      }

      // Search query filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesName = item.displayName.toLowerCase().includes(query);
        const matchesDesc = item.description.toLowerCase().includes(query);
        const matchesService = item.service.toLowerCase().includes(query);
        const matchesAccount = item.connectedAccount?.toLowerCase().includes(query);
        return matchesName || matchesDesc || matchesService || matchesAccount;
      }

      return true;
    });
  }, [connectors, activeTab, searchQuery]);

  const connectedCount = useMemo(() => {
    return connectors.filter((c) => c.status === 'connected').length;
  }, [connectors]);

  const availableCount = useMemo(() => {
    return connectors.filter((c) => c.status !== 'connected').length;
  }, [connectors]);

  return (
    <SettingsPageWrapper contentClassName='max-w-1200px'>
      <div className='flex flex-col gap-16px' data-testid='connectors-settings-page'>
        <SettingsPageHeader
          data-testid='connectors-header'
          title={t('settings.connectorsConfig.title')}
          description={t('settings.connectorsConfig.description')}
          tabs={[
            {
              key: 'all',
              label: t('settings.connectorsTab.all'),
              count: connectors.length,
            },
            {
              key: 'connected',
              label: t('settings.connectorsTab.connected'),
              count: connectedCount,
            },
            {
              key: 'available',
              label: t('settings.connectorsTab.available'),
              count: availableCount,
            },
          ]}
          activeTab={activeTab}
          onTabChange={(key) => setActiveTab(key as ConnectorsTab)}
          actions={
            <div className='flex items-center gap-8px'>
              <AionSearchInput
                placeholder={t('settings.connectorsConfig.searchPlaceholder')}
                value={searchQuery}
                onChange={setSearchQuery}
                data-testid='input-search-connectors'
              />
              <Button
                type='text'
                icon={<Refresh />}
                onClick={() => void fetchConnectors()}
                data-testid='btn-refresh-connectors'
              />
            </div>
          }
        />

        <Spin loading={loading} className='w-full'>
          {filteredConnectors.length > 0 ? (
            <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-16px'>
              {filteredConnectors.map((connector) => (
                <ConnectorCard
                  key={connector.service}
                  connector={connector}
                  onConfigure={handleConfigure}
                  onDisconnect={handleDisconnect}
                  isDisconnecting={disconnectingService === connector.service}
                />
              ))}
            </div>
          ) : (
            <div
              className='text-center text-t-secondary text-13px py-48px bg-fill-1 rounded-12px border border-border-2 border-dashed'
              data-testid='empty-connectors-view'
            >
              {t('settings.connectorsConfig.noConnectors')}
            </div>
          )}
        </Spin>

        <QQMailConfigModal
          visible={modalVisible}
          connector={activeConnector}
          onClose={() => {
            setModalVisible(false);
            setActiveConnector(null);
          }}
          onSuccess={() => {
            void fetchConnectors();
          }}
        />
      </div>
    </SettingsPageWrapper>
  );
};

export default ConnectorsSettings;
