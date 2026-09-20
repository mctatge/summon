# Third-party renderer code

Summon's application code is Apache-2.0. The following separately licensed code is used by the visual workspace. Its notices are retained beside the source and copied into the built application's `dist/third-party/` directory.

## Agenttrail

The animated kitchen uses procedural chef rigs, animation, geometry and art helpers from [Agenttrail](https://github.com/sodiumsun/agenttrail), copyright 2026 Kelly Sun, under the MIT license.

- Source: `packages/kitchen/public/src/{art,chefs,batch}.js` at commit `e4ba2daa270abd7ecb51565bbfb12386f47ea418`.
- Vendored files and adaptation notes: `src/renderer/agenttrail/`.
- License shipped with the application: `public/third-party/agenttrail-MIT.txt`.
- Summon's room controller, React integration and session-to-chef mapping are local additions. No Agenttrail server, log reader, hook installer, fonts or telemetry are included.

## Three.js

Three.js 0.186.0 provides local WebGL rendering, camera controls and geometry helpers under its MIT license. The dependency is pinned and bundled by Vite; it does not load a CDN or remote model assets at runtime.

- Package: `three`.
- License shipped with the application: `public/third-party/three-MIT.txt`.

No game artwork, soundtrack or other game assets are bundled.
