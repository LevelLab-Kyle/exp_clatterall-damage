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

// 2D view: orthographic camera looking straight down -Z at the X/Y plane.
const PX_PER_UNIT = 72;
const camera2d = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
camera2d.position.set(8, 4, 20);
const view = { cx: 8, cy: 4, zoom: 1 };

// 3D view: a fixed tilted camera that follows the same pan/zoom as the flat view.
const camera3d = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
const CAMERA_3D_OFFSET = new THREE.Vector3(5, 6, 13);

let mode = '2d';
const activeCamera = () => (mode === '2d' ? camera2d : camera3d);

// Selection outline, matching the platform builder: three's outline pass
// finds the selected object's silhouette (visible and hidden edges alike) and
// adds it over the finished picture in the accent color.
const OUTLINE = { edgeStrength: 3, edgeGlow: 0, edgeThickness: 1 };
const accent = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim());
const composer = new THREE.EffectComposer(renderer);
const renderPass = new THREE.RenderPass(scene, camera2d);
const outlinePass = new THREE.OutlinePass(new THREE.Vector2(1, 1), scene, camera2d);
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

// Backdrop with an infinite grid, drawn in a shader using world coordinates.
const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(FLOOR_LEN, FLOOR_LEN),
  new THREE.ShaderMaterial({
    uniforms: { uSky: { value: new THREE.Color(0xdff1ff) }, uLine: { value: new THREE.Color(0xb9d4e8) } },
    vertexShader: `
      varying vec2 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xy;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform vec3 uSky; uniform vec3 uLine;
      varying vec2 vWorld;
      void main() {
        vec2 g = abs(fract(vWorld - 0.5) - 0.5) / fwidth(vWorld);
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        vec3 c = mix(uSky, uLine, line * 0.9);
        if (vWorld.y < 0.0) c = vec3(0.47, 0.67, 0.33);
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
);
backdrop.position.z = -0.5;
scene.add(backdrop);

// Ghost preview when dragging.
const ghostMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
const ghostBadMat = new THREE.MeshStandardMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.5 });

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------

const items = new Map(); // id -> item
const occupied = new Map(); // "x,y" -> id
let nextId = 1;
let selected = null;
let playing = false;

const key = (x, y) => `${x},${y}`;

function canPlace(type, x, y, rot = 0, ignoreId = null) {
  return footprintCells(type, x, y, rot).every(([cx, cy]) => {
    if (cy < 0) return false;
    const id = occupied.get(key(cx, cy));
    return id == null || id === ignoreId;
  });
}

function applyTransform(item) {
  const { position, quaternion } = itemTransform(item);
  item.mesh.position.copy(position);
  item.mesh.quaternion.copy(quaternion);
  GADGETS[item.type].applyRot?.(item);
}

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

function setFaded(obj, on) {
  eachMesh(obj, (m) => { m.material.transparent = on; m.material.opacity = on ? 0.5 : 1; });
}

// Remember where every sub-part sits so Reset can put moving parts back.
function storeRest(obj) {
  obj.traverse((o) => { o.userData.rest = { p: o.position.clone(), q: o.quaternion.clone() }; });
}

function restoreRest(obj) {
  obj.traverse((o) => { if (o.userData.rest) { o.position.copy(o.userData.rest.p); o.quaternion.copy(o.userData.rest.q); } });
}

function addItem(type, x, y, rot = 0, flip = false) {
  const item = { id: nextId++, type, x, y, rot, flip, parts: null };
  item.mesh = GADGETS[type].makeMesh(item);
  items.set(item.id, item);
  footprintCells(type, x, y, rot).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  applyTransform(item);
  storeRest(item.mesh);
  setHighlight(item, false); // records each mesh's base glow
  item.mesh.userData.itemId = item.id;
  scene.add(item.mesh);
  scheduleSave();
  return item;
}

function moveItem(item, x, y, rot = item.rot, flip = item.flip) {
  footprintCells(item.type, item.x, item.y, item.rot).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  item.x = x;
  item.y = y;
  item.rot = rot;
  if (flip !== item.flip) {
    // A mirrored shape needs its own geometry: rebuild the mesh in place.
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
  footprintCells(item.type, x, y, rot).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  applyTransform(item);
  scheduleSave();
}

function removeItem(item) {
  footprintCells(item.type, item.x, item.y, item.rot).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  items.delete(item.id);
  tweens.delete(item.mesh);
  scene.remove(item.mesh);
  if (selected === item) select(null);
  scheduleSave();
}

function select(item) {
  selected = item;
  outlinePass.selectedObjects = selected ? [selected.mesh] : [];
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
  return [...items.values()].map((i) => ({ type: i.type, x: i.x, y: i.y, rot: i.rot, flip: !!i.flip }));
}

// Call before changing the board.
function recordEdit() {
  history.undo.push(snapshot());
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
  updateHistoryButtons();
}

function restore(snap) {
  finishTweens();
  clearBoard();
  for (const s of snap) addItem(s.type, s.x, s.y, s.rot, s.flip);
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
// Progress is kept in localStorage: the board, the view and the current
// example name. Saved (debounced) after every board change or view move.
// ---------------------------------------------------------------------------

const SAVE_KEY = 'clatter-lab.save.v1';
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 250);
}

function saveProgress() {
  saveTimer = null;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      items: snapshot(),
      view: { cx: view.cx, cy: view.cy, zoom: view.zoom },
      mode,
      example: examplesSelect.value,
    }));
  } catch { /* private mode or storage full: just don't save */ }
}

// Returns true if a saved board was restored.
function loadProgress() {
  let data;
  try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return false; }
  if (!data || !Array.isArray(data.items)) return false;
  clearBoard();
  for (const s of data.items) {
    if (GADGETS[s.type] && canPlace(s.type, s.x, s.y, s.rot || 0)) addItem(s.type, s.x, s.y, s.rot || 0, !!s.flip);
  }
  if (data.view) { view.cx = data.view.cx; view.cy = data.view.cy; view.zoom = data.view.zoom; }
  if (data.mode === '3d') setMode('3d');
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
  // No sleeping: a slowly leaning domino wouldn't wake a sleeping neighbour.
  // Pieces are about a metre big, so real gravity feels sluggish. Crank it up for a toy feel.
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -30, 0), allowSleep: false });
  world.defaultContactMaterial.friction = 0.4;
  world.defaultContactMaterial.restitution = 0.05;
  // Dominoes grip the floor so they tip rather than slide. Between dominoes
  // friction must be exactly 0: any friction at all makes a leaning row of
  // dominoes lock up in cannon-es instead of toppling along.
  world.addContactMaterial(new CANNON.ContactMaterial(MATS.domino, MATS.surface, { friction: 1.0, restitution: 0.0 }));
  world.addContactMaterial(new CANNON.ContactMaterial(MATS.domino, MATS.domino, { friction: 0.0, restitution: 0.1 }));
  world.addContactMaterial(new CANNON.ContactMaterial(MATS.marble, MATS.surface, { friction: 0.4, restitution: 0.1 }));
  world.addContactMaterial(new CANNON.ContactMaterial(MATS.marble, MATS.domino, { friction: 0.0, restitution: 0.1 }));
  world.addContactMaterial(new CANNON.ContactMaterial(MATS.marble, MATS.bouncy, { friction: 0.3, restitution: 0.95 }));
  world.addContactMaterial(new CANNON.ContactMaterial(MATS.domino, MATS.bouncy, { friction: 0.3, restitution: 0.6 }));

  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: MATS.surface });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(ground);

  // Gadget forces (fan etc.) run inside each physics sub-step, never per
  // frame: at 120 Hz a frame may run no sub-step, and forces would pile up.
  world.addEventListener('preStep', () => {
    for (const item of items.values()) GADGETS[item.type].onStep?.(item, world, world.dt);
  });

  scene.updateMatrixWorld(true);
  const wp = new THREE.Vector3(), wq = new THREE.Quaternion();
  for (const item of items.values()) {
    const def = GADGETS[item.type];
    const built = def.makeBodies
      ? def.makeBodies(item.mesh)
      : { parts: [{ body: def.makeBody(item), mesh: item.mesh }], constraints: [] };
    for (const part of built.parts) {
      const src = part.mesh || item.mesh;
      src.getWorldPosition(wp);
      src.getWorldQuaternion(wq);
      part.body.position.copy(wp);
      part.body.quaternion.copy(wq);
      world.addBody(part.body);
      if (part.body.mass > 0) part.body.addEventListener('collide', (ev) => onImpact(part.body, ev));
      if (def.ring) part.body.addEventListener('collide', (ev) => onBellHit(item, ev));
    }
    built.constraints.forEach((c) => world.addConstraint(c));
    item.parts = built.parts;
    if (def.goal) built.parts[0].body.addEventListener('collide', () => onGoalHit(item));
  }

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
}

function onGoalHit(star) {
  if (won) return;
  won = true;
  eachMesh(star.mesh, (m) => m.material.emissive?.set(0xffaa00));
  toast.textContent = '⭐ You did it!';
  toast.hidden = false;
  playSound('win', 0.8);
}

// ---------------------------------------------------------------------------
// Sounds (assets/sounds.js). Only play during a run the user started with
// the Play button or Space, so scripted/synchronous runs stay silent.
// ---------------------------------------------------------------------------

const SOUND_KEY = 'clatter-lab.sound';
const sounds = {};
for (const [key, b64] of Object.entries(typeof SOUND_DATA === 'undefined' ? {} : SOUND_DATA)) {
  sounds[key] = new Audio('data:audio/mpeg;base64,' + b64);
  sounds[key].preload = 'auto';
}
let soundOn = true;
try { soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch {}
let audioArmed = false; // true during a user-started run
const lastImpact = new Map(); // body -> time of its last sound

function playSound(key, volume = 1) {
  if (!audioArmed || !soundOn || !sounds[key]) return;
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
  if (!audioArmed || !soundOn) return;
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

function setSound(on) {
  soundOn = on;
  btnSound.textContent = on ? '🔊' : '🔇';
  btnSound.title = on ? 'Sound on (click to mute)' : 'Sound off (click to unmute)';
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch {}
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
  world.step(1 / 60, dt, 4);
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
  raycaster.setFromCamera(pointerNdc, activeCamera());
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
  return { ax, ay, x: Math.round(ax), y: Math.round(ay) };
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

function updateTweens(dt) {
  for (const [mesh, tw] of tweens) {
    tw.t = Math.min(1, tw.t + dt / SNAP_SECONDS);
    const k = easeOut(tw.t);
    mesh.position.lerpVectors(tw.from, tw.to, k);
    if (tw.fromQ) mesh.quaternion.slerpQuaternions(tw.fromQ, tw.toQ, k);
    if (tw.t >= 1) tweens.delete(mesh);
  }
}

function finishTweens() {
  for (const [mesh, tw] of tweens) { mesh.position.copy(tw.to); mesh.quaternion.copy(tw.toQ); }
  tweens.clear();
  for (const anim of mirrorAnims) endMirrorAnim(anim);
  mirrorAnims.length = 0;
}

// A flip shown as a mirror: a stand-in copy of the piece squashes through
// its center along the flipped axis and comes out reversed, while the real
// (already flipped) piece stays hidden until it's done.
const mirrorAnims = []; // { item, stand, axis, t }
const MIRROR_SECONDS = 0.22;

function startMirrorAnim(item, axis, before, center) {
  const stand = new THREE.Group();
  stand.position.copy(center);
  const copy = before.mesh;
  copy.position.copy(before.position).sub(center);
  copy.quaternion.copy(before.quaternion);
  stand.add(copy);
  scene.add(stand);
  item.mesh.visible = false;
  if (selected === item) outlinePass.selectedObjects = [stand];
  mirrorAnims.push({ item, stand, axis, t: 0 });
}

function endMirrorAnim(anim) {
  scene.remove(anim.stand);
  anim.item.mesh.visible = true;
  if (selected === anim.item) outlinePass.selectedObjects = [anim.item.mesh];
}

function updateMirrorAnims(dt) {
  for (let i = mirrorAnims.length - 1; i >= 0; i--) {
    const anim = mirrorAnims[i];
    anim.t = Math.min(1, anim.t + dt / MIRROR_SECONDS);
    // Scale from 1 through 0 to -1 along the flipped world axis.
    const s = Math.cos(anim.t * Math.PI);
    if (anim.axis === 'h') anim.stand.scale.x = s; else anim.stand.scale.y = s;
    if (anim.t >= 1) { endMirrorAnim(anim); mirrorAnims.splice(i, 1); }
  }
}

function pickItem(ev) {
  const r = canvas.getBoundingClientRect();
  pointerNdc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, activeCamera());
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
  const ghost = GADGETS[type].makeMesh();
  eachMesh(ghost, (m) => { m.material = ghostMat; m.castShadow = false; });
  ghost.visible = false;
  scene.add(ghost);
  drag = { kind: 'new', type, ghost, rot: 0, cell: null };
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
    view.cy = drag.cy0 + dy;
    return;
  }
  const type = drag.kind === 'new' ? drag.type : drag.item.type;
  const rot = drag.kind === 'new' ? drag.rot : drag.item.rot;
  const cell = dragTarget(drag.kind === 'new' ? liftForTouch(ev) : ev, footprintSize(type, rot), drag.grab);
  drag.cell = cell;
  if (drag.kind === 'new') {
    drag.ghost.visible = !!cell;
    if (cell) {
      const ok = canPlace(drag.type, cell.x, cell.y, rot);
      eachMesh(drag.ghost, (m) => { m.material = ok ? ghostMat : ghostBadMat; });
      const { position, quaternion } = itemTransform({ type: drag.type, x: cell.ax, y: cell.ay, rot });
      drag.ghost.position.copy(position);
      drag.ghost.quaternion.copy(quaternion);
    }
  } else if (drag.kind === 'move') {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) > 4) drag.moved = true;
    if (drag.moved && cell) {
      const ok = canPlace(drag.item.type, cell.x, cell.y, rot, drag.item.id);
      const { position } = itemTransform({ ...drag.item, x: cell.ax, y: cell.ay });
      drag.item.mesh.position.copy(position);
      setFaded(drag.item.mesh, !ok);
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
    if (d.cell && canPlace(d.type, d.cell.x, d.cell.y, d.rot)) {
      recordEdit();
      const item = addItem(d.type, d.cell.x, d.cell.y, d.rot);
      settle(item, d.ghost.position);
      select(item);
    }
  } else if (d.kind === 'move') {
    setFaded(d.item.mesh, false);
    const from = d.item.mesh.position.clone();
    if (d.moved && d.cell && canPlace(d.item.type, d.cell.x, d.cell.y, d.item.rot, d.item.id)) {
      if (d.cell.x !== d.item.x || d.cell.y !== d.item.y) recordEdit();
      moveItem(d.item, d.cell.x, d.cell.y);
    } else {
      applyTransform(d.item);
    }
    if (d.moved) settle(d.item, from);
    select(d.item);
  }
}

canvas.addEventListener('pointerdown', (ev) => {
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
// A cancelled gesture (the browser took it over, e.g. to scroll the tray)
// puts things back instead of placing.
window.addEventListener('pointercancel', cancelDrag);

function cancelDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.classList.remove('dragging');
  if (d.kind === 'new') scene.remove(d.ghost);
  else if (d.kind === 'move') { setFaded(d.item.mesh, false); applyTransform(d.item); }
  else if (d.kind === 'pan') snapView();
}

// Two-finger pinch on the board zooms (and pans with the midpoint).
const touches = new Map(); // pointerId -> { x, y }
let pinch = null; // { dist, zoom, mid, cx, cy }
function pinchState() {
  const [a, b] = [...touches.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}
// Called first thing by the board's pointerdown handler (not a separate
// listener, so it can't depend on which listener a browser runs first).
// Returns true when this finger started a pinch.
function trackTouchDown(ev) {
  if (ev.pointerType !== 'touch') return false;
  touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (touches.size < 2) return false;
  cancelDrag(); // the first finger's pan/move becomes a pinch
  const s = pinchState();
  pinch = { dist: s.dist, zoom: view.zoom, mid: s.mid, cx: view.cx, cy: view.cy };
  viewSnap = null;
  return true;
}

// Safari has its own pinch gesture events; stop them zooming the page.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
}
canvas.addEventListener('pointermove', (ev) => {
  if (!touches.has(ev.pointerId)) return;
  touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (!pinch || touches.size < 2) return;
  const s = pinchState();
  view.zoom = THREE.MathUtils.clamp(pinch.zoom * s.dist / Math.max(1, pinch.dist), 0.25, 3);
  const k = PX_PER_UNIT * view.zoom;
  view.cx = pinch.cx - (s.mid.x - pinch.mid.x) / k;
  view.cy = pinch.cy + (s.mid.y - pinch.mid.y) / k;
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
    view.zoom = THREE.MathUtils.clamp(view.zoom * Math.exp(-ev.deltaY * 0.01), 0.25, 3);
  } else {
    view.cx += ev.deltaX / (PX_PER_UNIT * view.zoom);
    view.cy -= ev.deltaY / (PX_PER_UNIT * view.zoom);
  }
}, { passive: false });

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'r' || ev.key === 'R') rotateSelected(ev.shiftKey ? -1 : 1);
  if (ev.key === 'f' || ev.key === 'F') flipSelected(ev.shiftKey ? 'v' : 'h');
  if (ev.key === 'h' || ev.key === 'H') homeView();
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && !playing) { recordEdit(); removeItem(selected); }
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault();
    ev.shiftKey ? redo() : undo();
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'y') { ev.preventDefault(); redo(); }
  if (ev.key === 'Escape') select(null);
  if (ev.key === ' ') { ev.preventDefault(); if (playing) stopPlay(); else { audioArmed = true; startPlay(); } }
});

// The rotation `item` would end up with after a step in `dir`, or null if it
// can't rotate that way (not rotatable, at the swing limit, or the turned
// footprint doesn't fit).
function nextRotation(item, dir) {
  const def = GADGETS[item.type];
  if (!def.rotatable) return null;
  const rot = def.swing
    ? THREE.MathUtils.clamp((item.rot || 0) + dir, def.swing.min, def.swing.max)
    : ((item.rot || 0) + dir + 4) % 4;
  if (rot === (item.rot || 0)) return null;
  return canPlace(item.type, item.x, item.y, rot, item.id) ? rot : null;
}

// What flipping `item` across the vertical ('h') or horizontal ('v') axis
// would give, as { rot, flip }, or null when the gadget is symmetric that
// way or the result wouldn't fit.
function nextFlip(item, axis) {
  const def = GADGETS[item.type];
  const fn = axis === 'h' ? def.flipH : def.flipV;
  if (!fn) return null;
  const change = fn(item);
  if (!change) return null;
  const next = { rot: change.rot ?? (item.rot || 0), flip: change.flip ?? !!item.flip };
  if (next.rot === (item.rot || 0) && next.flip === !!item.flip) return null;
  return canPlace(item.type, item.x, item.y, next.rot, item.id) ? next : null;
}

function flipSelected(axis) {
  if (!selected || playing) return;
  const next = nextFlip(selected, axis);
  if (!next) return;
  recordEdit();
  // Every flip is shown as a mirror about the piece's footprint center: a
  // copy of the piece as it was shrinks through that center along the
  // flipped axis and expands out reversed.
  const { w, h } = footprintSize(selected.type, selected.rot);
  const center = new THREE.Vector3(selected.x + w / 2, selected.y + h / 2, 0);
  const before = { mesh: selected.mesh.clone(), position: selected.mesh.position.clone(), quaternion: selected.mesh.quaternion.clone() };
  moveItem(selected, selected.x, selected.y, next.rot, next.flip);
  startMirrorAnim(selected, axis, before, center);
}

// Turn the selected (or being-dragged) gadget a quarter turn.
// dir = +1 counter-clockwise, -1 clockwise.
function rotateSelected(dir = 1) {
  if (drag?.kind === 'new' && GADGETS[drag.type].rotatable) {
    const def = GADGETS[drag.type];
    if (def.swing) {
      drag.rot = THREE.MathUtils.clamp(drag.rot + dir, def.swing.min, def.swing.max);
      def.applyRot({ mesh: drag.ghost, rot: drag.rot });
    } else {
      drag.rot = (drag.rot + dir + 4) % 4;
    }
    return;
  }
  if (!selected || playing) return;
  const def = GADGETS[selected.type];
  const rot = nextRotation(selected, dir);
  if (rot === null) return;
  if (def.swing) {
    recordEdit();
    const ball = selected.mesh.getObjectByName('ball');
    const from = ball.position.clone();
    moveItem(selected, selected.x, selected.y, rot); // updates occupancy, puts the ball at its new rest
    const to = ball.position.clone();
    ball.position.copy(from);
    tweens.set(ball, { from, to, t: 0, fromQ: null, toQ: ball.quaternion.clone() });
    return;
  }
  const from = selected.mesh.position.clone();
  const fromQ = selected.mesh.quaternion.clone();
  recordEdit();
  moveItem(selected, selected.x, selected.y, rot);
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
const btnView = document.getElementById('btn-view');
const btnHome = document.getElementById('btn-home');
const toast = document.getElementById('toast');
const itemTools = document.getElementById('item-tools');
const toolRotateCcw = document.getElementById('tool-rotate-ccw');
const toolRotateCw = document.getElementById('tool-rotate-cw');
const toolFlipH = document.getElementById('tool-flip-h');
const toolFlipV = document.getElementById('tool-flip-v');
const toolDelete = document.getElementById('tool-delete');
const trayList = document.getElementById('gadget-list');

btnPlay.onclick = () => { audioArmed = true; startPlay(); };
const btnSound = document.getElementById('btn-sound');
btnSound.onclick = () => setSound(!soundOn);
setSound(soundOn);
btnReset.onclick = stopPlay;
btnClear.onclick = () => { if (!playing && items.size) { recordEdit(); clearBoard(); } };
btnUndo.onclick = undo;
btnRedo.onclick = redo;
toolRotateCcw.onclick = () => rotateSelected(1);
toolRotateCw.onclick = () => rotateSelected(-1);
toolFlipH.onclick = () => flipSelected('h');
toolFlipV.onclick = () => flipSelected('v');
toolDelete.onclick = () => { if (selected && !playing) { recordEdit(); removeItem(selected); } };
// Clicks on the floating tools must not reach the board underneath.
itemTools.addEventListener('pointerdown', (ev) => ev.stopPropagation());

// Float the rotate/delete buttons just above the selected gadget.
const _corner = new THREE.Vector3();
const _bbox = new THREE.Box3();
function updateItemTools() {
  const show = selected && !playing && !drag;
  itemTools.hidden = !show;
  if (!show) return;
  _bbox.setFromObject(selected.mesh);
  const cam = activeCamera();
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
  // Actions that don't apply are hidden, not greyed out.
  toolRotateCcw.hidden = nextRotation(selected, 1) === null;
  toolRotateCw.hidden = nextRotation(selected, -1) === null;
  toolFlipH.hidden = nextFlip(selected, 'h') === null;
  toolFlipV.hidden = nextFlip(selected, 'v') === null;
}
btnView.onclick = () => setMode(mode === '2d' ? '3d' : '2d');
btnHome.onclick = homeView;

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

// A plain mouse wheel scrolls the tray sideways (trackpads already do).
trayList.addEventListener('wheel', (ev) => {
  if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
  ev.preventDefault();
  trayList.scrollLeft += ev.deltaY;
}, { passive: false });

function buildTray() {
for (const type of GADGET_ORDER) {
  const def = GADGETS[type];
  const card = document.createElement('div');
  card.className = 'gadget-card';
  const src = def.image || thumbnailer(def.makeMesh());
  card.innerHTML = `<img class="icon" alt="" draggable="false" src="${src}"><div class="name">${def.name}</div><div class="hint">${def.hint}</div>`;
  card.addEventListener('pointerdown', (ev) => { if (!playing) beginNewDrag(type, ev); });
  trayList.appendChild(card);
}
}

function setMode(next) {
  mode = next;
  scheduleSave();
  btnView.textContent = next === '2d' ? '3D view' : 'Flat view';
  backdrop.visible = next === '2d';
  renderPass.camera = activeCamera();
  outlinePass.renderCamera = activeCamera();
}

function update3dCamera() {
  const target = new THREE.Vector3(view.cx, view.cy, 0);
  camera3d.position.copy(target).addScaledVector(CAMERA_3D_OFFSET, 1 / view.zoom);
  camera3d.lookAt(target);
}

// ---------------------------------------------------------------------------
// Resize + loop
// ---------------------------------------------------------------------------

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  outlinePass.setSize(w, h);
  camera3d.aspect = w / h;
  camera3d.updateProjectionMatrix();
}
window.addEventListener('resize', () => { resize(); homeView(); });
resize();

const MIN_VIEW_Y = -1; // show at most one row of ground below y = 0

// After a pan or zoom the view eases so its bottom-left corner sits on a grid
// line: whole cells only, never a sliver of ground.
let viewSnap = null; // { cx, cy } target, or null
let wheelSnapTimer = null;

function viewSize() {
  const w = canvas.clientWidth / (PX_PER_UNIT * view.zoom);
  const h = canvas.clientHeight / (PX_PER_UNIT * view.zoom);
  return { w, h };
}

// Ease the view to fit the whole board (or the origin when it's empty),
// zooming in or out as needed.
function homeView() {
  view.zoom = 1;
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  for (const item of items.values()) {
    for (const [cx, cy] of footprintCells(item.type, item.x, item.y, item.rot)) {
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx + 1); maxY = Math.max(maxY, cy + 1);
    }
  }
  if (!items.size) { minX = 0; maxX = 16; maxY = 0; }
  // Fit the contraption with a cell of margin each side (plus headroom),
  // zooming in or out; capped so a lone piece doesn't fill the screen.
  const fitW = canvas.clientWidth / (PX_PER_UNIT * (maxX - minX + 2));
  const fitH = canvas.clientHeight / (PX_PER_UNIT * (maxY + 3));
  view.zoom = THREE.MathUtils.clamp(Math.min(fitW, fitH), 0.25, 2);
  const { w, h } = viewSize();
  const left = Math.round((minX + maxX) / 2 - w / 2);
  const bottom = Math.max(MIN_VIEW_Y, Math.round(maxY / 2 - h / 2));
  viewSnap = { cx: left + w / 2, cy: bottom + h / 2 };
}

function snapView() {
  const { w, h } = viewSize();
  const left = Math.round(view.cx - w / 2);
  const bottom = Math.max(MIN_VIEW_Y, Math.round(view.cy - h / 2));
  viewSnap = { cx: left + w / 2, cy: bottom + h / 2 };
}

function updateViewSnap(dt) {
  if (!viewSnap) return;
  const k = 1 - Math.exp(-dt * 14);
  view.cx += (viewSnap.cx - view.cx) * k;
  view.cy += (viewSnap.cy - view.cy) * k;
  if (Math.abs(viewSnap.cx - view.cx) < 0.002 && Math.abs(viewSnap.cy - view.cy) < 0.002) {
    view.cx = viewSnap.cx;
    view.cy = viewSnap.cy;
    viewSnap = null;
    scheduleSave();
  }
}

function update2dCamera() {
  const { w, h } = viewSize();
  view.cy = Math.max(view.cy, MIN_VIEW_Y + h / 2);
  camera2d.left = -w / 2; camera2d.right = w / 2;
  camera2d.top = h / 2; camera2d.bottom = -h / 2;
  camera2d.position.set(view.cx, view.cy, 20);
  camera2d.updateProjectionMatrix();
}

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (playing) stepPhysics(dt); else { updateTweens(dt); updateMirrorAnims(dt); }
  updateViewSnap(dt);
  update2dCamera(); // also clamps the view above the ground
  if (mode === '3d') update3dCamera();

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
// Examples (src/examples.js)
// ---------------------------------------------------------------------------

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
  if (playing) stopPlay();
  if (items.size) recordEdit();
  clearBoard();
  for (const [type, x, y, rot] of ex.items) addItem(type, x, y, rot || 0);
  // Center the view on the contraption.
  homeView();
  examplesSelect.value = name;
}

buildTray();
if (!loadProgress()) loadExample('Domino Run');
// Start fitted to the contraption, exactly on the grid, no easing.
homeView();
if (viewSnap) { view.cx = viewSnap.cx; view.cy = viewSnap.cy; viewSnap = null; }
window.addEventListener('beforeunload', () => { if (saveTimer) saveProgress(); });
setMode('2d');
frame();
