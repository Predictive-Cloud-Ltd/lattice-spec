# Implementing Lattice

> **Lattice is OpenAPI for energy-device capabilities:** producers describe devices, mergers reconcile sources, and controllers operate against generic capabilities instead of vendor code.

This is the adopter's guide and self-certification checklist. The normative schema is [`0.4.0/topology-capability-doc.schema.json`](0.4.0/topology-capability-doc.schema.json); the behaviours below are pinned by language-neutral conformance corpora ([`conformance/`](conformance/)). If your implementation passes those corpora and meets the [acceptance criteria](#acceptance-criteria), it is credible — in any language, including obscure ones.

## The problem

Energy devices expose the same real-world functions through incompatible vendor APIs, register maps, clouds, gateways, and firmware quirks. Controllers end up hardcoding vendor/model logic: "if GivEnergy do X, if Solax do Y, if Fox do Z." That does not scale, and it breaks when one physical device is visible through multiple sources (local gateway *and* vendor cloud), or when a user correction must survive rediscovery.

## The solution

Define a **data contract, not a vendor SDK.** Each producer emits a Lattice **fragment** describing what it knows — device topology + capabilities + access paths + bindings. A pure **merge** combines fragments and overlays into one **site document**. A controller consumes that site document generically: it asks for `battery.charge_power_limit`, `meter.grid_power`, `thermal.setpoint`, and resolves each capability to the right access path and binding — with no vendor-specific planning logic.

## Core model

1. **Producer** — emits `scope:"fragment"` docs. Examples: a gateway, a cloud connector, an installer tool.
2. **Fragment** — a partial view of the site: stable node IDs, access paths, capabilities, relationships, and optional device-type descriptors.
3. **Overlay** — *also just a fragment*, but with higher `producer.authority`. Used for corrections, additions, or tombstones. There is no separate overlay type.
4. **Merge** — a pure function `merge([fragment, overlay, …]) -> { site, warnings }`.
5. **Site document** — the merged `scope:"site"` doc that controllers consume.
6. **Controller** — resolves desired capabilities into concrete reads/writes without vendor-specific planning.

## Minimum implementation profile

To stand this up on hardware or in any language, support this subset first — you do **not** need every advanced feature to be useful:

```text
JSON parse/emit
topologyVersion
producer { name, provider, authority }
nodes[]  (node.id, node.kind)
accessPaths[]
capabilities[]
relationships[]
merge()
resolve read/control by capability name
docVersion + cap_ref data-plane binding
```

Advanced constructs (derived reads, control groups / coupled bindings, schedule slots, transform pipelines, runtime-sourced constraints) layer on top and are exercised by their own examples and corpus cases.

## Merge rules

Identity keys:

```text
Node:                         id
Access path (within a node):  id
Capability offer (in a node): capability + accessPath   (a derived offer: capability only)
Relationship:                 from + to + type
Device type:                  key
```

Precedence (highest wins): **`producer.authority`**, then **`docVersion`** (recency), then **earlier input order**. The merge is deterministic given an ordered input list, but **not commutative under ties** — equal authority *and* docVersion with conflicting scalar values keeps the first input and emits a warning.

