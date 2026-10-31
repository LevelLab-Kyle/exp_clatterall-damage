// ---------------------------------------------------------------------------
// Renderer, scene, cameras
// ---------------------------------------------------------------------------

const canvas = document.getElementById('scene');
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdff1ff);

// One side-on perspective camera, looking straight down -Z at the X/Y plane.
// It backs off so the board plane (z = 0) shows PX_PER_UNIT pixels per cell
// at 1× zoom, which keeps pan, zoom and grid snapping in board units.
const PX_PER_UNIT = 72;
const CAMERA_FOV = 30;
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 500);
const view = { cx: 8, cy: 4, zoom: 1 };

// Selection outline, matching the platform builder: three's outline pass
// finds the selected object's silhouette (visible and hidden edges alike) and
// adds it over the finished picture in the accent color.
const OUTLINE = { edgeStrength: 3, edgeGlow: 0, edgeThickness: 1 };
const accent = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim());
const composer = new THREE.EffectComposer(renderer);
const renderPass = new THREE.RenderPass(scene, camera);
const outlinePass = new THREE.OutlinePass(new THREE.Vector2(1, 1), scene, camera);
Object.assign(outlinePass, OUTLINE);
outlinePass.pulsePeriod = 0;
// Solid accent: the pass normally adds the edge color onto the picture, which
// washes out on a light sky. Use white edges as a mask and paint the accent
// over the frame with that mask as alpha instead.
outlinePass.visibleEdgeColor.set(0xffffff);
outlinePass.hiddenEdgeColor.set(0xffffff);
outlinePass.overlayMaterial.blending = THREE.NormalBlending;
outlinePass.overlayMaterial.uniforms.outlineColor = { value: accent };
outlinePass.overlayMaterial.fragmentShader = `
  uniform sampler2D maskTexture;
  uniform sampler2D edgeTexture1;
  uniform sampler2D edgeTexture2;
  uniform float edgeStrength;
  uniform float edgeGlow;
  uniform vec3 outlineColor;
  varying vec2 vUv;
  void main() {
    float mask = texture2D(maskTexture, vUv).r;
    float edge = texture2D(edgeTexture1, vUv).r + texture2D(edgeTexture2, vUv).r * edgeGlow;
    gl_FragColor = vec4(outlineColor, clamp(edgeStrength * mask * edge, 0.0, 1.0));
  }`;
outlinePass.overlayMaterial.needsUpdate = true;
composer.addPass(renderPass);
composer.addPass(outlinePass);
composer.addPass(new THREE.OutputPass());

// Lights
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8a98a, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 120;
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

// Ground: a one-voxel-deep strip at y <= 0, as long as the board.
const FLOOR_LEN = 2000;
const FLOOR_DEPTH = 3;
const floor = new THREE.Mesh(
  new THREE.BoxGeometry(FLOOR_LEN, FLOOR_DEPTH, 1),
  new THREE.MeshStandardMaterial({ color: 0x9ccf6b, roughness: 0.9 })
);
floor.position.set(0, -FLOOR_DEPTH / 2, 0);
floor.receiveShadow = true;
scene.add(floor);

// An infinite grid drawn in a shader using world coordinates. Only the lines
// are drawn; the sky behind is the scene background.
const GRID_STRENGTH = 0.9;
const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(FLOOR_LEN, FLOOR_LEN),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false, // pieces behind the grid's plane still show through it
    uniforms: { uLine: { value: new THREE.Color(0xb9d4e8) }, uGrid: { value: GRID_STRENGTH } },
    vertexShader: `
      varying vec2 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xy;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform vec3 uLine; uniform float uGrid;
      varying vec2 vWorld;
      void main() {
        vec2 g = abs(fract(vWorld - 0.5) - 0.5) / fwidth(vWorld);
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        // Fainter quarter lines between, fading out as they crowd together
        // when zoomed out.
        vec2 q = vWorld * 4.0;
        vec2 gq = abs(fract(q - 0.5) - 0.5) / fwidth(q);
        float quarter = 1.0 - min(min(gq.x, gq.y), 1.0);
        float room = smoothstep(6.0, 14.0, 1.0 / max(fwidth(q).x, fwidth(q).y));
        float a = max(line, quarter * 0.35 * room) * uGrid;
        if (vWorld.y < 0.0) a = 0.0; // the ground covers below y = 0
        gl_FragColor = vec4(uLine, a);
      }`,
  })
);
// The grid sits on the back plane, behind the pieces.
backdrop.position.z = -0.5;
scene.add(backdrop);

// Ghost preview when dragging.
const ghostMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------

const items = new Map(); // id -> item
const occupied = new Map(); // "i,j" subgrid cell -> id (see footprintCells)
let nextId = 1;
let selected = null;
let playing = false;

const key = (x, y) => `${x},${y}`;

function canPlace(type, x, y, rot = 0, ignoreId = null, size = null) {
  return footprintCells(type, x, y, rot, size).every(([cx, cy]) => {
    if (cy < 0) return false;
    const id = occupied.get(key(cx, cy));
    return id == null || id === ignoreId;
  });
}

// The free spot nearest to where a gadget was dropped. `ax, ay` is its
// un-snapped position, so it slides toward whichever side it was closer to.
// Spots are on the subgrid, up to 8 cells away.
const snapSub = (v) => Math.round(v * SUB) / SUB;
// Drops land on the quarter-cell subgrid (DROP_STEPS per cell), on the
// nearest free spot up to 8 cells away.
const DROP_STEPS = SUB;
function nearestFree(type, ax, ay, rot = 0, ignoreId = null, size = null) {
  return nearestFreeStep(type, ax, ay, rot, ignoreId, size, DROP_STEPS);
}

function nearestFreeStep(type, ax, ay, rot, ignoreId, size, sub) {
  const snap = (v) => Math.round(v * sub) / sub;
  const x0 = snap(ax), y0 = Math.max(0, snap(ay));
  const spots = [];
  for (let r = 0; r <= 8 * sub; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx / sub, y = y0 + dy / sub;
        if (y >= 0) spots.push({ x, y, d: Math.hypot(x - ax, y - ay) });
      }
    }
  }
  spots.sort((a, b) => a.d - b.d);
  return spots.find((s) => canPlace(type, s.x, s.y, rot, ignoreId, size)) || null;
}

const applyTransform = placeMesh;

// Gadget visuals may be a single mesh or a group; these apply to every mesh inside.
function eachMesh(obj, fn) {
  obj.traverse((o) => { if (o.isMesh) fn(o); });
}

function setHighlight(item, on) {
  eachMesh(item.mesh, (m) => {
    if (!m.material.emissive) return;
    if (m.userData.baseEmissive === undefined) m.userData.baseEmissive = m.material.emissive.getHex();
    m.material.emissive.setHex(on ? 0x444444 : m.userData.baseEmissive);
  });
}

// Remember where every sub-part sits so Reset can put moving parts back.
function storeRest(obj) {
  obj.traverse((o) => { o.userData.rest = { p: o.position.clone(), q: o.quaternion.clone() }; });
}

function restoreRest(obj) {
  obj.traverse((o) => { if (o.userData.rest) { o.position.copy(o.userData.rest.p); o.quaternion.copy(o.userData.rest.q); } });
}

const cellsOf = (item) => footprintCells(item.type, item.x, item.y, item.rot, item.size);

const sameSize = (a, b) => (a?.w ?? 1) === (b?.w ?? 1) && (a?.h ?? 1) === (b?.h ?? 1) && (a?.off ?? 0) === (b?.off ?? 0);

// Locked items are a level's own pieces: the player can't move or remove them.
function addItem(type, x, y, rot = 0, flip = false, size = null, locked = false) {
  const item = { id: nextId++, type, x, y, rot, flip, size, locked, parts: null };
  item.mesh = GADGETS[type].makeMesh(item);
  items.set(item.id, item);
  cellsOf(item).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  applyTransform(item);
  storeRest(item.mesh);
  setHighlight(item, false); // records each mesh's base glow
  item.mesh.userData.itemId = item.id;
  scene.add(item.mesh);
  scheduleSave();
  updateTrayCounts();
  return item;
}

