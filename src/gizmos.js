// Gizmo registry.
//
// Each gizmo separates *how it looks* (makeMesh) from *how it behaves*
// (makeBody). Swap makeMesh for a loaded 3D asset later without touching
// the physics or the game logic.
//
// Coordinates: a gizmo's "anchor" is the bottom-left cell of its footprint.
// Meshes and bodies are positioned relative to the anchor cell's origin
// (the cell spans x..x+1, y..y+1, z -0.5..0.5).


const Y_AXIS = new THREE.Vector3(0, 1, 0);
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
  return mesh;
}

// Right-triangle prism: high edge on the left, sloping down to the right.
function wedgeGeometry(w, h, d) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(w, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(-w / 2, -h / 2, -d / 2);
  return geo;
}

function wedgeShape(w, h, d) {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const v = (x, y, z) => new CANNON.Vec3(x, y, z);
  const vertices = [
    v(-hw, -hh, -hd), v(hw, -hh, -hd), v(-hw, hh, -hd),
    v(-hw, -hh, hd), v(hw, -hh, hd), v(-hw, hh, hd),
  ];
  // Faces wound counter-clockwise when viewed from outside.
  const faces = [
    [0, 1, 4, 3], // bottom
    [0, 2, 1],    // back
    [3, 4, 5],    // front
    [0, 3, 5, 2], // left (tall side)
    [1, 2, 5, 4], // slope
  ];
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
};

const GIZMOS = {
  marble: {
    name: 'Marble',
    icon: '🔵',
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
    icon: '🀫',
    hint: 'tips over',
    w: 1, h: 2,
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
    icon: '◢',
    hint: 'F to flip',
    w: 1, h: 1,
    flippable: true,
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
    icon: '◢◢',
    hint: 'F to flip',
    w: 2, h: 1,
    flippable: true,
    makeMesh() {
      return shadowed(new THREE.Mesh(wedgeGeometry(2, 1, 1), standard(COLORS.ramp)));
    },
    makeBody() {
      return new CANNON.Body({ mass: 0, shape: wedgeShape(2, 1, 1), material: MATS.surface });
    },
    offset: () => new THREE.Vector3(1, 0.5, 0),
  },

  block: {
    name: 'Block',
    icon: '🟫',
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
    icon: '⭐',
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
};

const GIZMO_ORDER = ['marble', 'domino', 'ramp', 'longramp', 'block', 'star'];

// World-space transform for an item placed at cell (x, y).
function itemTransform(item) {
  const def = GIZMOS[item.type];
  const position = def.offset().add(new THREE.Vector3(item.x, item.y, 0));
  const quaternion = new THREE.Quaternion();
  if (item.flip) quaternion.setFromAxisAngle(Y_AXIS, Math.PI);
  return { position, quaternion };
}

function footprintCells(type, x, y) {
  const def = GIZMOS[type];
  const cells = [];
  for (let i = 0; i < def.w; i++) {
    for (let j = 0; j < def.h; j++) cells.push([x + i, y + j]);
  }
  return cells;
}
