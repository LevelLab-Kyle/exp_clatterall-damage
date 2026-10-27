// Gadget registry.
//
// Each gadget separates *how it looks* (makeMesh) from *how it behaves*
// (makeBody). The tray picture is rendered from makeMesh() too; set `image`
// to a URL to use a hand-made picture instead. Swap makeMesh for a loaded 3D asset later without touching
// the physics or the game logic.
//
// Coordinates: a gadget's "anchor" is the bottom-left cell of its footprint.
// Meshes and bodies are positioned relative to the anchor cell's origin
// (the cell spans x..x+1, y..y+1, z -0.5..0.5).


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

const MARBLE_R = 0.36;
// Dominoes are two cells tall so each one reaches the next cell when it falls.
const DOMINO = { w: 0.24, h: 1.6, d: 0.6 };
// Physics materials. Static surfaces share one so contact rules are simple.
const MATS = {
  surface: new CANNON.Material('surface'),
  domino: new CANNON.Material('domino'),
  marble: new CANNON.Material('marble'),
  bouncy: new CANNON.Material('bouncy'),
  bell: new CANNON.Material('bell'),
};

// Direction a gadget "faces" after rot quarter turns: local +x turned.
const ROLLER_SPIN = 6; // conveyor roller spin, radians per second (see conveyor.onFrame)

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
  marble: {
    name: 'Marble',
    hint: 'rolls',
    w: 1, h: 1,
    dynamic: true,
    makeMesh() {
      return shadowed(new THREE.Mesh(new THREE.SphereGeometry(MARBLE_R, 32, 24), standard(COLORS.marble, { roughness: 0.3 })));
    },
    makeBody() {
      return lockToPlane(new CANNON.Body({ mass: 1.2, shape: new CANNON.Sphere(MARBLE_R), material: MATS.marble }));
    },
    offset: () => new THREE.Vector3(0.5, MARBLE_R, 0),
  },

  domino: {
    name: 'Domino',
    hint: 'tips over',
    w: 1, h: 2,
    rotatable: true,
    dynamic: true,
    makeMesh() {
      return shadowed(new THREE.Mesh(new THREE.BoxGeometry(DOMINO.w, DOMINO.h, DOMINO.d), standard(COLORS.domino)));
    },
    makeBody() {
      const shape = new CANNON.Box(new CANNON.Vec3(DOMINO.w / 2, DOMINO.h / 2, DOMINO.d / 2));
      return lockToPlane(new CANNON.Body({ mass: 0.15, shape, material: MATS.domino }));
    },
    offset: () => new THREE.Vector3(0.5, DOMINO.h / 2, 0),
  },

  ramp: {
    name: 'Ramp',
    hint: 'rotates',
    w: 1, h: 1,
    rotatable: true,
    // A 1x1 wedge's mirror image is one of its own rotations.
    flipH: (item) => ({ rot: (5 - (item.rot || 0)) % 4 }),
    flipV: (item) => ({ rot: (7 - (item.rot || 0)) % 4 }),
    makeMesh() {
      return shadowed(new THREE.Mesh(wedgeGeometry(1, 1, 1), standard(COLORS.ramp)));
    },
    makeBody() {
      return new CANNON.Body({ mass: 0, shape: wedgeShape(1, 1, 1), material: MATS.surface });
    },
    offset: () => new THREE.Vector3(0.5, 0.5, 0),
  },

  longramp: {
    name: 'Long ramp',
    hint: 'rotates',
    w: 2, h: 1,
    rotatable: true,
    // A 2x1 wedge mirrored is a genuinely new shape, so it carries a mirror flag.
    flipH: (item) => ({ flip: !item.flip }),
    flipV: (item) => ({ flip: !item.flip, rot: ((item.rot || 0) + 2) % 4 }),
    makeMesh(item) {
      return shadowed(new THREE.Mesh(wedgeGeometry(2, 1, 1, !!item?.flip), standard(COLORS.ramp)));
    },
    makeBody(item) {
      return new CANNON.Body({ mass: 0, shape: wedgeShape(2, 1, 1, !!item?.flip), material: MATS.surface });
    },
    offset: () => new THREE.Vector3(1, 0.5, 0),
  },

  block: {
    name: 'Block',
    hint: 'solid',
    w: 1, h: 1,
    makeMesh() {
      return shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), standard(COLORS.block)));
    },
    makeBody() {
      return new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), material: MATS.surface });
    },
    offset: () => new THREE.Vector3(0.5, 0.5, 0),
  },

  star: {
    name: 'Star',
    hint: 'the goal!',
    w: 1, h: 1,
    goal: true,
    makeMesh() {
      const shape = new THREE.Shape();
      const outer = 0.42, inner = 0.18;
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
    hint: 'heavy',
    w: 2, h: 2,
    dynamic: true,
    makeMesh() {
      return shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.9, 40, 28), standard(0x4a4668, { roughness: 0.35 })));
    },
    makeBody() {
      return lockToPlane(new CANNON.Body({ mass: 6, shape: new CANNON.Sphere(0.9), material: MATS.marble }));
    },
    offset: () => new THREE.Vector3(1, 0.9, 0),
  },

  bouncer: {
    name: 'Bouncer',
    hint: 'boing!',
    w: 1, h: 1,
    rotatable: true,
    flipV: (item) => ({ rot: ((item.rot || 0) + 2) % 4 }),
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 1), standard(0x6b5b95))).translateY(0.15));
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.14, 0.9), standard(0xff8fd8, { roughness: 0.4 }))).translateY(0.37));
      return g;
    },
    makeBody() {
      const body = new CANNON.Body({ mass: 0, material: MATS.bouncy });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 0.22, 0.5)), new CANNON.Vec3(0, 0.22, 0));
      return body;
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },

  seesaw: {
    name: 'Seesaw',
    hint: 'tips',
    w: 3, h: 1,
    makeMesh() {
      const g = new THREE.Group();
      // Fulcrum: base on the ground, point up at the hinge (local y = 0.5).
      g.add(named(shadowed(new THREE.Mesh(fulcrumGeometry(0.7, 0.5, 0.6), standard(0x8a7f6a))), 'base'));
      g.add(named(shadowed(new THREE.Mesh(new THREE.BoxGeometry(3, 0.16, 0.6), standard(0xf2b134))), 'plank')).children[1].position.y = 0.58;
      return g;
    },
    makeBodies(g) {
      const base = new CANNON.Body({ mass: 0, material: MATS.surface });
      base.addShape(new CANNON.Box(new CANNON.Vec3(0.3, 0.25, 0.3)), new CANNON.Vec3(0, 0.25, 0));
      const plank = lockToPlane(new CANNON.Body({ mass: 0.6, shape: new CANNON.Box(new CANNON.Vec3(1.5, 0.08, 0.3)), material: MATS.surface }));
      plank.angularDamping = 0.2;
      const hinge = new CANNON.HingeConstraint(base, plank, {
        pivotA: new CANNON.Vec3(0, 0.5, 0), axisA: Z_AXIS,
        pivotB: new CANNON.Vec3(0, -0.08, 0), axisB: Z_AXIS,
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
    hint: 'rotates',
    w: 1, h: 1,
    rotatable: true,
    push: 3.5, // reach in cells
    flipH: (item) => ((item.rot || 0) % 2 === 0 ? { rot: ((item.rot || 0) + 2) % 4 } : null),
    flipV: (item) => ((item.rot || 0) % 2 === 1 ? { rot: ((item.rot || 0) + 2) % 4 } : null),
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.5), standard(0x5a6b7a))).translateY(0.5));
      const blade = named(new THREE.Group(), 'blade');
      blade.position.set(0.32, 0.5, 0);
      blade.rotation.y = Math.PI / 2;
      for (let i = 0; i < 3; i++) {
        const b = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.04), standard(0xc7e6ff, { roughness: 0.3 })));
        b.rotation.z = (i * Math.PI) / 3;
        blade.add(b);
      }
      blade.add(shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.03, 8, 32), standard(0x5a6b7a))));
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
    hint: 'swings',
    w: 1, h: 3,
    // Rotate doesn't turn the pendulum; it swings the ball out one column at
    // a time, up to two either side (rot is -2..2). At each level the ball's
    // outer edge sits on that column's far grid line (about 27° and 62°).
    rotatable: true,
    flipH: (item) => (item.rot ? { rot: -item.rot } : null),
    rope: 2.35,
    ballRadius: 0.42,
    swing: { min: -2, max: 2 },
    idleFrame: true, // keep the rope drawn while editing
    swingAngle(rot) {
      // ↺ (positive rot) swings the ball to the left, ↻ to the right.
      const reach = 0.5 + Math.abs(rot) - this.ballRadius;
      return -Math.sign(rot) * Math.asin(Math.min(1, reach / this.rope));
    },
    ballRest(rot = 0) {
      const a = rot ? this.swingAngle(rot) : 0;
      return new THREE.Vector3(Math.sin(a) * this.rope, 2.85 - Math.cos(a) * this.rope, 0);
    },
    // Only the anchor and the ball take up cells (the rope doesn't), so the
    // footprint moves with the swing level: swinging the ball out can change
    // which cells the pendulum needs to be free.
    footprint(rot = 0) {
      const b = this.ballRest(rot); // relative to the group origin (x + 0.5, y)
      return [[0, 2], [Math.floor(b.x + 0.5), Math.floor(b.y)]];
    },
    applyRot(item) {
      const ball = item.mesh.getObjectByName('ball');
      ball.position.copy(this.ballRest(item.rot || 0));
      if (ball.userData.rest) ball.userData.rest.p.copy(ball.position);
      this.onFrame(item);
    },
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 0.6), standard(0x8a7f6a))).translateY(2.85));
      const ball = named(shadowed(new THREE.Mesh(new THREE.SphereGeometry(this.ballRadius, 32, 24), standard(0x5a5a68, { roughness: 0.3, metalness: 0.3 }))), 'ball');
      ball.position.copy(this.ballRest(0));
      g.add(ball);
      const rope = named(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 8), standard(0x333333))), 'rope');
      g.add(rope);
      return g;
    },
    makeBodies(g) {
      const anchor = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.15, 0.3)), material: MATS.surface });
      const ball = lockToPlane(new CANNON.Body({ mass: 3, shape: new CANNON.Sphere(this.ballRadius), material: MATS.marble }));
      ball.linearDamping = 0.02;
      // Rope: pin the ball to the anchor at whatever angle it starts from.
      const toAnchor = g.children[0].position.clone().sub(g.getObjectByName('ball').position);
      const rope = new CANNON.PointToPointConstraint(anchor, new CANNON.Vec3(0, 0, 0), ball, new CANNON.Vec3(toAnchor.x, toAnchor.y, toAnchor.z));
      return {
        parts: [{ body: anchor, mesh: g.children[0] }, { body: ball, mesh: g.getObjectByName('ball') }],
        constraints: [rope],
      };
    },
    onFrame(item) {
      const top = new THREE.Vector3(0, 2.85, 0);
      const ball = item.mesh.getObjectByName('ball').position;
      const rope = item.mesh.getObjectByName('rope');
      const dir = new THREE.Vector3().subVectors(ball, top);
      rope.position.copy(top).addScaledVector(dir, 0.5);
      rope.scale.y = dir.length();
      rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },

  conveyor: {
    name: 'Conveyor',
    hint: 'carries',
    w: 2, h: 1,
    rotatable: true,
    flipH: (item) => ((item.rot || 0) % 2 === 0 ? { rot: ((item.rot || 0) + 2) % 4 } : null),
    flipV: (item) => ((item.rot || 0) % 2 === 1 ? { rot: ((item.rot || 0) + 2) % 4 } : null),
    speed: 3,
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 0.8), standard(0x3d3d46))).translateY(0.15));
      // Rollers along the top spin to show the direction. They sit half sunk
      // in the base and stop just short of its front and back faces.
      for (let i = 0; i < 5; i++) {
        const r = named(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.76, 12), standard(0xffb545, { roughness: 0.5 }))), 'roller');
        r.rotation.x = Math.PI / 2;
        r.position.set(-0.8 + i * 0.4, 0.3, 0);
        g.add(r);
      }
      return g;
    },
    makeBody() {
      const body = new CANNON.Body({ mass: 0, material: MATS.surface });
      body.addShape(new CANNON.Box(new CANNON.Vec3(1, 0.2, 0.4)), new CANNON.Vec3(0, 0.2, 0));
      return body;
    },
    onStep(item, world) {
      // Anything resting just above the belt gets pulled toward the belt speed.
      const f = facing(item);
      const cx = item.x + (footprintSize(item.type, item.rot).w) / 2;
      const cy = item.y + (footprintSize(item.type, item.rot).h) / 2;
      // Local frame: along = belt direction, up = away from the belt surface.
      for (const b of world.bodies) {
        if (b.mass === 0) continue;
        const rx = b.position.x - cx, ry = b.position.y - cy;
        const along = rx * f.dx + ry * f.dy;
        const up = rx * f.ux + ry * f.uy;
        if (Math.abs(along) > 1.1 || up < -0.1 || up > 0.9) continue;
        const v = b.velocity.x * f.dx + b.velocity.y * f.dy;
        const push = (this.speed - v) * 8 * b.mass;
        b.applyForce(new CANNON.Vec3(f.dx * push, f.dy * push, 0));
      }
    },
    onFrame(item, dt) {
      // A true rolling speed (speed / radius, ~27 rad/s) moves the roller's
      // edge lines almost one 30° segment per frame, which the eye reads as
      // spinning backwards. A slower spin reads correctly.
      item.mesh.traverse((o) => { if (o.name === 'roller') o.rotation.y -= dt * ROLLER_SPIN; });
    },
    offset: () => new THREE.Vector3(1, 0, 0),
  },

  launcher: {
    name: 'Launcher',
    hint: 'fires on play',
    w: 1, h: 1,
    rotatable: true,
    delay: 0.4,
    kick: 14,
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 0.8), standard(0x5a4a6a))).translateY(0.125));
      const plate = named(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.7), standard(0xff5a5a, { roughness: 0.4 }))), 'plate');
      plate.position.y = 0.31;
      g.add(plate);
      // A little arrow on the plate shows which way it fires (local +y, i.e. up).
      const arrow = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.22, 4), standard(0xffe08a)));
      arrow.position.y = 0.5;
      arrow.rotation.y = Math.PI / 4;
      g.add(arrow);
      return g;
    },
    makeBody() {
      const body = new CANNON.Body({ mass: 0, material: MATS.surface });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 0.19, 0.4)), new CANNON.Vec3(0, 0.19, 0));
      return body;
    },
    onStep(item, world) {
      if (world.time < this.delay) { item.armed = true; return; }
      if (!item.armed) return;
      item.armed = false;
      item.popT = 0;
      // Fire along local "up" (the plate's normal), turned by the rotation.
      const f = facing(item);
      const cx = item.x + 0.5, cy = item.y + 0.5;
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
      plate.position.y = 0.31 + Math.sin(Math.min(1, item.popT * 4) * Math.PI) * 0.35 * (k + 0.2);
      if (item.popT > 0.5) { plate.position.y = 0.31; delete item.popT; }
    },
    offset: () => new THREE.Vector3(0.5, 0, 0),
  },

  bell: {
    name: 'Bell',
    hint: 'rings',
    w: 1, h: 1,
    idleFrame: true,
    makeMesh() {
      const g = new THREE.Group();
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.12, 0.5), standard(0x8a7f6a))).translateY(0.94));
      const swing = named(new THREE.Group(), 'swing');
      swing.position.y = 0.88;
      const cup = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.36, 0.55, 16), standard(0xf5c542, { roughness: 0.3, metalness: 0.4 })));
      cup.position.y = -0.33;
      swing.add(cup);
      const clapper = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), standard(0x333333)));
      clapper.position.y = -0.64;
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
    hint: 'loose board',
    w: 3, h: 1,
    rotatable: true,
    dynamic: true,
    makeMesh() {
      return shadowed(new THREE.Mesh(new THREE.BoxGeometry(3, 0.16, 0.6), standard(0xc98f4a)));
    },
    makeBody() {
      return lockToPlane(new CANNON.Body({ mass: 0.5, shape: new CANNON.Box(new CANNON.Vec3(1.5, 0.08, 0.3)), material: MATS.surface }));
    },
    offset: () => new THREE.Vector3(1.5, 0.08, 0),
  },

  bucket: {
    name: 'Bucket',
    hint: 'catches',
    w: 1, h: 1,
    rotatable: true,
    makeMesh() {
      const g = new THREE.Group();
      const mat = standard(0x4f7fa8);
      g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 0.8), mat)).translateY(0.05));
      const left = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.8), mat)); left.position.set(-0.45, 0.5, 0); g.add(left);
      const right = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.8), mat)); right.position.set(0.45, 0.5, 0); g.add(right);
      return g;
    },
    makeBody() {
      const body = new CANNON.Body({ mass: 0, material: MATS.surface });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 0.05, 0.4)), new CANNON.Vec3(0, 0.05, 0));
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.05, 0.5, 0.4)), new CANNON.Vec3(-0.45, 0.5, 0));
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.05, 0.5, 0.4)), new CANNON.Vec3(0.45, 0.5, 0));
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

