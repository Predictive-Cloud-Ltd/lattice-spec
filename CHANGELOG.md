# Changelog

All notable changes to the Lattice specification are recorded here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the spec
is versioned by **directory** — each frozen version lives in its own
`MAJOR.MINOR.PATCH/` folder with a self-contained schema, data-plane proto, and
worked example. Versioning follows the `topologyVersion` major-match rule: a
consumer accepts any document whose major version it understands.

## [0.2.0] — 2026-06-29

First **frozen** release. `0.1.0` was the pre-freeze working draft and was never
published with a stable external consumer; all of the work below was prototyped
in place and is now cut as the immutable `0.2.0/` directory. There is no
separate `0.1.0/` artifact — `0.2.0/` supersedes it.

### Added

- **Transform vocabulary** — a fixed generic core registry (`identity`,
  `affine`, `ratio`, `negate`, `clamp`, `hhmm`, `pipeline`) closing the old
  "vendor-specificity allowed" loophole; namespaced `x-<vendor>:` kinds are the
  extension of last resort. Value-or-ref parameters (`{ ref, factor }`) resolve
  against a new node `parameters` block (`capacity`, `rated_power`,
  `nominal_voltage`). A `round` mode (`trunc` default / `half_up` / `half_even`)
  and an `onRefUnavailable` policy (`zero` default / `max` fail-open) make
  capacity-scaled and degraded transforms expressible as data.
- **Control model** — `shape` on offers (`setpoint` / `switch` / `schedule`,
  replacing the dead `schedule` boolean); `controlGroup` for coupled writes
  sharing one binding; `tier` (L1/L2) on offers; `readModifyWrite` on bindings;
  `groupSlot` (a coupled-binding `field` or `{ bits: { lsb, width } }` map) for
  packed/bitfield registers; `scheduleSpec` for schedule-shaped offers.
- **Read model** — `class.function` capability identity (`battery.soc`,
  `battery.charge_power_limit`, `ev_charger.charge_current_limit`,
  `meter.grid_power`, `thermal.*`, …), enforced by schema `pattern`
  (`class.function` | `x-*`) on both node capabilities and `deviceTypes`
  templates; a `distribution` field; multi-input **derived** reads
  (`$defs/derived`, `sum` | `ratio` over sibling capabilities); and
  runtime-sourced constraints (`constraints.min`/`max` as `{ source: capability }`).
- **Composition (export + overlay/merge)** — `producer.authority` (merge
  precedence) and gated `removed` tombstones on nodes, access paths, capability
  offers, and relationships. `merge(docs) -> { site, warnings }` is the
  normative composition contract.
- **Conformance corpora** — three language-neutral golden suites, the
  cross-language contract: [`conformance/resolve/`](conformance/resolve/)
  (read/control routing, ranked access-path fallback, clamping, aggregate
  delegation, derived reads), [`conformance/merge/`](conformance/merge/)
  (authority-ranked composition, overrides, tombstones), and
  [`conformance/transform/`](conformance/transform/) (bidirectional
  `toEng`/`fromEng` value math). TypeScript reference engines under
  `editor/src/` are pinned by these corpora; batpred's Python `merge` is the
  first provably-identical second-language adopter.
- **Adopter guide** — [`IMPLEMENTING.md`](IMPLEMENTING.md), a minimum
  implementation profile and a self-certification checklist backed by the corpora.

### Changed

- The canonical schema `$id` is now
  `https://lattice-spec.org/0.2.0/topology-capability-doc.schema.json`.
- Transform `kind` is constrained to the core registry or an `x-*` extension
  (was an open vendor-specific string).

### Notes

- **Scope boundary.** Lattice is a data contract — *describe → merge → resolve*.
  Cross-controller arbitration, claim lifecycle, authentication/provenance, and
  cross-merger `docVersion` interchange are runtime concerns the spec *enables*
  (e.g. via `ownedNodes`, `producer.authority`) but does not implement.

## [0.1.0] — unreleased

Pre-freeze working draft. Superseded by 0.2.0; not published as a stable artifact.

[0.2.0]: https://github.com/Predictive-Cloud-Ltd/lattice-spec/tree/main/0.2.0
