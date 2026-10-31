// Gadget registry.
//
// Each gadget separates *how it looks* (makeMesh) from *how it behaves*
// (makeBody). The tray picture is rendered from makeMesh() too; set `image`
// to a URL to use a hand-made picture instead. Swap makeMesh for a loaded 3D asset later without touching
// the physics or the game logic.
//
// Coordinates: one unit is one grid cell, and every cell splits into a 4x4
// subgrid. Gadgets are sized so their outer edges all land on subgrid lines,
// and they're placed on subgrid lines too. A gadget's anchor (x, y) is the
// bottom-left corner of its footprint box (w x h units, multiples of 1/4);
// z runs -0.5..0.5.


const Z_AXIS_THREE = new THREE.Vector3(0, 0, 1);
const COLORS = {
  marble: 0x4f8cff,
  domino: 0xff6b6b,
  ramp: 0x8bd17c,
  block: 0xc9a06b,
  star: 0xffd84d,
};

function standard(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...extra });
}

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return edged(mesh);
}

// Thin dark edge lines on every part, so pieces placed side by side read as
// separate things instead of one merged shape. (Smooth shapes like spheres
// have no hard edges and get none.)
const EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5 });
function edged(mesh) {
  // Push the surface back a hair so the lines on it don't z-fight.
  mesh.material.polygonOffset = true;
  mesh.material.polygonOffsetFactor = 1;
  mesh.material.polygonOffsetUnits = 1;
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 20), EDGE_MATERIAL));
  return mesh;
}

// Right-triangle prism: high edge on the left, sloping down to the right.
// `mirror` puts the right angle at the bottom-right instead (a flipped wedge).
function wedgeGeometry(w, h, d, mirror = false) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(w, 0);
  shape.lineTo(mirror ? w : 0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(-w / 2, -h / 2, -d / 2);
  return geo;
}

// Upright triangle: flat base on the bottom, point at the top (a fulcrum).
function fulcrumGeometry(w, h, d) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  return geo;
}

function wedgeShape(w, h, d, mirror = false) {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const sx = mirror ? -1 : 1; // mirror across x: negate x and reverse face winding
  const v = (x, y, z) => new CANNON.Vec3(x * sx, y, z);
  const vertices = [
    v(-hw, -hh, -hd), v(hw, -hh, -hd), v(-hw, hh, -hd),
    v(-hw, -hh, hd), v(hw, -hh, hd), v(-hw, hh, hd),
  ];
  // Faces wound counter-clockwise when viewed from outside.
  let faces = [
    [0, 1, 4, 3], // bottom
    [0, 2, 1],    // back
    [3, 4, 5],    // front
    [0, 3, 5, 2], // left (tall side)
    [1, 2, 5, 4], // slope
  ];
  if (mirror) faces = faces.map((f) => [...f].reverse());
  return new CANNON.ConvexPolyhedron({ vertices, faces });
}

// Keep dynamic bodies in the X/Y plane so nothing drifts into the screen.
function lockToPlane(body) {
  body.linearFactor.set(1, 1, 0);
  body.angularFactor.set(0, 0, 1);
  return body;
}

// Subgrid: each cell is SUB x SUB quarter cells.
const SUB = 4;

const MARBLE_R = 0.25; // half a cell across
// Dominoes are taller than a cell so each one reaches the next when it falls.
const DOMINO = { w: 0.25, h: 1.5, d: 0.6 };
// Physics materials. Static surfaces share one so contact rules are simple.
const MATS = {
  surface: new CANNON.Material('surface'),
  domino: new CANNON.Material('domino'),
  marble: new CANNON.Material('marble'),
  bouncy: new CANNON.Material('bouncy'),
  bell: new CANNON.Material('bell'),
};

const ROLLER_SPIN = 6; // conveyor roller spin, radians per second (see conveyor.onFrame)

// Direction a gadget "faces" after rot quarter turns: local +x turned.
function facing(item) {
  const a = (item.rot || 0) * Math.PI / 2;
  return { dx: Math.cos(a), dy: Math.sin(a), ux: -Math.sin(a), uy: Math.cos(a) };
}

// Multi-part gadgets: makeMesh() returns a THREE.Group with named children,
// and makeBodies(group) returns { parts: [{ body, mesh }], constraints }.
// Each part's body starts at its mesh's world transform; dynamic parts drive
// their mesh during play. mesh may be null for a body with no moving visual.
// Optional hooks: onStep(item, world, dt) before each physics step,
// onFrame(item, dt) after each render sync.
function named(mesh, name) {
  mesh.name = name;
  return mesh;
}

