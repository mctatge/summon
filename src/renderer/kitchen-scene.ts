import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createChef, animateChef, apronColors } from './agenttrail/chefs.js';
import { batchMeshes } from './agenttrail/batch.js';
import { ball, bell, board, box, bunting, colors, counter, cylinder, group, ingredient, material, plant, plaque, plate, pot, recipe, resetArtCaches, rod, sink, stove, torus, wood } from './agenttrail/art.js';
import type { AgentSession } from './types';

export type KitchenSceneController = {
  update: (sessions: AgentSession[], selected: string | null) => void;
  setPaused: (paused: boolean) => void;
  setReducedMotion: (reduced: boolean) => void;
  resetCamera: () => void;
  dispose: () => void;
};
type Options = { onSelect: (key: string) => void; onError: (message: string) => void };
type Chef = ReturnType<typeof createChef>;
type WorkSpot = 'prep' | 'stove';
type Cook = {
  chef: Chef; resources: OwnedResources; session: AgentSession; slot: number;
  route: T.Vector3[]; spot: WorkSpot; dwell: number; number: number;
  badge: T.Sprite; badgeCanvas: HTMLCanvasElement; badgeTexture: T.CanvasTexture;
  ordinaryRing: T.MeshStandardMaterial; selectedRing: T.MeshStandardMaterial;
};
type Steam = { mesh: T.Mesh<T.SphereGeometry, T.MeshBasicMaterial>; origin: T.Vector3; phase: number; slot: number };

const POSITIONS = [-3.75, -2.25, -.75, .75, 2.25, 3.75];
const PREP_Z = -1.78;
const STOVE_Z = -.04;
const PASS_Z = 2.85;
const SIDE_X = 5.38;
const FRONT_AISLE_Z = 3.8;
const FRAME_MS = 1000 / 30;
let activeScenes = 0;

/** Agenttrail's art library intentionally caches primitives and materials. Never
 * put those shared originals on a renderer: copy GPU resources per scene/rig so
 * removing one cook or remounting the panel cannot invalidate another scene. */
class OwnedResources {
  geometries = new Set<T.BufferGeometry>();
  materials = new Set<T.Material>();
  textures = new Set<T.Texture>();
  geometry<G extends T.BufferGeometry>(value: G): G { this.geometries.add(value); return value; }
  mat<M extends T.Material>(value: M): M { this.materials.add(value); return value; }
  texture<X extends T.Texture>(value: X): X { this.textures.add(value); return value; }
  adopt(root: T.Object3D) {
    const geometries = new Map<T.BufferGeometry, T.BufferGeometry>();
    const materials = new Map<T.Material, T.Material>();
    const textures = new Map<T.Texture, T.Texture>();
    const cloneMaterial = (original: T.Material) => {
      let copy = materials.get(original);
      if (copy) return copy;
      copy = this.mat(original.clone()); materials.set(original, copy);
      for (const [key, value] of Object.entries(copy)) {
        if (!(value instanceof T.Texture)) continue;
        let texture = textures.get(value);
        if (!texture) { texture = this.texture(value.clone()); textures.set(value, texture); }
        (copy as unknown as Record<string, unknown>)[key] = texture;
      }
      return copy;
    };
    root.traverse(object => {
      if (!(object instanceof T.Mesh)) return;
      const geometry = geometries.get(object.geometry) || this.geometry<T.BufferGeometry>(object.geometry.clone());
      geometries.set(object.geometry, geometry);
      object.geometry = geometry;
      object.material = Array.isArray(object.material) ? object.material.map(cloneMaterial) : cloneMaterial(object.material);
    });
  }
  dispose() {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.geometries.clear(); this.materials.clear(); this.textures.clear();
  }
}

const point = (x: number, z: number) => new T.Vector3(x, 0, z);
const needsYou = (session: AgentSession) => session.activity === 'needs-you';
const working = (session: AgentSession) => session.activity === 'working';
const failed = (session: AgentSession) => session.activity === 'failed';
const rigState = (session: AgentSession) => failed(session) ? 'error' : needsYou(session) ? 'input' : working(session) ? 'working' : 'quiet';
const destination = (cook: Cook) => point(POSITIONS[cook.slot], working(cook.session) ? cook.spot === 'prep' ? PREP_Z : STOVE_Z : PASS_Z);

