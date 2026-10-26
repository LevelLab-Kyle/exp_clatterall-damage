# vendor/libs.js

One-time bundle of [three.js](https://threejs.org) 0.186.1 (+ `EffectComposer`, `RenderPass`, `OutlinePass`, `OutputPass`) and [cannon-es](https://github.com/pmndrs/cannon-es) 0.20.0, both MIT.
Exposes `window.THREE` (with those addons attached) and `window.CANNON`.

Rebuild (only needed to upgrade the libraries):

```sh
npm i three cannon-es
cat > _entry.js <<'EOF'
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as CANNON from 'cannon-es';
window.THREE = Object.assign({}, THREE, { EffectComposer, RenderPass, OutlinePass, OutputPass });
window.CANNON = CANNON;
EOF
npx esbuild _entry.js --bundle --format=iife --minify --outfile=vendor/libs.js
rm _entry.js
```
