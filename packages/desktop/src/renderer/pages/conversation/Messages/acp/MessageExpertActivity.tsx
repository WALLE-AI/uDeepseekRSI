/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageExpertActivity } from '@/common/chat/chatLib';
import { Card, Tag } from '@arco-design/web-react';
import { Peoples } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Live card for one expert-team member working inside the lead's turn.
 *
 * It lives beside the other ACP stream cards because that is literally where it comes
 * from: the engine's `subagent/start|end` events never cross ACP, so a delegated member is
 * visible only as the delegating tool's own `tool_call` / `tool_call_update` frames. The
 * backend re-labels those frames and adds a heartbeat, which is what the elapsed time
 * below advances on — without it a member working for minutes would look like a hang.
 */
const MessageExpertActivity: React.FC<{ message: IMessageExpertActivity }> = ({ message }) => {
  const { t } = useTranslation();
  const { content } = message;
  if (!content?.tool_call_id) return null;

  const label = content.member_id ?? content.tool_name;
  const seconds = Math.max(0, Math.round(content.elapsed_ms / 1000));
  const failed = content.phase === 'done' && content.status === 'failed';

  const statusTag = failed ? (
    <Tag color='red' size='small' data-testid='expert-activity-status'>
      {t('experts.activityFailed', { defaultValue: 'Failed' })}
    </Tag>
  ) : content.phase === 'done' ? (
    <Tag color='green' size='small' data-testid='expert-activity-status'>
      {t('experts.activityDone', { defaultValue: 'Done' })}
    </Tag>
  ) : (
    <Tag color='arcoblue' size='small' data-testid='expert-activity-status'>
      {t('experts.activityWorking', { defaultValue: 'Working' })}
    </Tag>
  );

  return (
    <Card className='w-full mb-2' size='small' bordered data-testid='expert-activity-card'>
      <div className='flex items-center gap-8px min-w-0'>
        <Peoples theme='outline' size='14' fill='currentColor' />
        <span className='text-13px font-600 text-t-primary truncate' data-testid='expert-activity-member'>
          {label}
        </span>
        {statusTag}
        <span className='ms-auto text-11px text-t-tertiary' data-testid='expert-activity-elapsed'>
          {t('experts.activityElapsed', { defaultValue: '{{seconds}}s', seconds })}
        </span>
      </div>
      {content.task ? (
        <p className='m-0 mt-6px text-12px leading-[1.6] text-t-secondary' data-testid='expert-activity-task'>
          {content.task}
        </p>
      ) : null}
    </Card>
  );
};

export default MessageExpertActivity;