const GADGET_ORDER = ['marble', 'bowling', 'domino', 'plank', 'ramp', 'longramp', 'block', 'bucket', 'seesaw', 'bouncer', 'conveyor', 'launcher', 'fan', 'pendulum', 'bell', 'star'];

// Footprint size after `rot` quarter turns (odd turns swap width and height).
function footprintSize(type, rot = 0) {
  const def = GADGETS[type];
  if (def.swing) return { w: def.w, h: def.h }; // swinging gadgets never turn
  return rot % 2 ? { w: def.h, h: def.w } : { w: def.w, h: def.h };
}

// World-space transform for an item at cell (x, y), turned `rot` quarter
// turns counter-clockwise about the center of its footprint.
function itemTransform(item) {
  const def = GADGETS[item.type];
  const rot = def.swing ? 0 : (item.rot || 0);
  const angle = rot * Math.PI / 2;
  const quaternion = new THREE.Quaternion().setFromAxisAngle(Z_AXIS_THREE, angle);
  const turned = footprintSize(item.type, rot);
  // The mesh origin sits at `offset` inside the unturned footprint; spin that
  // about the footprint center, then drop it into the turned footprint.
  const local = def.offset().sub(new THREE.Vector3(def.w / 2, def.h / 2, 0)).applyQuaternion(quaternion);
  const position = local.add(new THREE.Vector3(item.x + turned.w / 2, item.y + turned.h / 2, 0));
  return { position, quaternion };
}

function footprintCells(type, x, y, rot = 0) {
  const def = GADGETS[type];
  if (def.footprint) return def.footprint(rot).map(([i, j]) => [x + i, y + j]);
  const { w, h } = footprintSize(type, rot);
  const cells = [];
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) cells.push([x + i, y + j]);
  }
  return cells;
}
