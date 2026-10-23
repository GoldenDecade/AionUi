/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConnectorItem } from '@/common/adapter/ipcBridge';

export type ConnectorCardProps = {
  connector: ConnectorItem;
  onConfigure: (connector: ConnectorItem) => void;
  onDisconnect: (connector: ConnectorItem) => void;
  isDisconnecting?: boolean;
};

export type QQMailConfigModalProps = {
  visible: boolean;
  connector?: ConnectorItem | null;
  onClose: () => void;
  onSuccess: () => void;
};
