/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getPlatformServices, getDevAppName } from '@/common/platform';

/**
 * Returns baseName unchanged in release builds, or baseName + '-dev' (with instance suffix) in dev builds.
 * Used to isolate symlink and directory names between environments.
 *
 * @example
 * getEnvAwareName('.aionui')        // release → '.aionui',        dev → '.aionui-dev'
 * getEnvAwareName('.aionui-config') // release → '.aionui-config', dev → '.aionui-config-dev'
 * // with AIONUI_MULTI_INSTANCE=1:  dev → '.aionui-dev-2'
 * // with wt-connector instance:    dev → '.aionui-dev-wt-connector'
 */
export function getEnvAwareName(baseName: string): string {
  if (getPlatformServices().paths.isPackaged() === true) return baseName;
  const devAppName = getDevAppName();
  const suffix = devAppName.replace(/^AionUi/i, '').toLowerCase();
  return `${baseName}${suffix}`;
}