/** The two worktops occupy the back and middle rows. All cross-row travel goes
 * through a side aisle, then the clear front aisle, never through a counter. */
function routeBetween(from: T.Vector3, to: T.Vector3, slot: number): T.Vector3[] {
  const result: T.Vector3[] = [];
  const side = (Math.abs(from.x) > 5 ? Math.sign(from.x) : slot < 3 ? -1 : 1) * SIDE_X;
  const fromFront = from.z > 2.25;
  const toFront = to.z > 2.25;
  const inSideAisle = from.z > .1 && from.z <= 2.25;
  if (inSideAisle) {
    result.push(point(side, from.z), point(side, toFront ? FRONT_AISLE_Z : STOVE_Z));
    if (toFront) result.push(point(to.x, FRONT_AISLE_Z));
  } else if (fromFront && !toFront) {
    result.push(point(from.x, FRONT_AISLE_Z), point(side, FRONT_AISLE_Z), point(side, STOVE_Z));
  } else if (!fromFront && toFront) {
    result.push(point(side, from.z), point(side, FRONT_AISLE_Z), point(to.x, FRONT_AISLE_Z));
  } else if (fromFront && toFront && Math.abs(from.x - to.x) > .1) {
    result.push(point(from.x, FRONT_AISLE_Z), point(to.x, FRONT_AISLE_Z));
  }
  result.push(to.clone());
  let previous = from;
  return result.filter(candidate => { const keep = candidate.distanceTo(previous) > .025; if (keep) previous = candidate; return keep; });
}

