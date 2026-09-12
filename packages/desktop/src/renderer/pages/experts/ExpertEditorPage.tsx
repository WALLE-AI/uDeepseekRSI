/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Message, Select } from '@arco-design/web-react';
import { ArrowLeft } from '@icon-park/react';
import { experts as expertsApi } from '@/common/adapter/ipcBridge';
import { expertErrorMessage } from './expertMessages';
import { useExpertToolVocabulary } from './useExperts';
import { DSH_ASSISTANT_WORK_MODES, type DshAssistantWorkMode } from '@/common/types/agent/assistantTypes';
import { promptLines, type ExpertEditorDraft } from './types';

const MODE_LABEL_KEYS = {
  office: 'agentMode.work.office',
  coding: 'agentMode.work.coding',
  research: 'agentMode.work.research',
} as const;

type ExpertEditorPageProps = {
  draft: ExpertEditorDraft;
  /** Editing keeps the identifier fixed: renaming would move the package directory. */
  isEdit: boolean;
  onCancel: () => void;
  onSaved: () => void;
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className='mb-16px block'>
    <span className='mb-6px block text-13px font-600 text-t-primary'>{label}</span>
    {children}
    {hint ? <span className='mt-4px block text-12px text-t-tertiary'>{hint}</span> : null}
  </label>
);

const ExpertEditorPage: React.FC<ExpertEditorPageProps> = ({ draft, isEdit, onCancel, onSaved }) => {
  const { t, i18n } = useTranslation();
  const localeKey = i18n.language;
  const toolVocabulary = useExpertToolVocabulary();
  const [form, setForm] = useState<ExpertEditorDraft>(draft);
  const [saving, setSaving] = useState(false);

  const update = <K extends keyof ExpertEditorDraft>(key: K, value: ExpertEditorDraft[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        expert_type: 'agent' as const,
        mode: form.mode,
        display_name: form.displayName.trim() ? { [localeKey]: form.displayName.trim() } : undefined,
        profession: form.profession.trim() ? { [localeKey]: form.profession.trim() } : undefined,
        goal: form.goal.trim(),
        method: form.method,
        output: form.output,
        output_template: form.outputTemplate,
        allowed_tools: form.allowedTools,
        prompts: promptLines(form.prompts),
      };
      if (isEdit) {
        await expertsApi.update.invoke(payload);
        Message.success(t('experts.updated'));
      } else {
        await expertsApi.create.invoke(payload);
        Message.success(t('experts.created'));
      }
      onSaved();
    } catch (error) {
      Message.error(expertErrorMessage(error, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid='expert-editor' className='flex h-full min-h-0 flex-col overflow-auto bg-transparent'>
      <div className='sticky top-0 z-10 flex items-center gap-8px border-b border-border-2 bg-bg-0 px-12px py-12px md:px-40px'>
        <Button
          data-testid='expert-editor-back'
          type='text'
          icon={<ArrowLeft theme='outline' size='16' fill='currentColor' />}
          onClick={onCancel}
        />
        <span className='text-15px font-600 text-t-primary'>{isEdit ? t('experts.edit') : t('experts.create')}</span>
        <div className='flex-1' />
        <Button onClick={onCancel}>{t('experts.cancel')}</Button>
        <Button data-testid='expert-editor-save' type='primary' loading={saving} onClick={() => void handleSave()}>
          {t('experts.save')}
        </Button>
      </div>

      <div className='mx-auto w-full max-w-720px px-12px py-24px md:px-0'>
        <Field label={t('experts.formName')} hint={t('experts.formNameHint')}>
          <Input
            data-testid='expert-field-name'
            value={form.name}
            disabled={isEdit}
            onChange={(value) => update('name', value)}
            placeholder='repo-surveyor'
          />
        </Field>
        <Field label={t('experts.formDisplayName')}>
          <Input
            data-testid='expert-field-display-name'
            value={form.displayName}
            onChange={(value) => update('displayName', value)}
          />
        </Field>
        <Field label={t('experts.typeAgent')}>
          <Input
            data-testid='expert-field-profession'
            value={form.profession}
            onChange={(value) => update('profession', value)}
            placeholder='代码勘察专家'
          />
        </Field>
        <Field label={t('experts.formMode')}>
          <Select
            data-testid='expert-field-mode'
            value={form.mode}
            onChange={(value: DshAssistantWorkMode) => update('mode', value)}
          >
            {DSH_ASSISTANT_WORK_MODES.map((mode) => (
              <Select.Option key={mode} value={mode}>
                {t(MODE_LABEL_KEYS[mode])}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field label={t('experts.formGoal')} hint={t('experts.formGoalHint')}>
          <Input data-testid='expert-field-goal' value={form.goal} onChange={(value) => update('goal', value)} />
        </Field>
        <Field label={t('experts.formMethod')}>
          <Input.TextArea
            data-testid='expert-field-method'
            autoSize={{ minRows: 4, maxRows: 12 }}
            value={form.method}
            onChange={(value) => update('method', value)}
          />
        </Field>
        <Field label={t('experts.formOutput')}>
          <Input value={form.output} onChange={(value) => update('output', value)} />
        </Field>
        <Field label={t('experts.formOutputTemplate')}>
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 10 }}
            value={form.outputTemplate}
            onChange={(value) => update('outputTemplate', value)}
          />
        </Field>
        <Field label={t('experts.formPrompts')} hint={t('experts.formPromptsHint')}>
          <Input.TextArea
            data-testid='expert-field-prompts'
            autoSize={{ minRows: 3, maxRows: 8 }}
            value={form.prompts}
            onChange={(value) => update('prompts', value)}
          />
        </Field>
        <Field label={t('experts.formTools')} hint={t('experts.formToolsHint')}>
          <Select
            data-testid='expert-field-tools'
            mode='multiple'
            value={form.allowedTools}
            onChange={(value: string[]) => update('allowedTools', value)}
          >
            {toolVocabulary.map((tool) => (
              <Select.Option key={tool} value={tool}>
                {tool}
              </Select.Option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
};

export default ExpertEditorPage;
