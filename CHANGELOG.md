# Changelog

All notable changes to the Lattice specification are recorded here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the spec
is versioned by **directory** — each frozen version lives in its own
`MAJOR.MINOR.PATCH/` folder with a self-contained schema, data-plane proto, and
worked example. Versioning follows the `topologyVersion` major-match rule: a
consumer accepts any document whose major version it understands.

## [0.4.0] — 2026-07-27

Additive calendar-correct schedule and controller-fencing release. Frozen 0.2
and 0.3 artifacts are unchanged.

### Added

- Absolute one-shot schedule field 7 with explicit UTC validity, half-open
  slots, diagnostic IANA timezone, supported modes, gap policy, and
  native/controller-stepped execution.
- Authenticated controller context plus lease identity, receiver-derived scope,
  monotonic durable fence token, expiry, priority arbitration, and UNKNOWN
  scope quarantine.
- Structured rejection reasons with fallback-safe classification and a bounded
  applied-schedule receipt containing digest, verification, and clamp summary.
- A language-neutral v0.4 corpus covering today/tomorrow, midnight, DST
  gap/fold, gaps/defaults, adjacency, modes, lease renewal/expiry, priority,
  reboot, stale fencing, and UNKNOWN reconciliation.
- Compatibility and payload-budget tests pinning old-decoder no-op behavior,
  a 964-byte worst-case embedded Control, and a 486-byte worst-case ACK under
  the 1024-byte gateway ingress ceiling.

### Compatibility

- v0.4 uses new `Control` field 7. A v0.3 decoder sees no known payload and
  must nack/no-op.
- Existing Control fields 1–6 and ControlAck fields 1–7 retain their wire
  numbers and layouts.

## [0.3.0] — 2026-07-26

Additive schedule-intent data-plane release. The frozen `0.2.0/` artifacts are
unchanged.

### Added

- **Vendor extension properties (`^x-<vendor>:` keys) are now accepted** on the
  document root, `node`, `capabilityOffer`, `deviceType`, `relationship`, and
  `aggregate` (#32). The spec already allowed namespaced `x-<vendor>:` *names*
  for transform kinds, capability names, and node kinds, but every object was
  `additionalProperties:false` with no `patternProperties` — so a producer had
  no legal way to carry its own metadata, which was an oversight rather than a
  deliberate restriction. The pattern is deliberately narrow (`^x-[^:]+:.+$`):
  an unprefixed or mistyped key is still rejected, so this is an extension
  point, not a blanket escape hatch. Value-shape objects (the `oneOf` branches
  of `derived`, `valueOrRef`, `paramValue`, `constraintBound`) intentionally
  remain closed, since permissive keys there would weaken variant
  discrimination. Three further closed objects — `groupSlot`, `scheduleSpec` and
  `constraints` — are also intentionally left closed for now: they are config
  sub-objects of an entity rather than entities in their own right, so a vendor
  annotation belongs on the owning node/offer. Revisit if a real producer needs
  one.
- `Control.schedule_intent` at oneof field 6, carrying a typed, atomic
  `ScheduleIntent`.
- Presence-aware optional schedule refinements for target/reserve SoC,
  charge/discharge power limits, and enable, plus `default_mode`.
- A language-neutral control conformance corpus and TypeScript reference
  validator covering stale refs, legacy rejection, presence, and atomic
  validation.
- Machine-readable `ControlResult` outcomes on the legacy-compatible
  `ControlAck`, including optional applied scalar, verification flag, completion
  timestamp, and a result-query message.
- Bounded durable result replay keyed by `command_id`, pinning duplicate
  idempotency and lost-ack recovery in a second control-result corpus.

### Deprecated

- `Control.schedule` field 5 and its ambiguous integer `Slot.value`. New
  executors reject it unless an explicit capability-specific migration adapter
  supplies its meaning.

### Compatibility

- The change is protobuf-additive. An old decoder ignores field 6 and sees an
  unset payload, which must be a nack/no-op.
- Senders use field 6 only for a `shape:"schedule"` offer from a retained
  `topologyVersion >= 0.3.0` document.

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

[0.4.0]: https://github.com/Predictive-Cloud-Ltd/lattice-spec/tree/main/0.4.0
[0.3.0]: https://github.com/Predictive-Cloud-Ltd/lattice-spec/tree/main/0.3.0
[0.2.0]: https://github.com/Predictive-Cloud-Ltd/lattice-spec/tree/main/0.2.0