function makeRoom(parent: T.Group) {
  // A cutaway toy kitchen: warm checker tiles, timber joinery, turquoise worktops.
  box(parent, 13, .42, 9.5, 0xa76736, 0, -.23, -.05, .22);
  box(parent, 12.78, .12, 9.28, 0xe7b971, 0, .005, -.05, .12);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 12; z++) {
    box(parent, .777, .035, .755, (x + z) % 2 ? 0xf2d69c : 0xfff2d0, (x - 7.5) * .79, .08, (z - 5.5) * .77 - .05, .007);
  }
  // Low side wall keeps the foreground and the walking lanes visible.
  box(parent, 13, 3.4, .22, 0xffe8bb, 0, 1.68, -4.64, .10);
  box(parent, 13.08, .16, .34, wood(), 0, 3.43, -4.64, .04);
  box(parent, .18, .62, 9.15, 0xe6c58b, -6.38, .37, -.05, .04);
  box(parent, .26, .12, 9.22, wood(), -6.38, .73, -.05, .035);
  for (const x of [-6.37, 6.37]) box(parent, .23, 3.5, .25, wood(), x, 1.7, -4.58, .035);
  for (let x = -5.8; x < 6; x += .61) for (let y = .8; y < 1.8; y += .33) box(parent, .59, .31, .025, (Math.round(x * 10) % 3) ? 0xb8ddd0 : 0x82bdba, x, y, -4.505, .012);
  const sign = group(parent, 0, 2.73, -4.42);
  box(sign, 4.3, .79, .12, wood(), 0, 0, -.03, .045);
  plaque(sign, 'SUMMON’S KITCHEN', 4.08, .61, 0, 0, .041, '#fff0cd', '#62462a');
  for (const x of [-5, -3.65, 3.65, 5]) {
    const shelf = group(parent, x, 2.05, -4.23);
    box(shelf, 1.15, .13, .66, wood(), 0, 0, 0, .035);
    for (const xx of [-.38, .38]) { rod(shelf, [xx, -.45, -.28], [xx, -.06, .24], .035, colors.trim); }
    for (let j = 0; j < 3; j++) {
      cylinder(shelf, .12, .13, .28 + j % 2 * .12, [0xdf9562, 0xf2d891, 0x81bdaa][j], (j - 1) * .31, .22, .02);
      cylinder(shelf, .135, .135, .055, colors.wood, (j - 1) * .31, .39 + j % 2 * .12, .02);
    }
  }
  // Six independent lanes let every cook visibly travel between prep and stove.
  const prep = counter(parent, 0, -3, 9.4, 1.3);
  const cooking = counter(parent, 0, 1.2, 9.4, 1.3);
  for (const [slot, x] of POSITIONS.entries()) {
    board(prep, x, .24); ingredient(prep, ['json', 'image', 'code'][slot % 3], x - .18, 1.26, .29, .67);
    const burner = stove(cooking, x, -.20);
    pot(burner, 0, .15, 0);
    if (slot % 2 === 0) plate(cooking, x + .57, 1.16, .40).scale.setScalar(.55);
  }
  plaque(prep, 'PREP', 1.1, .29, 0, .65, .68, '#986334', '#fff1ce');
  plaque(cooking, 'THE PASS', 1.65, .31, 0, .65, .68, '#986334', '#fff1ce');
  bell(cooking, 4.45, 1.18, .3);
  // Rounded turquoise refrigerator with inset doors and polished brass handles.
  const fridge = group(parent, -5.5, 0, -3.25);
  box(fridge, 1.12, 2.52, 1.17, 0x479b9b, 0, 1.3, 0, .15);
  box(fridge, 1.04, .82, .12, 0x7ec4bb, 0, 2.03, .61, .10);
  box(fridge, 1.04, 1.37, .12, 0x7ec4bb, 0, .90, .61, .10);
  for (const y of [1.93, 1.28]) box(fridge, .065, .32, .085, material(0xebcb82, { metalness: .5, roughness: .3 }), .35, y, .735, .025);
  plaque(fridge, 'FRESH', .57, .19, -.10, 2.15, .685, '#fff0cf', '#45766e');
  const wash = counter(parent, 5.46, -2.95, 1.2, 1.3); sink(wash);
  plant(parent, 5.72, -4.01, .83, true);
  // Keep the front-side corners clear of the pass-to-stove walking route.
  plant(parent, 5.98, 4.17, .92, true);
  plant(parent, -5.98, 4.17, .82);
  recipe(parent, -4.5, 1.19, -3.35);
  // Striped valance and little lamps make the room feel like the upstream toys.
  for (let i = 0; i < 17; i++) box(parent, .71, .12, .57, i % 2 ? 0xffefcf : 0xde7655, (i - 8) * .72, 3.53, -4.36, .03);
  for (const x of [-4.9, 4.9]) {
    rod(parent, [x, 3.42, -4.3], [x, 2.8, -3.76], .025, colors.dark);
    cylinder(parent, .10, .28, .25, colors.coral, x, 2.73, -3.76);
    ball(parent, .15, .07, .15, material(0xffedbd, { emissive: 0xffb951, emissiveIntensity: .7 }), x, 2.59, -3.76);
  }
  bunting(parent, [-5.9, 3.38, -4.16], [5.9, 3.38, -4.16]);
}

function drawBadge(cook: Cook) {
  const ctx = cook.badgeCanvas.getContext('2d');
  if (!ctx) return;
  const selected = cook.chef.selected;
  const tone = failed(cook.session) ? '#c84d39' : `#${cook.chef.color.toString(16).padStart(6, '0')}`;
  ctx.clearRect(0, 0, 128, 128);
  ctx.beginPath(); ctx.arc(64, 64, 51, 0, Math.PI * 2);
  ctx.fillStyle = selected ? '#fff0ab' : '#fff9e8'; ctx.fill();
  ctx.lineWidth = selected ? 10 : 8; ctx.strokeStyle = tone; ctx.stroke();
  ctx.fillStyle = '#483528'; ctx.font = '700 64px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(cook.number), 64, 67);
  cook.badgeTexture.needsUpdate = true;
}

