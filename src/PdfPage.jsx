import React, { useEffect, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import { FileWarning } from 'lucide-react';
import { prepareTextLayer } from './selection.js';
import { rasterRatio } from './reader-layout.js';
import RegionSelection from './RegionSelection.jsx';

function markMatches(container, query) {
  const spans = [...container.querySelectorAll('span')].filter(span => !span.children.length);
  spans.forEach(span => span.classList.remove('search-match'));
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, '');
  if (!needle) return;
  let text = '';
  const offsets = spans.map(span => {
    const start = text.length;
    text += span.textContent.toLocaleLowerCase().replace(/\s+/g, '');
    return { span, start, end: text.length };
  });
  let at = text.indexOf(needle);
  while (at !== -1) {
    for (const item of offsets) if (item.end > at && item.start < at + needle.length) item.span.classList.add('search-match');
    at = text.indexOf(needle, at + needle.length);
  }
}

/** A tile owns only its page's rendering tasks and geometry. */
export default function PdfPage({ pdf, documentId, geometry, layoutCount, captions, annotations, focusedAnnotation, find, regionMode, selection, selectionLocked, onSelection, onRegister, onReady, onDimensions, onActivate, onCopy }) {
  const { page, scale, width, height } = geometry;
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  const paperRef = useRef(null), canvasRef = useRef(null), textRef = useRef(null);
  const callbacks = useRef({ onRegister, onReady, onDimensions });
  callbacks.current = { onRegister, onReady, onDimensions };
  useEffect(() => {
    const record = { page, documentId, paper: paperRef.current, text: textRef.current, canvas: canvasRef.current, ready: false };
    callbacks.current.onRegister(page, record);
    let cancelled = false, renderTask, textLayer, pageProxy;
    setReady(false); setError(''); callbacks.current.onReady(page, false);
    (async () => {
      const source = await pdf.getPage(page);
      if (cancelled) return;
      pageProxy = source;
      const base = source.getViewport({ scale: 1 });
      callbacks.current.onDimensions(page, { width: base.width, height: base.height });
      const viewport = source.getViewport({ scale });
      const paper = paperRef.current;
      paper.style.width = `${viewport.width}px`; paper.style.height = `${viewport.height}px`;
      paper.style.setProperty('--user-unit', String(viewport.userUnit || 1));
      paper.style.setProperty('--total-scale-factor', String(scale * (viewport.userUnit || 1)));
      paper.style.setProperty('--scale-round-x', '1px'); paper.style.setProperty('--scale-round-y', '1px');
      const canvas = window.document.createElement('canvas');
      const ratio = rasterRatio(viewport.width, viewport.height, window.devicePixelRatio || 1, layoutCount);
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute('aria-label', `PDF 第 ${page} 页`);
      canvasRef.current.replaceChildren(canvas); textRef.current.replaceChildren();
      renderTask = source.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (cancelled) return;
      const content = await source.getTextContent();
      if (cancelled) return;
      textLayer = new TextLayer({ textContentSource: content, container: textRef.current, viewport });
      await textLayer.render();
      if (cancelled) return;
      prepareTextLayer(textRef.current, { rotation: viewport.rotation, paperBounds: paper.getBoundingClientRect() });
      const end = window.document.createElement('div'); end.className = 'endOfContent'; textRef.current.append(end);
      record.ready = true;
      setReady(true); callbacks.current.onReady(page, true);
    })().catch(err => {
      if (!cancelled && err.name !== 'RenderingCancelledException') {
        setError(`第 ${page} 页加载失败：${err.message}`);
        callbacks.current.onReady(page, 'error');
      }
    });
    return () => {
      cancelled = true; record.ready = false;
      renderTask?.cancel(); textLayer?.cancel();
      if (renderTask) renderTask.promise.catch(() => {}).finally(() => pageProxy?.cleanup());
      else pageProxy?.cleanup();
      callbacks.current.onRegister(page, null, record);
      callbacks.current.onReady(page, false);
      // Release the bitmap immediately when a continuous-reading tile unloads.
      for (const canvas of record.canvas.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; }
    };
  }, [pdf, documentId, page, scale, layoutCount]);
  useEffect(() => { if (ready) markMatches(textRef.current, find || ''); }, [ready, find]);
  return <div className="pdf-tile" style={{ width }}>
    <div className={`pdf-paper ${ready ? '' : 'is-loading'}`} style={{ width, height }} ref={paperRef} data-page={page} onPointerDownCapture={() => onActivate(page)}>
      <div ref={canvasRef}/>
      <div className="textLayer" ref={textRef} tabIndex={0} aria-label="PDF 本页文字" onCopy={onCopy}/>
      {error && <div className="pdf-tile-error" role="alert"><FileWarning size={16}/>{error}</div>}
      {ready && <div className="highlight-layer" aria-hidden="true">{annotations.filter(annotation => annotation.page === page).flatMap(annotation => annotation.rects.map((rect, index) => <span key={`${annotation.id}-${index}`} className={`highlight-rect ${annotation.color} ${annotation.kind === 'region' ? 'region-annotation' : ''} ${focusedAnnotation === annotation.id ? 'focused' : ''}`} data-annotation={annotation.id} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}/>))}</div>}
      {ready && regionMode && <RegionSelection enabled={!selectionLocked} documentId={documentId} page={page} canvasRef={canvasRef} selection={selection} onSelection={onSelection}/>}
    </div>
    {captions && <div className="pdf-tile-caption">第 {page} 页</div>}
  </div>;
}
