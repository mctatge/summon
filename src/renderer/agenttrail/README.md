# Agenttrail Kitchen renderer assets

`art.js`, `chefs.js`, and `batch.js` are vendored from
[sodiumsun/agenttrail](https://github.com/sodiumsun/agenttrail/tree/e4ba2daa270abd7ecb51565bbfb12386f47ea418/packages/kitchen/public/src),
commit `e4ba2daa270abd7ecb51565bbfb12386f47ea418` (Kitchen 0.1.0-alpha.3).
Copyright (c) 2026 Kelly Sun. The full MIT license is in [LICENSE](./LICENSE).
Retain that notice and permission text when distributing these files or a bundle
containing them. Summon's surrounding code retains its own license.

The upstream [third-party statement](https://github.com/sodiumsun/agenttrail/blob/e4ba2daa270abd7ecb51565bbfb12386f47ea418/packages/kitchen/docs/THIRD-PARTY.md)
identifies the procedural geometry, rigs, textures, and animation as original
MIT-licensed work. No game assets, recordings, fonts, server, hook collector, or
upstream application shell are included. These modules use the locally bundled
Three.js dependency and its geometry utilities. Canvas textures are generated
locally; the optional plaque helper falls back to sans-serif without fetching a
font. Three.js carries its own MIT license.

## Host interface

- `createChef(parent, id, index)` returns the rig. Keep `id` and the nonnegative
  appearance index stable across updates.
- Set `state`, `target`, `facing`, `pose`, `atWorktop`, `carrying`, `selected`, and
  `related` from Summon's observed session metadata. `animateChef` accepts time
  and frame delta in seconds, plus reduced-motion and paused flags.
- `setCarriedType` chooses a procedural ingredient; calling it creates more
  meshes. Do not show a carried artifact unless Summon has the corresponding
  evidence.
- `art.js` supplies the rounded kitchen props and primitives. `batchMeshes`
  reduces static draw calls; `disposeBatches` releases only batch geometries.

The source modules share geometry and material caches. A host that owns separate
scene lifetimes must clone geometry, materials, and textures before rendering and
dispose its copies when the scene is removed. `animateChef` replaces the ring's
material with a cached material each frame, so map that material back to the
host-owned clone. Reapply resource ownership after `setCarriedType` adds meshes.

`resetArtCaches()` is Summon's lifecycle addition. It disposes and clears cached
primitive geometries, materials, and generated texture maps, and resets the
procedural random seed. Call it only at final scene teardown, after animation
stops and all host-owned scene resources have been removed. Do not call it during
live updates or while any scene renders shared originals. The kitchen host mounts
one scene at a time. If that changes, coordinate all scene lifetimes before
resetting. The chef hat has one separate, constant geometry cache; cloning it
before rendering leaves that bounded original without GPU allocations.

Summon's adjacent `.d.ts` files describe the public helpers; they are not upstream
files. The JavaScript contains an added copyright/source banner; `art.js` also
contains the explicit cache-reset helper described above. All procedural visual
and animation routines are unchanged from the pinned source.