const Z_AXIS = new CANNON.Vec3(0, 0, 1);

const GADGETS = {
  // The tray has one Ball (the medium one): the marble, ball and bowling
  // ball are its three sizes (see BALL_SIZES; Size swaps between them).
  marble: {
    name: 'Marble',
    // It snaps like a whole cell, sitting in the middle of it: only those
    // 2 x 2 quarter cells are taken, so neighbours can come close.
    w: 1, h: 1,
    footprint: () => rectCells(0.5 - MARBLE_R, 0.5 - MARBLE_R, 2 * MARBLE_R, 2 * MARBLE_R),
    dynamic: true,
    makeMesh() {
      return shadowed(new THREE.Mesh(new THREE.SphereGeometry(MARBLE_R, 32, 24), standard(COLORS.marble, { roughness: 0.3 })));
    },
    makeBody() {
      return lockToPlane(new CANNON.Body({ mass: 1.2, shape: new CANNON.Sphere(MARBLE_R), material: MATS.marble }));
    },
    offset: () => new THREE.Vector3(0.5, 0.5, 0),
  },

  // Between the marble and the bowling ball: a whole cell across, middling weight.
  ball: {
    name: 'Ball',
    w: 1, h: 1,
    dynamic: true,
    makeMesh() {
      return shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 24), standard(COLORS.marble, { roughness: 0.3 })));
    },
    makeBody() {
      return lockToPlane(new CANNON.Body({ mass: 3, shape: new CANNON.Sphere(0.5), material: MATS.marble }));
    },
    offset: () => new THREE.Vector3(0.5, 0.5, 0),
  },

  domino: {
    name: 'Domino',
    w: DOMINO.w, h: DOMINO.h,
    rotatable: true,
    dynamic: true,
    // Size changes the height only: 1½ (normal), 2, then 1. Sizes scale the
    // normal 1½, so those are x1, x4/3 and x2/3. Weight goes with height.
    resizable: { sizes: [[1, 1], [1, 4 / 3], [1, 2 / 3]] },
    makeMesh(item) {
      const h = DOMINO.h * (item?.size?.h || 1);
      return shadowed(new THREE.Mesh(new THREE.BoxGeometry(DOMINO.w, h, DOMINO.d), standard(COLORS.domino)));
    },
    makeBody(item) {
      const k = item?.size?.h || 1;
      const shape = new CANNON.Box(new CANNON.Vec3(DOMINO.w / 2, DOMINO.h * k / 2, DOMINO.d / 2));
      return lockToPlane(new CANNON.Body({ mass: 0.15 * k, shape, material: MATS.domino }));
    },
    offset: () => new THREE.Vector3(DOMINO.w / 2, DOMINO.h / 2, 0),
  },

  // Flip mirrors it to slope the other way (item.flip): a stretched or 2x1
  // wedge's mirror image isn't one of its own rotations.
  ramp: {
    name: 'Ramp',
    w: 1, h: 1,
    rotatable: true,
    // The Size button steps through these (width x height, in its own
    // unturned frame) and wraps around.
    resizable: { sizes: [[1, 1], [2, 1], [2, 2], [1, 2]] },
    flippable: true,
    makeMesh(item) {
      const s = item?.size || NORMAL_SIZE;
      return shadowed(new THREE.Mesh(wedgeGeometry(s.w, s.h, 1, !!item?.flip), standard(COLORS.ramp)));
    },
    makeBody(item) {
      const s = item?.size || NORMAL_SIZE;
      return new CANNON.Body({ mass: 0, shape: wedgeShape(s.w, s.h, 1, !!item?.flip), material: MATS.surface });
    },
    offset: () => new THREE.Vector3(0.5, 0.5, 0),
  },

  block: {
    name: 'Block',
    w: 1, h: 1,
    // Size steps through these (width x height): whole sizes, then half sizes.
    resizable: { sizes: [[1, 1], [2, 1], [1, 2], [2, 2], [0.5, 0.5], [1, 0.5], [0.5, 1]] },
    makeMesh(item) {
      const s = item?.size || NORMAL_SIZE;
      return shadowed(new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, 1), standard(COLORS.block)));
    },
    makeBody(item) {
      const s = item?.size || NORMAL_SIZE;
      return new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(s.w / 2, s.h / 2, 0.5)), material: MATS.surface });
    },
    offset: () => new THREE.Vector3(0.5, 0.5, 0),
  },

  star: {
    name: 'Star',
    w: 1, h: 1,
    goal: true,
    makeMesh() {
      const shape = new THREE.Shape();
      const outer = 0.5, inner = 0.21;
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = Math.PI / 2 + (i * Math.PI) / 5;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
      }
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false });
      geo.translate(0, 0, -0.125);
      return shadowed(new THREE.Mesh(geo, standard(COLORS.star, { emissive: 0x332800, roughness: 0.4 })));
    },
    makeBody() {
      return new CANNON.Body({ mass: 0, isTrigger: true, shape: new CANNON.Sphere(0.4) });
    },
    offset: () => new THREE.Vector3(0.5, 0.5, 0),
  },

  bowling: {
    name: 'Bowling ball',
    w: 2, h: 2,
    dynamic: true,
    makeMesh() {
      return shadowed(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), standard(COLORS.marble, { roughness: 0.3 })));
    },
    makeBody() {
      return lockToPlane(new CANNON.Body({ mass: 6, shape: new CANNON.Sphere(1), material: MATS.marble }));
    },
    offset: () => new THREE.Vector3(1, 1, 0),
  },

  bouncer: {
    name: 'Bouncer',
    w: 1, h: 0.5,
    rotatable: true,
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 1), standard(0x6b5b95))).translateY(0.125));
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.25, 0.75), standard(0xff8fd8, { roughness: 0.4 }))).translateY(0.375));
      return g;
    },
    makeBody() {
      const body = new CANNON.Body({ mass: 0, material: MATS.bouncy });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 0.25, 0.5)), new CANNON.Vec3(0, 0.25, 0));
      return body;
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },

  seesaw: {
    name: 'Seesaw',
    w: 3, h: 0.75,
    // Size: 3 wide, 4 wide, then 3 wide with the plank shifted half a cell
    // left or right of the fulcrum (a size's third value, `off`, is how far
    // the plank sits right of the fulcrum). The fulcrum stays put.
    resizable: { sizes: [[1, 1], [4 / 3, 1], [1, 1, -0.5], [1, 1, 0.5]] },
    // Where the fulcrum's middle sits, from the plank's left end.
    pivotX: (size) => (3 * (size?.w || 1)) / 2 - (size?.off || 0),
    // The plank across the top and the fulcrum under it; the space under each
    // end of the plank stays free.
    footprint(rot, { w, off }) {
      const px = w / 2 - off;
      return [...rectCells(0, 0.5, w, 0.25), ...rectCells(px - 0.5, 0, 1, 0.5)];
    },
    makeMesh(item) {
      const k = item?.size || NORMAL_SIZE;
      const len = 3 * k.w, off = k.off || 0;
      // The group's origin is the plank's middle; the fulcrum sits `off` left of it.
      const g = new THREE.Group();
      g.userData.seesaw = { len, off };
      // Fulcrum: base on the ground, point up at the hinge (local y = 0.5).
      const base = named(shadowed(new THREE.Mesh(fulcrumGeometry(1, 0.5, 0.6), standard(0x8a7f6a))), 'base');
      base.position.x = -off;
      g.add(base);
      // A shifted plank starts tipped, its long end resting on the ground:
      // the hinge (on the plank's underside, over the fulcrum) is 1/2 up, and
      // the long end reaches len/2 + |off| from it.
      const tilt = off ? -Math.sign(off) * Math.asin(0.5 / (len / 2 + Math.abs(off))) : 0;
      const plank = named(shadowed(new THREE.Mesh(new THREE.BoxGeometry(len, 0.25, 0.6), standard(0xf2b134))), 'plank');
      // Plank middle = hinge + (off, 1/8) turned by the tilt.
      const c = Math.cos(tilt), s = Math.sin(tilt);
      plank.position.set(-off + off * c - 0.125 * s, 0.5 + off * s + 0.125 * c, 0);
      plank.rotation.z = tilt;
      g.add(plank);
      return g;
    },
    makeBodies(g) {
      const { len, off } = g.userData.seesaw;
      const base = new CANNON.Body({ mass: 0, material: MATS.surface });
      base.addShape(new CANNON.Box(new CANNON.Vec3(0.3, 0.25, 0.3)), new CANNON.Vec3(0, 0.25, 0));
      const plank = lockToPlane(new CANNON.Body({ mass: 0.2 * len, shape: new CANNON.Box(new CANNON.Vec3(len / 2, 0.125, 0.3)), material: MATS.surface }));
      plank.angularDamping = 0.2;
      // The hinge is at the fulcrum's point, `off` left of the plank's middle.
      const hinge = new CANNON.HingeConstraint(base, plank, {
        pivotA: new CANNON.Vec3(0, 0.5, 0), axisA: Z_AXIS,
        pivotB: new CANNON.Vec3(-off, -0.125, 0), axisB: Z_AXIS,
      });
      return {
        parts: [{ body: base, mesh: g.getObjectByName('base') }, { body: plank, mesh: g.getObjectByName('plank') }],
        constraints: [hinge],
      };
    },
    offset: () => new THREE.Vector3(1.5, 0, 0),
  },

  fan: {
    name: 'Fan',
    w: 1, h: 1,
    rotatable: true,
    push: 3.5, // reach in cells
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.5), standard(0x5a6b7a))).translateY(0.5));
      const blade = named(new THREE.Group(), 'blade');
      // The blade ring sits at the cell's right edge (it ends on x = 1), on
      // a short axle from the post.
      blade.position.set(0.47, 0.5, 0);
      const axle = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 12), standard(0x5a6b7a)));
      axle.rotation.z = Math.PI / 2;
      axle.position.set(0.36, 0.5, 0);
      g.add(axle);
      blade.rotation.y = Math.PI / 2;
      for (let i = 0; i < 3; i++) {
        const b = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.04), standard(0xc7e6ff, { roughness: 0.3 })));
        b.rotation.z = (i * Math.PI) / 3;
        blade.add(b);
      }
      blade.add(shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.03, 8, 32), standard(0x5a6b7a))));
      g.add(blade);
      return g;
    },
    makeBodies() {
      const post = new CANNON.Body({ mass: 0, material: MATS.surface });
      post.addShape(new CANNON.Box(new CANNON.Vec3(0.25, 0.5, 0.25)), new CANNON.Vec3(0, 0.5, 0));
      return { parts: [{ body: post, mesh: null }], constraints: [] };
    },
    onStep(item, world) {
      // Blows along the fan's local +x, turned by the item's rotation.
      const a = (item.rot || 0) * Math.PI / 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      const fx = item.x + 0.5, fy = item.y + 0.5;
      for (const b of world.bodies) {
        if (b.mass === 0) continue;
        const rx = b.position.x - fx, ry = b.position.y - fy;
        const ahead = rx * dx + ry * dy;
        const side = Math.abs(-rx * dy + ry * dx);
        if (ahead < 0.4 || ahead > this.push || side > 0.8) continue;
        // Strong enough to lift a marble against gravity (30) at full reach.
        const strength = 75 * (1 - 0.5 * ahead / this.push);
        // Force through the center of mass: no lever arm, so no spin.
        b.applyForce(new CANNON.Vec3(dx * strength * b.mass, dy * strength * b.mass, 0));
      }
    },
    onFrame(item, dt) {
      item.mesh.getObjectByName('blade').rotation.x += dt * 25;
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },

  pendulum: {
    name: 'Pendulum',
    w: 1, h: 3.25,
    // Rotate doesn't turn the pendulum; it swings the ball out one level
    // either side (rot is -1..1). The rope is 2.5 long, so pulled out the ball
    // rests at a 3-4-5 triangle point, 1.5 across / 2 down, where its box
    // lands exactly on the subgrid.
    rotatable: true,
    // Rotate steps the ball through the swing levels and wraps around.
    poses: [0, 1, -1].map((rot) => ({ rot, flip: false })),
    startRot: -1, // a new pendulum comes pulled partway back to the left
    pivotY: 3, // the rope hangs from the bottom of the bar (bar: y 3..3.25)
    rope: 2.5,
    reach: [0, 1.5], // how far across the ball sits at each swing level
    ballRadius: 0.5,
    swing: { min: -1, max: 1 },
    idleFrame: true, // keep the rope drawn while editing
    ballRest(rot = 0) {
      // ↺ (positive rot) swings the ball out to the right, ↻ to the left,
      // the way a hanging ball moves when its bar turns that way.
      // Older saves may hold a level that's gone; use the furthest one left.
      const across = this.reach[Math.min(Math.abs(rot), this.reach.length - 1)];
      const down = Math.sqrt(this.rope * this.rope - across * across);
      return new THREE.Vector3(Math.sign(rot) * across, this.pivotY - down, 0);
    },
    // Only the bar and the ball take up space (the rope doesn't), so the
    // footprint moves with the swing level: swinging the ball out can change
    // which cells the pendulum needs to be free.
    footprint(rot = 0) {
      const b = this.ballRest(rot); // relative to the group origin (x + 0.5, y)
      const r = this.ballRadius;
      return [...rectCells(0, 3, 1, 0.25), ...rectCells(b.x + 0.5 - r, b.y - r, 2 * r, 2 * r)];
    },
    applyRot(item) {
      const ball = item.mesh.getObjectByName('ball');
      ball.position.copy(this.ballRest(item.rot || 0));
      if (ball.userData.rest) ball.userData.rest.p.copy(ball.position);
      this.onFrame(item);
    },
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 0.6), standard(0x8a7f6a))).translateY(this.pivotY + 0.125));
      const ball = named(shadowed(new THREE.Mesh(new THREE.SphereGeometry(this.ballRadius, 32, 24), standard(0x5a5a68, { roughness: 0.3, metalness: 0.3 }))), 'ball');
      ball.position.copy(this.ballRest(0));
      g.add(ball);
      const rope = named(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 8), standard(0x333333))), 'rope');
      g.add(rope);
      return g;
    },
    makeBodies(g) {
      const anchor = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.125, 0.3)), material: MATS.surface });
      const ball = lockToPlane(new CANNON.Body({ mass: 3, shape: new CANNON.Sphere(this.ballRadius), material: MATS.marble }));
      ball.linearDamping = 0.02;
      // Rope: pin the ball to the bar's underside at whatever angle it starts from.
      const toPivot = new THREE.Vector3(0, this.pivotY, 0).sub(g.getObjectByName('ball').position);
      const rope = new CANNON.PointToPointConstraint(anchor, new CANNON.Vec3(0, -0.125, 0), ball, new CANNON.Vec3(toPivot.x, toPivot.y, toPivot.z));
      return {
        parts: [{ body: anchor, mesh: g.children[0] }, { body: ball, mesh: g.getObjectByName('ball') }],
        constraints: [rope],
      };
    },
    onFrame(item) {
      const top = new THREE.Vector3(0, this.pivotY, 0);
      const ball = item.mesh.getObjectByName('ball').position;
      const rope = item.mesh.getObjectByName('rope');
      const dir = new THREE.Vector3().subVectors(ball, top);
      rope.position.copy(top).addScaledVector(dir, 0.5);
      rope.scale.y = dir.length();
      rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },

  // Carries things right, or left when flipped (item.flip). An arrow on the
  // front face shows the belt direction.
  conveyor: {
    name: 'Conveyor',
    w: 2, h: 0.5,
    rotatable: true,
    flippable: true,
    speed: 3,
    makeMesh(item) {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(2, 0.375, 0.8), standard(0x3d3d46))).translateY(0.1875));
      const arrow = new THREE.Shape();
      const s = item?.flip ? -1 : 1;
      [[-0.45, 0.05], [0.2, 0.05], [0.2, 0.11], [0.45, 0], [0.2, -0.11], [0.2, -0.05], [-0.45, -0.05]]
        .forEach(([x, y], i) => (i ? arrow.lineTo(x * s, y) : arrow.moveTo(x * s, y)));
      const face = new THREE.Mesh(new THREE.ShapeGeometry(arrow), standard(0xffe08a, { roughness: 0.5 }));
      face.position.set(0, 0.1875, 0.401); // on the front face, facing the camera
      g.add(face);
      // Rollers along the top spin to show the direction. They sit half sunk
      // in the base and stop just short of its front and back faces.
      for (let i = 0; i < 5; i++) {
        const r = named(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.76, 12), standard(0xffb545, { roughness: 0.5 }))), 'roller');
        r.rotation.x = Math.PI / 2;
        r.position.set(-0.75 + i * 0.375, 0.375, 0); // tops on y = 0.5
        g.add(r);
      }
      return g;
    },
    makeBody() {
      const body = new CANNON.Body({ mass: 0, material: MATS.surface });
      body.addShape(new CANNON.Box(new CANNON.Vec3(1, 0.25, 0.4)), new CANNON.Vec3(0, 0.25, 0));
      return body;
    },
    onStep(item, world) {
      // Anything resting just above the belt gets pulled toward the belt speed.
      const f = facing(item);
      const dir = item.flip ? -1 : 1;
      const cx = item.x + (footprintSize(item.type, item.rot).w) / 2;
      const cy = item.y + (footprintSize(item.type, item.rot).h) / 2;
      // Local frame: along = belt direction, up = away from the belt surface.
      for (const b of world.bodies) {
        if (b.mass === 0) continue;
        const rx = b.position.x - cx, ry = b.position.y - cy;
        const along = rx * f.dx + ry * f.dy;
        const up = rx * f.ux + ry * f.uy;
        if (Math.abs(along) > 1.1 || up < 0 || up > 1.1) continue;
        const v = (b.velocity.x * f.dx + b.velocity.y * f.dy) * dir;
        const push = (this.speed - v) * 8 * b.mass * dir;
        b.applyForce(new CANNON.Vec3(f.dx * push, f.dy * push, 0));
      }
    },
    onFrame(item, dt) {
      // A true rolling speed (speed / radius, ~27 rad/s) moves the roller's
      // edge lines almost one 30° segment per frame, which the eye reads as
      // spinning backwards. A slower spin reads correctly.
      const spin = dt * ROLLER_SPIN * (item.flip ? -1 : 1);
      item.mesh.traverse((o) => { if (o.name === 'roller') o.rotation.y -= spin; });
    },
    offset: () => new THREE.Vector3(1, 0, 0),
  },

  launcher: {
    name: 'Launcher',
    w: 1, h: 0.5,
    rotatable: true,
    delay: 0.4,
    kick: 14,
    plateY: 0.3125, // plate spans y 0.25..0.375
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 0.8), standard(0x5a4a6a))).translateY(0.125));
      const plate = named(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.125, 0.7), standard(0xff5a5a, { roughness: 0.4 }))), 'plate');
      plate.position.y = this.plateY;
      g.add(plate);
      // A little arrow on the plate shows which way it fires (local +y, i.e. up).
      const arrow = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.125, 4), standard(0xffe08a)));
      arrow.position.y = 0.4375; // tip on y = 0.5
      arrow.rotation.y = Math.PI / 4;
      g.add(arrow);
      return g;
    },
    makeBody() {
      const body = new CANNON.Body({ mass: 0, material: MATS.surface });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 0.1875, 0.4)), new CANNON.Vec3(0, 0.1875, 0));
      return body;
    },
    onStep(item, world) {
      if (world.time < this.delay) { item.armed = true; return; }
      if (!item.armed) return;
      item.armed = false;
      item.popT = 0;
      // Fire along local "up" (the plate's normal), turned by the rotation.
      const f = facing(item);
      const { w, h } = footprintSize(item.type, item.rot);
      const cx = item.x + w / 2, cy = item.y + h / 2;
      for (const b of world.bodies) {
        if (b.mass === 0) continue;
        const rx = b.position.x - cx, ry = b.position.y - cy;
        const along = rx * f.dx + ry * f.dy;
        const up = rx * f.ux + ry * f.uy;
        if (Math.abs(along) > 0.6 || up < -0.2 || up > 1.4) continue;
        b.applyImpulse(new CANNON.Vec3(f.ux * this.kick * b.mass, f.uy * this.kick * b.mass, 0));
      }
    },
    onFrame(item, dt) {
      if (item.popT === undefined) return;
      item.popT += dt;
      const plate = item.mesh.getObjectByName('plate');
      const k = Math.max(0, 1 - item.popT * 4); // quick pop then settle
      plate.position.y = this.plateY + Math.sin(Math.min(1, item.popT * 4) * Math.PI) * 0.35 * (k + 0.2);
      if (item.popT > 0.5) { plate.position.y = this.plateY; delete item.popT; }
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },

  bell: {
    name: 'Bell',
    w: 1, h: 1,
    idleFrame: true,
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.125, 0.5), standard(0x8a7f6a))).translateY(0.9375));
      const swing = named(new THREE.Group(), 'swing');
      swing.position.y = 0.875;
      const cup = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.375, 0.5, 16), standard(0xf5c542, { roughness: 0.3, metalness: 0.4 })));
      cup.position.y = -0.25; // cup spans y 0.375..0.875
      swing.add(cup);
      const clapper = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), standard(0x333333)));
      clapper.position.y = -0.535; // bottom on y = 0.25
      swing.add(clapper);
      g.add(swing);
      return g;
    },
    makeBody() {
      const body = new CANNON.Body({ mass: 0, material: MATS.bell });
      body.addShape(new CANNON.Sphere(0.34), new CANNON.Vec3(0, 0.5, 0));
      return body;
    },
    // Set by the game when something hits the bell: starts the swing.
    ring(item) { item.swingT = 0; },
    onFrame(item, dt) {
      if (item.swingT === undefined) return;
      item.swingT += dt;
      const swing = item.mesh.getObjectByName('swing');
      swing.rotation.z = Math.sin(item.swingT * 18) * 0.25 * Math.exp(-item.swingT * 3);
      if (item.swingT > 1.5) { swing.rotation.z = 0; delete item.swingT; }
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },

  plank: {
    name: 'Plank',
    w: 3, h: 0.25,
    rotatable: true,
    dynamic: true,
    // Size changes the length only: 3 (normal), 4, then 2. Sizes scale the
    // normal 3, so those are x1, x4/3 and x2/3. Weight goes with length.
    resizable: { sizes: [[1, 1], [4 / 3, 1], [2 / 3, 1]] },
    makeMesh(item) {
      const w = 3 * (item?.size?.w || 1);
      return shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, 0.25, 0.6), standard(0xc98f4a)));
    },
    makeBody(item) {
      const k = item?.size?.w || 1;
      return lockToPlane(new CANNON.Body({ mass: 0.5 * k, shape: new CANNON.Box(new CANNON.Vec3(1.5 * k, 0.125, 0.3)), material: MATS.surface }));
    },
    offset: () => new THREE.Vector3(1.5, 0.125, 0),
  },

  bucket: {
    name: 'Bucket',
    // A quarter-thick floor and walls around an open inside exactly as wide
    // as a ball, so a bucket lined up under a ball catches it. Size steps it
    // up for each ball: inside 1/2 (marble), 1 (ball), 2 (bowling ball). The
    // arms stand half the ball's height above the floor.
    w: 1, h: 0.5,
    rotatable: true,
    resizable: { sizes: [[1, 1], [1.5, 1.5], [2.5, 2.5]] },
    // Size grows it evenly around its cavity: see nextSize in main.js.
    cavity: true,
    floor: 0.25,
    dims(item) {
      const k = item?.size || NORMAL_SIZE;
      const w = this.w * k.w, h = this.h * k.h;
      return { w, h, t: this.wall(w) };
    },
    wall: () => 0.25, // wall thickness
    // Just the floor and the two walls: the inside stays free to fill.
    footprint(rot, dims) {
      const { w, h } = dims, t = this.wall(w), f = this.floor;
      return [...rectCells(0, 0, w, f), ...rectCells(0, f, t, h - f), ...rectCells(w - t, f, t, h - f)];
    },
    makeMesh(item) {
      // One U-shaped piece, so edge lines only trace its outline (separate
      // floor and wall boxes would show seams where they meet).
      const { w, h, t } = this.dims(item), f = this.floor;
      const x0 = -w / 2, x1 = w / 2;
      const u = new THREE.Shape();
      [[x0, 0], [x1, 0], [x1, h], [x1 - t, h], [x1 - t, f], [x0 + t, f], [x0 + t, h], [x0, h]]
        .forEach(([x, y], i) => (i ? u.lineTo(x, y) : u.moveTo(x, y)));
      const geo = new THREE.ExtrudeGeometry(u, { depth: 0.8, bevelEnabled: false });
      geo.translate(0, 0, -0.4);
      return shadowed(new THREE.Mesh(geo, standard(0x4f7fa8)));
    },
    makeBody(item) {
      const { w, h, t } = this.dims(item), f = this.floor;
      const body = new CANNON.Body({ mass: 0, material: MATS.surface });
      body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2 - t, f / 2, 0.4)), new CANNON.Vec3(0, f / 2, 0));
      for (const side of [-1, 1]) body.addShape(new CANNON.Box(new CANNON.Vec3(t / 2, h / 2, 0.4)), new CANNON.Vec3(side * (w / 2 - t / 2), h / 2, 0));
      return body;
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },
};