function moveItem(item, x, y, rot = item.rot, flip = item.flip, size = item.size) {
  cellsOf(item).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  item.x = x;
  item.y = y;
  item.rot = rot;
  const reshaped = flip !== item.flip || !sameSize(size, item.size);
  item.size = size; // even at the same width and height, its Size step may differ
  if (reshaped) {
    // A mirrored or resized shape needs its own geometry: rebuild the mesh in place.
    item.flip = flip;
    scene.remove(item.mesh);
    tweens.delete(item.mesh);
    item.mesh = GADGETS[item.type].makeMesh(item);
    item.mesh.userData.itemId = item.id;
    scene.add(item.mesh);
    storeRest(item.mesh);
    setHighlight(item, false);
    if (selected === item) outlinePass.selectedObjects = [item.mesh];
  }
  cellsOf(item).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  applyTransform(item);
  scheduleSave();
}

function removeItem(item) {
  cellsOf(item).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  items.delete(item.id);
  tweens.delete(item.mesh);
  scene.remove(item.mesh);
  if (selected === item) select(null);
  scheduleSave();
  updateTrayCounts();
}

function select(item) {
  selected = item;
  outlinePass.selectedObjects = selected ? [selected.mesh] : [];
  if (!item) itemTools.hidden = true; // right away, not on the next frame
}

function clearBoard() {
  [...items.values()].forEach(removeItem);
}

// ---------------------------------------------------------------------------
// Undo / redo: a snapshot of the board is taken before every edit.
// ---------------------------------------------------------------------------

const history = { undo: [], redo: [] };
const HISTORY_LIMIT = 100;

function snapshot() {
  return [...items.values()].map((i) => ({ type: i.type, x: i.x, y: i.y, rot: i.rot, flip: !!i.flip, size: i.size ? { ...i.size } : null, locked: !!i.locked }));
}

// Call before changing the board.
function recordEdit() {
  history.undo.push(snapshot());
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
  updateHistoryButtons();
}

// Older saves have long ramps (now a 2x1 ramp) and separate left-facing
// ramps and conveyors (now the same gadget, flipped).
function upgradeEntry(s) {
  if (s.type === 'longramp') s = { ...s, type: 'ramp', size: { w: 2, h: 1 } };
  if (s.type === 'rampL' || s.type === 'conveyorL') s = { ...s, type: s.type.slice(0, -1), flip: true };
  return s;
}

function restore(snap) {
  finishTweens();
  clearBoard();
  for (const s of snap) addItem(s.type, s.x, s.y, s.rot, s.flip, s.size || null, !!s.locked);
}

function undo() {
  if (playing || !history.undo.length) return;
  history.redo.push(snapshot());
  restore(history.undo.pop());
  updateHistoryButtons();
}

function redo() {
  if (playing || !history.redo.length) return;
  history.undo.push(snapshot());
  restore(history.redo.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  btnUndo.disabled = playing || !history.undo.length;
  btnRedo.disabled = playing || !history.redo.length;
}

// ---------------------------------------------------------------------------
// Progress is kept in localStorage, saved (debounced) after every board
// change or view move:
// - SAVE_KEY: the Sandbox board, view and example name.
// - LEVELS_KEY: the open mode and level, levels done, and the parts the
//   player has placed in each level.
// ---------------------------------------------------------------------------

const SAVE_KEY = 'clatterall-damage.save.v1';
const LEVELS_KEY = 'clatterall-damage.levels.v1';

// The game used to be called Clatter Lab: copy any saves from the old keys
// once, so players keep their progress after the rename.
try {
  for (const k of ['save.v1', 'levels.v1', 'lock-y']) {
    const old = localStorage.getItem('clatter-lab.' + k);
    if (old !== null && localStorage.getItem('clatterall-damage.' + k) === null) {
      localStorage.setItem('clatterall-damage.' + k, old);
    }
    localStorage.removeItem('clatter-lab.' + k);
  }
} catch {}
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 250);
}

function saveProgress() {
  saveTimer = null;
  const level = currentLevel();
  if (level) levelBoards[level.name] = snapshot().filter((s) => !s.locked).map(({ locked, ...s }) => s);
  try {
    if (!level) {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        items: snapshot().map(({ locked, ...s }) => s),
        view: { cx: view.cx, cy: view.cy, zoom: view.zoom },
        example: examplesSelect.value,
      }));
    }
    localStorage.setItem(LEVELS_KEY, JSON.stringify({
      mode,
      level: LEVELS[levelIndex].name,
      done: [...levelsDone],
      boards: levelBoards,
    }));
  } catch { /* private mode or storage full: just don't save */ }
}

// Returns true if a saved board was restored.
function loadProgress() {
  let data;
  try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return false; }
  if (!data || !Array.isArray(data.items)) return false;
  clearBoard();
  for (const s of data.items.map(upgradeEntry)) {
    if (GADGETS[s.type] && canPlace(s.type, s.x, s.y, s.rot || 0, null, s.size || null)) addItem(s.type, s.x, s.y, s.rot || 0, !!s.flip, s.size || null);
  }
  if (data.view) { view.cx = data.view.cx; view.cy = data.view.cy; view.zoom = data.view.zoom; }
  if (data.example && EXAMPLES[data.example]) examplesSelect.value = data.example;
  return true;
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

let world = null;
let won = false;

function startPlay() {
  select(null);
  finishTweens();
  won = false;
  scene.updateMatrixWorld(true);
  world = buildWorld([...items.values()], { onImpact, onBell: onBellHit, onGoal: onGoalHit });

  playing = true;
  canvas.classList.remove('hover');
  document.body.classList.add('playing');
  updateHistoryButtons();
  btnPlay.hidden = true;
  btnReset.hidden = false;
}

function stopPlay() {
  playing = false;
  audioArmed = false;
  lastImpact.clear();
  canvas.classList.remove('hover');
  won = false;
  world = null;
  for (const item of items.values()) {
    item.parts = null;
    restoreRest(item.mesh);
    applyTransform(item);
    setHighlight(item, false);
  }
  document.body.classList.remove('playing');
  updateHistoryButtons();
  btnPlay.hidden = false;
  btnReset.hidden = true;
  toast.hidden = true;
  hideWin();
}

function onGoalHit(star) {
  if (won) return;
  won = true;
  eachMesh(star.mesh, (m) => m.material.emissive?.set(0xffaa00));
  toast.textContent = '⭐ You did it!';
  toast.hidden = false;
  playSound('win', 0.8);
  if (currentLevel()) levelWon();
}

// ---------------------------------------------------------------------------
// Sounds (assets/sounds.js). Only play during a run the user started with
// the Play button or Space, so scripted/synchronous runs stay silent.
// ---------------------------------------------------------------------------

const sounds = {};
for (const [key, b64] of Object.entries(typeof SOUND_DATA === 'undefined' ? {} : SOUND_DATA)) {
  sounds[key] = new Audio('data:audio/mpeg;base64,' + b64);
  sounds[key].preload = 'auto';
}
let audioArmed = false; // true during a user-started run
const lastImpact = new Map(); // body -> time of its last sound

function playSound(key, volume = 1) {
  if (!audioArmed || !sounds[key]) return;
  const a = sounds[key].cloneNode();
  a.volume = Math.min(1, Math.max(0, volume));
  a.play().catch(() => {});
}

function onBellHit(item, ev) {
  const speed = Math.abs(ev.contact.getImpactVelocityAlongNormal());
  if (speed < 1) return;
  const now = performance.now();
  if (now - (lastImpact.get(item) || 0) < 250) return;
  lastImpact.set(item, now);
  GADGETS[item.type].ring(item);
  playSound('ding', Math.min(1, 0.4 + speed / 10));
}

// Pick a sound for a collision by what hit what, scaled by how hard.
function onImpact(body, ev) {
  if (!audioArmed) return;
  const speed = Math.abs(ev.contact.getImpactVelocityAlongNormal());
  if (speed < 2) return;
  const now = performance.now();
  if (now - (lastImpact.get(body) || 0) < 90) return;
  lastImpact.set(body, now);
  const other = ev.body;
  if (other.material === MATS.bell) return; // the bell rings instead
  const bouncy = body.material === MATS.bouncy || other.material === MATS.bouncy;
  const heavy = body.mass >= 3 || other.mass >= 3;
  playSound(bouncy ? 'boing' : heavy ? 'thud' : 'tap', Math.min(1, 0.2 + speed / 12));
}