export function createKitchenScene(host: HTMLElement, options: Options): KitchenSceneController {
  let renderer: T.WebGLRenderer;
  try { renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }); }
  catch { options.onError('This device could not start the 3D kitchen. Your sessions are still available below.'); return { update() {}, setPaused() {}, setReducedMotion() {}, resetCamera() {}, dispose() {} }; }

  activeScenes++;
  const canvas = renderer.domElement;
  canvas.className = 'vw-kitchen-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Interactive 3D kitchen. Drag to orbit, scroll to zoom, press 0 to reset, or 1 through 6 to select a cook.');
  canvas.style.touchAction = 'none';
  canvas.style.display = 'block';
  canvas.style.width = '100%'; canvas.style.height = '100%';
  host.appendChild(canvas);
  const scene = new T.Scene();
  scene.background = new T.Color(0xf4dcb0);
  const camera = new T.OrthographicCamera(-9, 9, 7, -7, .1, 90);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = false;
  controls.minPolarAngle = .36; controls.maxPolarAngle = Math.PI / 2.35;
  controls.minAzimuthAngle = -Math.PI / 2.5; controls.maxAzimuthAngle = Math.PI / 2.5;
  controls.minZoom = .75; controls.maxZoom = 2.5;
  controls.rotateSpeed = .6; controls.zoomSpeed = .7;
  const room = new T.Group(); scene.add(room);
  const characters = new T.Group(); characters.position.y = .115; scene.add(characters);
  const effects = new T.Group(); scene.add(effects);
  const roomResources = new OwnedResources();
  const effectResources = new OwnedResources();
  const cooks = new Map<string, Cook>();
  const steam: Steam[] = [];
  const order: string[] = [];
  const raycaster = new T.Raycaster();
  const pointer = new T.Vector2();
  const sun = new T.DirectionalLight(0xffe0ab, 3.2);
  let environmentTarget: T.WebGLRenderTarget | null = null;
  let disposed = false;
  let lost = false;
  let paused = false;
  let reduced = false;
  let inViewport = true;
  let frame: number | null = null;
  let lastFrame = 0;
  let animationTime = 0;
  let dirty = true;
  let width = 0;
  let height = 0;
  let observer: ResizeObserver | null = null;
  let intersection: IntersectionObserver | null = null;
  let down: { x: number; y: number; id: number; multiple: boolean } | null = null;
  let selectedKey: string | null = null;

  const visible = () => !disposed && !lost && !document.hidden && inViewport && width > 0 && height > 0;
  const animate = () => {
    if (paused || reduced) return false;
    for (const cook of cooks.values()) if (!failed(cook.session)) return true;
    return false;
  };
  const cancelFrame = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
  const fail = (error: unknown) => {
    if (disposed || lost) return;
    lost = true; cancelFrame();
    options.onError(`The 3D kitchen stopped rendering. ${error instanceof Error ? error.message : 'Your sessions are still available below.'}`);
  };
  const schedule = () => { if (visible() && frame === null && (dirty || animate())) frame = requestAnimationFrame(renderFrame); };
  const invalidate = () => { dirty = true; schedule(); };
  const setRoute = (cook: Cook) => {
    const target = destination(cook);
    cook.route = routeBetween(cook.chef.root.position, target, cook.slot);
    cook.chef.target.copy(cook.route[0] || target);
    cook.chef.atWorktop = working(cook.session) && cook.route.length === 0;
  };
  const staticPose = (cook: Cook) => {
    if (failed(cook.session)) cook.chef.target.copy(cook.chef.root.position);
    else { cook.chef.target.copy(destination(cook)); cook.chef.root.position.copy(cook.chef.target); }
    cook.route = [];
    cook.chef.atWorktop = working(cook.session);
    cook.chef.facing = working(cook.session) && cook.spot === 'prep' ? Math.PI : 0;
    cook.chef.pose = working(cook.session) ? cook.spot === 'prep' ? 'writing' : 'executing' : 'quiet';
  };
  const updateCook = (cook: Cook, dt: number) => {
    const chef = cook.chef;
    chef.state = rigState(cook.session);
    chef.selected = cook.session.key === selectedKey;
    if (!paused) {
      if (reduced) staticPose(cook);
      else if (failed(cook.session)) { cook.route = []; chef.target.copy(chef.root.position); chef.atWorktop = false; }
      else {
        const next = cook.route[0];
        chef.target.copy(next || destination(cook));
        const arrived = chef.root.position.distanceTo(chef.target) < .06;
        if (next && arrived) { cook.route.shift(); chef.target.copy(cook.route[0] || destination(cook)); }
        const atDestination = cook.route.length === 0 && chef.root.position.distanceTo(destination(cook)) < .06;
        chef.atWorktop = working(cook.session) && atDestination;
        if (atDestination) {
          chef.facing = working(cook.session) && cook.spot === 'prep' ? Math.PI : 0;
          if (working(cook.session)) {
            cook.dwell += dt;
            if (cook.dwell > (cook.spot === 'prep' ? 2.6 : 3.2)) {
              cook.spot = cook.spot === 'prep' ? 'stove' : 'prep'; cook.dwell = 0; setRoute(cook);
            }
          }
        }
      }
      chef.pose = working(cook.session) ? cook.spot === 'prep' ? 'writing' : 'executing' : chef.state;
    }
    // Cooking is an activity metaphor, not a claim that a particular tool ran.
    animateChef(chef, animationTime, dt * .72, reduced || failed(cook.session), paused);
    // animateChef reassigns a module-cached material. Replace it before rendering.
    chef.ring.material = chef.selected ? cook.selectedRing : cook.ordinaryRing;
    cook.badge.position.y = needsYou(cook.session) || failed(cook.session) ? 2.54 : 2.18;
  };
  function renderFrame(now: number) {
    frame = null;
    if (!visible()) { lastFrame = 0; return; }
    if (lastFrame && now - lastFrame < FRAME_MS) { schedule(); return; }
    const dt = lastFrame ? Math.min(.075, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    if (!paused && !reduced) animationTime += dt;
    try {
      let walkers = 0;
      for (const cook of cooks.values()) { updateCook(cook, dt); if (cook.route.length && !paused && !reduced && !failed(cook.session)) walkers++; }
      for (const puff of steam) {
        const cook = [...cooks.values()].find(item => item.slot === puff.slot);
        puff.mesh.visible = Boolean(cook && working(cook.session) && cook.chef.atWorktop && cook.spot === 'stove' && !reduced);
        if (!paused) {
          const phase = (animationTime * .48 + puff.phase) % 1;
          puff.mesh.position.copy(puff.origin).add(new T.Vector3(Math.sin(animationTime + puff.phase * 8) * .07, phase * .8, 0));
          puff.mesh.scale.setScalar(.7 + phase * 1.5);
          puff.mesh.material.opacity = (1 - phase) * .24;
        }
      }
      canvas.dataset.chefs = String(cooks.size);
      canvas.dataset.walking = String(walkers);
      canvas.dataset.motion = paused ? 'paused' : reduced ? 'reduced' : 'playing';
      renderer.render(scene, camera);
      dirty = false;
    } catch (error) { fail(error); return; }
    schedule();
  }
  const fitCamera = () => {
    if (!width || !height) return;
    camera.updateMatrixWorld();
    const inverse = camera.matrixWorldInverse;
    let horizontal = 0; let vertical = 0;
    // Fit the physical diorama in camera space, preserving its current orbit.
    for (const x of [-6.6, 6.6]) for (const y of [-.5, 3.75]) for (const z of [-4.8, 4.8]) {
      const projected = new T.Vector3(x, y, z).applyMatrix4(inverse);
      horizontal = Math.max(horizontal, Math.abs(projected.x)); vertical = Math.max(vertical, Math.abs(projected.y));
    }
    const aspect = width / height;
    const half = Math.max(vertical, horizontal / aspect) * 1.035;
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
    camera.updateProjectionMatrix();
  };
  const resetCamera = () => {
    if (disposed) return;
    controls.target.set(0, .9, -.1);
    camera.position.set(11, 15, 17); camera.zoom = 1;
    camera.lookAt(controls.target); controls.update(); fitCamera(); invalidate();
  };
  const resize = () => {
    if (disposed) return;
    const rect = host.getBoundingClientRect(); width = Math.round(rect.width); height = Math.round(rect.height);
    if (width <= 0 || height <= 0) { cancelFrame(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height, false); fitCamera(); invalidate();
  };
  const pick = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects([...cooks.values()].map(cook => cook.chef.root), true)) {
      let node: T.Object3D | null = hit.object;
      while (node && !node.userData.sessionKey) node = node.parent;
      if (node && cooks.has(node.userData.sessionKey)) return node.userData.sessionKey as string;
    }
    return null;
  };
  const pointerDown = (event: PointerEvent) => { if (down) { down.multiple = true; return; } down = { x: event.clientX, y: event.clientY, id: event.pointerId, multiple: false }; };
  const pointerMove = (event: PointerEvent) => { if (!down && visible()) canvas.style.cursor = pick(event) ? 'pointer' : 'grab'; };
  const pointerUp = (event: PointerEvent) => {
    const start = down;
    if (!start || start.id !== event.pointerId) return;
    down = null;
    if (!start.multiple && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5 && event.button === 0) {
      const key = pick(event); if (key) options.onSelect(key);
    }
  };
  const pointerCancel = () => { down = null; };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === '0') { event.preventDefault(); resetCamera(); }
    else if (/^[1-6]$/.test(event.key)) { const key = order[Number(event.key) - 1]; if (key) { event.preventDefault(); options.onSelect(key); } }
    else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); camera.zoom = T.MathUtils.clamp(camera.zoom * (event.key === '-' ? .88 : 1.12), controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix(); invalidate(); }
  };
  const visibilityChange = () => { lastFrame = 0; if (!visible()) cancelFrame(); else invalidate(); };
  const contextLost = (event: Event) => { event.preventDefault(); fail(new Error('The graphics context was lost. Reopen this view to try again.')); };
  const removeCook = (cook: Cook) => { cook.chef.root.removeFromParent(); cook.resources.dispose(); };

  const dispose = () => {
    if (disposed) return;
    disposed = true; cancelFrame(); observer?.disconnect(); intersection?.disconnect();
    document.removeEventListener('visibilitychange', visibilityChange);
    canvas.removeEventListener('webglcontextlost', contextLost);
    canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove);
    canvas.removeEventListener('pointerup', pointerUp); canvas.removeEventListener('pointercancel', pointerCancel); canvas.removeEventListener('keydown', keyDown);
    controls.removeEventListener('change', invalidate); controls.dispose();
    for (const cook of cooks.values()) removeCook(cook); cooks.clear();
    scene.clear(); roomResources.dispose(); effectResources.dispose();
    environmentTarget?.dispose(); sun.shadow.dispose();
    renderer.renderLists.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    activeScenes--;
    if (activeScenes === 0) resetArtCaches();
  };

  try {
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = T.SRGBColorSpace;
    const environment = new RoomEnvironment();
    const generator = new T.PMREMGenerator(renderer);
    try { environmentTarget = generator.fromScene(environment, .06); scene.environment = environmentTarget.texture; scene.environmentIntensity = .34; }
    finally { environment.dispose(); generator.dispose(); }
    scene.add(new T.HemisphereLight(0xfff2d7, 0xa1825c, 1.05));
    sun.position.set(-5, 14, 8); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -11; sun.shadow.camera.right = 11;
    sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10; sun.shadow.camera.near = .5; sun.shadow.camera.far = 36;
    sun.shadow.normalBias = .025; sun.shadow.bias = -.0002; sun.shadow.radius = 3;
    scene.add(sun);
    const fill = new T.DirectionalLight(0xc1eaff, .6); fill.position.set(7, 9, -4); scene.add(fill);
    makeRoom(room); batchMeshes(room); roomResources.adopt(room);
    const steamGeometry = effectResources.geometry(new T.SphereGeometry(.09, 8, 6));
    for (let slot = 0; slot < POSITIONS.length; slot++) for (let i = 0; i < 3; i++) {
      const mesh = new T.Mesh(steamGeometry, effectResources.mat(new T.MeshBasicMaterial({ color: 0xfff9e5, transparent: true, opacity: .2, depthWrite: false })));
      const origin = new T.Vector3(POSITIONS[slot], 1.92, 1);
      mesh.position.copy(origin); mesh.visible = false; effects.add(mesh); steam.push({ mesh, origin, phase: i / 3, slot });
    }
    controls.addEventListener('change', invalidate);
    canvas.addEventListener('webglcontextlost', contextLost);
    canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerCancel); canvas.addEventListener('keydown', keyDown);
    document.addEventListener('visibilitychange', visibilityChange);
    observer = new ResizeObserver(resize); observer.observe(host);
    if (typeof IntersectionObserver !== 'undefined') {
      intersection = new IntersectionObserver(entries => { inViewport = entries.some(entry => entry.isIntersecting); visibilityChange(); }); intersection.observe(host);
    }
    resetCamera(); resize();
  } catch (error) { fail(error); dispose(); }

  return {
    update(sessions, selected) {
      if (disposed || lost) return;
      try {
        const unique = [...new Map(sessions.slice(0, 6).map(session => [session.key, session])).values()];
        const keys = new Set(unique.map(session => session.key));
        for (const [key, cook] of cooks) if (!keys.has(key)) { removeCook(cook); cooks.delete(key); }
        selectedKey = selected; order.splice(0, order.length, ...unique.map(session => session.key));
        for (const [index, session] of unique.entries()) {
          let cook = cooks.get(session.key);
          if (!cook) {
            const occupied = new Set([...cooks.values()].map(item => item.slot));
            const slot = POSITIONS.findIndex((_, i) => !occupied.has(i));
            const resources = new OwnedResources();
            const chef = createChef(characters, session.key, index);
            chef.root.scale.setScalar(1.13); chef.root.userData.sessionKey = session.key;
            resources.adopt(chef.root);
            const ordinaryRing = chef.ring.material as T.MeshStandardMaterial;
            const selectedRing = resources.mat(ordinaryRing.clone()); selectedRing.color.setHex(0xffe9a0);
            const badgeCanvas = document.createElement('canvas'); badgeCanvas.width = 128; badgeCanvas.height = 128;
            const badgeTexture = resources.texture(new T.CanvasTexture(badgeCanvas)); badgeTexture.colorSpace = T.SRGBColorSpace;
            const badge = new T.Sprite(resources.mat(new T.SpriteMaterial({ map: badgeTexture, transparent: true, depthTest: false, depthWrite: false })));
            badge.scale.set(.46, .46, 1); badge.position.set(0, 2.18, 0); badge.renderOrder = 2; chef.root.add(badge);
            cook = { chef, resources, session, slot, route: [], spot: slot % 2 ? 'stove' : 'prep', dwell: -.45 * slot, number: index + 1, badge, badgeCanvas, badgeTexture, ordinaryRing, selectedRing };
            chefsInitialPose(cook);
            cooks.set(session.key, cook);
          }
          const changed = cook.session.activity !== session.activity;
          const oldColor = cook.chef.color;
          const nextColor = apronColors[index % apronColors.length];
          if (oldColor !== nextColor) {
            for (const mat of cook.resources.materials) if (mat instanceof T.MeshStandardMaterial && mat !== cook.selectedRing && mat.color.getHex() === oldColor) mat.color.setHex(nextColor);
            cook.chef.color = nextColor; cook.ordinaryRing.color.setHex(nextColor);
          }
          cook.number = index + 1; cook.session = session; cook.chef.selected = session.key === selected;
          if (changed) {
            cook.dwell = 0;
            if (working(session)) cook.spot = cook.slot % 2 ? 'stove' : 'prep';
            if (failed(session)) { cook.route = []; cook.chef.target.copy(cook.chef.root.position); cook.chef.atWorktop = false; }
            else setRoute(cook);
          }
          drawBadge(cook);
          // A paused frame reflects metadata and selection while retaining joints.
          updateCook(cook, 0);
        }
        invalidate();
      } catch (error) { fail(error); }
    },
    setPaused(value) { if (disposed || paused === value) return; paused = value; lastFrame = 0; invalidate(); },
    setReducedMotion(value) { if (disposed || reduced === value) return; reduced = value; lastFrame = 0; if (value && !paused) for (const cook of cooks.values()) staticPose(cook); invalidate(); },
    resetCamera,
    dispose,
  };

  function chefsInitialPose(cook: Cook) {
    const chef = cook.chef;
    chef.root.position.copy(destination(cook)); chef.target.copy(chef.root.position);
    chef.state = rigState(cook.session); chef.carrying = false;
    chef.atWorktop = working(cook.session);
    chef.facing = working(cook.session) && cook.spot === 'prep' ? Math.PI : 0;
    chef.root.rotation.y = chef.facing;
    chef.pose = working(cook.session) ? cook.spot === 'prep' ? 'writing' : 'executing' : chef.state;
    animateChef(chef, 0, 0, true, false);
    chef.ring.material = cook.ordinaryRing;
  }
}