// Rope needs drawing before play too.
GADGETS.pendulum._makeMesh = GADGETS.pendulum.makeMesh;
GADGETS.pendulum.makeMesh = function () {
  const g = this._makeMesh();
  this.onFrame({ mesh: g });
  return g;
};

// The Ball's sizes, smallest first: Size steps through them. In a level's
// parts, `ball` stands for a ball of any size.
const BALL_SIZES = ['marble', 'ball', 'bowling'];
const partType = (type) => (BALL_SIZES.includes(type) ? 'ball' : type);

const GADGET_ORDER = ['ball', 'domino', 'plank', 'ramp', 'block', 'bucket', 'seesaw', 'bouncer', 'conveyor', 'launcher', 'fan', 'pendulum', 'bell', 'star'];

// A resizable gadget's `size` scales its normal width and height separately
// ({ w, h }); null means its normal size.
const NORMAL_SIZE = { w: 1, h: 1 };
const sizeOf = (type, size) => (GADGETS[type].resizable && size) || NORMAL_SIZE;

// Footprint size after `rot` quarter turns (odd turns swap width and height).
function footprintSize(type, rot = 0, size = null) {
  const def = GADGETS[type];
  const k = sizeOf(type, size);
  const w = def.w * k.w, h = def.h * k.h;
  if (def.swing) return { w, h }; // swinging gadgets never turn
  return rot % 2 ? { w: h, h: w } : { w, h };
}

