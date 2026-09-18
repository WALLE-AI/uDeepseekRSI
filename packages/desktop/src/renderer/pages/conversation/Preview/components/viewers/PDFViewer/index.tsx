/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import { chatFileRefKey } from '@/common/types/chatFile';
import { Button, Input, Message, Spin } from '@arco-design/web-react';
import { FilePdfOne, Left, Refresh, Right, Search, ZoomIn, ZoomOut } from '@icon-park/react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePreviewToolbarExtras } from '../../../context/PreviewToolbarExtrasContext';
import { registerTabReloader } from '../../../context/tabReloaderRegistry';
import type { PdfDocumentHandle, PdfSearchState } from './PdfDocumentView';
import PdfDocumentView from './PdfDocumentView';
import { PDF_MAX_SCALE, PDF_MIN_SCALE, PDF_SCALE_STEP } from './pdfLayout';
import { buildPdfDocumentSource, describePdfError } from './pdfDocumentSource';
import { stepPdfMatch } from './pdfSearch';
import type { PdfjsModule } from './pdfTypes';
import { clampPdfPage, readPdfViewState, savePdfViewState } from './pdfViewState';

type PDFPreviewProps = {
  tabId?: string;
  fileRef?: ChatFileRef;
  file_path?: string;
  content?: string;
  hideToolbar?: boolean;
};

const EMPTY_SEARCH: PdfSearchState = { matches: [], searching: false };

