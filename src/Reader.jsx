import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Highlighter, LoaderCircle, FileWarning, ListTree, ScanLine } from 'lucide-react';
import { readPdfSelection } from './selection.js';
import { groupGeometry, groupStart, PAGE_GAP, PAGE_LAYOUTS, readDisplayPreferences, saveDisplayPreferences } from './reader-layout.js';
import Contents from './Contents.jsx';
import PdfPage from './PdfPage.jsx';
import './regions.css';
import './reader-layout.css';
GlobalWorkerOptions.workerSrc = workerUrl;

const FALLBACK_PAGE = { width: 612, height: 792 };
const endpointLayer = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.pdf-paper .textLayer');

export default function Reader({ document, page, onPage, annotations, selection, onSelection, selectionLocked, find, focusedAnnotation, focusTick, tocOpen, onToggleToc }) {
  const [preferences, setPreferences] = useState(readDisplayPreferences);
  const { mode, count, zoom } = preferences;
  const [pdf, setPdf] = useState(null), [loadedId, setLoadedId] = useState(null), [error, setError] = useState('');
  const [viewport, setViewport] = useState({ width: 650, height: 650 });
  const [dimensions, setDimensions] = useState(() => new Map()), [fallback, setFallback] = useState(FALLBACK_PAGE);
  const [readyPages, setReadyPages] = useState(() => new Set());
  const [pageInput, setPageInput] = useState(String(page)), [regionMode, setRegionMode] = useState(false), [selectionError, setSelectionError] = useState('');
  const [visibleWindow, setVisibleWindow] = useState({ first: 0, last: 2 });
  const scrollRef = useRef(null), readerRef = useRef(null), tocButtonRef = useRef(null);
  const tiles = useRef(new Map()), groupsRef = useRef([]), scrollFrame = useRef(0), selectionFrame = useRef(0), dragging = useRef(false);
  const internalPage = useRef(null), pendingJump = useRef(null), jumpInFlight = useRef(null);
  const latest = useRef(null);
  latest.current = { documentId: document.id, page, onPage, onSelection, selection, selectionLocked, regionMode, mode, count, pageCount: document.pageCount };
  const currentStart = groupStart(page, count), currentIndex = (currentStart - 1) / count;
  const groups = useMemo(() => Array.from({ length: Math.ceil(document.pageCount / count) }, (_, index) => groupGeometry({
    start: index * count + 1, pageCount: document.pageCount, count, zoom,
    width: viewport.width, height: viewport.height, dimensions, fallback,
  })), [document.pageCount, count, zoom, viewport, dimensions, fallback]);
  const busy = !pdf || loadedId !== document.id || !readyPages.has(page);

  useEffect(() => { saveDisplayPreferences(preferences); }, [preferences]);
  useEffect(() => { setPageInput(String(page)); }, [page]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const measure = () => {
      const style = getComputedStyle(element);
      const width = Math.max(24, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      // Reserve the page footer; captions are included in groupGeometry.
      const height = Math.max(48, element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 36);
      setViewport(value => Math.abs(value.width - width) < .5 && Math.abs(value.height - height) < .5 ? value : { width, height });
    };
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    setPdf(null); setLoadedId(null); setError(''); setReadyPages(new Set()); setDimensions(new Map()); setFallback(FALLBACK_PAGE); setRegionMode(false); setSelectionError('');
    tiles.current.clear(); groupsRef.current = []; internalPage.current = null;
    pendingJump.current = { page: latest.current.page, documentId: document.id };
    const task = getDocument({ url: `/api/documents/${document.id}/file`, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/', isEvalSupported: false });
    task.promise.then(async value => {
      const first = await value.getPage(1);
      if (!alive) return;
      const base = first.getViewport({ scale: 1 });
      setFallback({ width: base.width, height: base.height }); setLoadedId(document.id); setPdf(value);
    }).catch(err => { if (alive) setError(`无法打开 PDF：${err.message}`); });
    return () => { alive = false; task.destroy().catch(() => {}); };
  }, [document.id]);

  const registerTile = useCallback((number, record, previous) => {
    if (record) tiles.current.set(number, record);
    else if (tiles.current.get(number) === previous) tiles.current.delete(number);
  }, []);
  const markReady = useCallback((number, value) => {
    setReadyPages(previous => {
      const ready = value === true || value === 'error';
      if (previous.has(number) === ready) return previous;
      const next = new Set(previous); ready ? next.add(number) : next.delete(number); return next;
    });
  }, []);
  const rememberDimensions = useCallback((number, value) => {
    setDimensions(previous => {
      const old = previous.get(number);
      if (old?.width === value.width && old?.height === value.height) return previous;
      const next = new Map(previous); next.set(number, value); return next;
    });
  }, []);
  const clearSelection = useCallback(() => {
    if (latest.current.selectionLocked) return;
    window.getSelection()?.removeAllRanges(); latest.current.onSelection(null); setSelectionError('');
  }, []);
  const syncPage = useCallback((number, source) => {
    const state = latest.current;
    if (state.selectionLocked || number < 1 || number > state.pageCount) return;
    internalPage.current = number;
    if (state.page !== number) state.onPage(number, { source });
  }, []);
  const acceptSelection = useCallback(value => {
    const state = latest.current;
    if (state.selectionLocked || (value && value.documentId !== state.documentId)) return;
    if (value) { pendingJump.current = null; jumpInFlight.current = null; syncPage(value.page, 'selection'); }
    const previous = state.selection;
    // Pointer/key release also samples when a preview action is clicked. Keep
    // the confirmed source identity if its text and page geometry did not change.
    if (value?.kind === 'text' && previous?.kind === 'text'
      && value.documentId === previous.documentId && value.page === previous.page && value.quote === previous.quote
      && value.rects.length === previous.rects.length
      && value.rects.every((rect, index) => ['x', 'y', 'width', 'height'].every(key => Math.abs(rect[key] - previous.rects[index][key]) < 1e-8))) return;
    state.onSelection(value);
  }, [syncPage]);
  const activateTile = useCallback(number => {
    if (!latest.current.selectionLocked) { pendingJump.current = null; jumpInFlight.current = null; syncPage(number, 'selection'); }
  }, [syncPage]);
  const getPdfSelection = useCallback(() => {
    const native = window.getSelection();
    if (!native?.rangeCount || native.isCollapsed) return { result: null, crossPage: false };
    let layer;
    for (let index = 0; index < native.rangeCount; index++) {
      const range = native.getRangeAt(index);
      const start = endpointLayer(range.startContainer), end = endpointLayer(range.endContainer);
      if (!start && !end) continue;
      // Separate pages must never become a partial-page quote.
      if (!start || start !== end || (layer && layer !== start)) return { result: null, crossPage: true };
      layer = start;
    }
    if (!layer) return { result: null, crossPage: false };
    const paper = layer.closest('.pdf-paper'), number = Number(paper.dataset.page), record = tiles.current.get(number);
    if (!record?.ready || record.documentId !== latest.current.documentId || record.text !== layer) return { result: null, crossPage: false };
    const quote = readPdfSelection(layer, paper, native);
    return { result: quote ? { documentId: latest.current.documentId, page: number, kind: 'text', ...quote } : null, crossPage: false };
  }, []);
  useEffect(() => {
    const owner = window.document;
    const capture = () => {
      selectionFrame.current = 0;
      if (latest.current.selectionLocked || latest.current.regionMode) return;
      const { result, crossPage } = getPdfSelection();
      setSelectionError(crossPage ? '请在同一页内选择文字。跨页选区不能保存为批注。' : '');
      acceptSelection(result);
    };
    const schedule = () => { cancelAnimationFrame(selectionFrame.current); selectionFrame.current = requestAnimationFrame(capture); };
    const down = event => {
      if (event.target.closest?.('.region-selection-layer') && scrollRef.current.contains(event.target)) { dragging.current = true; return; }
      const layer = endpointLayer(event.target);
      if (!layer || !scrollRef.current.contains(layer) || latest.current.regionMode) return;
      dragging.current = true; layer.classList.add('selecting');
    };
    const finish = () => {
      dragging.current = false;
      for (const tile of tiles.current.values()) tile.text.classList.remove('selecting');
      schedule();
    };
    owner.addEventListener('selectionchange', schedule); owner.addEventListener('pointerdown', down);
    owner.addEventListener('pointerup', finish); owner.addEventListener('keyup', finish); window.addEventListener('blur', finish);
    return () => {
      cancelAnimationFrame(selectionFrame.current);
      owner.removeEventListener('selectionchange', schedule); owner.removeEventListener('pointerdown', down);
      owner.removeEventListener('pointerup', finish); owner.removeEventListener('keyup', finish); window.removeEventListener('blur', finish);
    };
  }, [getPdfSelection, acceptSelection]);
  const copySelection = event => {
    if (regionMode) return;
    const { result } = getPdfSelection();
    if (result && event.clipboardData) { event.clipboardData.setData('text/plain', result.quote); event.preventDefault(); }
  };
  // Region rectangles survive zoom/resize. Replaced text layers cannot retain
  // native character endpoints, so clear only an unlocked text draft.
  useEffect(() => {
    if (!latest.current.selectionLocked && latest.current.selection?.kind === 'text') clearSelection();
  }, [viewport.width, viewport.height, zoom, clearSelection]);

  const updateScrollWindow = useCallback(() => {
    const element = scrollRef.current, nodes = groupsRef.current;
    if (!element || latest.current.mode !== 'continuous' || !nodes.length) return;
    const indexAt = position => {
      let low = 0, high = nodes.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((nodes[middle]?.offsetTop || 0) <= position) low = middle; else high = middle - 1;
      }
      return low;
    };
    const first = indexAt(element.scrollTop + 1), last = indexAt(element.scrollTop + element.clientHeight - 1);
    const windowValue = { first: Math.max(0, first - 1), last: Math.min(nodes.length - 1, last + 1) };
    setVisibleWindow(value => value.first === windowValue.first && value.last === windowValue.last ? value : windowValue);
    const state = latest.current;
    if (state.selectionLocked || state.selection || dragging.current || jumpInFlight.current) return;
    const bounds = element.getBoundingClientRect();
    const candidates = [...tiles.current.values()].filter(tile => {
      const rect = tile.paper.getBoundingClientRect();
      return rect.bottom > bounds.top + 2 && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right;
    }).map(tile => {
      const rect = tile.paper.getBoundingClientRect();
      return { page: tile.page, distance: Math.abs(rect.top - bounds.top - 24) };
    }).sort((a, b) => a.distance - b.distance || (a.page === state.page ? -1 : b.page === state.page ? 1 : a.page - b.page));
    if (candidates.length) syncPage(candidates[0].page, 'scroll');
  }, [syncPage]);
  const scheduleScroll = useCallback(() => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = 0; updateScrollWindow(); });
  }, [updateScrollWindow]);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  useLayoutEffect(() => { if (pdf) scheduleScroll(); }, [pdf, groups, mode, readyPages, visibleWindow.first, visibleWindow.last, scheduleScroll]);

  const scrollToPage = useCallback(number => {
    const root = scrollRef.current, target = tiles.current.get(number)?.paper;
    const group = groupsRef.current[Math.floor((number - 1) / latest.current.count)];
    const element = target || group;
    if (!root || !element) return;
    const bounds = root.getBoundingClientRect(), rect = element.getBoundingClientRect();
    const style = getComputedStyle(root), topPadding = parseFloat(style.paddingTop), leftPadding = parseFloat(style.paddingLeft);
    const targetGroup = zoom === 'fit' || zoom === 'page' ? group || element : element;
    const targetRect = targetGroup.getBoundingClientRect();
    root.scrollTo({ top: root.scrollTop + targetRect.top - bounds.top - topPadding, left: Math.max(0, root.scrollLeft + rect.left - bounds.left - leftPadding), behavior: 'instant' });
    scheduleScroll();
  }, [zoom, scheduleScroll]);
  useLayoutEffect(() => {
    if (!pdf) return;
    if (internalPage.current === page) { internalPage.current = null; return; }
    pendingJump.current = { page, documentId: document.id }; jumpInFlight.current = page;
    setVisibleWindow({ first: Math.max(0, currentIndex - 1), last: Math.min(groups.length - 1, currentIndex + 1) });
    scrollToPage(page);
  }, [pdf, document.id, page, currentIndex, mode, count, scrollToPage]);
  useLayoutEffect(() => {
    const target = pendingJump.current;
    if (!target || target.documentId !== document.id || !pdf) return;
    scrollToPage(target.page);
    if (readyPages.has(target.page)) {
      pendingJump.current = null;
      requestAnimationFrame(() => { if (!pendingJump.current && jumpInFlight.current === target.page) jumpInFlight.current = null; });
    }
  }, [readyPages, pdf, document.id, groups, scrollToPage]);
  useEffect(() => {
    if (selectionLocked || !readyPages.has(page)) return;
    const tile = tiles.current.get(page);
    if (focusedAnnotation) {
      const target = [...tile?.paper.querySelectorAll('[data-annotation]') || []].find(element => element.dataset.annotation === focusedAnnotation);
      target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } else if (find) tile?.text.querySelector('.search-match')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [focusedAnnotation, focusTick, find, readyPages, page, selectionLocked]);

  const navigate = useCallback(next => {
    const state = latest.current;
    if (state.selectionLocked || next < 1 || next > state.pageCount) return;
    clearSelection(); pendingJump.current = { page: next, documentId: state.documentId }; jumpInFlight.current = next;
    state.onPage(next); scrollToPage(next);
    // Enter/blur on the already active page need no React page update, but must
    // still release the programmatic-scroll guard for later wheel navigation.
    if (state.page === next && tiles.current.get(next)?.ready) {
      pendingJump.current = null;
      requestAnimationFrame(() => { if (!pendingJump.current && jumpInFlight.current === next) jumpInFlight.current = null; });
    }
  }, [clearSelection, scrollToPage]);
  useEffect(() => {
    const handler = event => {
      const state = latest.current;
      if (state.mode !== 'paged' || state.selectionLocked || state.selection || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.target.closest('input,textarea,select,button,[contenteditable="true"]')) return;
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!direction) return;
      const next = groupStart(state.page, state.count) + direction * state.count;
      if (next >= 1 && next <= state.pageCount) { event.preventDefault(); navigate(next); }
    };
    window.document.addEventListener('keydown', handler); return () => window.document.removeEventListener('keydown', handler);
  }, [navigate]);
  const gotoInput = () => {
    if (selectionLocked) { setPageInput(String(page)); return; }
    const next = Number(pageInput);
    if (Number.isInteger(next) && next >= 1 && next <= document.pageCount) navigate(next); else setPageInput(String(page));
  };
  const changeDisplay = patch => {
    if (selectionLocked) return;
    if (Object.entries(patch).every(([key, value]) => preferences[key] === value)) return;
    if (patch.mode || patch.count) clearSelection(); else if (selection?.kind !== 'region') clearSelection();
    setPreferences(value => ({ ...value, ...patch }));
    pendingJump.current = { page, documentId: document.id }; jumpInFlight.current = page;
  };
  const closeToc = () => { if (selectionLocked) return; onToggleToc(false); tocButtonRef.current?.focus(); };
  const jumpFromToc = next => { navigate(next); if (readerRef.current.clientWidth <= 700) closeToc(); };
  const toggleRegion = () => { if (!busy && !selectionLocked) { clearSelection(); setRegionMode(value => !value); } };
  const pinnedIndex = selection?.documentId === document.id ? Math.floor((selection.page - 1) / count) : null;
  const mounted = mode === 'paged' ? [currentIndex] : groups.map((_, index) => index).filter(index => (index >= visibleWindow.first && index <= visibleWindow.last) || index === pinnedIndex || index === currentIndex);
  const mountedSet = new Set(mounted);
  const shownGroups = mode === 'paged' ? groups.slice(currentIndex, currentIndex + 1) : groups;
  return <section className={`reader reader-${mode} ${regionMode ? 'region-mode' : ''}`} aria-label="PDF 阅读器" ref={readerRef}>
    <div className="reader-toolbar">
      <div className="reader-navigation"><button ref={tocButtonRef} className={`contents-toggle ${tocOpen ? 'selected' : ''}`} aria-label={tocOpen ? '收起目录' : '展开目录'} aria-expanded={tocOpen} disabled={selectionLocked} onClick={() => onToggleToc(!tocOpen)}><ListTree size={16}/><span>目录</span></button><div className="pager"><button className="icon-button" aria-label="上一页" disabled={currentStart <= 1 || busy || selectionLocked} onClick={() => navigate(Math.max(1, currentStart - count))}><ChevronLeft size={17}/></button><input aria-label="页码" type="number" min="1" max={document.pageCount} value={pageInput} disabled={selectionLocked} onChange={event => setPageInput(event.target.value)} onBlur={gotoInput} onKeyDown={event => { if (event.key === 'Enter') gotoInput(); }}/><span>/ {document.pageCount}</span><button className="icon-button" aria-label="下一页" disabled={currentStart + count > document.pageCount || busy || selectionLocked} onClick={() => navigate(currentStart + count)}><ChevronRight size={17}/></button></div></div>
      <span className="reader-hint">{regionMode ? <><ScanLine size={14}/> 拖动框选区域 · Esc 取消</> : <><Highlighter size={14}/> 选中文字，留下想法</>}</span>
      <div className="reader-tools"><select aria-label="翻页方式" value={mode} disabled={selectionLocked} onChange={event => changeDisplay({ mode: event.target.value })}><option value="paged">左右翻页</option><option value="continuous">上下连续</option></select><select aria-label="页面布局" value={count} disabled={selectionLocked} onChange={event => { const next = Number(event.target.value); changeDisplay({ count: next, zoom: next > 1 ? 'page' : 'fit' }); }}>
        {PAGE_LAYOUTS.map(value => <option key={value} value={value}>{value} 页</option>)}
      </select><button className="region-toggle" aria-label="区域批注" aria-pressed={regionMode} disabled={busy || selectionLocked} onClick={toggleRegion}><ScanLine size={16}/><span>区域批注</span></button><select aria-label="阅读缩放" value={zoom} disabled={selectionLocked} onChange={event => changeDisplay({ zoom: event.target.value })}><option value="fit">适合宽度</option><option value="page">适合整屏</option><option value="0.8">80%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></div>
    </div>
    <div className="reader-body">
      {tocOpen && <Contents key={document.id} document={document} page={page} onJump={jumpFromToc} onClose={closeToc}/>}
      <div className="pdf-scroll" ref={scrollRef} onScroll={scheduleScroll}>
        {busy && !error && <div className="reader-status" role="status"><LoaderCircle className="spin" size={17}/> 正在排版页面…</div>}
        {error && <div className="reader-error" role="alert"><FileWarning/><p>{error}</p><button onClick={() => window.location.reload()}>重新加载</button></div>}
        {pdf && loadedId === document.id && shownGroups.map(group => {
          const index = (group.start - 1) / count;
          return <div className={`pdf-group ${mountedSet.has(index) ? '' : 'pdf-group-unmounted'}`} key={group.start} data-group-start={group.start} ref={node => { groupsRef.current[index] = node; }} style={{ width: group.width, minHeight: group.height, gridTemplateColumns: group.columnWidths.map(value => `${value}px`).join(' '), gap: PAGE_GAP }}>
            {mountedSet.has(index) ? group.pages.map(geometry => <PdfPage key={`${document.id}:${geometry.page}`} pdf={pdf} documentId={document.id} geometry={geometry} layoutCount={count} captions={count > 1} annotations={annotations} focusedAnnotation={focusedAnnotation} find={find} regionMode={regionMode} selection={selection} selectionLocked={selectionLocked} onSelection={acceptSelection} onRegister={registerTile} onReady={markReady} onDimensions={rememberDimensions} onActivate={activateTile} onCopy={copySelection}/>) : <div className="pdf-group-placeholder" aria-label={`第 ${group.start} 至 ${group.pages.at(-1).page} 页`} style={{ gridColumn: '1 / -1', height: group.height }}>第 {group.start}{group.pages.length > 1 ? `–${group.pages.at(-1).page}` : ''} 页</div>}
          </div>;
        })}
        {selectionError && <p className="pdf-selection-error" role="status">{selectionError}</p>}
        {!document.textAvailable && <p className="scan-notice">这份 PDF 没有可提取的文字。点击“区域批注”，拖动框选图片、公式或文字区域并添加评论；仍可写笔记。区域批注不会识别图片中的文字。</p>}
        <div className="page-footer">{document.filename} <span>·</span> {page} / {document.pageCount}</div>
      </div>
    </div>
  </section>;
}
