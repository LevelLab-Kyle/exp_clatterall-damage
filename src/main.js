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
}

// Gizmo visuals may be a single mesh or a group; these apply to every mesh inside.
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

function addItem(type, x, y, rot = 0) {
  const item = { id: nextId++, type, x, y, rot, mesh: GIZMOS[type].makeMesh(), parts: null };
  items.set(item.id, item);
  footprintCells(type, x, y, rot).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  storeRest(item.mesh);
  setHighlight(item, false); // records each mesh's base glow
  applyTransform(item);
  item.mesh.userData.itemId = item.id;
  scene.add(item.mesh);
  return item;
}

function moveItem(item, x, y, rot = item.rot) {
  footprintCells(item.type, item.x, item.y, item.rot).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  item.x = x;
  item.y = y;
  item.rot = rot;
  footprintCells(item.type, x, y, rot).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  applyTransform(item);
}

function removeItem(item) {
  footprintCells(item.type, item.x, item.y, item.rot).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  items.delete(item.id);
  tweens.delete(item.mesh);
  scene.remove(item.mesh);
  if (selected === item) select(null);
}

function select(item) {
  selected = item;
  outlinePass.selectedObjects = selected ? [selected.mesh] : [];
}

function clearBoard() {
  [...items.values()].forEach(removeItem);
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

  scene.updateMatrixWorld(true);
  const wp = new THREE.Vector3(), wq = new THREE.Quaternion();
  for (const item of items.values()) {
    const def = GIZMOS[item.type];
    const built = def.makeBodies
      ? def.makeBodies(item.mesh)
      : { parts: [{ body: def.makeBody(), mesh: item.mesh }], constraints: [] };
    for (const part of built.parts) {
      const src = part.mesh || item.mesh;
      src.getWorldPosition(wp);
      src.getWorldQuaternion(wq);
      part.body.position.copy(wp);
      part.body.quaternion.copy(wq);
      world.addBody(part.body);
    }
    built.constraints.forEach((c) => world.addConstraint(c));
    item.parts = built.parts;
    if (def.goal) built.parts[0].body.addEventListener('collide', () => onGoalHit(item));
  }

  playing = true;
  document.body.classList.add('playing');
  btnPlay.hidden = true;
  btnReset.hidden = false;
}

function stopPlay() {
  playing = false;
  won = false;
  world = null;
  for (const item of items.values()) {
    item.parts = null;
    restoreRest(item.mesh);
    applyTransform(item);
    setHighlight(item, false);
  }
  document.body.classList.remove('playing');
  btnPlay.hidden = false;
  btnReset.hidden = true;
  toast.hidden = true;
}

function onGoalHit(star) {
  if (won) return;
  won = true;
  star.mesh.material.emissive.set(0xffaa00);
  toast.textContent = '⭐ You did it!';
  toast.hidden = false;
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
  for (const item of items.values()) GIZMOS[item.type].onStep?.(item, world, dt);
  world.step(1 / 60, dt, 4);
  for (const item of items.values()) {
    if (!item.parts) continue;
    for (const part of item.parts) {
      if (part.mesh && part.body.mass > 0) syncPart(item, part);
    }
    GIZMOS[item.type].onFrame?.(item, dt);
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

// Where the dragged gizmo floats (un-snapped) and the cell it would land in.
// `grab` is the pointer-to-anchor offset so a picked-up item doesn't jump.
function dragTarget(ev, size, grab) {
  const p = pointerToWorld(ev);
  if (!p) return null;
  const ax = grab ? p.x + grab.x : p.x - size.w / 2;
  const ay = grab ? p.y + grab.y : p.y - size.h / 2;
  return { ax, ay, x: Math.round(ax), y: Math.round(ay) };
}

// Short ease-out animation into place: slide (and turn, if the rotation
// changed) from wherever the gizmo was into its cell, both at once.
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
}

function pickItem(ev) {
  const r = canvas.getBoundingClientRect();
  pointerNdc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, activeCamera());
  const meshes = [...items.values()].map((i) => i.mesh);
  const hit = raycaster.intersectObjects(meshes, true)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && o.userData.itemId == null) o = o.parent;
  return o ? items.get(o.userData.itemId) : null;
}

let drag = null; // { kind: 'new'|'move'|'pan', ... }

function beginNewDrag(type, ev) {
  const ghost = GIZMOS[type].makeMesh();
  eachMesh(ghost, (m) => { m.material = ghostMat; m.castShadow = false; });
  ghost.visible = false;
  scene.add(ghost);
  drag = { kind: 'new', type, ghost, rot: 0, cell: null };
  try { ev.target.setPointerCapture(ev.pointerId); } catch {}
  updateDrag(ev);
}

