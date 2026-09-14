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
 * 用 Notification 而不是 Modal：下载是既成事实，没有需要用户决定的东西，不该拿弹窗拦人。
 * 同样的取舍见 firstUseNotice.ts。
 *
 * Notice shown when an in-app browser download finishes. Chromium turns a response it
 * cannot render inline (typically an attachment-disposition PDF) into a download, and a
 * download leaves the page untouched — before this notice existed the user simply saw
 * nothing happen. It has to answer two things: where the file went, and how to reach it.
 *
 * A Notification rather than a Modal: the download already happened and there is nothing
 * for the user to decide, so it must not block. Same trade-off as firstUseNotice.ts.
 */

import { ipcBridge } from '@/common';
import { Button, Notification } from '@arco-design/web-react';
import i18next from 'i18next';
import React from 'react';

export type BrowserDownloadNotice = {
  state: 'completed' | 'cancelled' | 'interrupted';
  fileName: string;
  savePath?: string;
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
