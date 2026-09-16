/**
 * Asset imports resolve to URLs.
 *
 * `tsconfig.web.json` sets `types: ["node"]` and does not pull in
 * `vite/client`, so the bundler's own module declarations are absent and an
 * `import x from './thing.svg'` has no type. Declaring just the extensions
 * actually imported keeps that narrow — adding `vite/client` wholesale would
 * also bring in its `ImportMeta` globals, which this renderer does not use and
 * which would quietly widen what typechecks.
 */

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}
