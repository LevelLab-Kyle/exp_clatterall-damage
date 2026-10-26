#!/usr/bin/env python3
"""Rebuild models.js / sounds.js from a folder of raw files.

    python3 assets/pack.py <folder-with-glb-and-mp3>

Model names come from the file names (marble.glb -> MODEL_DATA.marble)."""
import base64, os, sys
src = sys.argv[1]; out = os.path.dirname(os.path.abspath(__file__))
def b64(p): return base64.b64encode(open(p, 'rb').read()).decode()
glbs = sorted(f for f in os.listdir(src) if f.endswith('.glb'))
mp3s = sorted(f for f in os.listdir(src) if f.endswith('.mp3'))
if glbs:
  with open(f'{out}/models.js', 'w') as f:
    f.write('// Low-poly GLB models, base64-embedded so the page works from file://.\n// See assets/README.md for what each one is and who made it.\n// Rebuild with assets/pack.py.\nconst MODEL_DATA = {\n')
    for g in glbs: f.write(f"  {g[:-4]}: '{b64(os.path.join(src, g))}',\n")
    f.write('};\n')
if mp3s:
  with open(f'{out}/sounds.js', 'w') as f:
    f.write('// Short MP3 sound effects, base64-embedded. See assets/README.md.\nconst SOUND_DATA = {\n')
    for m in mp3s: f.write(f"  {m[:-4]}: '{b64(os.path.join(src, m))}',\n")
    f.write('};\n')
print('packed', len(glbs), 'models and', len(mp3s), 'sounds')
