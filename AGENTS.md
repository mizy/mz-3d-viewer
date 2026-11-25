# MZ 3D Viewer development

- Start at `src/main.ts` and follow the entry point for the feature you are
  changing. Group code by what it owns. Loading belongs in `src/loaders/`,
  scene state in `src/viewer/`, DOM wiring in `src/ui/`, and installation and
  offline caching in `src/pwa/`. Give a feature its own folder when its code
  and contracts span several files, as in `src/viewer/edges/`.
- Keep contracts explicit at the boundary. Use named input objects for more
  than four related inputs, concrete result types, and tagged success/error
  responses across workers. Document who owns transferred buffers, who can
  cancel work, and who disposes of the result. Validate external inputs at
  their entry point. Use strict TypeScript and avoid `any`.
- Prefer functions with explicit inputs and return values. Keep geometry,
  numerical calculations, and state derivation separate from DOM, WebGPU,
  workers, and persistence. Use classes or closures for resources that have
  a lifetime. Favor composition. Keep new functions within about 100
  executable lines and four levels of nesting, with searchable names and
  `@entry` for feature entry points.
- Render and update camera controls on demand. Coalesce changes in one frame
  and request another frame while motion is active. Keep expensive geometry
  work cancellable and off the main thread. Share derived buffers when the
  inputs are identical, invalidate them only when their inputs change, and
  release them at their owner's disposal boundary.
- Measure the changed path using representative files. Use `pnpm typecheck`,
  `pnpm build`, and the relevant browser checks from the README. For changes
  to rendering or input, check WebGPU and inspect console and network errors.
  For startup changes, also check the unavailable-adapter state. Check idle work and resource lifetime when
  changing scheduling or shared geometry.