const _invQ = new THREE.Quaternion();
const _bodyQ = new THREE.Quaternion();
function syncPart(item, part) {
  const target = part.mesh;
  if (target === item.mesh) {
    target.position.copy(part.body.position);
    target.quaternion.copy(part.body.quaternion);
    return;
  }
  // Sub-part: convert the body's world transform into the group's local space.
  const group = item.mesh;
  target.position.copy(part.body.position);
  group.worldToLocal(target.position);
  // Copy into a THREE quaternion first: THREE's multiply reads private fields
  // that a cannon-es quaternion doesn't have (you get NaN otherwise).
  const q = part.body.quaternion;
  _bodyQ.set(q.x, q.y, q.z, q.w);
  _invQ.copy(group.quaternion).invert();
  target.quaternion.copy(_invQ).multiply(_bodyQ);
}

function stepPhysics(dt) {
  world.step(PHYSICS_STEP, dt, 8);
  for (const item of items.values()) {
    if (!item.parts) continue;
    for (const part of item.parts) {
      if (part.mesh && part.body.mass > 0) syncPart(item, part);
    }
    GADGETS[item.type].onFrame?.(item, dt);
  }
}

// ---------------------------------------------------------------------------
// Input: drag from tray, move/pan on board, zoom
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const pointerNdc = new THREE.Vector2();

function pointerToWorld(ev) {
  const r = canvas.getBoundingClientRect();
  pointerNdc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(boardPlane, hit) ? hit : null;
}

// Where the dragged gadget floats (un-snapped) and the cell it would land in.
// `grab` is the pointer-to-anchor offset so a picked-up item doesn't jump.
function dragTarget(ev, size, grab) {
  const p = pointerToWorld(ev);
  if (!p) return null;
  const ax = grab ? p.x + grab.x : p.x - size.w / 2;
  const ay = grab ? p.y + grab.y : p.y - size.h / 2;
  const snap = (v) => Math.round(v * DROP_STEPS) / DROP_STEPS; // drops snap to quarter cells
  return { ax, ay, x: snap(ax), y: snap(ay) };
}

// Short ease-out animation into place: slide (and turn, if the rotation
// changed) from wherever the gadget was into its cell, both at once.
const tweens = new Map(); // mesh -> { from, to, fromQ, toQ, t }
const SNAP_SECONDS = 0.2;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function settle(item, fromPosition, fromQuaternion = null) {
  const to = item.mesh.position.clone();
  const toQ = item.mesh.quaternion.clone();
  item.mesh.position.copy(fromPosition);
  const tw = { from: fromPosition.clone(), to, t: 0, fromQ: null, toQ };
  if (fromQuaternion && !fromQuaternion.equals(toQ)) {
    tw.fromQ = fromQuaternion.clone();
    item.mesh.quaternion.copy(fromQuaternion);
  }
  tweens.set(item.mesh, tw);
}

const ONE = new THREE.Vector3(1, 1, 1);
function updateTweens(dt) {
  for (const [mesh, tw] of tweens) {
    tw.t = Math.min(1, tw.t + dt / SNAP_SECONDS);
    const k = easeOut(tw.t);
    mesh.position.lerpVectors(tw.from, tw.to, k);
    if (tw.fromQ) mesh.quaternion.slerpQuaternions(tw.fromQ, tw.toQ, k);
    if (tw.fromS) mesh.scale.lerpVectors(tw.fromS, ONE, k);
    if (tw.t >= 1) tweens.delete(mesh);
  }
}

function finishTweens() {
  for (const [mesh, tw] of tweens) { mesh.position.copy(tw.to); mesh.quaternion.copy(tw.toQ); mesh.scale.copy(ONE); }
  tweens.clear();
}

function pickItem(ev) {
  const item = pickAnyItem(ev);
  return item && !item.locked ? item : null;
}

function pickAnyItem(ev) {
  // Gadgets never share a subgrid cell, so the cells a gadget takes up are
  // its hit box: a thin domino is as easy to grab as its box.
  const p = pointerToWorld(ev);
  if (p) {
    const id = occupied.get(key(Math.floor(p.x * SUB), Math.floor(p.y * SUB)));
    if (id != null) return items.get(id);
  }
  // Parts outside the footprint (the pendulum's rope) still pick by mesh.
  // Only solid meshes count as hits: the edge lines would otherwise grab
  // clicks from up to a unit away (Three's line-picking threshold).
  const meshes = [];
  for (const i of items.values()) i.mesh.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && o.userData.itemId == null) o = o.parent;
  return o ? items.get(o.userData.itemId) : null;
}

let drag = null; // { kind: 'new'|'move'|'pan', ... }

function beginNewDrag(type, ev) {
  if (partsLeft(type) <= 0) return;
  const ghost = GADGETS[type].makeMesh();
  eachMesh(ghost, (m) => { m.material = ghostMat; m.castShadow = false; });
  ghost.visible = false;
  scene.add(ghost);
  const rot = GADGETS[type].startRot || 0;
  GADGETS[type].applyRot?.({ mesh: ghost, rot });
  drag = { kind: 'new', type, ghost, rot, flip: false, cell: null };
  try { ev.target.setPointerCapture(ev.pointerId); } catch {}
  updateDrag(ev);
}

// On touch the finger covers the piece being dragged, so drags from the tray
// and moves hold the piece this many pixels above the finger.
const TOUCH_LIFT_PX = 70;
function liftForTouch(ev) {
  if (ev.pointerType !== 'touch') return ev;
  return { clientX: ev.clientX, clientY: ev.clientY - TOUCH_LIFT_PX, pointerType: ev.pointerType, pointerId: ev.pointerId };
}

function updateDrag(ev) {
  if (pinch) return;
  if (!drag) return;
  if (drag.kind === 'pan') {
    const dx = (ev.clientX - drag.startX) / (PX_PER_UNIT * view.zoom);
    const dy = (ev.clientY - drag.startY) / (PX_PER_UNIT * view.zoom);
    view.cx = drag.cx0 - dx;
    if (!lockY) view.cy = drag.cy0 + dy;
    return;
  }
  const type = drag.kind === 'new' ? drag.type : drag.item.type;
  const rot = drag.kind === 'new' ? drag.rot : drag.item.rot;
  const size = drag.kind === 'new' ? null : drag.item.size;
  const cell = dragTarget(drag.kind === 'new' ? liftForTouch(ev) : ev, footprintSize(type, rot, size), drag.grab);
  drag.cell = cell;
  if (drag.kind === 'new') {
    drag.ghost.visible = !!cell;
    if (cell) {
      const { position, quaternion } = itemTransform({ type: drag.type, x: cell.ax, y: cell.ay, rot });
      drag.ghost.position.copy(position);
      drag.ghost.quaternion.copy(quaternion);
    }
  } else if (drag.kind === 'move') {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) > 4) drag.moved = true;
    if (drag.moved && cell) {
      const { position } = itemTransform({ ...drag.item, x: cell.ax, y: cell.ay });
      drag.item.mesh.position.copy(position);
    }
  }
}

function endDrag(ev) {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.classList.remove('dragging');
  if (d.kind === 'pan') snapView();
  if (d.kind === 'new') {
    scene.remove(d.ghost);
    const spot = d.cell && nearestFree(d.type, d.cell.ax, d.cell.ay, d.rot);
    if (spot) {
      recordEdit();
      const item = addItem(d.type, spot.x, spot.y, d.rot, d.flip);
      settle(item, d.ghost.position);
      select(item);
    }
  } else if (d.kind === 'move') {
    const from = d.item.mesh.position.clone();
    const spot = d.moved && d.cell && nearestFree(d.item.type, d.cell.ax, d.cell.ay, d.item.rot, d.item.id, d.item.size);
    if (spot) {
      if (spot.x !== d.item.x || spot.y !== d.item.y) recordEdit();
      moveItem(d.item, spot.x, spot.y);
    } else {
      applyTransform(d.item);
    }
    if (d.moved) settle(d.item, from);
    select(d.item);
  }
}

