/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge } from '@/common/platform/bridge';
import type {
  IChannelAssistantBindingWrite,
  IChannelDefaultModelSetting,
  IChannelPairingRequest,
  IChannelPlatformSettings,
  IChannelPluginStatus,
  IChannelUser,
} from '@/common/types/channel/channel';

export const wecomBridgeProviders = {
  getStatus: bridge.buildProvider<IChannelPluginStatus, void>('wecom:get-status'),
  enable: bridge.buildProvider<void, { botId: string; secret: string }>('wecom:enable'),
  disable: bridge.buildProvider<void, void>('wecom:disable'),
  getSettings: bridge.buildProvider<IChannelPlatformSettings, void>('wecom:get-settings'),
  setAssistant: bridge.buildProvider<void, IChannelAssistantBindingWrite>('wecom:set-assistant'),
  setDefaultModel: bridge.buildProvider<void, IChannelDefaultModelSetting>('wecom:set-default-model'),
  getPairings: bridge.buildProvider<IChannelPairingRequest[], void>('wecom:get-pairings'),
  approvePairing: bridge.buildProvider<void, { code: string }>('wecom:approve-pairing'),
  rejectPairing: bridge.buildProvider<void, { code: string }>('wecom:reject-pairing'),
  getUsers: bridge.buildProvider<IChannelUser[], void>('wecom:get-users'),
  revokeUser: bridge.buildProvider<void, { user_id: string }>('wecom:revoke-user'),
};
