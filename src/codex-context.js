import { useEffect, useRef, useState } from 'react';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function readDeepLink(search = window.location.search) {
  const query = new URLSearchParams(search);
  const documentId = query.get('document');
  const rawPage = query.get('page');
  const page = rawPage === null ? undefined : /^[1-9]\d*$/.test(rawPage) && Number.isSafeInteger(Number(rawPage)) ? Number(rawPage) : null;
  return { documentId, page, invalid: (rawPage !== null && (!documentId || page === null)) || query.getAll('document').length > 1 || query.getAll('page').length > 1 };
}
function embeddedSettings() {
  const query = new URLSearchParams(window.location.search);
  if (query.get('embedded') !== '1' || window.parent === window) return {};
  const supplied = query.get('readerSession');
  let parentOrigin;
  try {
    const raw = query.get('parentOrigin'), parsed = new URL(raw);
    if (['http:', 'https:'].includes(parsed.protocol) && parsed.origin === raw && new URL(window.document.referrer).origin === parsed.origin) parentOrigin = parsed.origin;
  } catch { /* Sandboxed or missing origins keep the ordinary server context path. */ }
  return { parentOrigin, sessionId: UUID.test(supplied || '') ? supplied : undefined };
}

async function fitPreview(preview) {
  if (!preview?.startsWith('data:image/png;base64,')) throw new Error('区域预览暂不可用，请重新框选后再分享。');
  if (preview.length <= 2 * 1024 * 1024) return preview;
  const source = new Image(); source.src = preview; await source.decode();
  const canvas = window.document.createElement('canvas');
  let scale = .8;
  while (scale >= .1) {
    canvas.width = Math.max(1, Math.floor(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.floor(source.naturalHeight * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    const reduced = canvas.toDataURL('image/png');
    if (reduced.length <= 2 * 1024 * 1024) return reduced;
    scale *= .7;
  }
  throw new Error('这块区域的图片过大，请框选较小的区域再分享。');
}

// The same UUID survives React effects and back/forward cache restoration, but
// independent tabs get independent sessions. Shared selections are never stored.
export function useCodexContext({ document, page, selection, notesDirty, onDocument, onError }) {
  const [identity] = useState(() => { const embedded = embeddedSettings(); return { ...embedded, sessionId: embedded.sessionId || crypto.randomUUID() }; });
  const [shared, setShared] = useState(null), [status, setStatus] = useState('connecting');
  const [dismissed, setDismissed] = useState(false);
  const sharedSelection = shared && shared.source === selection && selection?.documentId === document?.id && selection.page === page ? shared.payload : null;
  const latest = useRef(null), sender = useRef(null), shareAttempt = useRef(0), localSelection = useRef(selection);
  localSelection.current = selection;
  latest.current = { document, page, selection: sharedSelection, shareId: sharedSelection ? shared.shareId : null, notesDirty, onDocument };
  useEffect(() => {
    let stopped = false, leaving = false, running = false, wanted = false, generation = 0;
    const endpoint = `/api/reader-sessions/${identity.sessionId}`;
    const publish = (state, selectionPresent) => {
      if (identity.parentOrigin) window.parent.postMessage({ type: 'paperdesk-context', context: {
        sessionId: identity.sessionId, documentId: state.document?.id || null, page: state.page,
        sharedSelection: selectionPresent, shareId: selectionPresent ? state.shareId : null, notesDirty: state.notesDirty,
      } }, identity.parentOrigin);
    };
    const send = async () => {
      wanted = true;
      if (running || stopped || leaving) return;
      running = true;
      while (wanted && !stopped && !leaving) {
        wanted = false;
        const state = latest.current, atGeneration = generation;
        if (!state.document) continue;
        try {
          const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            documentId: state.document.id, page: state.page, selection: state.selection,
            notesDirty: state.notesDirty, visible: window.document.visibilityState === 'visible',
          }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '阅读连接暂时不可用');
          if (!stopped && !leaving && atGeneration === generation && latest.current.document?.id === state.document.id) {
            setStatus(state.selection ? 'shared' : 'ready');
            state.onDocument(result.document, state.document.notesRevision);
            publish(state, Boolean(state.selection));
          }
        } catch {
          if (!stopped && !leaving && atGeneration === generation) setStatus('error');
        }
      }
      running = false;
      // A pagehide can happen while a POST is on the wire. Delete again after it
      // settles so that it cannot resurrect a session after the first DELETE.
      if (stopped || leaving) fetch(endpoint, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    sender.current = () => { generation++; void send(); };
    const clearShared = () => {
      shareAttempt.current++; setShared(null);
      latest.current = { ...latest.current, selection: null, shareId: null };
    };
    const visibility = () => {
      if (window.document.visibilityState === 'hidden') clearShared();
      generation++; void send();
    };
    const leave = () => {
      clearShared();
      leaving = true; generation++;
      const state = latest.current;
      if (state.document) publish(state, false);
      fetch(endpoint, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    const returnToPage = () => { leaving = false; generation++; void send(); };
    window.document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', leave); window.addEventListener('pageshow', returnToPage);
    const timer = setInterval(() => void send(), 3000);
    void send();
    return () => {
      stopped = true; clearInterval(timer); sender.current = null;
      window.document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', returnToPage);
      fetch(endpoint, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
  }, [identity]);
  useEffect(() => { sender.current?.(); }, [document?.id, page, sharedSelection, notesDirty]);
  const share = async () => {
    if (!selection || selection.documentId !== document?.id || selection.page !== page) return;
    const attempt = ++shareAttempt.current;
    try {
      const payload = { kind: selection.kind || 'text', text: selection.kind === 'region' ? '' : selection.quote, rects: selection.rects.map(rect => ({ ...rect })) };
      if (selection.kind === 'region') payload.preview = await fitPreview(selection.preview);
      if (attempt !== shareAttempt.current || localSelection.current !== selection) return;
      setShared({ source: selection, payload, shareId: crypto.randomUUID() }); setStatus('connecting'); setDismissed(false);
    } catch (error) { if (attempt === shareAttempt.current) onError?.(error.message); }
  };
  // Deriving selection above also clears it on the very first render after a
  // page/document/selection change, before the heartbeat can send an old quote.
  return { sessionId: identity.sessionId, status: sharedSelection && status === 'shared' ? 'shared' : status === 'shared' ? 'ready' : status,
    dismissed, dismiss: () => setDismissed(true), share, clear: () => { shareAttempt.current++; setShared(null); setDismissed(true); }, shared: Boolean(sharedSelection) };
}
