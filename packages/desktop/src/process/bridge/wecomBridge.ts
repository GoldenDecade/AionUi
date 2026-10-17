/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { wecomService } from '../services/channel/wecomService';
import { wecomBridgeProviders } from '@/common/adapter/wecomBridgeTypes';

export function initWecomBridge(): void {
  wecomBridgeProviders.getStatus.provider(async () => wecomService.getStatus());
  wecomBridgeProviders.enable.provider(async ({ botId, secret }) => wecomService.start(botId, secret));
  wecomBridgeProviders.disable.provider(async () => wecomService.stop());
  wecomBridgeProviders.getSettings.provider(async () => wecomService.getSettings());
  wecomBridgeProviders.setAssistant.provider(async (assistant) => wecomService.setAssistant(assistant));
  wecomBridgeProviders.setDefaultModel.provider(async (model) => wecomService.setDefaultModel(model));
  wecomBridgeProviders.getPairings.provider(async () => wecomService.getPendingPairings());
  wecomBridgeProviders.approvePairing.provider(async ({ code }) => wecomService.approvePairing(code));
  wecomBridgeProviders.rejectPairing.provider(async ({ code }) => wecomService.rejectPairing(code));
  wecomBridgeProviders.getUsers.provider(async () => wecomService.getAuthorizedUsers());
  wecomBridgeProviders.revokeUser.provider(async ({ user_id }) => wecomService.revokeUser(user_id));
}