canvas.addEventListener('pointerdown', (ev) => {
  clearConfirm.hidden = true;
  if (trackTouchDown(ev) || pinch) return;
  if (ev.button === 2) return;
  const item = !playing && ev.button === 0 ? pickItem(ev) : null;
  try { canvas.setPointerCapture(ev.pointerId); } catch {}
  canvas.classList.add('dragging');
  if (item) {
    const p = pointerToWorld(ev);
    tweens.delete(item.mesh);
    const grab = p ? { x: item.x - p.x, y: item.y - p.y } : null;
    drag = { kind: 'move', item, grab, startX: ev.clientX, startY: ev.clientY, moved: false, cell: null };
  } else {
    select(null);
    // On touch screens one finger never pans: that takes two (see pinch).
    if (ev.pointerType === 'touch') { canvas.classList.remove('dragging'); return; }
    viewSnap = null;
    drag = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, cx0: view.cx, cy0: view.cy };
  }
});

window.addEventListener('pointermove', updateDrag);

// Pointer cursor over anything selectable (only while editing and not dragging).
canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerType === 'touch') return;
  const over = !drag && !playing && pickItem(ev) !== null;
  canvas.classList.toggle('hover', over);
});
canvas.addEventListener('pointerleave', () => canvas.classList.remove('hover'));
window.addEventListener('pointerup', endDrag);
// A cancelled gesture (the browser took it over, e.g. for a system swipe)
// puts things back instead of placing.
window.addEventListener('pointercancel', cancelDrag);

function cancelDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.classList.remove('dragging');
  if (d.kind === 'new') scene.remove(d.ghost);
  else if (d.kind === 'move') applyTransform(d.item);
  else if (d.kind === 'pan') snapView();
}

// Two fingers on the board pan, and zoom only on a clear pinch. A gesture
// locks into one or the other early on: once it's a pan, finger spread is
// ignored, so a two-finger scroll never zooms by accident.
const PINCH_SPREAD_PX = 24; // fingers must spread/close this far to zoom...
const PAN_LOCK_PX = 10;     // ...before the pair moves this far together
const touches = new Map(); // pointerId -> { x, y }
let pinch = null; // { mode: null|'pan'|'zoom', dist, zoom, mid, cx, cy }
function pinchState() {
  const [a, b] = [...touches.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}
// Called first thing by the board's pointerdown handler (not a separate
// listener, so it can't depend on which listener a browser runs first).
// Returns true when this finger started a pinch.
function trackTouchDown(ev) {
  if (ev.pointerType !== 'touch') return false;
  // The first finger of a new gesture starts fresh: if the browser ever
  // dropped a finger's lift, that stale finger would turn every later tap
  // into a "pinch" and taps would stop selecting or deselecting.
  if (ev.isPrimary) { touches.clear(); pinch = null; }
  touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (touches.size < 2) return false;
  cancelDrag(); // the first finger's pan/move becomes a pinch
  const s = pinchState();
  pinch = { mode: null, dist: s.dist, zoom: view.zoom, mid: s.mid, cx: view.cx, cy: view.cy };
  viewSnap = null;
  return true;
}

// The page itself never zooms: only the board does, with its own pinch.
// Safari has its own pinch gesture events and ignores the viewport's
// user-scalable=no, so stop those, any two-finger touch move, double-tap
// zoom, and trackpad pinch (a ctrl+wheel) everywhere off the board.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (ev) => { if (ev.touches.length > 1) ev.preventDefault(); }, { passive: false });
document.addEventListener('dblclick', (ev) => ev.preventDefault(), { passive: false });
document.addEventListener('wheel', (ev) => { if (ev.ctrlKey) ev.preventDefault(); }, { passive: false });
canvas.addEventListener('pointermove', (ev) => {
  if (!touches.has(ev.pointerId)) return;
  touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (!pinch || touches.size < 2) return;
  const s = pinchState();
  if (!pinch.mode) {
    const spread = Math.abs(s.dist - pinch.dist);
    const travel = Math.hypot(s.mid.x - pinch.mid.x, s.mid.y - pinch.mid.y);
    if (spread >= PINCH_SPREAD_PX && spread > travel) {
      // Start zooming from here so the view doesn't jump by the dead zone.
      pinch = { mode: 'zoom', dist: s.dist, zoom: view.zoom, mid: s.mid, cx: view.cx, cy: view.cy };
    } else if (travel >= PAN_LOCK_PX && travel > spread) {
      pinch.mode = 'pan';
    }
  }
  if (pinch.mode === 'zoom') view.zoom = THREE.MathUtils.clamp(pinch.zoom * s.dist / Math.max(1, pinch.dist), ZOOM_MIN, ZOOM_MAX);
  const k = PX_PER_UNIT * view.zoom;
  view.cx = pinch.cx - (s.mid.x - pinch.mid.x) / k;
  if (!lockY) view.cy = pinch.cy + (s.mid.y - pinch.mid.y) / k;
});
function endTouch(ev) {
  if (!touches.delete(ev.pointerId)) return;
  if (pinch && touches.size < 2) { pinch = null; snapView(); }
}
window.addEventListener('pointerup', endTouch);
window.addEventListener('pointercancel', endTouch);

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (playing) return;
  const item = pickItem(ev);
  if (item) { recordEdit(); removeItem(item); }
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  viewSnap = null;
  clearTimeout(wheelSnapTimer);
  wheelSnapTimer = setTimeout(snapView, 150);
  if (ev.ctrlKey || ev.metaKey) {
    view.zoom = THREE.MathUtils.clamp(view.zoom * Math.exp(-ev.deltaY * 0.01), ZOOM_MIN, ZOOM_MAX);
  } else {
    view.cx += ev.deltaX / (PX_PER_UNIT * view.zoom);
    if (!lockY) view.cy -= ev.deltaY / (PX_PER_UNIT * view.zoom);
  }
}, { passive: false });

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'r' || ev.key === 'R') rotateSelected(ev.shiftKey ? 1 : -1); // clockwise; Shift goes back
  if (ev.key === 's' || ev.key === 'S') resizeSelected(ev.shiftKey ? -1 : 1);
  if (ev.key === 'f' || ev.key === 'F') flipSelected();
  const arrow = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[ev.key];
  if (arrow && selected) { ev.preventDefault(); nudgeSelected(...NUDGE[arrow]); }
  if (ev.key === 'h' || ev.key === 'H') homeView();
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && !playing) { recordEdit(); removeItem(selected); }
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault();
    ev.shiftKey ? redo() : undo();
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'y') { ev.preventDefault(); redo(); }
  if (ev.key === 'Escape') { select(null); clearConfirm.hidden = true; }
  if (ev.key === ' ') { ev.preventDefault(); if (playing) stopPlay(); else { audioArmed = true; startPlay(); } }
});

// Every way a gadget can be turned, in Rotate order, as { rot, flip }. A
// gadget can list its own (the pendulum's swing levels); otherwise it's the
// four quarter turns. flip null keeps it.
function posesOf(type) {
  const def = GADGETS[type];
  if (!def.rotatable) return [];
  return def.poses || [0, 1, 2, 3].map((rot) => ({ rot, flip: null }));
}

// The pose `item` turns to on its next step in `dir` (-1 clockwise, +1
// counter-clockwise), wrapping around and skipping turns that don't fit.
// Null if none do.
function nextRotation(item, dir) {
  const poses = posesOf(item.type);
  const at = poses.findIndex((p) => p.rot === (item.rot || 0) && (p.flip === null || p.flip === !!item.flip));
  for (let k = 1; k < poses.length; k++) {
    const p = poses[(((at + dir * k) % poses.length) + poses.length) % poses.length];
    const pose = { rot: p.rot, flip: p.flip === null ? !!item.flip : p.flip };
    if (turnedAnchor(item, pose.rot)) return pose;
  }
  return null;
}

// Where `item` sits after turning to `rot`, or null if it doesn't fit.
// It turns about its own center, so a long thin piece spins in place; if
// that spot is taken it keeps its bottom-left corner instead.
function turnedAnchor(item, rot) {
  const spots = [];
  if (!GADGETS[item.type].swing) {
    const was = footprintSize(item.type, item.rot, item.size), now = footprintSize(item.type, rot, item.size);
    spots.push({
      x: snapSub(item.x + (was.w - now.w) / 2),
      y: Math.max(0, snapSub(item.y + (was.h - now.h) / 2)),
    });
  }
  spots.push({ x: item.x, y: item.y });
  return spots.find((at) => canPlace(item.type, at.x, at.y, rot, item.id, item.size)) || null;
}

