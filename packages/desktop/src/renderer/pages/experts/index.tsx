/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Message, Modal } from '@arco-design/web-react';
import { dialog, experts as expertsApi } from '@/common/adapter/ipcBridge';
import ExpertDetailModal from './components/ExpertDetailModal';
import ExpertEditorPage from './ExpertEditorPage';
import ExpertLibrary from './ExpertLibrary';
import { expertErrorMessage } from './expertMessages';
import { useExperts } from './useExperts';
import { draftFromDetail, emptyExpertDraft, type ExpertEditorDraft } from './types';
import { assistantIdForWorkMode } from '@/common/types/agent/assistantTypes';
import { resolveExpertName, type ExpertSummary } from '@/common/types/agent/expertTypes';

const ExpertsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const localeKey = i18n.language;
  const { experts, isLoading, refresh } = useExperts();
  const [editing, setEditing] = useState<{ draft: ExpertEditorDraft; isEdit: boolean } | null>(null);
  const [opened, setOpened] = useState<ExpertSummary | null>(null);

  const closeEditor = (reload: boolean) => {
    setEditing(null);
    if (reload) void refresh();
  };

  /**
   * Summoning reuses the existing "start a chat with a preselected assistant" path: the
   * expert's mode decides the assistant, the expert id rides along as a conversation
   * override so the backend can freeze it into the capability snapshot, and a clicked
   * example ask arrives as the composer's prefilled draft.
   */
  const handleSummon = (expert: ExpertSummary, prompt?: string) => {
    setOpened(null);
    void navigate('/guid', {
      state: {
        selectedAssistantId: assistantIdForWorkMode(expert.mode),
        expertId: expert.name,
        expertLabel: resolveExpertName(expert, localeKey),
        ...(prompt ? { prefillPrompt: prompt, focusPrefill: true } : {}),
      },
    });
  };

  const handleEdit = async (expert: ExpertSummary) => {
    try {
      const detail = await expertsApi.get.invoke({ name: expert.name });
      setEditing({ draft: draftFromDetail(detail, localeKey), isEdit: true });
    } catch (error) {
      Message.error(expertErrorMessage(error, t));
    }
  };

  const handleDelete = (expert: ExpertSummary) => {
    Modal.confirm({
      title: t('experts.deleteTitle', { name: resolveExpertName(expert, localeKey) }),
      content: t('experts.deleteHint'),
      onOk: async () => {
        try {
          await expertsApi.remove.invoke({ name: expert.name });
          Message.success(t('experts.deleted'));
          void refresh();
        } catch (error) {
          Message.error(expertErrorMessage(error, t));
        }
      },
    });
  };

  const handleReveal = async (expert: ExpertSummary) => {
    try {
      await expertsApi.reveal.invoke({ name: expert.name });
    } catch (error) {
      Message.error(expertErrorMessage(error, t));
    }
  };

  const handleImport = async () => {
    const selected = await dialog.showOpen.invoke({ properties: ['openDirectory'] });
    const source = selected?.[0];
    if (!source) return;
    try {
      const result = await expertsApi.import.invoke({ expert_path: source });
      Message.success(t('experts.imported', { name: result.expert_name }));
      void refresh();
    } catch (error) {
      Message.error(expertErrorMessage(error, t));
    }
  };

  if (editing) {
    return (
      <ExpertEditorPage
        draft={editing.draft}
        isEdit={editing.isEdit}
        onCancel={() => closeEditor(false)}
        onSaved={() => closeEditor(true)}
      />
    );
  }

  return (
    <>
      <ExpertLibrary
        experts={experts}
        loading={isLoading}
        localeKey={localeKey}
        onCreate={() => setEditing({ draft: emptyExpertDraft(), isEdit: false })}
        onImport={() => void handleImport()}
        onOpen={setOpened}
        onEdit={(expert) => void handleEdit(expert)}
        onDelete={handleDelete}
        onReveal={(expert) => void handleReveal(expert)}
      />
      <ExpertDetailModal
        expert={opened}
        localeKey={localeKey}
        onClose={() => setOpened(null)}
        onSummon={handleSummon}
      />
    </>
  );
};

export default ExpertsPage;
