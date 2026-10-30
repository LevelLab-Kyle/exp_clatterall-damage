---
name: deploy
description: Upload the committed ClatterAll Damage build to the Level Lab web host at ~/www/lab/clatterall-damage (rsync over SSH, same flags the platform uses for client folders). Use when the user says /deploy, "deploy", "upload", "put it on the site" or "publish to labs".
---

# /deploy — publish ClatterAll Damage to the web host

Target: `levellab:~/www/lab/clatterall-damage` — the `levellab` SSH alias and the
`~/www/...` layout are the same ones `platform/utilities/sync.sh` and
`deploy.sh` use. Change `REMOTE` below if the page should live elsewhere.

The game is static files with no build step, so an upload is a straight copy
of the repo's runtime files. Only committed work goes up.

## 1. Preconditions

```sh
cd /Users/levellab/Repos/Experiments/ClatterAll-Damage
git status --short
git rev-parse --short HEAD
git status -sb | head -1
```

- If `git status --short` prints anything, stop: say the tree has uncommitted
  changes and offer `/auto` first. Don't upload a working copy that differs
  from a commit.
- If the branch is ahead of `origin/main`, say so (it can still be uploaded,
  but mention it so the live site and GitHub don't quietly diverge).

## 2. What goes up

Runtime files only:

| Sent | Not sent |
|---|---|
| `index.html` | `.git/`, `.claude/`, `.gitignore` |
| `src/*.js`, `src/style.css` | `README.md`, `assets/README.md`, `assets/pack.py` |
| `assets/*.js` (embedded sounds) | anything else |
| `vendor/libs.js` | |

## 3. Upload

The upload is staged from the commit itself (`git archive HEAD`), and
`index.html` gets its cache buster stamped in: every local script and
stylesheet link ends in `?v=__VERSION__`, which becomes the commit's short
hash, so browsers fetch fresh files after each deploy.

Dry run first, then the real sync. Flags mirror the platform's client
sync: no permission bits (the web host rejects them), delete what the
source no longer has, keep the output short.

```sh
cd /Users/levellab/Repos/Experiments/ClatterAll-Damage
REMOTE="levellab:~/www/lab/clatterall-damage"
VERSION=$(git rev-parse --short HEAD)
STAGE=$(mktemp -d)
git archive HEAD index.html src assets vendor | tar -x -C "$STAGE"
sed -i '' "s/__VERSION__/$VERSION/g" "$STAGE/index.html"
grep -c "?v=$VERSION" "$STAGE/index.html"   # expect 7 (stylesheet + 6 scripts)
FILTER=(--include='index.html' --include='src/' --include='src/*.js' --include='src/style.css'
        --include='assets/' --include='assets/*.js' --include='vendor/' --include='vendor/libs.js'
        --exclude='*')
# See what would change
rsync -rlvz --delete-after --omit-dir-times --dry-run --itemize-changes "${FILTER[@]}" "$STAGE/" "$REMOTE/" | grep -vE '^(sending|sent |total )'
# Do it
rsync -rlvz --delete-after --omit-dir-times --itemize-changes "${FILTER[@]}" "$STAGE/" "$REMOTE/" | grep -vE '^(sending|sent |total )'
rm -rf "$STAGE"
```

`rsync` creates `clatterall-damage/` on the host if it doesn't exist yet (its parent
`~/www/lab` must exist). Exit status 23 (partial transfer) is a warning:
report it; anything else non-zero is a failure: stop and report the output.

## 4. Verify

```sh
ssh levellab 'ls -la ~/www/lab/clatterall-damage && ls ~/www/lab/clatterall-damage/src ~/www/lab/clatterall-damage/assets ~/www/lab/clatterall-damage/vendor'
```

Expect `index.html`, `src/` (main.js, gadgets.js, examples.js, levels.js,
style.css), `assets/sounds.js`, `vendor/libs.js` and nothing else. Then check
the live page (https://lab.levellab.com/clatterall-damage/) returns `200` and carries
this commit's cache buster:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://lab.levellab.com/clatterall-damage/
curl -s https://lab.levellab.com/clatterall-damage/ | grep -c "?v=$(git rev-parse --short HEAD)"   # expect 7
```

## 5. Report

Two lines: the commit that was uploaded (`<hash> <subject>`) and the target
path, plus the dry-run's changed-file count. If the site URL is known, give
it. If any step failed, say which and show its output.
