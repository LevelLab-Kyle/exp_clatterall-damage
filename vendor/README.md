# vendor/libs.js

One-time bundle of [three.js](https://threejs.org) 0.186.1 (+ `OrbitControls`) and [cannon-es](https://github.com/pmndrs/cannon-es) 0.20.0, both MIT.
Exposes `window.THREE` (with `THREE.OrbitControls`) and `window.CANNON`.

Rebuild (only needed to upgrade the libraries):

```sh
npm i three cannon-es
printf "import * as THREE from 'three';import {OrbitControls} from 'three/addons/controls/OrbitControls.js';import * as CANNON from 'cannon-es';window.THREE=Object.assign({},THREE,{OrbitControls});window.CANNON=CANNON;" > _entry.js
npx esbuild _entry.js --bundle --format=iife --minify --outfile=vendor/libs.js
rm _entry.js
```
