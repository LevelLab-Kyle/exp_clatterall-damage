# Clatter Lab

Prototype of a kids' Rube Goldberg builder. Drag gadgets onto a voxel board, press Play, watch it go.

## Run

Open `index.html` in a browser. No build step, no server, no internet needed.

## Controls

| Action | How |
|---|---|
| Place a gadget | Drag a card from the tray onto the board. It floats freely while dragging and slides into the nearest free spot on the quarter-cell subgrid when you let go |
| More gadgets | Cards cut off at the tray edge fade out; the ‹ / › arrows (or a scroll/swipe over the tray) slide the next set into view |
| Move a gadget | Drag it. The selected gadget gets a blue outline, same as the platform builder |
| Delete | Right-click it, or select + `Delete` |
| Rotate | Select a gadget and use the ↺ / ↻ buttons next to it, or `R` (counter-clockwise) / `Shift+R` (clockwise). Turns 90° at a time; works mid-drag too. Ramps get all four orientations; the fan blows in the direction it faces. |
| Flip | ⇔ / ⇕ buttons next to the selected gadget, or `F` (left-right) / `Shift+F` (up-down). Only shown where it changes something: ramps, the fan (reverses its direction), the pendulum (mirrors the swing), the bouncer (upside-down). |
| Pan | Drag empty space or scroll (mouse); two fingers (touch). The view settles onto whole cells and never goes below the ground |
| Zoom | `Ctrl`/`Cmd` + scroll, or pinch (trackpad or touch screen) |
| Home | Home button or `H`: fit the whole contraption on screen. Also happens on load, when loading an example and when the window resizes |
| Play / Reset | Buttons, or `Space` |
| Undo / Redo | Buttons, or `Cmd/Ctrl+Z` / `Shift+Cmd/Ctrl+Z` (also `Ctrl+Y`). Covers placing, moving, rotating, deleting and Clear |
| 3D view | "3D view" button. Fixed tilted camera; pan, zoom and editing work the same as the flat view |

Hit the ⭐ Star with anything to win.

Your board, view and chosen example are saved in the browser (localStorage) as you work, and come back when you reopen the page.

The **Examples** menu in the top bar loads ready-made contraptions (Domino Run, Seesaw Launch, Fan Elevator, Wrecking Ball, Bounce Alley, Launch & Catch, Plank Bridge, Bell Ringer). They live in `src/examples.js` as plain lists of `[type, x, y, rot]`.

## Gadgets

| Gadget | Size | What it does |
|---|---|---|
| Marble | ¾×¾ | Rolls and falls |
| Bowling ball | 2×2 | Heavy. Knocks big things over |
| Domino | ¼×1½ | Tips over and takes the next one with it |
| Ramp / Long ramp | 1×1 / 2×1 | Static slope. Rotate for all four orientations |
| Block | 1×1 | Solid cube to build on |
| Seesaw | 3×¾ | Plank on a hinge. Drop something on one end to fling the other |
| Bouncer | 1×½ | Springy pad; marbles bounce off it |
| Fan | 1×1 | Pushes anything up to 3 cells in the direction it faces. Rotate to aim it |
| Pendulum | 1×3¼ | Heavy ball on a rope. Swings when hit. Rotate swings the ball out (two levels, 1½ and 2 across) left or right to start it off |
| Plank | 3×¼ | Loose board — bridges gaps, falls when pushed |
| Bucket | 1½×1 | Catches a marble (the bowling ball won't fit); the inside stays free to drop things into |
| Conveyor | 2×½ | Carries whatever sits on it. Rotate / flip to set the direction |
| Launcher | 1×½ | Fires whatever is on it shortly after Play, in the direction it faces |
| Bell | 1×1 | Rings and swings when hit |
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
| `src/gadgets.js` | Gadget registry (code still says "gadget"). Each gadget has `makeMesh()` (looks), `makeBody()` (physics), a footprint box (`w`,`h`, multiples of ¼; an optional `footprint()` lists just the quarter cells it really fills) and an `offset` inside that box. Multi-part gadgets (seesaw, fan, pendulum) use `makeBodies(group)` to return several bodies plus constraints, and optional `onStep` / `onFrame` hooks. |
| `src/main.js` | Scene, cameras, board state, drag/drop, play loop, sounds. |
| `assets/sounds.js` | Four short sound effects, base64-embedded (see `assets/README.md`). |
| `src/style.css` | Chrome, on the [Level Lab design system](https://levellab.com/style): dark theme, Roboto, 5px grid, `.button` / `.button-accent` / `.button-icon`. Tokens are copied in so the page still works offline. |

### Swapping in real 3D assets

Each gadget's `makeMesh()` returns any `THREE.Object3D`. Replace the placeholder geometry with a loaded GLTF (scaled to fit the footprint, origin at the cell center + `offset`) and nothing else needs to change. `makeBody()` stays as the simple collision shape. Sounds play on impacts (tap / thud / boing by what hit what) and on winning; the 🔊 button mutes them.
