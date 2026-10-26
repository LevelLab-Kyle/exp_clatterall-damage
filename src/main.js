const { OrbitControls } = THREE;

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

// 3D view: perspective camera on orbit controls.
const camera3d = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
const orbit = new OrbitControls(camera3d, canvas);
orbit.enabled = false;
orbit.enableDamping = true;

let mode = '2d';
const activeCamera = () => (mode === '2d' ? camera2d : camera3d);

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
const FLOOR_DEPTH = 60;
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

function canPlace(type, x, y, ignoreId = null) {
  return footprintCells(type, x, y).every(([cx, cy]) => {
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

function addItem(type, x, y, flip = false) {
  const item = { id: nextId++, type, x, y, flip, mesh: GIZMOS[type].makeMesh(), body: null };
  items.set(item.id, item);
  footprintCells(type, x, y).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  applyTransform(item);
  item.mesh.userData.itemId = item.id;
  scene.add(item.mesh);
  return item;
}

function moveItem(item, x, y) {
  footprintCells(item.type, item.x, item.y).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  item.x = x;
  item.y = y;
  footprintCells(item.type, x, y).forEach(([cx, cy]) => occupied.set(key(cx, cy), item.id));
  applyTransform(item);
}

function removeItem(item) {
  footprintCells(item.type, item.x, item.y).forEach(([cx, cy]) => occupied.delete(key(cx, cy)));
  items.delete(item.id);
  scene.remove(item.mesh);
  if (selected === item) select(null);
}

function select(item) {
  if (selected) selected.mesh.material.emissive?.set(selected.type === 'star' ? 0x332800 : 0x000000);
  selected = item;
  if (selected) selected.mesh.material.emissive?.set(0x444444);
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

  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: MATS.surface });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(ground);

  for (const item of items.values()) {
    const def = GIZMOS[item.type];
    const body = def.makeBody();
    body.position.copy(item.mesh.position);
    body.quaternion.copy(item.mesh.quaternion);
    item.body = body;
    world.addBody(body);
    if (def.goal) body.addEventListener('collide', () => onGoalHit(item));
  }

  playing = true;
  document.body.classList.add('playing');
  btnPlay.hidden = true;
  btnReset.hidden = false;
}

function stopPlay() {
  playing = false;
  world = null;
  for (const item of items.values()) {
    item.body = null;
    applyTransform(item);
    if (item.type === 'star') item.mesh.material.emissive.set(0x332800);
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

function stepPhysics(dt) {
  world.step(1 / 60, dt, 4);
  for (const item of items.values()) {
    if (!item.body || item.body.mass === 0) continue;
    item.mesh.position.copy(item.body.position);
    item.mesh.quaternion.copy(item.body.quaternion);
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

function pointerToCell(ev, def) {
  const p = pointerToWorld(ev);
  if (!p) return null;
  // Center the footprint under the pointer.
  return { x: Math.floor(p.x - def.w / 2 + 0.5), y: Math.floor(p.y - def.h / 2 + 0.5) };
}

function pickItem(ev) {
  const r = canvas.getBoundingClientRect();
  pointerNdc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, activeCamera());
  const meshes = [...items.values()].map((i) => i.mesh);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  return hit ? items.get(hit.object.userData.itemId) : null;
}

let drag = null; // { kind: 'new'|'move'|'pan', ... }

function beginNewDrag(type, ev) {
  const ghost = GIZMOS[type].makeMesh();
  ghost.material = ghostMat;
  ghost.castShadow = false;
  ghost.visible = false;
  scene.add(ghost);
  drag = { kind: 'new', type, ghost, flip: false, cell: null };
  ev.target.setPointerCapture?.(ev.pointerId);
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
  const def = GIZMOS[drag.kind === 'new' ? drag.type : drag.item.type];
  const cell = pointerToCell(ev, def);
  drag.cell = cell;
  if (drag.kind === 'new') {
    drag.ghost.visible = !!cell;
    if (cell) {
      const ok = canPlace(drag.type, cell.x, cell.y);
      drag.ghost.material = ok ? ghostMat : ghostBadMat;
      const { position, quaternion } = itemTransform({ type: drag.type, x: cell.x, y: cell.y, flip: drag.flip });
      drag.ghost.position.copy(position);
      drag.ghost.quaternion.copy(quaternion);
    }
  } else if (drag.kind === 'move') {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) > 4) drag.moved = true;
    if (drag.moved && cell) {
      const ok = canPlace(drag.item.type, cell.x, cell.y, drag.item.id);
      const { position } = itemTransform({ ...drag.item, x: cell.x, y: cell.y });
      drag.item.mesh.position.copy(position);
      drag.item.mesh.material.opacity = ok ? 1 : 0.5;
      drag.item.mesh.material.transparent = !ok;
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
    if (d.cell && canPlace(d.type, d.cell.x, d.cell.y)) select(addItem(d.type, d.cell.x, d.cell.y, d.flip));
  } else if (d.kind === 'move') {
    d.item.mesh.material.opacity = 1;
    d.item.mesh.material.transparent = false;
    if (d.moved && d.cell && canPlace(d.item.type, d.cell.x, d.cell.y, d.item.id)) {
      moveItem(d.item, d.cell.x, d.cell.y);
    } else {
      applyTransform(d.item);
    }
    select(d.item);
  }
}

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button === 2) return;
  if (mode === '3d') return; // orbit controls own the pointer in 3D
  const item = !playing && ev.button === 0 ? pickItem(ev) : null;
  canvas.setPointerCapture(ev.pointerId);
  canvas.classList.add('dragging');
  if (item) {
    drag = { kind: 'move', item, startX: ev.clientX, startY: ev.clientY, moved: false, cell: null };
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
  if (playing || mode === '3d') return;
  const item = pickItem(ev);
  if (item) removeItem(item);
});

canvas.addEventListener('wheel', (ev) => {
  if (mode === '3d') return;
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    view.zoom = THREE.MathUtils.clamp(view.zoom * Math.exp(-ev.deltaY * 0.01), 0.25, 3);
  } else {
    view.cx += ev.deltaX / (PX_PER_UNIT * view.zoom);
    view.cy -= ev.deltaY / (PX_PER_UNIT * view.zoom);
  }
}, { passive: false });

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'f' || ev.key === 'F') flipSelected();
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && !playing) removeItem(selected);
  if (ev.key === 'Escape') select(null);
  if (ev.key === ' ') { ev.preventDefault(); playing ? stopPlay() : startPlay(); }
});

