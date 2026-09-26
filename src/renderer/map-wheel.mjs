/** Chromium reports a trackpad pinch as a wheel event with ctrlKey set. */
export function wheelPixels(event, size) {
  return {
    x: event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.width : 1),
    y: event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1),
  };
}

export function applyMapWheel(view, event, size, point) {
  const delta = wheelPixels(event, size);
  if (!event.ctrlKey) return { ...view, x: view.x - delta.x, y: view.y - delta.y };
  const zoom = Math.max(.005, Math.min(2.4, view.zoom * Math.exp(-delta.y * .008)));
  const ratio = zoom / view.zoom;
  return { zoom, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
