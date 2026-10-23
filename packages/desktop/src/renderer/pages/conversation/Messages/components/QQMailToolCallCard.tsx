/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Alert, Tag } from '@arco-design/web-react';
import { IconDown, IconRight } from '@arco-design/web-react/icon';
import { CheckOne, CloseOne, LoadingOne, Mail } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { NormalizedToolStatus } from '@/common/chat/normalizeToolCall';

export type QQMailToolCallCardProps = {
  name: string;
  status: NormalizedToolStatus;
  input?: string;
  output?: string;
  description?: string;
};

export function isQQMailTool(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return (
    lower.startsWith('qq_mail') ||
    lower.startsWith('qqmail') ||
    lower.includes('__qq_mail') ||
    lower.includes('__qqmail') ||
    lower.includes('qq_mail__') ||
    lower.includes('qqmail__') ||
    lower.includes('qq-mail') ||
    lower.includes('qq邮箱')
  );
}

function getActionLabel(name: string): string {
  const cleanName = name.replace(/^.*?qq_?mail(__|_)?/i, '').toLowerCase();
  switch (cleanName) {
    case 'list_messages':
    case 'list':
      return '获取邮件列表';
    case 'get_message':
    case 'get':
    case 'read':
      return '读取邮件详情';
    case 'send_message':
    case 'send':
      return '发送邮件';
    case 'search':
    case 'search_messages':
      return '搜索邮件';
    case 'list_folders':
      return '获取邮箱文件夹';
    default:
      return cleanName || name;
  }
}

const QQMailToolCallCard: React.FC<QQMailToolCallCardProps> = ({ name, status, input, output, description }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const actionLabel = getActionLabel(name);
  const isRunning = status === 'running';
  const isCompleted = status === 'completed';
  const isError = status === 'error';

  const hasDetail = Boolean(input || output);

  return (
    <div
      data-testid='qq-mail-tool-call-card'
      className='my-6px rounded-10px border border-border-2 bg-fill-1 overflow-hidden transition-all'
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between p-10px select-none ${
          hasDetail ? 'cursor-pointer hover:bg-fill-2' : ''
        }`}
        onClick={hasDetail ? () => setExpanded(!expanded) : undefined}
        data-testid='qq-mail-tool-call-header'
      >
        {/* Left: QQ Mail Logo + Title + Action Tag */}
        <div className='flex items-center gap-8px min-w-0'>
          <div className='size-22px rounded-6px bg-primary-1 border border-primary-2 flex items-center justify-center shrink-0 text-primary-6'>
            <Mail theme='outline' size='14' />
          </div>
          <span className='font-600 text-13px text-t-primary shrink-0'>QQ 邮箱</span>
          <Tag size='small' color='arcoblue' className='shrink-0'>
            {actionLabel}
          </Tag>
          {description && (
            <span className='text-12px text-t-tertiary truncate' title={description}>
              {description}
            </span>
          )}
        </div>

        {/* Right: Status Animation & Expand Chevron */}
        <div className='flex items-center gap-10px shrink-0 pl-8px'>
          {isRunning && (
            <span className='flex items-center gap-4px text-12px text-primary-6' data-testid='tool-status-running'>
              <LoadingOne theme='outline' size='14' className='animate-spin' />
              <span>{t('conversation.connectors.qqMailCalling')}</span>
            </span>
          )}
          {isCompleted && (
            <span className='flex items-center gap-4px text-12px text-success-6' data-testid='tool-status-completed'>
              <CheckOne theme='filled' size='14' />
              <span>{t('conversation.connectors.qqMailSuccess')}</span>
            </span>
          )}
          {isError && (
            <span className='flex items-center gap-4px text-12px text-danger-6' data-testid='tool-status-error'>
              <CloseOne theme='filled' size='14' />
              <span>{t('conversation.connectors.qqMailFailed')}</span>
            </span>
          )}

          {hasDetail && (
            <span className='text-t-tertiary'>
              {expanded ? <IconDown style={{ fontSize: 12 }} /> : <IconRight style={{ fontSize: 12 }} />}
            </span>
          )}
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && hasDetail && (
        <div className='border-t border-border-1 p-12px flex flex-col gap-10px bg-2' data-testid='qq-mail-tool-detail'>
          {isError && (
            <Alert
              type='error'
              showIcon
              content={output || t('conversation.connectors.errorTip')}
              data-testid='tool-error-alert'
            />
          )}

          {input && (
            <div className='flex flex-col gap-4px'>
              <div className='text-11px font-500 text-t-tertiary uppercase tracking-wider'>
                {t('conversation.connectors.inputParams')}
              </div>
              <pre className='m-0 p-8px rounded-6px bg-fill-2 border border-border-1 text-12px text-t-primary font-mono overflow-x-auto max-h-160px'>
                {input}
              </pre>
            </div>
          )}

          {output && !isError && (
            <div className='flex flex-col gap-4px'>
              <div className='text-11px font-500 text-t-tertiary uppercase tracking-wider'>
                {t('conversation.connectors.resultOutput')}
              </div>
              <pre className='m-0 p-8px rounded-6px bg-fill-2 border border-border-1 text-12px text-t-primary font-mono overflow-x-auto max-h-240px overflow-y-auto'>
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default QQMailToolCallCard;