function flipSelected() {
  if (drag?.kind === 'new' && GIZMOS[drag.type].flippable) {
    drag.flip = !drag.flip;
    return;
  }
  if (!selected || playing || !GIZMOS[selected.type].flippable) return;
  selected.flip = !selected.flip;
  applyTransform(selected);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const btnPlay = document.getElementById('btn-play');
const btnReset = document.getElementById('btn-reset');
const btnFlip = document.getElementById('btn-flip');
const btnClear = document.getElementById('btn-clear');
const btnView = document.getElementById('btn-view');
const toast = document.getElementById('toast');
const trayList = document.getElementById('gizmo-list');

btnPlay.onclick = startPlay;
btnReset.onclick = stopPlay;
btnFlip.onclick = flipSelected;
btnClear.onclick = () => { if (!playing) clearBoard(); };
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
  orbit.enabled = next === '3d';
  if (next === '3d') {
    const target = new THREE.Vector3(view.cx, Math.max(view.cy, 2), 0);
    camera3d.position.copy(target).add(new THREE.Vector3(6, 7, 14));
    orbit.target.copy(target);
    orbit.update();
  }
}

// ---------------------------------------------------------------------------
// Resize + loop
// ---------------------------------------------------------------------------

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera3d.aspect = w / h;
  camera3d.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function update2dCamera() {
  const w = canvas.clientWidth / (PX_PER_UNIT * view.zoom);
  const h = canvas.clientHeight / (PX_PER_UNIT * view.zoom);
  camera2d.left = -w / 2; camera2d.right = w / 2;
  camera2d.top = h / 2; camera2d.bottom = -h / 2;
  camera2d.position.set(view.cx, view.cy, 20);
  camera2d.updateProjectionMatrix();
}

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (playing) stepPhysics(dt);
  if (mode === '2d') update2dCamera(); else orbit.update();

  // Keep the backdrop, floor and shadow light centered on the view.
  const focus = mode === '2d' ? new THREE.Vector3(view.cx, view.cy, 0) : orbit.target;
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

  renderer.render(scene, activeCamera());
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