const PDFPreview: React.FC<PDFPreviewProps> = ({ tabId, fileRef, file_path, content, hideToolbar = false }) => {
  const { t } = useTranslation();
  const [messageApi, messageContextHolder] = Message.useMessage();
  const toolbarExtrasContext = usePreviewToolbarExtras();
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const documentHandleRef = useRef<PdfDocumentHandle>(null);
  const sourceIdentity = fileRef ? chatFileRefKey(fileRef) : (content ?? '');
  const viewStateKey = `${tabId ?? 'pdf'}:${sourceIdentity}`;
  const initialViewState = useMemo(() => readPdfViewState(viewStateKey), [viewStateKey]);
  const [pdfjs, setPdfjs] = useState<PdfjsModule | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(initialViewState.pageNumber);
  const [scale, setScale] = useState(initialViewState.scale);
  const [fitWidth, setFitWidth] = useState(initialViewState.fitWidth);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<PdfSearchState>(EMPTY_SEARCH);
  const [matchCursor, setMatchCursor] = useState(-1);

  // 打开文档时的页码只读一次：之后页码由滚动位置反推，再把它当输入会造成循环。
  // The page the document opens at is read once; afterwards the page follows the scroll
  // position, and feeding it back in would create a loop.
  const initialPageRef = useRef(initialViewState.pageNumber);

  const source = useMemo(() => buildPdfDocumentSource(fileRef, content), [sourceIdentity]);
  const usePortalToolbar = Boolean(toolbarExtrasContext) && !hideToolbar;

  const reload = useCallback(() => setReloadKey((current) => current + 1), []);

  useEffect(() => {
    if (!tabId) return;
    return registerTabReloader(tabId, reload);
  }, [reload, tabId]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setErrorKey(null);
    setDocument(null);
    setSearch(EMPTY_SEARCH);
    setMatchCursor(-1);
    const saved = readPdfViewState(viewStateKey);
    initialPageRef.current = saved.pageNumber;
    setPageNumber(saved.pageNumber);
    setScale(saved.scale);
    setFitWidth(saved.fitWidth);
    void loadingTaskRef.current?.destroy();

    if (!source) {
      setErrorKey('preview.pdf.pathMissing');
      setLoading(false);
      return;
    }

    let task: PDFDocumentLoadingTask | null = null;
    void import('pdfjs-dist')
      .then((module) => {
        if (disposed) return null;
        module.GlobalWorkerOptions.workerSrc = workerSrc;
        setPdfjs(module);
        task = module.getDocument(source);
        loadingTaskRef.current = task;
        return task.promise;
      })
      .then((nextDocument) => {
        if (!nextDocument) return;
        if (disposed) {
          void nextDocument.destroy();
          return;
        }
        initialPageRef.current = clampPdfPage(initialPageRef.current, nextDocument.numPages);
        setPageNumber(initialPageRef.current);
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

  // 搜索结果换了就跳到第一处命中；没有命中则退回「未选中」。
  // A new result set jumps to the first hit; an empty one falls back to "nothing selected".
  const handleSearchState = useCallback((next: PdfSearchState) => {
    setSearch(next);
    setMatchCursor((current) => {
      if (next.matches.length === 0) return -1;
      return current < 0 ? 0 : Math.min(current, next.matches.length - 1);
    });
  }, []);

  const handleError = useCallback((key: string) => setErrorKey(key), []);

  const activeMatch = matchCursor >= 0 ? (search.matches[matchCursor] ?? null) : null;
  const goToMatch = useCallback(
    (direction: 1 | -1) => setMatchCursor((current) => stepPdfMatch(search.matches.length, current, direction)),
    [search.matches.length]
  );

  const goToPage = useCallback((next: number) => {
    setPageNumber(next);
    documentHandleRef.current?.scrollToPage(next);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setSearch(EMPTY_SEARCH);
    setMatchCursor(-1);
  }, []);

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

  const searchSummary = search.searching
    ? t('preview.pdf.search.searching')
    : search.matches.length === 0
      ? query
        ? t('preview.pdf.search.noResults')
        : ''
      : t('preview.pdf.search.count', { current: matchCursor + 1, total: search.matches.length });

  const toolbar = document ? (
    <div className='flex items-center gap-6px'>
      {searchOpen && (
        <div className='flex items-center gap-4px'>
          <Input
            size='mini'
            allowClear
            autoFocus
            value={query}
            placeholder={t('preview.pdf.search.placeholder')}
            className='w-160px'
            onChange={setQuery}
            onPressEnter={() => goToMatch(1)}
          />
          <span className='min-w-56px text-center text-12px text-t-secondary'>{searchSummary}</span>
          <Button
            type='text'
            size='mini'
            icon={<Left />}
            disabled={search.matches.length === 0}
            title={t('preview.pdf.search.previous')}
            onClick={() => goToMatch(-1)}
          />
          <Button
            type='text'
            size='mini'
            icon={<Right />}
            disabled={search.matches.length === 0}
            title={t('preview.pdf.search.next')}
            onClick={() => goToMatch(1)}
          />
        </div>
      )}
      <Button
        type={searchOpen ? 'secondary' : 'text'}
        size='mini'
        icon={<Search />}
        title={searchOpen ? t('preview.pdf.search.close') : t('preview.pdf.search.open')}
        onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
      />
      <Button
        type='text'
        size='mini'
        icon={<Left />}
        disabled={pageNumber <= 1}
        title={t('preview.pdf.previousPage')}
        onClick={() => goToPage(Math.max(1, pageNumber - 1))}
      />
      <span className='min-w-64px text-center text-12px text-t-secondary' title={t('preview.pdf.goToPage')}>
        {pageNumber} / {document.numPages}
      </span>
      <Button
        type='text'
        size='mini'
        icon={<Right />}
        disabled={pageNumber >= document.numPages}
        title={t('preview.pdf.nextPage')}
        onClick={() => goToPage(Math.min(document.numPages, pageNumber + 1))}
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
        disabled={!fitWidth && scale <= PDF_MIN_SCALE}
        onClick={() => {
          setFitWidth(false);
          setScale((current) => Math.max(PDF_MIN_SCALE, current - PDF_SCALE_STEP));
        }}
      />
      <Button
        type='text'
        size='mini'
        icon={<ZoomIn />}
        title={t('preview.zoomIn')}
        disabled={!fitWidth && scale >= PDF_MAX_SCALE}
        onClick={() => {
          setFitWidth(false);
          setScale((current) => Math.min(PDF_MAX_SCALE, current + PDF_SCALE_STEP));
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
      <div className='relative flex-1 overflow-hidden bg-fill-1'>
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
          document &&
          pdfjs && (
            <PdfDocumentView
              handleRef={documentHandleRef}
              pdfjs={pdfjs}
              document={document}
              scale={scale}
              fitWidth={fitWidth}
              initialPage={initialPageRef.current}
              query={query}
              matches={search.matches}
              activeMatch={activeMatch}
              onSearchState={handleSearchState}
              onPageChange={setPageNumber}
              onError={handleError}
            />
          )
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
