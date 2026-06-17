# Lattice Editor

A live editor, validator and topology visualiser for [Lattice](https://lattice-spec.org) documents — deployed at **editor.lattice-spec.org**.

- **Monaco** editor (left) — paste/edit a Lattice document.
- **Live validation** against the meta-schema via `ajv` (JSON Schema 2020-12).
- **Topology graph** (cytoscape) + a capability list rendered from the document.

The schema and example are copied from the repo's `0.1.0/` at build time (`scripts/copy-artifacts.mjs`) — single source of truth, no drift.

## Develop

```bash
cd editor
npm install
npm run dev      # http://localhost:5173
```

## Build

```bash
npm run build    # outputs to editor/dist
```

## Deploy (Cloudflare Pages → editor.lattice-spec.org)

- **Root directory:** `editor`
- **Build command:** `npm run build`
- **Build output directory:** `editor/dist` (or `dist` if root is set to `editor`)
- SPA fallback is handled by `public/_redirects`.