// World-space transform for an item at cell (x, y), turned `rot` quarter
// turns counter-clockwise about the center of its footprint.
function itemTransform(item) {
  const def = GADGETS[item.type];
  const rot = def.swing ? 0 : (item.rot || 0);
  const angle = rot * Math.PI / 2;
  const quaternion = new THREE.Quaternion().setFromAxisAngle(Z_AXIS_THREE, angle);
  const k = sizeOf(item.type, item.size);
  const turned = footprintSize(item.type, rot, item.size);
  // The mesh origin sits at `offset` inside the unturned footprint; spin that
  // about the footprint center, then drop it into the turned footprint.
  const local = def.offset().multiply(new THREE.Vector3(k.w, k.h, 1))
    .sub(new THREE.Vector3(def.w * k.w / 2, def.h * k.h / 2, 0)).applyQuaternion(quaternion);
  const position = local.add(new THREE.Vector3(item.x + turned.w / 2, item.y + turned.h / 2, 0));
  return { position, quaternion };
}

// Subgrid cells covering a w x h box at (x, y), all in units (multiples of
// 1/4). Cells are [i, j] subgrid indices: cell i spans i/SUB..(i+1)/SUB.
function rectCells(x, y, w, h) {
  const cells = [];
  const i0 = Math.round(x * SUB), j0 = Math.round(y * SUB);
  const nw = Math.round(w * SUB), nh = Math.round(h * SUB);
  for (let i = 0; i < nw; i++) {
    for (let j = 0; j < nh; j++) cells.push([i0 + i, j0 + j]);
  }
  return cells;
}

