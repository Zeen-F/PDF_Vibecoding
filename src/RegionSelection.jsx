import React, { useEffect, useRef, useState } from 'react';

const MIN_EDGE = 8;
const clamp = value => Math.min(1, Math.max(0, value));
const pointAt = (event, bounds) => ({
  x: clamp((event.clientX - bounds.left) / bounds.width),
  y: clamp((event.clientY - bounds.top) / bounds.height),
});
function rectangle(from, to) {
  const x = Math.min(from.x, to.x), y = Math.min(from.y, to.y);
  return {
    x, y,
    width: Math.min(1 - x, Math.abs(from.x - to.x)),
    height: Math.min(1 - y, Math.abs(from.y - to.y)),
  };
}
function changedBounds(before, after) {
  return ['left', 'top', 'width', 'height'].some(key => Math.abs(before[key] - after[key]) > 0.5);
}
function cropPreview(canvas, rect) {
  if (!canvas?.width || !canvas?.height) return '';
  const left = Math.max(0, Math.floor(rect.x * canvas.width));
  const top = Math.max(0, Math.floor(rect.y * canvas.height));
  const right = Math.min(canvas.width, Math.ceil((rect.x + rect.width) * canvas.width));
  const bottom = Math.min(canvas.height, Math.ceil((rect.y + rect.height) * canvas.height));
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0) return '';
  const preview = canvas.ownerDocument.createElement('canvas');
  const scale = Math.min(1, 960 / Math.max(width, height));
  preview.width = Math.max(1, Math.round(width * scale));
  preview.height = Math.max(1, Math.round(height * scale));
  const context = preview.getContext('2d');
  if (!context) return '';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, preview.width, preview.height);
  context.drawImage(canvas, left, top, width, height, 0, 0, preview.width, preview.height);
  try { return preview.toDataURL('image/png'); } catch { return ''; }
}

/** Pointer coordinates and previews stay in the browser; only rects are saved. */
export default function RegionSelection({ enabled, documentId, page, canvasRef, selection, onSelection }) {
  const layerRef = useRef(null), dragRef = useRef(null), selectionRef = useRef(selection);
  const onSelectionRef = useRef(onSelection);
  const [dragRect, setDragRect] = useState(null);
  selectionRef.current = selection;
  onSelectionRef.current = onSelection;

  const cancelDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
    setDragRect(null);
  };
  useEffect(() => {
    if (!enabled) { cancelDrag(); return; }
    const layer = layerRef.current;
    const cancelInterruptedDrag = () => { if (dragRef.current) cancelDrag(); };
    const keydown = event => {
      if (event.key !== 'Escape') return;
      const draft = selectionRef.current;
      if (dragRef.current || (draft?.kind === 'region' && draft.documentId === documentId && draft.page === page)) {
        event.preventDefault();
        event.stopPropagation();
        cancelDrag();
        onSelectionRef.current(null);
      }
    };
    const observer = new ResizeObserver(() => {
      if (dragRef.current && changedBounds(dragRef.current.bounds, layer.getBoundingClientRect())) cancelDrag();
    });
    observer.observe(layer);
    window.document.addEventListener('keydown', keydown);
    window.addEventListener('blur', cancelInterruptedDrag);
    window.addEventListener('resize', cancelInterruptedDrag);
    return () => {
      observer.disconnect();
      window.document.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', cancelInterruptedDrag);
      window.removeEventListener('resize', cancelInterruptedDrag);
      cancelDrag();
    };
  }, [enabled, documentId, page]);

  const start = event => {
    if (!enabled || event.button !== 0 || !event.isPrimary || dragRef.current) return;
    const element = event.currentTarget, bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    onSelection(null);
    element.focus({ preventScroll: true });
    const origin = pointAt(event, bounds);
    dragRef.current = { pointerId: event.pointerId, bounds, origin, element };
    setDragRect(rectangle(origin, origin));
    try { element.setPointerCapture(event.pointerId); } catch { cancelDrag(); }
  };
  const move = event => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (changedBounds(drag.bounds, drag.element.getBoundingClientRect())) { cancelDrag(); return; }
    setDragRect(rectangle(drag.origin, pointAt(event, drag.bounds)));
  };
  const finish = event => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (changedBounds(drag.bounds, drag.element.getBoundingClientRect())) { cancelDrag(); return; }
    const rect = rectangle(drag.origin, pointAt(event, drag.bounds));
    cancelDrag();
    if (rect.width * drag.bounds.width < MIN_EDGE || rect.height * drag.bounds.height < MIN_EDGE) return;
    onSelection({
      documentId, page, kind: 'region', quote: '', rects: [rect],
      preview: cropPreview(canvasRef.current?.querySelector('canvas'), rect),
    });
  };
  const pending = selection?.kind === 'region' && selection.documentId === documentId && selection.page === page
    ? selection.rects[0] : null;
  const visible = dragRect || pending;
  return <div ref={layerRef} className={`region-selection-layer ${enabled ? 'enabled' : ''}`} role="group" aria-label="拖动框选批注区域" data-region-selection="true" tabIndex={enabled ? 0 : -1}
    onPointerDown={start} onPointerMove={move} onPointerUp={finish}
    onPointerCancel={cancelDrag} onLostPointerCapture={() => { if (dragRef.current) cancelDrag(); }}>
    {visible && <span className="region-draft-rect" aria-hidden="true"
      style={{ left: `${visible.x * 100}%`, top: `${visible.y * 100}%`, width: `${visible.width * 100}%`, height: `${visible.height * 100}%` }}/>}
  </div>;
}