// Where a resizable `item` ends up on its next Size step in `dir` (+1
// forward, -1 back) through its gadget's list of sizes, wrapping around, as
// { size, x, y }; null if no other size fits. It keeps its bottom-left
// corner, or slides left and/or down to make room when growing into
// something. Sizes that don't fit are skipped.
function nextSize(item, dir) {
  const r = GADGETS[item.type].resizable;
  if (!r) return null;
  // Each size remembers its step in the list, so a size that comes up twice
  // in a cycle still moves on to the right next one.
  // A third value is an offset (the seesaw's plank shifted on its fulcrum).
  const sizes = r.sizes.map(([w, h, off], step) => (off ? { w, h, off, step } : { w, h, step }));
  const was = item.size || NORMAL_SIZE;
  const same = (z) => sameSize(z, was);
  const at = sizes[was.step] && same(sizes[was.step]) ? was.step : sizes.findIndex(same);
  const old = footprintSize(item.type, item.rot, item.size);
  for (let k = 1; k <= sizes.length; k++) {
    const size = sizes[(((at + dir * k) % sizes.length) + sizes.length) % sizes.length];
    if (sameSize(size, was)) continue;
    const now = footprintSize(item.type, item.rot, size);
    // A bucket grows around its cavity: the cavity's middle and the floor
    // stay put. Everything else grows from its bottom-left corner.
    let bx = 0, by = 0;
    if (GADGETS[item.type].pivotX) bx = GADGETS[item.type].pivotX(was) - GADGETS[item.type].pivotX(size); // the fulcrum stays put
    if (GADGETS[item.type].cavity) {
      const r = (item.rot || 0) % 4; // floor: bottom, right, top, left
      if (r % 2 === 0) { bx = (old.w - now.w) / 2; if (r === 2) by = old.h - now.h; }
      else { by = (old.h - now.h) / 2; if (r === 1) bx = old.w - now.w; }
    }
    const dx = Math.max(0, now.w - old.w), dy = Math.max(0, now.h - old.h);
    for (const [ox, oy] of [[bx, by], [0, 0], [-dx, 0], [0, -dy], [-dx, -dy]]) {
      const x = item.x + ox, y = item.y + oy;
      if (y >= 0 && canPlace(item.type, x, y, item.rot, item.id, size)) return { size, x, y };
    }
  }
  return null;
}

// Nudge: move the selected gadget a quarter cell (dx, dy in quarters).
function canNudge(item, dx, dy) {
  const x = item.x + dx / SUB, y = item.y + dy / SUB;
  return y >= 0 && canPlace(item.type, x, y, item.rot, item.id, item.size);
}
function nudgeSelected(dx, dy) {
  if (!selected || playing || !canNudge(selected, dx, dy)) return;
  recordEdit();
  const from = selected.mesh.position.clone();
  moveItem(selected, selected.x + dx / SUB, selected.y + dy / SUB);
  settle(selected, from);
}

// The Ball's next size (marble, ball, bowling ball), as { type, x, y }, or
// null if none fit. It stays centered across and keeps its bottom where it
// was (the marble's bottom sits a quarter up in its cell).
const ballBottom = (type) => Math.min(...footprintCells(type, 0, 0).map(([, j]) => j)) / SUB;
function nextBall(item, dir) {
  const at = BALL_SIZES.indexOf(item.type);
  if (at < 0) return null;
  const old = footprintSize(item.type);
  for (let k = 1; k < BALL_SIZES.length; k++) {
    const type = BALL_SIZES[(((at + dir * k) % BALL_SIZES.length) + BALL_SIZES.length) % BALL_SIZES.length];
    const now = footprintSize(type);
    const dx = (old.w - now.w) / 2, dy = ballBottom(item.type) - ballBottom(type);
    for (const [ox, oy] of [[dx, dy], [0, dy], [old.w - now.w, dy]]) {
      const x = item.x + ox, y = item.y + oy;
      if (y >= 0 && canPlace(type, x, y, 0, item.id)) return { type, x, y };
    }
  }
  return null;
}

// Swap a ball for another size in place (same id, so undo and selection keep working).
function retypeItem(item, type, x, y) {
  cellsOf(item).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  scene.remove(item.mesh);
  tweens.delete(item.mesh);
  item.type = type;
  item.x = x;
  item.y = y;
  item.mesh = GADGETS[type].makeMesh(item);
  item.mesh.userData.itemId = item.id;
  scene.add(item.mesh);
  storeRest(item.mesh);
  setHighlight(item, false);
  if (selected === item) outlinePass.selectedObjects = [item.mesh];
  cellsOf(item).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  applyTransform(item);
  scheduleSave();
}

function resizeSelected(dir = 1) {
  if (!selected || playing) return;
  if (BALL_SIZES.includes(selected.type)) {
    const next = nextBall(selected, dir);
    if (!next) return;
    recordEdit();
    const was = footprintSize(selected.type).w;
    const from = selected.mesh.position.clone();
    retypeItem(selected, next.type, next.x, next.y);
    const k = was / footprintSize(next.type).w; // grow or shrink from the old size
    const fromS = new THREE.Vector3(k, k, k);
    selected.mesh.scale.copy(fromS);
    settle(selected, from);
    tweens.get(selected.mesh).fromS = fromS;
    return;
  }
  const next = nextSize(selected, dir);
  if (!next) return;
  recordEdit();
  if (GADGETS[selected.type].pivotX) {
    // The seesaw's fulcrum doesn't move: only the plank glides (and turns)
    // from where it was to its new spot.
    const old = selected.mesh.getObjectByName('plank');
    const fromW = old.getWorldPosition(new THREE.Vector3()), fromQ = old.getWorldQuaternion(new THREE.Quaternion());
    moveItem(selected, next.x, next.y, selected.rot, selected.flip, next.size); // rebuilds the mesh
    selected.mesh.updateMatrixWorld(true);
    const plank = selected.mesh.getObjectByName('plank');
    const to = plank.position.clone(), toQ = plank.quaternion.clone();
    plank.position.copy(selected.mesh.worldToLocal(fromW));
    plank.quaternion.copy(selected.mesh.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(fromQ));
    tweens.set(plank, { from: plank.position.clone(), to, t: 0, fromQ: plank.quaternion.clone(), toQ });
    return;
  }
  const from = selected.mesh.position.clone();
  const was = selected.size || NORMAL_SIZE;
  moveItem(selected, next.x, next.y, selected.rot, selected.flip, next.size); // rebuilds the mesh
  // Grow or shrink smoothly from the old size and spot (the mesh's scale is
  // in its own unturned frame, like `size`).
  const fromS = new THREE.Vector3(was.w / next.size.w, was.h / next.size.h, 1);
  selected.mesh.scale.copy(fromS);
  settle(selected, from);
  tweens.get(selected.mesh).fromS = fromS;
}

// Mirror the selected (or being-dragged) gadget left-right as it looks on
// screen, whatever way it's turned: ramps slope the other way, conveyors run
// the other way. Mirroring a turned piece is the same as mirroring its own
// shape and turning it the opposite way, so the turn goes to -rot.
const mirroredRot = (rot) => (4 - (rot || 0)) % 4;
function flipSelected() {
  if (drag?.kind === 'new' && GADGETS[drag.type].flippable) {
    // Swap in a mirrored ghost where the old one was.
    drag.flip = !drag.flip;
    drag.rot = mirroredRot(drag.rot);
    const ghost = GADGETS[drag.type].makeMesh({ flip: drag.flip });
    eachMesh(ghost, (m) => { m.material = ghostMat; m.castShadow = false; });
    ghost.visible = drag.ghost.visible;
    scene.remove(drag.ghost);
    scene.add(ghost);
    drag.ghost = ghost;
    if (drag.cell) {
      const { position, quaternion } = itemTransform({ type: drag.type, x: drag.cell.ax, y: drag.cell.ay, rot: drag.rot });
      ghost.position.copy(position);
      ghost.quaternion.copy(quaternion);
    }
    return;
  }
  if (!selected || playing || !GADGETS[selected.type].flippable) return;
  recordEdit();
  const from = selected.mesh.position.clone();
  const rot = mirroredRot(selected.rot);
  moveItem(selected, selected.x, selected.y, rot, !selected.flip); // rebuilds the mesh
  // Squash through the middle across the screen: along the piece's own x
  // when it's level, its own y when it's turned a quarter.
  const fromS = rot % 2 ? new THREE.Vector3(1, -1, 1) : new THREE.Vector3(-1, 1, 1);
  selected.mesh.scale.copy(fromS);
  settle(selected, from);
  tweens.get(selected.mesh).fromS = fromS;
}

