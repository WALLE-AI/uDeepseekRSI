/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import { chatFileRefKey } from '@/common/types/chatFile';
import { Button, Message, Spin } from '@arco-design/web-react';
import { FilePdfOne, Left, Refresh, Right, ZoomIn, ZoomOut } from '@icon-park/react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { registerTabReloader } from '../../../context/tabReloaderRegistry';
import { usePreviewToolbarExtras } from '../../../context/PreviewToolbarExtrasContext';
import { buildPdfDocumentSource, describePdfError } from './pdfDocumentSource';
import { clampPdfPage, readPdfViewState, savePdfViewState } from './pdfViewState';

type PDFPreviewProps = {
  tabId?: string;
  fileRef?: ChatFileRef;
  file_path?: string;
  content?: string;
  hideToolbar?: boolean;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;

const PDFPreview: React.FC<PDFPreviewProps> = ({ tabId, fileRef, file_path, content, hideToolbar = false }) => {
  const { t } = useTranslation();
  const [messageApi, messageContextHolder] = Message.useMessage();
  const toolbarExtrasContext = usePreviewToolbarExtras();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const sourceIdentity = fileRef ? chatFileRefKey(fileRef) : (content ?? '');
  const viewStateKey = `${tabId ?? 'pdf'}:${sourceIdentity}`;
  const initialViewState = useMemo(() => readPdfViewState(viewStateKey), [viewStateKey]);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(initialViewState.pageNumber);
  const [scale, setScale] = useState(initialViewState.scale);
  const [fitWidth, setFitWidth] = useState(initialViewState.fitWidth);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const source = useMemo(() => buildPdfDocumentSource(fileRef, content), [sourceIdentity]);
  const usePortalToolbar = Boolean(toolbarExtrasContext) && !hideToolbar;

  const reload = useCallback(() => setReloadKey((current) => current + 1), []);

  useEffect(() => {
    if (!tabId) return;
    return registerTabReloader(tabId, reload);
  }, [reload, tabId]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setViewportWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setErrorKey(null);
    setDocument(null);
    const saved = readPdfViewState(viewStateKey);
    setPageNumber(saved.pageNumber);
    setScale(saved.scale);
    setFitWidth(saved.fitWidth);
    renderTaskRef.current?.cancel();
    void loadingTaskRef.current?.destroy();

    if (!source) {
      setErrorKey('preview.pdf.pathMissing');
      setLoading(false);
      return;
    }

    let task: PDFDocumentLoadingTask | null = null;
    void import('pdfjs-dist')
      .then((pdfjs) => {
        if (disposed) return null;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        task = pdfjs.getDocument(source);
        loadingTaskRef.current = task;
        return task.promise;
      })
      .then((nextDocument) => {
        if (!nextDocument) return;
        if (disposed) {
          void nextDocument.destroy();
          return;
        }
        setPageNumber((current) => clampPdfPage(current, nextDocument.numPages));
        setDocument(nextDocument);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (disposed || (error instanceof Error && error.name === 'AbortException')) return;
        const kind = describePdfError(error);
        setErrorKey(kind === 'unknown' ? 'preview.pdf.loadFailed' : `preview.pdf.errors.${kind}`);
        setLoading(false);
      });

    return () => {
      disposed = true;
      const activeTask = task;
      if (activeTask && loadingTaskRef.current === activeTask) loadingTaskRef.current = null;
      void activeTask?.destroy();
    };
  }, [reloadKey, source, viewStateKey]);

  useEffect(() => {
    savePdfViewState(viewStateKey, { pageNumber, scale, fitWidth });
  }, [fitWidth, pageNumber, scale, viewStateKey]);

  useEffect(() => {
    if (!document || !canvasRef.current || viewportWidth <= 0) return;
    let disposed = false;
    setLoading(true);
    renderTaskRef.current?.cancel();

    void document
      .getPage(pageNumber)
      .then((page) => {
        if (disposed || !canvasRef.current) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(240, viewportWidth - 32);
        const effectiveScale = fitWidth ? Math.min(MAX_SCALE, availableWidth / baseViewport.width) : scale;
        const viewport = page.getViewport({ scale: effectiveScale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const task = page.render({
          canvas,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        renderTaskRef.current = task;
        return task.promise;
      })
      .then(() => {
        if (!disposed) setLoading(false);
      })
      .catch((error: unknown) => {
        if (disposed || (error instanceof Error && error.name === 'RenderingCancelledException')) return;
        setErrorKey('preview.pdf.loadFailed');
        setLoading(false);
      });

    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
    };
  }, [document, fitWidth, pageNumber, scale, viewportWidth]);

  const openInSystem = useCallback(async () => {
    if (!file_path) {
      messageApi.error(t('preview.errors.openWithoutPath'));
      return;
    }
    try {
      await ipcBridge.shell.openFile.invoke(file_path);
      messageApi.success(t('preview.openInSystemSuccess'));
    } catch {
      messageApi.error(t('preview.openInSystemFailed'));
    }
  }, [file_path, messageApi, t]);

  const toolbar = document ? (
    <div className='flex items-center gap-6px'>
      <Button
        type='text'
        size='mini'
        icon={<Left />}
        disabled={pageNumber <= 1}
        title={t('preview.pdf.previousPage')}
        onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
      />
      <span className='min-w-64px text-center text-12px text-t-secondary'>
        {pageNumber} / {document.numPages}
      </span>
      <Button
        type='text'
        size='mini'
        icon={<Right />}
        disabled={pageNumber >= document.numPages}
        title={t('preview.pdf.nextPage')}
        onClick={() => setPageNumber((current) => Math.min(document.numPages, current + 1))}
      />
      <Button
        type={fitWidth ? 'secondary' : 'text'}
        size='mini'
        title={t('preview.pdf.fitWidth')}
        onClick={() => setFitWidth(true)}
      >
        {t('preview.pdf.fitWidth')}
      </Button>
      <Button
        type='text'
        size='mini'
        icon={<ZoomOut />}
        title={t('preview.zoomOut')}
        disabled={!fitWidth && scale <= MIN_SCALE}
        onClick={() => {
          setFitWidth(false);
          setScale((current) => Math.max(MIN_SCALE, current - SCALE_STEP));
        }}
      />
      <Button
        type='text'
        size='mini'
        icon={<ZoomIn />}
        title={t('preview.zoomIn')}
        disabled={!fitWidth && scale >= MAX_SCALE}
        onClick={() => {
          setFitWidth(false);
          setScale((current) => Math.min(MAX_SCALE, current + SCALE_STEP));
        }}
      />
      <Button type='text' size='mini' icon={<Refresh />} title={t('preview.refresh.label')} onClick={reload} />
    </div>
  ) : null;

  useEffect(() => {
    if (!usePortalToolbar || !toolbarExtrasContext) return;
    toolbarExtrasContext.setExtras({
      left: (
        <div className='flex items-center gap-8px text-13px text-t-secondary'>
          <FilePdfOne />
          <span>{t('preview.pdf.title')}</span>
        </div>
      ),
      right: toolbar,
    });
    return () => toolbarExtrasContext.setExtras(null);
  }, [t, toolbar, toolbarExtrasContext, usePortalToolbar]);

  return (
    <div className='h-full w-full bg-bg-1 flex flex-col'>
      {messageContextHolder}
      {!usePortalToolbar && !hideToolbar && (
        <div className='flex items-center justify-between min-h-40px px-12px bg-bg-2 flex-shrink-0'>
          <div className='flex items-center gap-8px text-13px text-t-secondary'>
            <FilePdfOne />
            <span>{t('preview.pdf.title')}</span>
          </div>
          <div className='flex items-center gap-8px'>
            {toolbar}
            {file_path && (
              <Button size='mini' type='text' onClick={openInSystem}>
                {t('preview.openInSystemApp')}
              </Button>
            )}
          </div>
        </div>
      )}
      <div ref={viewportRef} className='relative flex-1 overflow-auto bg-fill-1 p-16px'>
        {errorKey ? (
          <div className='h-full flex flex-col items-center justify-center gap-12px text-center'>
            <div className='text-14px text-t-error'>{t(errorKey)}</div>
            <div className='flex items-center gap-8px'>
              <Button type='primary' icon={<Refresh />} onClick={reload}>
                {t('common.retry')}
              </Button>
              {file_path && <Button onClick={openInSystem}>{t('preview.openInSystemApp')}</Button>}
            </div>
          </div>
        ) : (
          <div className='min-h-full flex justify-center items-start'>
            <canvas ref={canvasRef} className='block bg-bg-1' />
          </div>
        )}
        {loading && !errorKey && (
          <div className='absolute inset-0 flex items-center justify-center bg-bg-1'>
            <Spin tip={t('preview.loading')} />
          </div>
        )}
      </div>
    </div>
  );
};

export default PDFPreview;
