# Clatter Lab

Prototype of a kids' Rube Goldberg game. Drag gadgets onto a voxel board, press Play, watch it go.

Two modes, switched in the top bar:

- **Levels**: puzzles that get harder as you go. Each level comes with locked pieces already on the board and a few parts in the tray (the number on each card is how many are left). Get anything to the ⭐ to win and unlock the next level. Each new gadget arrives in its own level, marked NEW in the tray. ☰ opens the level picker.
- **Sandbox**: every gadget, no limits, plus the Examples menu.

## Run

Open `index.html` in a browser. No build step, no server, no internet needed.

## Controls

| Action | How |
|---|---|
| Place a gadget | Drag a card from the tray onto the board. It floats freely while dragging and slides into the nearest free half cell when you let go (quarter steps only if no half cell nearby is free). If that leaves it floating a quarter above something (a gap half cells can't close), it settles onto it, so a plank drops into a quarter-deep slot. Use the Move buttons or arrow keys for quarter-cell placement |
| More gadgets | Cards cut off at the tray edge fade out; the ‹ / › arrows (or a scroll/swipe over the tray) slide the next set into view |
| Move a gadget | Drag it. The selected gadget gets a blue outline, same as the platform builder |
| Delete | Right-click it, or select + `Delete` |
| Selected-gadget menu | Floats above the selected gadget: **Rotate** and **Size** buttons, **Move** (slides out a column of nudge buttons), plus 🗑. Every gadget shows every button; ones that don't apply are greyed out |
| Rotate | The Rotate button or `R` steps clockwise through every way the gadget can turn and wraps around; `Shift+R` steps back. Skips turns that don't fit; works mid-drag too. Most gadgets turn 90° at a time; the pendulum cycles its swing (straight, out left, further left, further right, out right). There is no flip: ramps and conveyors come in two gadgets, one for each direction |
| Size | The Size button or `S` steps blocks, ramps, dominoes, planks and buckets through a set of sizes and wraps around; `Shift+S` steps back. Blocks and ramps go 1×1 → 2×1 → 2×2 → 1×2; dominoes change height only, 1½ → 2 → 1; planks change length only, 3 → 4 → 2; buckets grow to fit the marble → ball → bowling ball. It keeps its bottom-left corner, sliding left and/or down when growing into something, and skips sizes that don't fit |
| Nudge | The Move group, or the arrow keys: moves the selected gadget ¼ cell |
| Pan | Drag empty space or scroll (mouse); two fingers (touch). The view settles onto whole cells and never goes below the ground |
| Zoom | `Ctrl`/`Cmd` + scroll, or pinch (trackpad or touch screen) |
| Home | The ⌂ button in the board's top-left corner, or `H`: fit the whole contraption on screen. Also happens on load, when loading an example and when the window resizes |
| Play / Reset | Buttons, or `Space` |
| Clear | The 🗑 button next to Home. Asks "Are you sure?" first; undo brings it all back |
| Undo / Redo | Buttons, or `Cmd/Ctrl+Z` / `Shift+Cmd/Ctrl+Z` (also `Ctrl+Y`). Covers placing, moving, rotating, deleting and Clear |

Hit the ⭐ Star with anything to win. In a level, the level's own pieces can't be moved, and **Clear** only takes back the parts you placed.

Everything is saved in the browser (localStorage) as you work and comes back when you reopen the page: the Sandbox board, view and example, and for Levels the open level, the levels you've beaten and the parts you'd placed in each one.

The **Examples** menu in the top bar loads ready-made contraptions (Domino Run, Seesaw Launch, Fan Elevator, Wrecking Ball, Bounce Alley, Launch & Catch, Plank Bridge, Bell Ringer). They live in `src/examples.js` as plain lists of `[type, x, y, rot]`.

## Gadgets

| Gadget | Size | What it does |
|---|---|---|
| Marble | ½×½ | Rolls and falls. Snaps to the center of a cell (settling onto a ledge when dropped just above one) |
| Ball | 1×1 | Between the marble and the bowling ball in size and weight |
| Bowling ball | 2×2 | Heavy. Knocks big things over |
| Domino | ¼×1½ (Size: 2 or 1 tall) | Tips over and takes the next one with it |
| Ramp ↘ / Ramp ↙ | 1×1 (Size cycles it) | Static slope, sloping down to the right or the left. Rotate for all four orientations; Size makes it long (2×1), steep (1×2) or big (2×2) |
| Block | 1×1 (Size cycles it) | Solid block to build on |
| Seesaw | 3×¾ | Plank on a hinge. Drop something on one end to fling the other |
| Bouncer | 1×½ | Springy pad; marbles bounce off it |
| Fan | 1×1 | Pushes anything up to 3 cells in the direction it faces. Rotate to aim it |
| Pendulum | 1×3¼ | Heavy ball on a rope. Swings when hit. Rotate swings the ball out (two levels, 1½ and 2 across) left or right to start it off |
| Plank | 3×¼ (Size: 4 or 2 long) | Loose board — bridges gaps, falls when pushed |
| Bucket | 1×¾ (Size: 2×1¼, 3×1¾) | Catches a ball. Walls and floor are ¼ thick. Its inside is ½ wide by default, exactly the marble, so a bucket lined up under a marble's cell catches it; Size steps it up for the ball (inside 1½) and the bowling ball (inside 2½), growing evenly around its cavity so the cavity stays lined up under the ball. Every size sits on half cells. The inside stays free to drop things into |
| Conveyor → / Conveyor ← | 2×½ | Carries whatever sits on it, the way the arrow on its front points. Rotate to turn it |
| Launcher | 1×½ | Fires whatever is on it shortly after Play, in the direction it faces |
| Bell | 1×1 | Rings and swings when hit |
| Star | 1×1 | The goal |

## How it's built

- **Plain HTML/CSS/JS.** Three.js and cannon-es are bundled once into `vendor/libs.js` (see `vendor/README.md` to upgrade them). Game code is classic `<script>` files, no modules, no bundler.
- The world is a true 3D voxel grid (`x`, `y`, one cell deep in `z`). The view is a side-on perspective camera (30° lens), so pieces show a little depth.
- The board is infinite. Ground is at `y = 0`; nothing can go below it.
- Physics runs only while playing. Bodies are created from placed items on Play and thrown away on Reset. Dynamic bodies are locked to the X/Y plane.

### Files

| File | What |
|---|---|
| `vendor/libs.js` | Three.js + cannon-es, exposed as `THREE` and `CANNON` globals. |
| `src/gadgets.js` | Gadget registry (code still says "gadget"). Each gadget has `makeMesh()` (looks), `makeBody()` (physics), a footprint box (`w`,`h`, multiples of ¼; an optional `footprint()` lists just the quarter cells it really fills) and an `offset` inside that box. Multi-part gadgets (seesaw, fan, pendulum) use `makeBodies(group)` to return several bodies plus constraints, and optional `onStep` / `onFrame` hooks. |
| `src/main.js` | Scene, cameras, board state, drag/drop, play loop, sounds, Levels / Sandbox modes. |
| `src/levels.js` | The levels, easiest first: name, goal line, parts on offer, locked pieces, and one known solution (used only by the checker). |
| `src/examples.js` | Sandbox examples. |
| `tools/check-levels.cjs` | Plays every level and example in Node with the game's own physics (`buildWorld` in `src/gadgets.js`). A level passes when its solution reaches the star and its locked pieces alone don't. `node tools/check-levels.cjs [level] [--trace / --free]`. |
| `assets/sounds.js` | Four short sound effects, base64-embedded (see `assets/README.md`). |
| `src/style.css` | Chrome, on the [Level Lab design system](https://levellab.com/style): dark theme, Roboto, 5px grid, `.button` / `.button-accent` / `.button-icon`. Tokens are copied in so the page still works offline. |

### Swapping in real 3D assets

Each gadget's `makeMesh()` returns any `THREE.Object3D`. Replace the placeholder geometry with a loaded GLTF (scaled to fit the footprint, origin at the cell center + `offset`) and nothing else needs to change. `makeBody()` stays as the simple collision shape. Sounds play on impacts (tap / thud / boing by what hit what) and on winning.