// Turn the selected (or being-dragged) gadget to its next pose.
// dir = -1 clockwise (Rotate, R), +1 counter-clockwise (Shift+R).
function rotateSelected(dir = 1) {
  if (drag?.kind === 'new' && GADGETS[drag.type].rotatable) {
    const poses = posesOf(drag.type);
    const at = poses.findIndex((p) => p.rot === drag.rot && (p.flip === null || p.flip === drag.flip));
    const p = poses[(((at + dir) % poses.length) + poses.length) % poses.length];
    drag.rot = p.rot;
    if (p.flip !== null) drag.flip = p.flip;
    GADGETS[drag.type].applyRot?.({ mesh: drag.ghost, rot: drag.rot });
    return;
  }
  if (!selected || playing) return;
  const def = GADGETS[selected.type];
  const pose = nextRotation(selected, dir);
  if (!pose) return;
  recordEdit();
  if (def.swing) {
    const ball = selected.mesh.getObjectByName('ball');
    const from = ball.position.clone();
    moveItem(selected, selected.x, selected.y, pose.rot); // updates occupancy, puts the ball at its new rest
    const to = ball.position.clone();
    ball.position.copy(from);
    tweens.set(ball, { from, to, t: 0, fromQ: null, toQ: ball.quaternion.clone() });
    return;
  }
  const from = selected.mesh.position.clone();
  const fromQ = selected.mesh.quaternion.clone();
  const at = turnedAnchor(selected, pose.rot);
  moveItem(selected, at.x, at.y, pose.rot, pose.flip);
  settle(selected, from, fromQ); // turns and slides into the cell together
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const btnPlay = document.getElementById('btn-play');
const btnReset = document.getElementById('btn-reset');
const btnClear = document.getElementById('btn-clear');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnHome = document.getElementById('btn-home');
const toast = document.getElementById('toast');
const itemTools = document.getElementById('item-tools');
const toolRotate = document.getElementById('tool-rotate');
// Arrow keys nudge the selected gadget a quarter cell.
const NUDGE = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] };
const toolSize = document.getElementById('tool-size');
const toolFlip = document.getElementById('tool-flip');
const toolDelete = document.getElementById('tool-delete');
const trayList = document.getElementById('gadget-list');

btnPlay.onclick = () => { audioArmed = true; startPlay(); };
btnReset.onclick = stopPlay;
// Clear asks first. In a level it takes back the player's parts and leaves
// the level's own pieces.
const clearConfirm = document.getElementById('clear-confirm');
const playerItems = () => [...items.values()].filter((i) => !i.locked);
btnClear.onclick = () => {
  if (playing || !playerItems().length) return;
  if (!clearConfirm.hidden) { clearConfirm.hidden = true; return; }
  const n = playerItems().length;
  document.getElementById('clear-text').textContent = currentLevel()
    ? `This takes back the ${n === 1 ? 'part' : n + ' parts'} you placed. The level's own pieces stay.`
    : `This removes all ${n === 1 ? 'gadget' : n + ' gadgets'} from the board.`;
  clearConfirm.hidden = false;
};
document.getElementById('clear-cancel').onclick = () => { clearConfirm.hidden = true; };
document.getElementById('clear-yes').onclick = () => {
  clearConfirm.hidden = true;
  const mine = playerItems();
  if (playing || !mine.length) return;
  recordEdit();
  mine.forEach(removeItem);
};
// Clicks on the floating view tools must not reach the board underneath.
document.getElementById('view-tools').addEventListener('pointerdown', (ev) => ev.stopPropagation());
btnUndo.onclick = undo;
btnRedo.onclick = redo;
toolRotate.onclick = () => rotateSelected(-1); // clockwise, like its icon
toolSize.onclick = () => resizeSelected(1);
toolFlip.onclick = flipSelected;
toolDelete.onclick = () => { if (selected && !playing) { recordEdit(); removeItem(selected); } };
// Clicks on the floating tools must not reach the board underneath.
itemTools.addEventListener('pointerdown', (ev) => ev.stopPropagation());

// Float the rotate/delete buttons just above the selected gadget.
const _corner = new THREE.Vector3();
const _bbox = new THREE.Box3();
function updateItemTools() {
  btnClear.disabled = playing || !playerItems().length;
  if (btnClear.disabled) clearConfirm.hidden = true;
  const show = selected && !playing && !drag;
  itemTools.hidden = !show;
  if (!show) return;
  _bbox.setFromObject(selected.mesh);
  const cam = camera;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  let minY = Infinity, sumX = 0;
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? _bbox.max.x : _bbox.min.x, i & 2 ? _bbox.max.y : _bbox.min.y, i & 4 ? _bbox.max.z : _bbox.min.z);
    _corner.project(cam);
    const sx = (_corner.x + 1) / 2 * w, sy = (1 - _corner.y) / 2 * h;
    minY = Math.min(minY, sy);
    sumX += sx;
  }
  const x = THREE.MathUtils.clamp(sumX / 8, 50, w - 50);
  const y = THREE.MathUtils.clamp(minY - 10, 56, h);
  itemTools.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  // Every action shows on every gadget; ones that don't apply are greyed out.
  toolRotate.disabled = nextRotation(selected, -1) === null;
  toolSize.disabled = (BALL_SIZES.includes(selected.type) ? nextBall(selected, 1) : nextSize(selected, 1)) === null;
  toolFlip.disabled = !GADGETS[selected.type].flippable;
  itemTools.classList.toggle('below', y < 200); // no room above near the top
}
btnHome.onclick = homeView;

// The lock (on by default) stops panning and scrolling up and down; left
// and right still work. Remembered per browser.
const LOCK_KEY = 'clatterall-damage.lock-y';
const btnLock = document.getElementById('btn-lock');
let lockY = true;
try { lockY = localStorage.getItem(LOCK_KEY) !== 'off'; } catch {}
function showLock() {
  btnLock.classList.toggle('on', lockY);
  btnLock.setAttribute('aria-pressed', String(lockY));
  btnLock.title = lockY ? 'Up/down scrolling is locked (click to unlock)' : 'Up/down scrolling is unlocked (click to lock)';
}
btnLock.onclick = () => {
  lockY = !lockY;
  try { localStorage.setItem(LOCK_KEY, lockY ? 'on' : 'off'); } catch {}
  showLock();
};
showLock();