function updateDrag(ev) {
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
  const cell = dragTarget(ev, footprintSize(type, rot), drag.grab);
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
  if (d.kind === 'new') {
    scene.remove(d.ghost);
    if (d.cell && canPlace(d.type, d.cell.x, d.cell.y, d.rot)) {
      const item = addItem(d.type, d.cell.x, d.cell.y, d.rot);
      settle(item, d.ghost.position);
      select(item);
    }
  } else if (d.kind === 'move') {
    setFaded(d.item.mesh, false);
    const from = d.item.mesh.position.clone();
    if (d.moved && d.cell && canPlace(d.item.type, d.cell.x, d.cell.y, d.item.rot, d.item.id)) {
      moveItem(d.item, d.cell.x, d.cell.y);
    } else {
      applyTransform(d.item);
    }
    if (d.moved) settle(d.item, from);
    select(d.item);
  }
}

canvas.addEventListener('pointerdown', (ev) => {
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
    drag = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, cx0: view.cx, cy0: view.cy };
  }
});

window.addEventListener('pointermove', updateDrag);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (playing) return;
  const item = pickItem(ev);
  if (item) removeItem(item);
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    view.zoom = THREE.MathUtils.clamp(view.zoom * Math.exp(-ev.deltaY * 0.01), 0.25, 3);
  } else {
    view.cx += ev.deltaX / (PX_PER_UNIT * view.zoom);
    view.cy -= ev.deltaY / (PX_PER_UNIT * view.zoom);
  }
}, { passive: false });

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'r' || ev.key === 'R') rotateSelected(ev.shiftKey ? -1 : 1);
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && !playing) removeItem(selected);
  if (ev.key === 'Escape') select(null);
  if (ev.key === ' ') { ev.preventDefault(); playing ? stopPlay() : startPlay(); }
});

// Turn the selected (or being-dragged) gizmo a quarter turn.
// dir = +1 counter-clockwise, -1 clockwise.
function rotateSelected(dir = 1) {
  if (drag?.kind === 'new' && GIZMOS[drag.type].rotatable) {
    drag.rot = (drag.rot + dir + 4) % 4;
    return;
  }
  if (!selected || playing || !GIZMOS[selected.type].rotatable) return;
  const rot = (selected.rot + dir + 4) % 4;
  // The turned footprint has to fit where it stands.
  if (!canPlace(selected.type, selected.x, selected.y, rot, selected.id)) return;
  const from = selected.mesh.position.clone();
  const fromQ = selected.mesh.quaternion.clone();
  moveItem(selected, selected.x, selected.y, rot);
  settle(selected, from, fromQ); // turns and slides into the cell together
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const btnPlay = document.getElementById('btn-play');
const btnReset = document.getElementById('btn-reset');
const btnClear = document.getElementById('btn-clear');
const btnView = document.getElementById('btn-view');
const toast = document.getElementById('toast');
const itemTools = document.getElementById('item-tools');
const toolRotateCcw = document.getElementById('tool-rotate-ccw');
const toolRotateCw = document.getElementById('tool-rotate-cw');
const toolDelete = document.getElementById('tool-delete');
const trayList = document.getElementById('gizmo-list');

btnPlay.onclick = startPlay;
btnReset.onclick = stopPlay;
btnClear.onclick = () => { if (!playing) clearBoard(); };
toolRotateCcw.onclick = () => rotateSelected(1);
toolRotateCw.onclick = () => rotateSelected(-1);
toolDelete.onclick = () => { if (selected && !playing) removeItem(selected); };
// Clicks on the floating tools must not reach the board underneath.
itemTools.addEventListener('pointerdown', (ev) => ev.stopPropagation());

// Float the rotate/delete buttons just above the selected gizmo.
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
  toolRotateCcw.disabled = toolRotateCw.disabled = !GIZMOS[selected.type].rotatable;
}
btnView.onclick = () => setMode(mode === '2d' ? '3d' : '2d');

for (const type of GIZMO_ORDER) {
  const def = GIZMOS[type];
  const card = document.createElement('div');
  card.className = 'gizmo-card';
  card.innerHTML = `<div class="icon">${def.icon}</div><div class="name">${def.name}</div><div class="hint">${def.hint}</div>`;
  card.addEventListener('pointerdown', (ev) => { if (!playing) beginNewDrag(type, ev); });
  trayList.appendChild(card);
}

function setMode(next) {
  mode = next;
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
window.addEventListener('resize', resize);
resize();

const MIN_VIEW_Y = -1; // show at most one row of ground below y = 0

function update2dCamera() {
  const w = canvas.clientWidth / (PX_PER_UNIT * view.zoom);
  const h = canvas.clientHeight / (PX_PER_UNIT * view.zoom);
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

  if (playing) stepPhysics(dt); else updateTweens(dt);
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
  updateItemTools();

  composer.render();
}

// ---------------------------------------------------------------------------
// Starter contraption so the board isn't empty
// ---------------------------------------------------------------------------

function loadStarter() {
  for (let y = 0; y < 3; y++) addItem('block', 2, y);
  addItem('block', 3, 0); addItem('block', 3, 1);
  addItem('block', 4, 0); addItem('block', 4, 1);
  addItem('longramp', 3, 2);
  addItem('marble', 3, 4);
  for (let x = 7; x <= 11; x++) addItem('domino', x, 0);
  addItem('star', 13, 0);
}

loadStarter();
setMode('2d');
frame();
