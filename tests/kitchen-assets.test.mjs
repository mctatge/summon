import test from 'node:test';
import assert from 'node:assert/strict';
import { Group } from 'three';
import { createChef, animateChef } from '../src/renderer/agenttrail/chefs.js';
import { box, colors, contact, ground, material, random, resetArtCaches, tile, wood } from '../src/renderer/agenttrail/art.js';
import { disposeBatches } from '../src/renderer/agenttrail/batch.js';

// Geometry and animation use real Three objects. Only canvas drawing is stubbed:
// these tests do not need pixels, a WebGL context, or a browser process.
function fixture(t) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = {
    beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, ellipse() {},
    fill() {}, stroke() {}, fillRect() {}, strokeRect() {},
    createRadialGradient() { return { addColorStop() {} }; },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return {
          width: 0, height: 0,
          getContext(kind) { assert.equal(kind, '2d'); return context; },
        };
      },
    },
  });
  resetArtCaches();
  const root = new Group();
  t.after(() => {
    disposeBatches(root);
    root.clear();
    resetArtCaches();
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
  });
  return root;
}

function pose(root) {
  const transforms = [];
  root.traverse(node => transforms.push([
    ...node.position, ...node.quaternion, ...node.scale,
  ]));
  return transforms;
}

function assertFiniteTransforms(root, description) {
  root.updateMatrixWorld(true);
  root.traverse(node => {
    assert.ok([
      ...node.position, ...node.quaternion, ...node.scale, ...node.matrixWorld.elements,
    ].every(Number.isFinite), `${description}: ${node.type} transform must stay finite`);
  });
}

test('a walking chef advances toward its target without overshooting', t => {
  const root = fixture(t);
  const chef = createChef(root, 'walking-session');
  chef.target.set(4, 0, 3);
  const start = chef.root.position.clone();
  const startPose = pose(chef.root);
  let previousDistance = start.distanceTo(chef.target);

  animateChef(chef, 0.25, 1 / 30);
  assert.ok(chef.root.position.distanceTo(start) > 0, 'an active frame must move the chef');
  assert.ok(chef.root.position.distanceTo(chef.target) < previousDistance);
  assert.notDeepEqual(pose(chef.root), startPose, 'walking animates the rig');

  for (let frame = 1; frame <= 100; frame++) {
    animateChef(chef, 0.25 + frame / 30, 1 / 30);
    const distance = chef.root.position.distanceTo(chef.target);
    assert.ok(distance <= previousDistance + 1e-12, 'walking must not move away from its target');
    assert.ok(chef.root.position.x <= chef.target.x + 1e-12);
    assert.ok(chef.root.position.z <= chef.target.z + 1e-12);
    previousDistance = distance;
  }
  assert.ok(previousDistance < 0.04, 'bounded frames should reach the target tolerance');
  assertFiniteTransforms(chef.root, 'walking');

  chef.target.copy(chef.root.position).addScalar(0.1);
  animateChef(chef, 10, 5);
  assert.ok(chef.root.position.distanceTo(chef.target) < 1e-12, 'a long frame must stop at the target');
});

test('pause preserves an active pose even after target and state updates, then movement resumes', t => {
  const root = fixture(t);
  const chef = createChef(root, 'paused-session', 1);
  chef.state = 'writing';
  chef.atWorktop = true;
  animateChef(chef, 0.7, 1 / 30);
  assert.equal(chef.utensil.visible, true, 'start with the active chopping pose');
  const frozenPose = pose(chef.root);
  chef.target.set(3, 0, -2);
  chef.state = 'permission';
  chef.selected = true;

  for (const reduced of [false, true]) {
    animateChef(chef, 25, 1, reduced, true);
    assert.deepEqual(pose(chef.root), frozenPose, 'paused joints and position must not reset or snap');
    assert.equal(chef.attention.visible, true, 'permission feedback remains current while paused');
  }
  const distance = chef.root.position.distanceTo(chef.target);
  chef.atWorktop = false;
  animateChef(chef, 26, 1 / 30, false, false);
  assert.ok(chef.root.position.distanceTo(chef.target) < distance, 'unpausing must resume movement');
  assertFiniteTransforms(chef.root, 'resumed');
});