`producer.authority` orders the merge but is not a trust statement — trust is local policy / authenticated provenance (see the spec's Trust & authority note).

Field resolution: scalar fields (`kind`, `deviceType`) override per-field; bag fields (`attributes`, `parameters`) merge per-key; cohesive objects (`aggregate`) override wholesale; collections (`accessPaths`, `capabilities`, `relationships`, and top-level `deviceTypes` by `key`) are identity-keyed unions.

Tombstones — a higher-authority source removes an element by re-stating it with `removed: true`:

```json
{ "id": "INV-1", "removed": true }
```

A tombstone suppresses the matching element from all sources of ≤ its authority; a still-higher-authority source may reintroduce it. The merged document omits tombstoned elements and never emits `removed`. Removing a node drops relationships referencing it.

Merged provenance is synthetic: the site's `producer` is `{ name: "lattice-merge", provider: "lattice-merge", inputs: [ … ] }` (each input's name/provider/authority/docVersion, in input order); `site.id` is taken from the highest-authority input that *sets* it. `docVersion` is a content digest minted by the merger — **implementation-local** (see [data plane](#data-plane--versioning)).

The exact behaviour is pinned by [`conformance/merge/`](conformance/merge/) — see [conformance](#conformance).

## Controller rules

A controller:

1. Loads a merged site document.
2. Builds an index by capability name.
3. For reads, chooses the best available access path by `preference` (failing over to the next).
4. For controls, selects the matching control offer.
5. Applies constraints and transforms.
6. Emits the concrete binding operation.
7. Uses `docVersion + cap_ref` for compact telemetry/control.

The exact routing/clamping/fallback behaviour is pinned by [`conformance/resolve/`](conformance/resolve/).

## Implementation boundary

Lattice removes vendor logic from the controller's **planning** layer. It does **not** remove all adapter work — something still has to *execute* the declared binding:

```text
modbus read/write
HTTP call
cloud OAuth request
OCPP command
```

The controller decides *what* to do generically; adapters only execute declared bindings. A binding's conformance **tier** marks whether it is purely declarative (tier 1 — zero provider code) or needs provider-implemented execution (tier 2).

## Data plane & versioning

Telemetry and control ride a compact `docVersion + cap_ref` binding (protobuf: [`0.4.0/topology-data-plane.proto`](0.4.0/topology-data-plane.proto)). `cap_ref` identifies a `(node, capability)` within a document; `docVersion` identifies the document a consumer is decoding/encoding against. A consumer that sees an unknown `docVersion` re-reads the retained topology.

For a v0.4 schedule-shaped offer, `Control.absolute_schedule_intent` carries the
complete one-shot replacement plan. `cap_ref` normally identifies the selected
node's `battery.mode` offer. Validity and slots are half-open UTC epoch-ms
intervals; `diagnostic_timezone` is never reinterpreted by the receiver. The
offer declares its supported modes, gap policy, native/controller-stepped
execution modes and eight-slot embedded limit. The receiver validates the
whole plan before admitting its authenticated controller lease and durable
fence. See the [normative schedule/fencing semantics](spec/2026-07-27-calendar-correct-schedules-and-fencing.md).

`Control.schedule` field 5 and local-HHMM `schedule_intent` field 6 remain for
protobuf compatibility. A v0.4 sender uses field 7 only against a retained
0.4 document. A v0.3 decoder ignores field 7, sees no known payload, and must
nack/no-op.

Every control result is terminally classified as `APPLIED`,
`NOT_APPLIED`, or `UNKNOWN`; `UNSPECIFIED` is invalid. `UNKNOWN` is the safety
case: the first write might have succeeded, so the controller must not fail over
or dual-write. It queries the original `command_id` and verifies through
telemetry where possible.

For v0.4 schedules, NOT_APPLIED/UNKNOWN additionally carry a structured reason
and fallback classification; UNKNOWN quarantines the exact control scope across
reboot. APPLIED carries a bounded digest/count/verification receipt and at most
eight clamp details, never a full-plan echo.

Executors persist a bounded result journal before publishing an ack. Duplicate
commands and `…/result/get/<command_id>` queries replay the original result
without executing the binding. The reference journal uses a 1,024-entry,
24-hour profile and supports durable snapshot/restore. Expiry produces
`UNKNOWN`, never permission to retry elsewhere.

`docVersion` is **implementation-local**: each merged document is produced by one merger that owns its `docVersion`, and consumers use the concrete document they were handed. It is therefore *not* pinned across languages in the merge corpus (the corpus normalizes it out and pins merge *semantics*). Each implementation mints its own deterministic, content-derived `docVersion`; that it is a positive integer which changes with content is an in-language test. (If a future model needs independent mergers to produce *interchangeable* `doc_version`s, that requires canonical digest rules and pinning the exact value — out of scope today.)

## Conformance

Validate documents against **both** the JSON Schema **and** the semantic conformance checker — the schema now enforces the capability-name shape (`class.function` | `x-*`) via `pattern`, and the semantic checker covers cross-reference and structural invariants the schema can't express.

Six language-neutral golden corpora are the cross-language contract. Each is a set of input cases plus expected outputs; an implementation passes by producing structurally-equal output for every case.

- **[`conformance/schedule-v0.4/`](conformance/schedule-v0.4/)** — absolute-time schedules, controller fencing, UNKNOWN quarantine, and bounded applied results.
- **[`conformance/control/`](conformance/control/)** — frozen v0.3 schedule-envelope validation, legacy rejection, presence-aware values, and atomic failure.
- **[`conformance/control-result/`](conformance/control-result/)** — terminal result validity, duplicate idempotency, and durable lost-ack replay.
- **[`conformance/merge/`](conformance/merge/)** — `cases.json` (input fragments/overlays) → `expected.json` (the merged `{ site, warnings }`, with the implementation-local `site.docVersion` normalized out). Run your `merge`, delete `site.docVersion`, and compare.
- **[`conformance/resolve/`](conformance/resolve/)** — read/control resolution: routing, ranked access-path fallback, clamping, aggregate delegation, derived reads.
- **[`conformance/transform/`](conformance/transform/)** — bidirectional value transforms (raw↔engineering math); `toEng`/`fromEng` per case.

The **reference implementation** is the editor's TypeScript: frozen v0.3 [`editor/src/control-engine.ts`](editor/src/control-engine.ts) and [`editor/src/control-result-engine.ts`](editor/src/control-result-engine.ts), additive v0.4 [`editor/src/control-v0_4-engine.ts`](editor/src/control-v0_4-engine.ts) and [`editor/src/control-result-v0_4-engine.ts`](editor/src/control-result-v0_4-engine.ts), plus [`editor/src/merge-engine.ts`](editor/src/merge-engine.ts), [`editor/src/resolve-engine.ts`](editor/src/resolve-engine.ts), and [`editor/src/transform-engine.ts`](editor/src/transform-engine.ts), pinned by these corpora via the runners in [`editor/scripts/`](editor/scripts/). A second-language implementation adopts the *same* corpus files — that is what makes "similar implementation" mean "provably identical."

## Acceptance criteria

An implementation is credible when:

```text
[ ] It emits a valid fragment for one real device.
[ ] It merges discovery + overlay without losing user corrections.
[ ] It resolves at least one read capability.
[ ] It resolves at least one control capability.
[ ] It passes the merge conformance corpus.
[ ] It passes the resolve conformance corpus.
[ ] It does not hardcode vendor names in controller planning logic.
```
