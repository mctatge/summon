import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Focus, Minus, Plus, RotateCcw } from 'lucide-react';
import { resizeWorkTreeView, type TreeViewport, type ViewSize } from './work-tree-camera.mjs';
import { FullscreenButton } from './FullscreenButton';
import { applyMapWheel } from './map-wheel.mjs';
import './git-map-viewport.css';

export type GitMapViewportProps = {
  width: number;
  height: number;
  viewKey: string;
  children: React.ReactNode;
};
type Point = { x: number; y: number };
type Gesture = { view: TreeViewport; origin: Point; distance: number; count: number };
const MIN_ZOOM = .005;
const MAX_ZOOM = 2.4;
const PADDING = 24;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const editable = 'input, textarea, select, [contenteditable="true"], [data-map-no-pan]';

/** A fitted overview, readable reset, and the same navigation as the work tree. */
export function GitMapViewport({ width, height, viewKey, children }: GitMapViewportProps) {
  const helpId = useId();
  const canvas = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const zoomOutput = useRef<HTMLOutputElement>(null);
  const transform = useRef<TreeViewport>({ x: PADDING, y: PADDING, zoom: 1 });
  const dimensions = useRef({ width, height });
  dimensions.current = { width, height };
  const previousSize = useRef<ViewSize | null>(null);
  const initialViewPending = useRef(true);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const dragged = useRef(false);
  const [dragging, setDragging] = useState(false);

  const applyTransform = useCallback((value: TreeViewport) => {
    transform.current = value;
    if (world.current) {
      world.current.style.transform = `translate(${value.x}px, ${value.y}px) scale(${value.zoom})`;
      world.current.dataset.level = value.zoom < .36 ? 'distant' : value.zoom < .66 ? 'overview' : 'detail';
    }
    if (zoomOutput.current) zoomOutput.current.textContent = `${Math.round(value.zoom * 1000) / 10}%`;
  }, []);

  const reset = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const size = { width: element.clientWidth, height: element.clientHeight };
    previousSize.current = size;
    // Long lists stay at a readable scale; Fit is available when seeing every folder matters.
    applyTransform({ zoom: 1, x: Math.max(PADDING, (size.width - dimensions.current.width) / 2), y: PADDING });
  }, [applyTransform]);

  const fit = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const size = { width: element.clientWidth, height: element.clientHeight };
    const bounds = dimensions.current;
    const zoom = clamp(Math.min(Math.max(1, size.width - PADDING * 2) / Math.max(1, bounds.width), Math.max(1, size.height - PADDING * 2) / Math.max(1, bounds.height)), MIN_ZOOM, 1);
    applyTransform({ zoom, x: (size.width - bounds.width * zoom) / 2, y: (size.height - bounds.height * zoom) / 2 });
  }, [applyTransform]);

  const zoom = useCallback((factor: number, center?: Point) => {
    const element = viewport.current;
    if (!element) return;
    const previous = transform.current;
    const next = clamp(previous.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const point = center ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    const ratio = next / previous.zoom;
    applyTransform({ zoom: next, x: point.x - (point.x - previous.x) * ratio, y: point.y - (point.y - previous.y) * ratio });
  }, [applyTransform]);

  useLayoutEffect(() => {
    const element = viewport.current;
    const size = element && { width: element.clientWidth, height: element.clientHeight };
    initialViewPending.current = !size?.width || !size?.height;
    if (size && !initialViewPending.current) {
      reset();
      previousSize.current = size;
    }
  }, [viewKey, reset]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const size = { width: element.clientWidth, height: element.clientHeight };
      if (size.width <= 0 || size.height <= 0) return;
      if (initialViewPending.current || !previousSize.current?.width || !previousSize.current?.height) {
        reset();
        initialViewPending.current = false;
      } else applyTransform(resizeWorkTreeView(transform.current, previousSize.current, size));
      previousSize.current = size;
    });
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest(editable)) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      applyTransform(applyMapWheel(transform.current, event, { width: element.clientWidth, height: element.clientHeight }, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [applyTransform, reset]);

  const local = (event: React.PointerEvent): Point => {
    const bounds = viewport.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const beginGesture = useCallback(() => {
    const points = [...pointers.current.values()];
    gesture.current = points.length ? {
      view: { ...transform.current }, count: points.length,
      origin: points.length > 1 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0],
      distance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0,
    } : null;
  }, []);
  const forgetPointer = useCallback((pointerId: number) => {
    if (!pointers.current.delete(pointerId)) return;
    beginGesture();
    if (!pointers.current.size) setDragging(false);
  }, [beginGesture]);
  useEffect(() => {
    // A press on a child button retains normal clicks; still clean up if released outside the map.
    const end = (event: PointerEvent) => forgetPointer(event.pointerId);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, [forgetPointer]);

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest(editable)) return;
    if (!pointers.current.size) dragged.current = false;
    pointers.current.set(event.pointerId, local(event));
    beginGesture();
    if (!(event.target as Element).closest('button, a, summary, [role="button"]')) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
    }
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, local(event));
    const points = [...pointers.current.values()];
    const start = gesture.current;
    if (points.length > 1 && start.count > 1) {
      const middle = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const next = clamp(start.view.zoom * Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / Math.max(1, start.distance), MIN_ZOOM, MAX_ZOOM);
      const ratio = next / start.view.zoom;
      dragged.current = true;
      applyTransform({ zoom: next, x: middle.x - (start.origin.x - start.view.x) * ratio, y: middle.y - (start.origin.y - start.view.y) * ratio });
    } else {
      const dx = points[0].x - start.origin.x;
      const dy = points[0].y - start.origin.y;
      if (Math.hypot(dx, dy) > 5) dragged.current = true;
      if (dragged.current) applyTransform({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
    }
    if (dragged.current) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
  };
  const pointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    forgetPointer(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboard = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target as Element).closest(editable)) return;
    const movement: Record<string, Point> = { ArrowLeft: { x: 64, y: 0 }, ArrowRight: { x: -64, y: 0 }, ArrowUp: { x: 0, y: 64 }, ArrowDown: { x: 0, y: -64 } };
    if (movement[event.key]) {
      event.preventDefault();
      const delta = movement[event.key];
      applyTransform({ ...transform.current, x: transform.current.x + delta.x, y: transform.current.y + delta.y });
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
    else if (event.key === '-') { event.preventDefault(); zoom(.8); }
    else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); fit(); }
  };
  const revealFocused = (event: React.FocusEvent<HTMLDivElement>) => {
    if (pointers.current.size || event.target === event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const target = event.target.getBoundingClientRect();
    const dx = target.left < bounds.left + PADDING ? bounds.left + PADDING - target.left : target.right > bounds.right - PADDING ? bounds.right - PADDING - target.right : 0;
    const dy = target.top < bounds.top + PADDING ? bounds.top + PADDING - target.top : target.bottom > bounds.bottom - PADDING ? bounds.bottom - PADDING - target.bottom : 0;
    if (dx || dy) applyTransform({ ...transform.current, x: transform.current.x + dx, y: transform.current.y + dy });
  };

  return <div ref={canvas} className="git-map">
    <div className="git-map-toolbar" role="group" aria-label="Git map controls" onKeyDown={keyboard}>
      <button type="button" className="git-map-control" onClick={() => zoom(.8)} aria-label="Zoom out"><Minus size={15} aria-hidden="true" /></button>
      <output ref={zoomOutput} className="git-map-zoom" aria-label="Zoom level" aria-live="off">100%</output>
      <button type="button" className="git-map-control" onClick={() => zoom(1.25)} aria-label="Zoom in"><Plus size={15} aria-hidden="true" /></button>
      <button type="button" className="git-map-control" onClick={fit}><Focus size={14} aria-hidden="true" />Fit view</button>
      <button type="button" className="git-map-control" onClick={reset}><RotateCcw size={13} aria-hidden="true" />Reset view</button>
      <FullscreenButton target={canvas} label="Git map" />
    </div>
    <div ref={viewport} className={`git-map-viewport${dragging ? ' is-dragging' : ''}`} tabIndex={0} role="region" aria-label="Interactive Git map" aria-describedby={helpId} onKeyDown={keyboard} onFocus={revealFocused} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={event => { if (event.target === event.currentTarget) forgetPointer(event.pointerId); }} onClickCapture={event => {
      if (dragged.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); dragged.current = false; }
    }}>
      <div ref={world} className="git-map-world" data-level="detail" style={{ width, height }}>{children}</div>
    </div>
    <p id={helpId} className="git-map-help">Drag or two-finger scroll to move · Pinch to zoom · Arrow keys to move · + / − to zoom · 0 to fit</p>
  </div>;
}