// The subgrid cells an item at (x, y) turned `rot` takes up on the board.
// A gadget's own `footprint(rot)` lists its cells relative to its anchor,
// unturned; otherwise it fills its whole box.
function footprintCells(type, x, y, rot = 0, size = null) {
  const def = GADGETS[type];
  const i0 = Math.round(x * SUB), j0 = Math.round(y * SUB);
  if (def.footprint) {
    const r = def.swing ? 0 : rot;
    const k = sizeOf(type, size);
    const dims = { w: def.w * k.w, h: def.h * k.h, off: k.off || 0 }; // unturned
    const W = Math.round(dims.w * SUB), H = Math.round(dims.h * SUB);
    // Turn each cell about the box: (i, j) -> after r quarter turns CCW.
    return def.footprint(rot, dims).map(([i, j]) => {
      for (let k = 0; k < r; k++) [i, j] = [(k % 2 ? W : H) - 1 - j, i];
      return [i0 + i, j0 + j];
    });
  }
  const { w, h } = footprintSize(type, rot, size);
  return rectCells(x, y, w, h);
}

// ---------------------------------------------------------------------------
// Physics world for a run. Shared by the game (src/main.js) and the headless
// level checker (tools/check-levels.cjs), so both play out exactly the same.
// Each item needs its mesh in place (see placeMesh). Sets item.parts.
// hooks: onImpact(body, ev), onBell(item, ev), onGoal(item).
// ---------------------------------------------------------------------------

