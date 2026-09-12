/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { notifyManualRestartRequired } from '@/renderer/utils/appRestart';
import { Alert, Button, Input, Message, Modal, Switch } from '@arco-design/web-react';
import { Delete, Plus } from '@icon-park/react';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate } from 'swr';
import PreferenceRow from './PreferenceRow';

/**
 * 应用内浏览器设置 / In-app browser settings.
 *
 * 这一节值得独立存在，而不是塞进开发者设置：
 * - 登录态是全局共享的（所有 tab、所有项目共用），用户需要一个明确的地方知道
 *   「我的登录信息存在哪、怎么清掉」；
 * - 「允许 Agent 操作浏览器」是安全开关，必须在正式版可见。开发者设置整节在打包版本里
 *   return null，把开关放那儿等于正式版用户根本没有开关可关，而这个能力默认是开着的
 *   —— 那就不叫「可选」了。
 *
 * This section stands on its own rather than living under developer settings:
 * - sign-in state is global (shared across every tab and project), so the user needs
 *   an obvious place to learn where those credentials live and how to remove them;
 * - "let the agent drive the browser" is a security switch and must be visible in
 *   production builds. The whole developer-settings section returns null when packaged,
 *   so putting the switch there would leave production users with no way to turn off a
 *   capability that defaults to on — which would make it not really optional.
 */
