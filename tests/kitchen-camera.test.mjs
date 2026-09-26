import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OrthographicCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { wheelPixels } from '../src/renderer/map-wheel.mjs';

const source = await readFile(new URL('../src/renderer/kitchen-scene.ts', import.meta.url), 'utf8');
const wheelBody = source.match(/const wheel = \(event: WheelEvent\) => \{([\s\S]*?)\n  \};/)?.[1];
assert.ok(wheelBody, 'The kitchen wheel adapter is available for the camera fixture.');
// Run the production wheel adapter with the real Three camera/controller, without
// a browser, WebGL renderer, or synthetic alternative camera implementation.
const createWheel = new Function('controls', 'canvas', 'wheelPixels', 'disposed', 'lost', `return event => {${wheelBody}}`);

function fixture(zoom = 1) {
  const document = new EventTarget();
  const canvas = Object.assign(new EventTarget(), { style: {}, ownerDocument: document, clientWidth: 800, clientHeight: 600, getRootNode: () => document });
  const camera = new OrthographicCamera(-12, 12, 9, -9, .1, 90);
  camera.position.set(11, 15, 17); camera.zoom = zoom; camera.updateProjectionMatrix();
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false; controls.enableDamping = false; controls.minZoom = .75; controls.maxZoom = 2.5; controls.zoomSpeed = .7;
  controls.target.set(0, .9, -.1); controls.update();
  const project = () => {
    camera.updateMatrixWorld();
    const point = new Vector3(0, 1, 0).project(camera);
    return { x: (point.x + 1) * canvas.clientWidth / 2, y: (1 - point.y) * canvas.clientHeight / 2 };
  };
  return { canvas, camera, controls, project, wheel: createWheel(controls, canvas, wheelPixels, false, false) };
}

test('kitchen scrolling pans in screen pixels without changing zoom', () => {
  for (const zoom of [1, 2]) {
    const scene = fixture(zoom);
    try {
      const before = scene.project(); let prevented = false; let stopped = false;
      scene.wheel({ ctrlKey: false, deltaX: 30, deltaY: 60, deltaMode: 0, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
      const after = scene.project();
      assert.ok(Math.abs(after.x - before.x + 30) < 1e-8, 'Scroll right moves the visible scene left.');
      assert.ok(Math.abs(after.y - before.y + 60) < 1e-8, 'Scroll down moves the visible scene up.');
      assert.equal(scene.camera.zoom, zoom);
      assert.equal(prevented, true); assert.equal(stopped, true, 'Ordinary scrolling must not also reach OrbitControls zoom.');
    } finally { scene.controls.dispose(); }
  }
});

test('kitchen pinch falls through to OrbitControls zoom without panning', () => {
  const scene = fixture();
  try {
    const target = scene.controls.target.clone();
    const pinch = new Event('wheel', { cancelable: true });
    Object.assign(pinch, { ctrlKey: true, deltaX: 0, deltaY: -5, deltaMode: 0, clientX: 400, clientY: 300 });
    scene.wheel(pinch);
    assert.equal(pinch.defaultPrevented, false, 'The kitchen adapter leaves pinch to OrbitControls.');
    scene.canvas.dispatchEvent(pinch);
    assert.ok(scene.camera.zoom > 1, 'The real OrbitControls wheel handler zooms in.');
    assert.ok(scene.controls.target.distanceTo(target) < 1e-8, 'Pinch does not translate the camera target.');
  } finally { scene.controls.dispose(); }
});
