/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 应用内浏览器下载结束时的提示。
 *
 * 为什么需要：Chromium 把不能内联渲染的响应（典型是 attachment 形式的 PDF）变成下载，
 * 而下载不会改变页面 —— 在这个提示出现之前，用户看到的就只是「点了没反应」。提示要说清
 * 两件事：文件去哪了，以及怎么找到它。
 *
 * 结果提示用 Notification 而不是 Modal：下载是既成事实，没有需要用户决定的东西，
 * 不该拿弹窗拦人。同样的取舍见 firstUseNotice.ts。
 *
 * 反过来，可执行文件和脚本的确认必须是 Modal —— 那里恰恰有一件需要用户决定的事，
 * 而且必须在文件落盘之前决定完。这是这个文件里唯一一处用模态框的地方。
 *
 * Notice shown when an in-app browser download finishes. Chromium turns a response it
 * cannot render inline (typically an attachment-disposition PDF) into a download, and a
 * download leaves the page untouched — before this notice existed the user simply saw
 * nothing happen. It has to answer two things: where the file went, and how to reach it.
 *
 * Outcomes use a Notification rather than a Modal: the download already happened and there is
 * nothing for the user to decide, so it must not block. Same trade-off as firstUseNotice.ts.
 *
 * Confirmation for programs and scripts is the inverse and must be a Modal — there is something
 * to decide, and it has to be decided before the file reaches the disk. It is the only modal
 * in this file.
 */

import { ipcBridge } from '@/common';
import { Button, Modal, Notification } from '@arco-design/web-react';
import i18next from 'i18next';
import React from 'react';

export type BrowserDownloadNotice = {
  id: string;
  state: 'completed' | 'cancelled' | 'interrupted' | 'blocked';
  fileName: string;
  savePath?: string;
  reason?: 'executable' | 'script' | 'tooLarge' | 'declined';
};

export const notifyBrowserDownload = (event: BrowserDownloadNotice): void => {
  /**
   * 直接用 i18next 单例而非 @/renderer/services/i18n：后者在模块加载时就会初始化 i18n
   * 并订阅 IPC，把这些副作用拖进任何 import 本文件的模块里。
   *
   * Use the i18next singleton rather than @/renderer/services/i18n: the latter initializes
   * i18n and subscribes to IPC at module load, dragging those side effects into anything
   * that imports this file.
   */
  const t = i18next.t.bind(i18next);

  /**
   * 被策略挡下和下载失败要分开说。「下载失败」会让用户去重试，而重试一次被主动挡下的
   * 下载只会再被挡一次 —— 他需要知道的是「这是有意为之」以及为什么。
   *
   * A download stopped by policy and a failed one need different wording. "Download failed"
   * sends the user off to retry, and retrying a deliberately blocked download only blocks it
   * again — what they need to know is that it was intentional, and why.
   */
  if (event.state === 'blocked') {
    Notification.warning({
      title: t('preview.browser.download.blockedTitle'),
      content:
        event.reason === 'tooLarge'
          ? t('preview.browser.download.blockedTooLarge', { fileName: event.fileName })
          : t('preview.browser.download.blockedDeclined', { fileName: event.fileName }),
      duration: 6000,
    });
    return;
  }

  if (event.state !== 'completed') {
    Notification.warning({
      title: t('preview.browser.download.failedTitle'),
      content: t('preview.browser.download.failedContent', { fileName: event.fileName }),
      duration: 6000,
    });
    return;
  }

  const savePath = event.savePath;
  Notification.info({
    title: t('preview.browser.download.completedTitle'),
    content: t('preview.browser.download.completedContent', { fileName: event.fileName }),
    duration: 8000,
    btn: savePath
      ? React.createElement(
          Button,
          {
            size: 'small',
            type: 'primary',
            onClick: () => {
              void ipcBridge.application.revealBrowserDownload.invoke({ savePath });
            },
          },
          t('preview.browser.download.reveal')
        )
      : undefined,
  });
};

export type BrowserDownloadConfirmRequest = {
  id: string;
  fileName: string;
  reason: 'executable' | 'script';
};

/**
 * 可执行文件/脚本下载的确认框。
 *
 * 主进程把下载暂停在那里等这个答复，所以每一条出路都必须回一次话：点「保存」、点
 * 「不保存」、点遮罩关掉，都得调用 resolveBrowserDownload。少回一条，那个下载就一直
 * 挂着，直到主进程那边的超时把它按拒绝处理 —— 用户看到的是「点了没反应，过两分钟说没存」。
 *
 * 默认按钮是「不保存」：这个框是因为文件危险才出现的，而模态框最常见的操作是回车确认默认项。
 *
 * The confirmation for a program or script download. The main process holds the download paused
 * awaiting this answer, so every exit has to answer: pressing Save, pressing Don't save, and
 * dismissing by clicking the mask all call resolveBrowserDownload. Miss one and the download
 * hangs until the main-process timeout refuses it — which the user experiences as "nothing
 * happened, and two minutes later it says it wasn't saved".
 *
 * Don't save is the default: this dialog only appears because the file is dangerous, and the
 * most common thing done to a modal is to press Enter on its default.
 */
export const confirmBrowserDownload = (request: BrowserDownloadConfirmRequest): void => {
  const t = i18next.t.bind(i18next);
  let answered = false;
  const answer = (allow: boolean) => {
    if (answered) return;
    answered = true;
    void ipcBridge.application.resolveBrowserDownload.invoke({ id: request.id, allow });
  };

  Modal.confirm({
    title: t('preview.browser.download.confirmTitle'),
    content:
      request.reason === 'script'
        ? t('preview.browser.download.confirmScript', { fileName: request.fileName })
        : t('preview.browser.download.confirmExecutable', { fileName: request.fileName }),
    okText: t('preview.browser.download.confirmSave'),
    cancelText: t('preview.browser.download.confirmDiscard'),
    okButtonProps: { status: 'danger' },
    onOk: () => answer(true),
    onCancel: () => answer(false),
    afterClose: () => answer(false),
  });
};