// Tray pictures are rendered from each gadget's own model (a small 3/4 view),
// so they always match the board. A gadget can supply `image` (a URL) instead.
const thumbnailer = (() => {
  const SIZE = 128;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(SIZE, SIZE, false);
  r.setPixelRatio(2);
  r.outputColorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Scene();
  s.add(new THREE.HemisphereLight(0xffffff, 0xb8a98a, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 6, 5);
  s.add(key);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  return (mesh) => {
    s.add(mesh);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 1.05;
    cam.position.copy(center).add(new THREE.Vector3(0.55, 0.45, 1).normalize().multiplyScalar(dist));
    cam.lookAt(center);
    r.render(s, cam);
    s.remove(mesh);
    return r.domElement.toDataURL('image/png');
  };
})();

// The tray slides along the row of cards; the arrows move it by however
// many cards are fully on screen.
const trayTrack = document.getElementById('gadget-track');
const trayPrev = document.getElementById('tray-prev');
const trayNext = document.getElementById('tray-next');
const CARD_STEP = 100; // card width 90 + gap 10
let trayStart = 0; // index of the first card on screen

function trayFits() { return Math.max(1, Math.floor((trayList.clientWidth + 10) / CARD_STEP)); }
function trayMaxStart() {
  // Stop once the last card is fully on screen.
  return Math.max(0, Math.ceil((trayTrack.children.length * CARD_STEP - 10 - trayList.clientWidth) / CARD_STEP));
}

function layoutTray() {
  // An arrow only takes up room when there's somewhere to go that way.
  // Showing or hiding one changes how much room the cards have, so work it
  // out twice to settle.
  let max = 0;
  for (let pass = 0; pass < 2; pass++) {
    max = trayMaxStart();
    trayStart = THREE.MathUtils.clamp(trayStart, 0, max);
    trayPrev.classList.toggle('off', trayStart === 0);
    trayNext.classList.toggle('off', trayStart >= max);
  }
  const shift = Math.min(trayStart * CARD_STEP, Math.max(0, trayTrack.children.length * CARD_STEP - 10 - trayList.clientWidth));
  trayTrack.style.transform = `translateX(${-shift}px)`;
  trayList.classList.toggle('more-left', trayStart > 0);
  trayList.classList.toggle('more-right', trayStart < max);
}

function turnTrayPage(dir) {
  trayStart += dir * trayFits();
  layoutTray();
}

trayPrev.onclick = () => turnTrayPage(-1);
trayNext.onclick = () => turnTrayPage(1);
// A wheel or trackpad swipe over the tray flips one page per gesture.
let trayWheelAt = 0;
document.getElementById('tray').addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
  if (Math.abs(d) < 4 || ev.timeStamp - trayWheelAt < 400) return;
  trayWheelAt = ev.timeStamp;
  turnTrayPage(Math.sign(d));
}, { passive: false });

// The tray holds every gadget in the Sandbox, or just a level's parts, each
// card with how many are left. Pictures are made once per gadget.
const thumbs = {};
const thumbOf = (type) => (thumbs[type] ??= GADGETS[type].image || thumbnailer(GADGETS[type].makeMesh()));

function buildTray() {
  const level = currentLevel();
  const types = level ? GADGET_ORDER.filter((t) => level.parts[t]) : GADGET_ORDER;
  trayTrack.replaceChildren();
  for (const type of types) {
    const def = GADGETS[type];
    const card = document.createElement('div');
    card.className = 'gadget-card';
    card.dataset.type = type;
    const isNew = level && newGadgetOf(levelIndex) === type;
    card.innerHTML = `<img class="icon" alt="" draggable="false" src="${thumbOf(type)}"><div class="name">${def.name}</div><div class="hint">${def.hint}</div>`
      + (level ? '<div class="count"></div>' : '') + (isNew ? '<div class="new">NEW</div>' : '');
    card.addEventListener('pointerdown', (ev) => { if (!playing) beginNewDrag(type, ev); });
    trayTrack.appendChild(card);
  }
  trayStart = 0;
  layoutTray();
  updateTrayCounts();
}

// How many more of `type` the player may place (always plenty in the Sandbox).
function partsLeft(type) {
  const level = currentLevel();
  if (!level) return Infinity;
  let used = 0;
  for (const i of items.values()) if (!i.locked && partType(i.type) === type) used++;
  return (level.parts[type] || 0) - used;
}

function updateTrayCounts() {
  if (!currentLevel()) return;
  for (const card of trayTrack.children) {
    const count = card.querySelector('.count');
    if (!count) continue; // the tray is rebuilt for the level right after
    const left = partsLeft(card.dataset.type);
    count.textContent = '×' + Math.max(0, left);
    card.classList.toggle('used-up', left <= 0);
  }
}

// ---------------------------------------------------------------------------
// Resize + loop
// ---------------------------------------------------------------------------

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  outlinePass.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', () => { layoutTray(); homeView(); });
// The stage also changes size without a window resize (the tray filling in,
// the top bar wrapping on phones), so follow the stage itself.
new ResizeObserver(resize).observe(stage);
resize();

const MIN_VIEW_Y = -1; // show at most one row of ground below y = 0

// After a pan or zoom the view eases onto the grid: the zoom settles so a
// whole number of rows fills the screen top to bottom, and the bottom-left
// corner sits on a grid line. Whole cells only, never a sliver of ground.
let viewSnap = null; // { cx, cy, zoom } target, or null
let wheelSnapTimer = null;
const ZOOM_MIN = 0.25, ZOOM_MAX = 3;

function viewSize(zoom = view.zoom) {
  const w = canvas.clientWidth / (PX_PER_UNIT * zoom);
  const h = canvas.clientHeight / (PX_PER_UNIT * zoom);
  return { w, h };
}

// The zoom at which exactly `rows` cells fill the screen height.
const zoomForRows = (rows) => canvas.clientHeight / (PX_PER_UNIT * rows);
function clampRows(rows, maxZoom = ZOOM_MAX) {
  const fewest = Math.ceil(canvas.clientHeight / (PX_PER_UNIT * maxZoom));
  const most = Math.floor(canvas.clientHeight / (PX_PER_UNIT * ZOOM_MIN));
  return THREE.MathUtils.clamp(rows, Math.max(1, fewest), Math.max(1, most));
}

// Snap target for a view centred near (cx, cy) at `zoom`.
function gridTarget(cx, cy, zoom) {
  const { w, h } = viewSize(zoom);
  const left = Math.round(cx - w / 2);
  const bottom = Math.max(MIN_VIEW_Y, Math.round(cy - h / 2));
  return { cx: left + w / 2, cy: bottom + h / 2, zoom };
}

// Ease the view to fit the whole board (or the origin when it's empty),
// zooming in or out as needed.
function homeView() {
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  for (const item of items.values()) {
    for (const [cx, cy] of cellsOf(item)) {
      minX = Math.min(minX, cx / SUB); maxX = Math.max(maxX, (cx + 1) / SUB); maxY = Math.max(maxY, (cy + 1) / SUB);
    }
  }
  // In a level, also leave room for where the parts go.
  for (const [type, x, y, rot, , size] of currentLevel()?.solution || []) {
    const f = footprintSize(type, rot || 0, size || null);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x + f.w); maxY = Math.max(maxY, y + f.h);
  }
  if (!items.size) { minX = 0; maxX = 16; maxY = 0; }
  // Fit the contraption with a cell of margin each side (plus headroom),
  // zooming in or out; capped so a lone piece doesn't fill the screen.
  const fitW = canvas.clientWidth / (PX_PER_UNIT * (maxX - minX + 2));
  const fitH = canvas.clientHeight / (PX_PER_UNIT * (maxY + 3));
  const fit = THREE.MathUtils.clamp(Math.min(fitW, fitH), ZOOM_MIN, 2);
  // Round the rows up so the contraption still fits.
  const zoom = zoomForRows(clampRows(Math.ceil(canvas.clientHeight / (PX_PER_UNIT * fit) - 1e-6), 2));
  viewSnap = gridTarget((minX + maxX) / 2, maxY / 2, zoom);
}

function snapView() {
  const rows = clampRows(Math.round(canvas.clientHeight / (PX_PER_UNIT * view.zoom)));
  viewSnap = gridTarget(view.cx, view.cy, zoomForRows(rows));
}

function updateViewSnap(dt) {
  if (!viewSnap) return;
  const k = 1 - Math.exp(-dt * 14);
  view.cx += (viewSnap.cx - view.cx) * k;
  view.cy += (viewSnap.cy - view.cy) * k;
  view.zoom *= Math.pow(viewSnap.zoom / view.zoom, k); // even steps in or out
  if (Math.abs(viewSnap.cx - view.cx) < 0.002 && Math.abs(viewSnap.cy - view.cy) < 0.002 && Math.abs(viewSnap.zoom / view.zoom - 1) < 0.001) {
    view.cx = viewSnap.cx;
    view.cy = viewSnap.cy;
    view.zoom = viewSnap.zoom;
    viewSnap = null;
    scheduleSave();
  }
}