test('reduced motion snaps to targets and keeps every supported state finite and still', t => {
  const root = fixture(t);
  const workingStates = ['reading', 'writing', 'executing', 'working'];
  const states = [...workingStates, 'permission', 'input', 'error', 'quiet', 'idle', 'complete', 'offline', 'interrupted', 'unknown'];
  for (let index = 0; index < 12; index++) {
    const chef = createChef(root, `reduced-${index}`, index);
    for (const state of states) {
      chef.state = state;
      chef.atWorktop = workingStates.includes(state);
      chef.root.position.set(-2, 0, -3);
      chef.target.set(index / 2, 0, 1);
      animateChef(chef, 1, 1 / 30, true);
      assert.ok(chef.root.position.equals(chef.target), `${state} must snap to its target`);
      assertFiniteTransforms(chef.root, `${index}/${state}`);
      assert.equal(chef.attention.visible, ['permission', 'input', 'error'].includes(state));
      assert.equal(chef.utensil.visible, state === 'writing');
      assert.equal(chef.spoon.visible, state === 'executing');
      const stillPose = pose(chef.root);
      animateChef(chef, 99, 1 / 30, true);
      assert.deepEqual(pose(chef.root), stillPose, `${state} must not bob or animate in reduced motion`);
    }
  }
});

test('cache reset releases shared resources once and allows a fresh kitchen to be created', t => {
  const root = fixture(t);
  const firstRandomSequence = [random(), random(), random()];
  const primitive = box(root, 1, 2, 3, colors.wood);
  const sharedMaterial = material(colors.wood);
  const generatedMaterials = [wood(), tile(), ground(), contact(root, 0, 0, 1, 1).material];
  const resources = new Set([
    primitive.geometry, sharedMaterial, ...generatedMaterials,
    ...generatedMaterials.map(item => item.map),
  ]);
  const disposalCounts = new Map();
  for (const resource of resources) {
    disposalCounts.set(resource, 0);
    resource.addEventListener('dispose', () => disposalCounts.set(resource, disposalCounts.get(resource) + 1));
  }

  // The renderer owns clones; releasing vendor caches must not dispose them.
  const ownedGeometry = primitive.geometry.clone();
  const ownedMaterial = generatedMaterials[0].clone();
  ownedMaterial.map = generatedMaterials[0].map.clone();
  let ownedDisposals = 0;
  for (const resource of [ownedGeometry, ownedMaterial, ownedMaterial.map]) {
    resource.addEventListener('dispose', () => ownedDisposals++);
    t.after(() => resource.dispose());
  }

  root.clear();
  resetArtCaches();
  for (const count of disposalCounts.values()) assert.equal(count, 1);
  assert.equal(ownedDisposals, 0, 'scene-owned copies survive shared cache cleanup');
  assert.deepEqual([random(), random(), random()], firstRandomSequence, 'a fresh kitchen gets a stable procedural seed');
  resetArtCaches();
  for (const count of disposalCounts.values()) assert.equal(count, 1, 'an empty reset must not redispose old resources');

  const replacement = box(root, 1, 2, 3, colors.wood);
  assert.notEqual(replacement.geometry, primitive.geometry);
  assert.notEqual(material(colors.wood), sharedMaterial);
  const newGenerated = [wood(), tile(), ground(), contact(root, 0, 0, 1, 1).material];
  newGenerated.forEach((next, index) => {
    assert.notEqual(next, generatedMaterials[index]);
    assert.notEqual(next.map, generatedMaterials[index].map);
  });
  const chef = createChef(root, 'after-reset', 2);
  chef.target.set(-2, 0, 1);
  animateChef(chef, 0.4, 1 / 30);
  assert.ok(chef.root.position.length() > 0, 'a new chef remains usable after disposal');
  assertFiniteTransforms(chef.root, 'after cache reset');
});
