import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMapWheel, wheelPixels } from '../src/renderer/map-wheel.mjs';
const size = { width: 1000, height: 600 };
const point = { x: 320, y: 180 };
const event = patch => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...patch });
const view = { x: 70, y: 90, zoom: .8 };

test('vertical and horizontal scrolling move the canvas without changing zoom', () => {
  assert.deepEqual(applyMapWheel(view, event({ deltaX: 35, deltaY: 80 }), size, point), { x: 35, y: 10, zoom: .8 });
  assert.deepEqual(applyMapWheel(view, event({ deltaX: -35, deltaY: -80 }), size, point), { x: 105, y: 170, zoom: .8 });
  assert.deepEqual(view, { x: 70, y: 90, zoom: .8 });
});
test('scrolling moves the same screen distance at different zoom levels', () => {
  for (const zoom of [.005, .3, 1, 2.4]) {
    const next = applyMapWheel({ ...view, zoom }, event({ deltaY: 100 }), size, point);
    assert.equal(next.y, -10); assert.equal(next.zoom, zoom);
  }
});
test('pinch zooms around the pointer and reversing it restores the camera', () => {
  const next = applyMapWheel(view, event({ deltaY: -30, ctrlKey: true }), size, point);
  assert.ok(next.zoom > view.zoom);
  for (const axis of ['x', 'y']) assert.ok(Math.abs((point[axis] - view[axis]) / view.zoom - (point[axis] - next[axis]) / next.zoom) < 1e-9);
  const restored = applyMapWheel(next, event({ deltaY: 30, ctrlKey: true }), size, point);
  for (const key of ['x', 'y', 'zoom']) assert.ok(Math.abs(restored[key] - view[key]) < 1e-9);
});
test('pinch limits retain pointer anchor at both zoom bounds', () => {
  for (const [deltaY, expected] of [[10000, .005], [-10000, 2.4]]) {
    const next = applyMapWheel(view, event({ deltaY, ctrlKey: true }), size, point);
    assert.equal(next.zoom, expected);
    for (const axis of ['x', 'y']) assert.ok(Math.abs((point[axis] - view[axis]) / view.zoom - (point[axis] - next[axis]) / next.zoom) < 1e-8);
  }
});
test('line and page scrolling normalize each axis to screen pixels', () => {
  assert.deepEqual(wheelPixels(event({ deltaX: 2, deltaY: 3, deltaMode: 1 }), size), { x: 32, y: 48 });
  assert.deepEqual(wheelPixels(event({ deltaX: 1, deltaY: -1, deltaMode: 2 }), size), { x: 1000, y: -600 });
});