// Physics runs at 120 steps a second. At 60, a small fast marble could sink
// a good way into the ground in one step, and the push back out stopped it
// dead. stepFrame advances one 1/60 s frame (used by scripted runs).
const PHYSICS_STEP = 1 / 120;
function stepFrame(world) {
  world.step(PHYSICS_STEP);
  world.step(PHYSICS_STEP);
}

function buildWorld(items, hooks = {}) {
  // No sleeping: a slowly leaning domino wouldn't wake a sleeping neighbour.
  // Pieces are about a metre big, so real gravity feels sluggish. Crank it up for a toy feel.
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -30, 0), allowSleep: false });
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
    for (const item of items) GADGETS[item.type].onStep?.(item, world, world.dt);
  });

  const wp = new THREE.Vector3(), wq = new THREE.Quaternion();
  for (const item of items) {
    const def = GADGETS[item.type];
    item.mesh.updateMatrixWorld(true);
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
      if (hooks.onImpact && part.body.mass > 0) part.body.addEventListener('collide', (ev) => hooks.onImpact(part.body, ev));
      if (hooks.onBell && def.ring) part.body.addEventListener('collide', (ev) => hooks.onBell(item, ev));
    }
    built.constraints.forEach((c) => world.addConstraint(c));
    item.parts = built.parts;
    if (def.goal && hooks.onGoal) built.parts[0].body.addEventListener('collide', () => hooks.onGoal(item));
  }
  return world;
}

// Put an item's mesh where it sits on the board.
function placeMesh(item) {
  const { position, quaternion } = itemTransform(item);
  item.mesh.position.copy(position);
  item.mesh.quaternion.copy(quaternion);
  GADGETS[item.type].applyRot?.(item);
}
