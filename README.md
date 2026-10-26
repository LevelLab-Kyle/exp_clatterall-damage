# Gadget Garage

Prototype of a kids' Rube Goldberg builder. Drag gadgets onto a voxel board, press Play, watch it go.

## Run

Open `index.html` in a browser. No build step, no server, no internet needed.

## Controls

| Action | How |
|---|---|
| Place a gadget | Drag a card from the tray onto the board. It floats freely while dragging and slides into a cell when you let go |
| Move a gadget | Drag it. The selected gadget gets a blue outline, same as the platform builder |
| Delete | Right-click it, or select + `Delete` |
| Rotate | Select a gadget and use the ↺ / ↻ buttons next to it, or `R` (counter-clockwise) / `Shift+R` (clockwise). Turns 90° at a time; works mid-drag too. Ramps get all four orientations; the fan blows in the direction it faces. |
| Pan | Drag empty space, or scroll. The view settles onto whole cells and never goes below the ground |
| Zoom | `Ctrl`/`Cmd` + scroll (pinch on a trackpad) |
| Home | ⌂ button or `H`: recenter on the whole contraption at normal zoom |
| Play / Reset | Buttons, or `Space` |
| Undo / Redo | Buttons, or `Cmd/Ctrl+Z` / `Shift+Cmd/Ctrl+Z` (also `Ctrl+Y`). Covers placing, moving, rotating, deleting and Clear |
| 3D view | "3D view" button. Fixed tilted camera; pan, zoom and editing work the same as the flat view |

Hit the ⭐ Star with anything to win.

Your board, view and chosen example are saved in the browser (localStorage) as you work, and come back when you reopen the page.

The **Examples** menu in the top bar loads ready-made contraptions (Domino Run, Seesaw Launch, Fan Elevator, Wrecking Ball, Bounce Alley). They live in `src/examples.js` as plain lists of `[type, x, y, rot]`.

## Gadgets

| Gadget | Size | What it does |
|---|---|---|
| Marble | 1×1 | Rolls and falls |
| Bowling ball | 2×2 | Heavy. Knocks big things over |
| Domino | 1×2 | Tips over and takes the next one with it |
| Ramp / Long ramp | 1×1 / 2×1 | Static slope. Rotate for all four orientations |
| Block | 1×1 | Solid cube to build on |
| Seesaw | 3×1 | Plank on a hinge. Drop something on one end to fling the other |
| Bouncer | 1×1 | Springy pad; marbles bounce off it |
| Fan | 1×1 | Pushes anything up to 3 cells in the direction it faces. Rotate to aim it |
| Pendulum | 1×3 | Heavy ball on a rope. Swings when hit. Rotate swings the ball out one column at a time (up to two) left or right to start it off |
| Star | 1×1 | The goal |

## How it's built

- **Plain HTML/CSS/JS.** Three.js and cannon-es are bundled once into `vendor/libs.js` (see `vendor/README.md` to upgrade them). Game code is classic `<script>` files, no modules, no bundler.
- The world is a true 3D voxel grid (`x`, `y`, one cell deep in `z`). The "2D" view is just an orthographic camera looking at it side-on; the 3D view is a perspective camera on the same scene. Tilt-shift will be a post-process on the 3D camera.
- The board is infinite. Ground is at `y = 0`; nothing can go below it.
- Physics runs only while playing. Bodies are created from placed items on Play and thrown away on Reset. Dynamic bodies are locked to the X/Y plane.

### Files

| File | What |
|---|---|
| `vendor/libs.js` | Three.js + cannon-es, exposed as `THREE` and `CANNON` globals. |
| `src/gadgets.js` | Gadget registry (code still says "gadget"). Each gadget has `makeMesh()` (looks), `makeBody()` (physics), a footprint (`w`,`h`) and an `offset` inside its cell. Multi-part gadgets (seesaw, fan, pendulum) use `makeBodies(group)` to return several bodies plus constraints, and optional `onStep` / `onFrame` hooks. |
| `src/main.js` | Scene, cameras, board state, drag/drop, play loop. |
| `src/style.css` | Chrome, on the [Level Lab design system](https://levellab.com/style): dark theme, Roboto, 5px grid, `.button` / `.button-accent` / `.button-icon`. Tokens are copied in so the page still works offline. |

### Swapping in real 3D assets

Each gadget's `makeMesh()` returns any `THREE.Object3D`. Replace the placeholder geometry with a loaded GLTF (scaled to fit the footprint, origin at the cell center + `offset`) and nothing else needs to change. `makeBody()` stays as the simple collision shape.
