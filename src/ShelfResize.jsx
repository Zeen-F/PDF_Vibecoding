import React, { useEffect, useRef, useState } from 'react';
import { shelfPreview } from './ShelfPreview.jsx';

export function useShelfResize() {
  const [width, setWidth] = useState(null);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  useEffect(() => {
    if (!shelfPreview) return;
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const maximum = Math.min(400, Math.max(200, viewport - 440));
  const current = Math.min(width ?? (viewport <= 1050 ? 210 : 244), maximum);
  const update = value => setWidth(Math.max(200, Math.min(maximum, Math.round(value))));
  const finish = () => { drag.current = null; setDragging(false); };
  return {
    style: shelfPreview ? { width: current } : undefined,
    separator: shelfPreview && <div
      className={`shelf-resizer${dragging ? ' dragging' : ''}`}
      role="separator" tabIndex={0} aria-label="调整文献栏宽度"
      aria-orientation="vertical" aria-valuemin={200} aria-valuemax={maximum}
      aria-valuenow={current}
      title="拖动调整宽度，双击恢复默认；也可使用左右方向键"
      onDoubleClick={() => setWidth(null)}
      onKeyDown={event => {
        const value = { ArrowLeft: current - 16, ArrowRight: current + 16, Home: 200, End: maximum }[event.key];
        if (value !== undefined) { event.preventDefault(); update(value); }
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, left: event.currentTarget.parentElement.getBoundingClientRect().left };
        setDragging(true);
      }}
      onPointerMove={event => {
        if (drag.current?.pointer === event.pointerId) update(event.clientX - drag.current.left);
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    />,
  };
}