function updateCamera() {
  const { h } = viewSize();
  view.cy = Math.max(view.cy, MIN_VIEW_Y + h / 2);
  const dist = h / (2 * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)));
  camera.position.set(view.cx, view.cy, dist);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.near = Math.max(0.1, dist - 60);
  camera.far = dist + 200;
  camera.updateProjectionMatrix();
}

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (playing) stepPhysics(dt); else updateTweens(dt);
  updateViewSnap(dt);
  updateCamera(); // also clamps the view above the ground

  // Keep the backdrop, floor and shadow light centered on the view.
  const focus = new THREE.Vector3(view.cx, view.cy, 0);
  backdrop.position.x = focus.x;
  backdrop.position.y = focus.y;
  floor.position.x = focus.x;
  sun.position.set(focus.x + 10, focus.y + 25, 18);
  sun.target.position.set(focus.x, focus.y, 0);
  const sc = sun.shadow.camera;
  sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30;
  sc.updateProjectionMatrix();

  // The grid is for building: it fades out while playing.
  const grid = backdrop.material.uniforms.uGrid;
  grid.value += ((playing ? 0 : GRID_STRENGTH) - grid.value) * (1 - Math.exp(-dt * 10));

  if (won) {
    for (const item of items.values()) if (item.type === 'star') item.mesh.rotation.y += dt * 4;
  }
  if (!playing) {
    for (const item of items.values()) if (GADGETS[item.type].idleFrame) GADGETS[item.type].onFrame(item, dt);
  }
  updateItemTools();

  composer.render();
}

// ---------------------------------------------------------------------------
// Modes: Levels (src/levels.js) and Sandbox (every gadget, plus the examples
// in src/examples.js).
// ---------------------------------------------------------------------------

let mode = 'levels';
let levelIndex = 0;
const levelsDone = new Set(); // level names
const levelBoards = {}; // level name -> the player's parts, as snapshot() entries

const currentLevel = () => (mode === 'levels' ? LEVELS[levelIndex] : null);
const levelOpen = (n) => n === 0 || levelsDone.has(LEVELS[n - 1].name) || levelsDone.has(LEVELS[n].name);

// The gadget a level brings in: the first level whose parts include it.
function newGadgetOf(n) {
  const seen = new Set();
  for (let k = 0; k < n; k++) Object.keys(LEVELS[k].parts).forEach((t) => seen.add(t));
  return GADGET_ORDER.find((t) => LEVELS[n].parts[t] && !seen.has(t)) || null;
}

const examplesSelect = document.getElementById('examples');
for (const name of Object.keys(EXAMPLES)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  opt.title = EXAMPLES[name].blurb;
  examplesSelect.appendChild(opt);
}
examplesSelect.onchange = () => loadExample(examplesSelect.value);

function loadExample(name) {
  const ex = EXAMPLES[name];
  if (!ex) return;
  if (mode !== 'sandbox') enterSandbox(); // examples belong to the Sandbox
  if (playing) stopPlay();
  if (items.size) recordEdit();
  clearBoard();
  for (const [type, x, y, rot, flip, size] of ex.items) addItem(type, x, y, rot || 0, !!flip, size || null);
  // Center the view on the contraption.
  homeView();
  examplesSelect.value = name;
}

function resetHistory() {
  history.undo.length = 0;
  history.redo.length = 0;
  updateHistoryButtons();
}

// Load level n: its locked pieces, then whatever the player had placed there.
function loadLevel(n) {
  n = THREE.MathUtils.clamp(n, 0, LEVELS.length - 1);
  if (playing) stopPlay();
  if (saveTimer) saveProgress(); // keep the board we're leaving
  hideWin();
  mode = 'levels';
  levelIndex = n;
  const level = LEVELS[n];
  clearBoard();
  for (const [type, x, y, rot, flip, size] of level.items) addItem(type, x, y, rot || 0, !!flip, size || null, true);
  for (const s of (levelBoards[level.name] || []).map(upgradeEntry)) {
    if (GADGETS[s.type] && partsLeft(partType(s.type)) > 0 && canPlace(s.type, s.x, s.y, s.rot || 0, null, s.size || null)) {
      addItem(s.type, s.x, s.y, s.rot || 0, !!s.flip, s.size || null);
    }
  }
  resetHistory();
  showMode();
  homeView();
  scheduleSave();
}

function enterSandbox() {
  if (mode === 'sandbox') return;
  if (playing) stopPlay();
  if (saveTimer) saveProgress();
  hideWin();
  mode = 'sandbox';
  clearBoard();
  if (!loadProgress()) loadExample('Domino Run');
  resetHistory();
  showMode();
  homeView();
  scheduleSave();
}

// Top bar, tray and goal line for the current mode.
function showMode() {
  const level = currentLevel();
  document.body.classList.toggle('mode-levels', !!level);
  document.body.classList.toggle('mode-sandbox', !level);
  document.getElementById('mode-levels').classList.toggle('on', !!level);
  document.getElementById('mode-sandbox').classList.toggle('on', !level);
  document.getElementById('level-title').textContent = level ? `${levelIndex + 1}. ${level.name}` : '';
  document.getElementById('tray-label').textContent = level ? level.goal : 'Drag a gadget onto the board';
  buildTray();
}

document.getElementById('mode-levels').onclick = () => { if (mode !== 'levels') loadLevel(levelIndex); };
document.getElementById('mode-sandbox').onclick = enterSandbox;

// Level picker
const picker = document.getElementById('level-picker');
const levelGrid = document.getElementById('level-grid');

function openPicker() {
  levelGrid.replaceChildren();
  LEVELS.forEach((level, n) => {
    const tile = document.createElement('button');
    tile.className = 'level-tile';
    const done = levelsDone.has(level.name);
    tile.classList.toggle('done', done);
    tile.classList.toggle('current', n === levelIndex);
    tile.disabled = !levelOpen(n);
    const gadget = newGadgetOf(n);
    tile.title = level.name + (gadget ? ` (new: ${GADGETS[gadget].name})` : '');
    tile.innerHTML = `<div class="num">${n + 1}</div>`
      + (gadget ? `<img class="icon" alt="" src="${thumbOf(gadget)}">` : '<div class="icon"></div>')
      + `<div class="name">${level.name}</div>`
      + `<div class="badge">${done ? '✓' : tile.disabled ? '🔒' : ''}</div>`;
    tile.onclick = () => { closePicker(); loadLevel(n); };
    levelGrid.appendChild(tile);
  });
  picker.hidden = false;
}
function closePicker() { picker.hidden = true; }
document.getElementById('btn-levels').onclick = openPicker;
document.getElementById('picker-close').onclick = closePicker;
picker.addEventListener('pointerdown', (ev) => { if (ev.target === picker) closePicker(); });

// Level complete
const winCard = document.getElementById('win-card');
let winTimer = null;

function levelWon() {
  const level = currentLevel();
  levelsDone.add(level.name);
  scheduleSave();
  const last = levelIndex === LEVELS.length - 1;
  document.getElementById('win-title').textContent = last ? 'You beat every level!' : `Level ${levelIndex + 1} done!`;
  const next = !last && newGadgetOf(levelIndex + 1);
  document.getElementById('win-text').textContent = last
    ? 'Now build anything you like in the Sandbox.'
    : next ? `Next up: the ${GADGETS[next].name.toLowerCase()}.` : `Next up: ${LEVELS[levelIndex + 1].name}.`;
  document.getElementById('win-next').textContent = last ? 'Sandbox ▶' : 'Next level ▶';
  // Let the star spin a moment first.
  clearTimeout(winTimer);
  winTimer = setTimeout(() => { toast.hidden = true; winCard.hidden = false; }, 900);
}
function hideWin() { clearTimeout(winTimer); winCard.hidden = true; }
document.getElementById('win-again').onclick = () => { hideWin(); stopPlay(); };
document.getElementById('win-next').onclick = () => {
  if (levelIndex === LEVELS.length - 1) enterSandbox();
  else loadLevel(levelIndex + 1);
};

// Start in whichever mode was open last; first visits start on level 1.
(function start() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(LEVELS_KEY)); } catch {}
  if (data) {
    (data.done || []).forEach((name) => levelsDone.add(name));
    Object.assign(levelBoards, data.boards || {});
  }
  buildTray();
  if (data?.mode === 'sandbox') {
    mode = 'sandbox';
    if (!loadProgress()) loadExample('Domino Run');
    showMode();
  } else {
    const n = Math.max(0, LEVELS.findIndex((l) => l.name === data?.level));
    loadLevel(n);
  }
  // Start fitted to the board, exactly on the grid, no easing.
  homeView();
  if (viewSnap) { Object.assign(view, viewSnap); viewSnap = null; }
  window.addEventListener('beforeunload', () => { if (saveTimer) saveProgress(); });
  frame();
})();
