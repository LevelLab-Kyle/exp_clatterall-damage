---
name: auto
description: Stage, syntax-check, smoke-test in the browser, then commit and push the current work on Gadget Garage. Use when the user says /auto or asks to "ship it".
---

# /auto — stage, test, smoke test, commit, push

Run these steps in order. Stop at the first failure, fix it (or report it) and do not commit until everything passes.

## 1. Stage

```sh
cd /Users/levellab/Repos/Experiments/Rube-Goldberg
git add -A
git status --short
```

If nothing is staged, say so and stop.

## 2. Syntax check

```sh
for f in src/*.js; do node --check "$f" || exit 1; done
```

## 3. Smoke test in Chrome

The game is plain HTML with no build step, but the Chrome extension cannot open `file://` pages, so serve the folder with no-cache headers if port 8077 isn't already serving it:

```sh
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8077/index.html || \
  python3 -I - /Users/levellab/Repos/Experiments/Rube-Goldberg <<'EOF' &
import http.server, sys, os
os.chdir(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', 8077), H).serve_forever()
EOF
```

Then, with the claude-in-chrome tools (load them with one ToolSearch call: `tabs_context_mcp, navigate, javascript_tool, read_console_messages, computer, browser_batch`):

1. `navigate` to `http://127.0.0.1:8077/index.html?r=<random>` and wait ~1.5 s.
2. Run this with `javascript_tool` and require every line to say `ok`:

```js
const out = [];
out.push('cards ' + (document.querySelectorAll('.gadget-card').length === GADGET_ORDER.length ? 'ok' : 'FAIL'));
out.push('tray images ' + ([...document.querySelectorAll('.gadget-card img')].every(i => i.src.startsWith('data:') || i.complete) ? 'ok' : 'FAIL'));
for (const name of Object.keys(EXAMPLES)) {
  loadExample(name); startPlay(); let w = null;
  for (let i = 0; i < 360; i++) { world.step(1/60); if (won && w === null) w = (i/60).toFixed(2); }
  stopPlay(); out.push(name + ' ' + (w ? 'ok (' + w + 's)' : 'FAIL'));
}
// drag from the tray, rotate, delete, undo, redo
const n0 = items.size; const card = document.querySelector('.gadget-card'); const rc = card.getBoundingClientRect();
card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rc.left + 10, clientY: rc.top + 10, pointerId: 9, button: 0 }));
window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 900, clientY: 300, pointerId: 9 }));
window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 900, clientY: 300, pointerId: 9, button: 0 }));
out.push('place ' + (items.size === n0 + 1 ? 'ok' : 'FAIL'));
select([...items.values()].find(i => i.type === 'longramp')); rotateSelected(1);
out.push('rotate ' + (selected.rot === 1 ? 'ok' : 'FAIL'));
toolDelete.click(); out.push('delete ' + (items.size === n0 ? 'ok' : 'FAIL'));
undo(); undo(); out.push('undo ' + (items.size === n0 + 1 ? 'ok' : 'FAIL'));
redo(); redo(); out.push('redo ' + (items.size === n0 ? 'ok' : 'FAIL'));
loadExample('Domino Run');
out.join(' | ');
```

3. `read_console_messages` with `onlyErrors: true` — must report no errors.
4. Take one `screenshot` (scale 0.5) and eyeball it: board visible, tray visible, no blank canvas.

If a browser step can't run (extension not connected), say so and stop: do not commit untested work.

## 4. Commit

Write a short imperative subject line describing the staged change (look at `git diff --cached --stat` and the conversation), optional body, and end with the attribution line from the system reminder (e.g. `Co-Authored-By: Claude ... <noreply@anthropic.com>`).

```sh
git commit -q -m "<message>"
```

## 5. Push

```sh
git push 2>&1 | tail -1
git log --oneline -1
```

Report to the user in one or two lines: what was committed (hash + subject) and that the smoke test passed, or what failed and where it stopped.
