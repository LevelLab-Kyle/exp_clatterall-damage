// Plays every level and example without a browser, using the game's own
// physics (buildWorld in src/gadgets.js).
//
//   node tools/check-levels.cjs            check everything
//   node tools/check-levels.cjs 7          check level 7 only (1-based)
//   node tools/check-levels.cjs 7 --trace  ...and print where moving pieces go
//   node tools/check-levels.cjs 7 --free   trace the run with no parts placed
//   LEVELS_FILE=draft.js node tools/check-levels.cjs   check a draft file of levels
//
// A level passes when its solution reaches the star, its locked pieces
// alone don't, leaving out any one part misses, and each part of the solution is somewhere a tray drop can
// actually put it (drops land on whole cells when one is free nearby).
// An example passes when it reaches the star.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ctx = { console, Math, performance };
ctx.window = ctx;
vm.createContext(ctx);
const files = ['vendor/libs.js', 'src/gadgets.js', 'src/examples.js', process.env.LEVELS_FILE || 'src/levels.js'];
for (const f of files) {
  const full = path.resolve(root, f);
  if (fs.existsSync(full)) vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: f });
}
const { GADGETS, buildWorld, placeMesh, footprintCells, stepFrame, SUB } = vm.runInContext('({ GADGETS, buildWorld, placeMesh, footprintCells, stepFrame, SUB })', ctx);
const EXAMPLES = vm.runInContext('typeof EXAMPLES === "undefined" ? {} : EXAMPLES', ctx);
const LEVELS = vm.runInContext('typeof LEVELS === "undefined" ? [] : LEVELS', ctx);

const SECONDS = 20;

// Entries are [type, x, y, rot, flip, size].
function toItems(list) {
  return list.map(([type, x, y, rot = 0, flip = false, size = null]) => {
    if (!GADGETS[type]) throw new Error('unknown gadget ' + type);
    const item = { type, x, y, rot, flip, size };
    item.mesh = GADGETS[type].makeMesh(item);
    placeMesh(item);
    return item;
  });
}

// Overlapping pieces can't be built in the game, so they fail the check.
function overlaps(list) {
  const seen = new Map();
  for (const [type, x, y, rot = 0, , size = null] of list) {
    for (const [i, j] of footprintCells(type, x, y, rot, size)) {
      if (j < 0) return `${type} at ${x},${y} is below the ground`;
      const k = i + ',' + j;
      if (seen.has(k)) return `${type} at ${x},${y} overlaps ${seen.get(k)}`;
      seen.set(k, `${type} at ${x},${y}`);
    }
  }
  return null;
}

// Where the game puts a part dropped with its corner at (ax, ay): the
// nearest free half cell (settling onto a ledge a quarter below), or
// the nearest free quarter cell if no half cell within 8 is free. Same rule
// as nearestFree in src/main.js.
const DROP_STEPS = 2;
function dropSpot(list, type, ax, ay, rot, size) {
  const taken = new Set();
  for (const [t, x, y, r = 0, , s = null] of list) for (const [i, j] of footprintCells(t, x, y, r, s)) taken.add(i + ',' + j);
  const fits = (x, y) => footprintCells(type, x, y, rot, size).every(([i, j]) => j >= 0 && !taken.has(i + ',' + j));
  for (const sub of [DROP_STEPS, SUB]) {
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
    const hit = spots.find((p) => fits(p.x, p.y));
    if (hit && sub === DROP_STEPS) return settleDown(hit);
    if (hit) return hit;
  }
  return null;

  // A spot floating a quarter above something settles onto it.
  function settleDown(spot) {
    const rests = (y) => y <= 0 || footprintCells(type, spot.x, y, rot, size).some(([i, j]) => taken.has(i + ',' + (j - 1)));
    if (rests(spot.y)) return spot;
    const y = spot.y - 1 / SUB;
    return y >= 0 && fits(spot.x, y) && rests(y) ? { ...spot, y } : spot;
  }
}

// Seconds until the star is hit, or null. With `trace`, prints every moving
// body's position each quarter second.
function play(list, trace = false) {
  let won = false;
  const items = toItems(list);
  const world = buildWorld(items, { onGoal: () => { won = true; } });
  const movers = [];
  for (const item of items) for (const p of item.parts) if (p.body.mass > 0) movers.push([item.type, p.body]);
  for (let i = 0; i < SECONDS * 60; i++) {
    stepFrame(world);
    if (trace && i % 15 === 0) {
      console.log(`  t=${(i / 60).toFixed(2).padStart(5)}  ` + movers.map(([t, b]) => `${t} ${b.position.x.toFixed(2)},${b.position.y.toFixed(2)}`).join('  |  '));
    }
    if (won) return +(i / 60).toFixed(2);
  }
  return null;
}

let failed = 0;
const only = process.argv[2] && !process.argv[2].startsWith('-') ? +process.argv[2] : null;
const trace = process.argv.includes('--trace'), traceFree = process.argv.includes('--free');

if (!only) {
  for (const [name, ex] of Object.entries(EXAMPLES)) {
    const t = play(ex.items);
    if (t === null) failed++;
    console.log(`${t === null ? 'FAIL' : 'ok  '}  example  ${name}${t === null ? '' : `  (${t}s)`}`);
  }
}

LEVELS.forEach((lv, n) => {
  if (only && only !== n + 1) return;
  const problems = [];
  const all = [...lv.items, ...lv.solution];
  const bad = overlaps(all);
  if (bad) problems.push(bad);
  // The solution may only use the parts on offer.
  const used = {};
  for (const [type] of lv.solution) used[type] = (used[type] || 0) + 1;
  for (const [type, k] of Object.entries(used)) if (k > (lv.parts[type] || 0)) problems.push(`solution uses ${k} ${type}, only ${lv.parts[type] || 0} on offer`);
  const t = bad ? null : play(all, trace && !traceFree);
  if (!bad && t === null) problems.push('solution misses the star');
  const free = play(lv.items, traceFree);
  if (free !== null) problems.push(`wins with no parts placed (${free}s)`);
  // Every part of the solution is needed: leave any one out and it misses
  // (unless the level says it has spares).
  if (t !== null && !lv.spares) {
    lv.solution.forEach((part, k) => {
      if (play([...lv.items, ...lv.solution.filter((_, j) => j !== k)]) !== null) problems.push(`wins without the ${part[0]} at ${part[1]},${part[2]}`);
    });
  }
  // A part dropped from the tray onto its answer spot must land exactly
  // there (see dropSpot), so the player can build the answer by dragging.
  lv.solution.forEach((part, k) => {
    const [type, x, y, rot = 0, , size = null] = part;
    const others = [...lv.items, ...lv.solution.filter((_, j) => j !== k)];
    const spot = dropSpot(others, type, x, y, rot, size);
    if (!spot || spot.x !== x || spot.y !== y) problems.push(`${type} dropped at ${x},${y} lands at ${spot ? spot.x + ',' + spot.y : 'nowhere'}`);
  });
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  level ${String(n + 1).padStart(2)}  ${lv.name}${t === null ? '' : `  (${t}s)`}${problems.length ? '  — ' + problems.join('; ') : ''}`);
});

process.exit(failed ? 1 : 0);
