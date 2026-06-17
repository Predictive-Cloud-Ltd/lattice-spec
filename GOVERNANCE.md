# Lattice — Governance

Lattice is developed as an **open, vendor-neutral, royalty-free** standard. This document describes how it is governed while it incubates; the intent is to move to a neutral foundation (LF Energy / Eclipse Foundation) once there are external adopters.

## Principles

1. **Open** — the specification, schema, and reference code are public and freely implementable.
2. **Vendor-neutral** — no vendor-specific concepts in the core. Vendor specifics live only in `deviceType` keys, `binding`s, and `transform`s — never in capability or node-kind names.
3. **Royalty-free** — implementing Lattice requires no fee or licence beyond the open licences (see `LICENSE.md`).
4. **Composes, doesn't reinvent** — align with existing standards (Sparkplug B, WoT Thing Description, SAREF, CIM) wherever they already solve a layer.
5. **Backwards-compatible by default** — breaking changes are rare, deliberate, and a major version bump.

## Roles

- **Maintainers** — review and merge changes, cut releases, steward the roadmap. (Currently the PredBat team; expands as adopters join.)
- **Contributors** — anyone proposing changes via the process below.
- **Adopters** — implementers (producers or consumers); their conformance feedback drives the spec.

## Decision-making

- **Editorial / non-normative** changes (typos, clarifications, examples): lazy consensus — a maintainer may merge after review.
- **Normative** changes (anything affecting a conformant document or the data plane): require an **RFC** (see `CONTRIBUTING.md`), a review period, and maintainer consensus. Objections must be addressed or explicitly overruled with rationale.
- Disputes escalate to the maintainers; once under a foundation, to its defined process.

## Versioning

- The spec uses **semantic versioning** (`topologyVersion`).
  - **Patch** — clarifications, no document changes required.
  - **Minor** — additive, backwards-compatible (new capabilities, optional fields, new `transform`/`reducer` kinds).
  - **Major** — breaking changes to a conformant document. Consumers accept any document whose **major** matches.
- Vendor/domain extensions use a **namespace prefix** (`x-…`) and never require a version bump.
- The instance-level `docVersion` (per document) is independent of the spec version.

## Conformance

Producers and consumers declare a conformance profile (L1 read / L2 control / L3 aggregation & federation — see the format spec). A conformance test suite is part of the roadmap; "conformant" means "passes the suite at the declared profile."

## Roadmap to a foundation

This is incubated to create a track record (reference implementations + adopters). Once that exists, Lattice is intended to be contributed to a neutral home — **LF Energy** or the **Eclipse Foundation** (the latter hosts Sparkplug, with which the data plane aligns) — under that body's IPR and governance.

## IPR

Contributions are made under the project licences (`LICENSE.md`) and the Developer Certificate of Origin (sign-off; see `CONTRIBUTING.md`). The standard is royalty-free.
