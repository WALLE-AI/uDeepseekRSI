/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { experts as expertsApi } from '@/common/adapter/ipcBridge';
import type { ExpertSummary } from '@/common/types/agent/expertTypes';
import { resolveExpertDescription, resolveExpertName } from '@/common/types/agent/expertTypes';
import { emitter } from '@/renderer/utils/emitter';
import { Button, Message, Modal, Tooltip } from '@arco-design/web-react';
import { Back, PeoplesTwo } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useExperts } from '../useExperts';

type ExpertHandoffButtonProps = {
  conversationId: string;
  /** Work mode of the current conversation; only same-mode experts can take over. */
  workMode: string;
  /** Expert already bound to this conversation, if any — it is not offered again. */
  currentExpertId?: string;
  /** Set when this conversation is itself the result of a handoff. */
  originConversationId?: string;
};

/**
 * Continues the current work under an expert.
 *
 * It deliberately opens a *new* conversation rather than rebinding this one. Once an
 * expert is part of the runtime key, a conversation belongs to one dsh process and one
 * session inside it, so swapping the expert in place would strand the stored session.
 * Presenting it as a handoff also keeps the original readable afterwards.
 */
const ExpertHandoffButton: React.FC<ExpertHandoffButtonProps> = ({
  conversationId,
  workMode,
  currentExpertId,
  originConversationId,
}) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { experts } = useExperts();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState('');

  const candidates = useMemo(
    () =>
      experts.filter(
        (expert) => expert.mode === workMode && expert.expert_type === 'agent' && expert.name !== currentExpertId
      ),
    [experts, workMode, currentExpertId]
  );

  const handoff = async (expert: ExpertSummary) => {
    setPending(expert.name);
    try {
      const created = await expertsApi.handoff.invoke({ conversation_id: conversationId, expert_id: expert.name });
      emitter.emit('chat.history.refresh');
      setOpen(false);
      void navigate(`/conversation/${created.id}`);
    } catch (error) {
      console.error('[ExpertHandoffButton] handoff failed:', error);
      Message.error(t('experts.handoffError'));
    } finally {
      setPending('');
    }
  };

  return (
    <>
      {/* The link back is what makes the two conversations legible as one piece of work;
          without it a handoff just looks like the old conversation went quiet. */}
      {originConversationId ? (
        <Tooltip content={t('experts.handoffFrom')}>
          <Button
            data-testid='expert-handoff-origin'
            size='small'
            type='text'
            icon={<Back theme='outline' size='15' fill='currentColor' />}
            onClick={() => void navigate(`/conversation/${originConversationId}`)}
          />
        </Tooltip>
      ) : null}
      <Tooltip content={t('experts.handoff')}>
        <Button
          data-testid='expert-handoff-open'
          size='small'
          type='text'
          icon={<PeoplesTwo theme='outline' size='15' fill='currentColor' />}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <Modal
        visible={open}
        title={t('experts.handoffTitle')}
        footer={null}
        autoFocus={false}
        focusLock
        onCancel={() => setOpen(false)}
        style={{ width: 520, maxWidth: '92vw' }}
      >
        <div data-testid='expert-handoff-modal' className='flex flex-col gap-12px'>
          <p className='m-0 text-13px leading-[1.6] text-t-secondary'>{t('experts.handoffHint')}</p>
          {candidates.length === 0 ? (
            <p className='m-0 text-13px text-t-tertiary'>{t('experts.handoffEmpty')}</p>
          ) : (
            <div className='flex flex-col gap-8px'>
              {candidates.map((expert) => (
                <div
                  key={expert.name}
                  className='flex items-center gap-12px rounded-10px bg-fill-1 px-12px py-10px'
                  data-testid='expert-handoff-option'
                >
                  <div className='min-w-0 flex-1'>
                    <div className='truncate text-13px font-600 text-t-primary'>
                      {resolveExpertName(expert, i18n.language)}
                    </div>
                    <div className='truncate text-12px text-t-tertiary'>
                      {resolveExpertDescription(expert, i18n.language)}
                    </div>
                  </div>
                  <Button
                    size='small'
                    type='primary'
                    loading={pending === expert.name}
                    onClick={() => void handoff(expert)}
                  >
                    {t('experts.handoffConfirm')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
};

export default ExpertHandoffButton;