const BrowserDataSection: React.FC = () => {
  const { t } = useTranslation();
  const [clearing, setClearing] = useState(false);
  const { data: cdpStatus, isLoading } = useSWR('cdp.status', () => ipcBridge.application.getCdpStatus.invoke());
  const [switchLoading, setSwitchLoading] = useState(false);
  const [credentialModalVisible, setCredentialModalVisible] = useState(false);
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [origin, setOrigin] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const { data: credentialResponse } = useSWR('browser.managedCredentials', () =>
    ipcBridge.application.listManagedBrowserCredentials.invoke()
  );

  const status = cdpStatus?.data;

  /**
   * 开关写的是配置，真正生效要等下次启动 —— 通道随进程创建。两者不一致时提示重启。
   * The switch writes config; it takes effect on the next launch because the bridge is
   * created with the process. Prompt for a restart while the two disagree.
   */
  const agentControlEnabled = status?.configEnabled ?? false;
  const hasPendingChange = !isLoading && status !== undefined && status.configEnabled !== status.enabled;
  const healthText = status
    ? t(
        {
          disabled: 'settings.browserData.health.disabled',
          noTarget: 'settings.browserData.health.noTarget',
          ready: 'settings.browserData.health.ready',
        }[status.health],
        { count: status.targetCount }
      )
    : null;

  const handleToggleAgentControl = useCallback(
    async (checked: boolean) => {
      setSwitchLoading(true);
      try {
        const result = await ipcBridge.application.updateCdpConfig.invoke({ enabled: checked });
        if (result.success) {
          Message.success(t('settings.browserData.agentControlSaved'));
          await mutate('cdp.status');
        } else {
          Message.error(result.msg || t('settings.browserData.agentControlFailed'));
        }
      } catch {
        Message.error(t('settings.browserData.agentControlFailed'));
      } finally {
        setSwitchLoading(false);
      }
    },
    [t]
  );

  const handleRestart = useCallback(async () => {
    try {
      const result = await ipcBridge.application.restart.invoke();
      notifyManualRestartRequired(result, t);
    } catch {
      Message.error(t('common.error'));
    }
  }, [t]);

  const handleClear = useCallback(() => {
    // 二次确认：清掉之后所有网站都要重新登录，且不可撤销
    // Confirm first: this signs out of every site and cannot be undone.
    Modal.confirm({
      title: t('settings.browserData.clearConfirmTitle'),
      content: t('settings.browserData.clearConfirmContent'),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        setClearing(true);
        try {
          const result = await ipcBridge.application.clearBrowserData.invoke();
          if (result.success) {
            Message.success(t('settings.browserData.clearSuccess'));
          } else {
            Message.error(result.msg || t('settings.browserData.clearFailed'));
          }
        } catch {
          Message.error(t('settings.browserData.clearFailed'));
        } finally {
          setClearing(false);
        }
      },
    });
  }, [t]);

  const closeCredentialModal = useCallback(() => {
    setCredentialModalVisible(false);
    setOrigin('');
    setClientId('');
    setClientSecret('');
  }, []);

  const handleSaveCredential = useCallback(async () => {
    setCredentialSaving(true);
    try {
      const result = await ipcBridge.application.saveManagedBrowserCredential.invoke({
        origin: origin.trim(),
        clientId: clientId.trim(),
        clientSecret,
      });
      if (!result.success) {
        Message.error(t('settings.browserData.access.saveFailed'));
        return;
      }
      await mutate('browser.managedCredentials');
      Message.success(t('settings.browserData.access.saved'));
      closeCredentialModal();
    } catch {
      Message.error(t('settings.browserData.access.saveFailed'));
    } finally {
      setCredentialSaving(false);
    }
  }, [clientId, clientSecret, closeCredentialModal, origin, t]);

  const handleRemoveCredential = useCallback(
    (id: string, credentialOrigin: string) => {
      Modal.confirm({
        title: t('settings.browserData.access.removeTitle'),
        content: t('settings.browserData.access.removeConfirm', { origin: credentialOrigin }),
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          const result = await ipcBridge.application.removeManagedBrowserCredential.invoke({ id });
          if (!result.success) {
            Message.error(t('settings.browserData.access.removeFailed'));
            return;
          }
          await mutate('browser.managedCredentials');
          Message.success(t('settings.browserData.access.removed'));
        },
      });
    },
    [t]
  );

  const credentials = credentialResponse?.success ? credentialResponse.data : [];

  return (
    <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
      <div className='text-14px font-medium text-t-primary mb-8px'>{t('settings.browserData.title')}</div>

      <PreferenceRow
        label={t('settings.browserData.agentControlLabel')}
        description={t('settings.browserData.agentControlDesc')}
      >
        <Switch
          checked={agentControlEnabled}
          loading={switchLoading || isLoading}
          onChange={handleToggleAgentControl}
        />
      </PreferenceRow>

      {hasPendingChange && (
        <Alert
          type='warning'
          content={
            <div className='flex items-center justify-between gap-12px'>
              <span>{t('settings.browserData.agentControlRestartRequired')}</span>
              <Button size='small' type='primary' onClick={handleRestart}>
                {t('settings.restartNow')}
              </Button>
            </div>
          }
          className='mb-8px'
        />
      )}

      {healthText && (
        <Alert type={status?.health === 'ready' ? 'success' : 'info'} content={healthText} className='mb-8px' />
      )}

      <PreferenceRow
        label={t('settings.browserData.access.label')}
        description={t('settings.browserData.access.description')}
      >
        <Button size='small' icon={<Plus />} onClick={() => setCredentialModalVisible(true)}>
          {t('settings.browserData.access.add')}
        </Button>
      </PreferenceRow>

      {credentials?.map((credential) => (
        <div
          key={credential.id}
          className='flex items-center justify-between gap-12px py-8px border-b border-b-solid border-border-2'
        >
          <div className='min-w-0'>
            <div className='text-13px text-t-primary break-all'>{credential.origin}</div>
            <div className='text-12px text-t-secondary break-all'>{credential.clientId}</div>
          </div>
          <Button
            size='mini'
            type='text'
            status='danger'
            icon={<Delete />}
            title={t('settings.browserData.access.remove')}
            onClick={() => handleRemoveCredential(credential.id, credential.origin)}
          />
        </div>
      ))}

      <PreferenceRow label={t('settings.browserData.clearLabel')} description={t('settings.browserData.clearDesc')}>
        <Button size='small' status='danger' loading={clearing} onClick={handleClear}>
          {t('common.clear')}
        </Button>
      </PreferenceRow>

      <Modal
        title={t('settings.browserData.access.addTitle')}
        visible={credentialModalVisible}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={credentialSaving}
        okButtonProps={{ disabled: !origin.trim() || !clientId.trim() || !clientSecret }}
        onOk={handleSaveCredential}
        onCancel={closeCredentialModal}
        unmountOnExit
      >
        <div className='flex flex-col gap-12px'>
          <div>
            <div className='text-13px text-t-secondary mb-4px'>{t('settings.browserData.access.origin')}</div>
            <Input
              value={origin}
              placeholder={t('settings.browserData.access.originPlaceholder')}
              onChange={setOrigin}
            />
          </div>
          <div>
            <div className='text-13px text-t-secondary mb-4px'>{t('settings.browserData.access.clientId')}</div>
            <Input value={clientId} onChange={setClientId} />
          </div>
          <div>
            <div className='text-13px text-t-secondary mb-4px'>{t('settings.browserData.access.clientSecret')}</div>
            <Input.Password value={clientSecret} visibilityToggle onChange={setClientSecret} />
          </div>
          <Alert type='warning' content={t('settings.browserData.access.securityNotice')} />
        </div>
      </Modal>
    </div>
  );
};

export default BrowserDataSection;
