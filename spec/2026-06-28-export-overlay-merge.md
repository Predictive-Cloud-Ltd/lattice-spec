# Lattice — Export + Overlay/Merge Contract (normative)

**Status:** Normative — 2026-06-28
**Authors:** Mark Gascoyne, with Claude
**Closes:** open questions **#2 (sharing & sync / convergence / authority)** and **#4 (source reconciliation)** of `spec/2026-06-17-topology-discovery-composition-design.md`.
**Reference implementation:** `editor/src/merge-engine.ts` — `merge(docs) -> { site, warnings }`.
**Cross-language corpus:** `conformance/merge/` — the contract is the pinned golden, not this prose.
**Companion design:** `docs/superpowers/specs/2026-06-28-lattice-export-overlay-merge-design.md` (approved brainstorm; this doc is the normative port).

---

## 1. Purpose

The gateway is a **producer**, not a plan-executor of the site document. Devices below it (inverters, batteries on Modbus) have no spec; the gateway **mints** one by consuming a descriptor catalog to recognise them, **exporting** the discovered site document, and **consuming upstream changes and additions** (installer corrections, cloud enumeration) to merge them back on.

The gateway never executes the site doc top-down. The spec it depends on is therefore not plan-resolution (that pins the consumer — the editor and the SaaS UI). It is this **export + overlay/merge contract**: what a produced document must contain, and how upstream changes and additions compose onto a discovered base, deterministically, so the gateway's `merge` equals batpred's `merge_fragments` equals the editor's reference, by construction.

The discovery-composition design (`spec/2026-06-17-topology-discovery-composition-design.md`) states the requirement — §2.3 "rediscovering gateway → inverter must never wipe a user's 'control via cloud' choice; everything is identity-keyed and merged" — but §5 (Sharing & sync) is the least-settled part and §7 open questions #2 and #4 leave authority, convergence, and source reconciliation unspecified. This document closes them with testable, corpus-pinned semantics.

---

## 2. Export contract

A conformant producer (the gateway, a cloud enumerator, an installer tool) emits a **schema-valid `scope:"fragment"`** document. The following are normative requirements on every conformant producer.

### 2.1 Producer identity and authority

The `producer` object MUST carry `{ name, provider, authority }`. The `authority` field (integer, default 0) is the precedence rank this producer's claims carry in a merge. On-device discovery MUST use **low authority** — conventionally 0 — so any field the gateway guessed (e.g. `kind`) stays overridable by an upstream overlay without the gateway being silent about what it probed.

### 2.2 Stable node identifiers

Every node MUST have a **stable `id`** (a serial number or persistent identity, never an ephemeral scan index). The `id` is the merge key across discovery cycles and across sources: the same `id` from two producers means one node, not two. A producer that changes a node's `id` between export cycles breaks merge; never use a scan slot or sequence index as `id`.

### 2.3 Access paths scoped to what is reachable

Access paths describe **only what this producer can actually reach**. Each access path MUST carry `provider` (transport identity) and a `preference` (integer; higher is preferred). A producer MUST NOT assert access paths for transports it cannot serve; it describes its own slice.

### 2.4 Descriptor-sourced capabilities and bindings

Capabilities and their bindings MUST come from the **matched device-type descriptor** for the identified device (the fingerprint → binding step already implemented in the gateway's `catalog.cpp`). A producer MUST NOT invent bindings; it instantiates what the descriptor declares.

### 2.5 Inferred relationships

Structural relationships (e.g. a gateway `contains` its inverters) SHOULD be included in the fragment if they can be reliably inferred. Relationships the producer cannot determine are omitted; overlays supply them.

### 2.6 docVersion and topologyVersion

`topologyVersion` MUST be set. `docVersion` MUST be **monotonic per export** — it increases on every change. A producer MUST NOT reuse a `docVersion` for different content.

A producer's `docVersion` is a monotonic counter (implementation-defined); the content-digest `docVersion` described in §4.2 is a property of the *merged* output only, not of producer fragments.

### 2.7 Minimal assertion principle

A producer SHOULD describe only its own slice and SHOULD NOT assert fields it did not determine. This keeps the discovery fragment a faithful, low-authority view that overlays refine.

---

## 3. Merge algorithm

`merge` is a **pure function** of a list of documents:

```
merge(docs: Doc[]) -> { site: SiteDoc, warnings: string[] }
```

It is total, deterministic (given an ordered input list), and has no I/O or state. The reference implementation is `editor/src/merge-engine.ts`. The corpus in `conformance/merge/` is the cross-language contract.

The gateway's runtime loop:

```
                ┌─ discovery fragment  D  (authority 0)         ─┐
rediscover ────►│  (gateway exports what it probed)             │
                │                                                ├─► merge([D, U₁, U₂…]) ─► SiteDoc S
stored upstream►│─ overlay U₁ (installer, authority 50)          │      (ephemeral, recomputed
overlays        │─ overlay U₂ (cloud,     authority 70)         ─┘       every cycle)
```

The **durable truth is the separate inputs** — a freshly exported discovery fragment plus the stored overlays. `S` is derived and discarded each cycle. Because overlays are re-applied on every rediscovery, upstream declarations **survive automatically** (§2.3 of the discovery-composition design) with no provenance stamping and no in-place patching.

### 3.1 Identity keys

What "the same element" means across documents:

| Element | Key |
|---------|-----|
| Node | `id` |
| Access path (within a node) | `id` |
| Capability offer (within a node) | `(capability, accessPath)`; a derived offer (no `accessPath`) keys on `capability` alone — one derived offer per capability per node |
| Relationship | `(from, to, type)` |

### 3.2 Precedence

For any element key, the winning contributor is determined by three ordered criteria:

1. **Highest `producer.authority`** — the authority of the document that contributor element belongs to.
2. **Highest `docVersion`** (recency) — breaks ties at equal authority.
3. **Input order** (first wins) — breaks ties at equal authority and equal `docVersion`.

Authority is a property of the document applied uniformly to every element that document contributes. **The function is NOT commutative**: when two contributors tie on (authority, docVersion), input order decides, so `merge([A, B])` and `merge([B, A])` can differ. Order-independence holds only when no tie occurs (distinct authority or distinct docVersion).

### 3.3 Per-element resolution rules

#### Node scalar fields: `kind`, `deviceType`

Resolved **per-field**: each field takes the value from the highest-precedence document that sets it. A document that omits a field does not override it. This lets a sparse overlay fix only `kind` without restating the node.

#### Node bag fields: `attributes`, `parameters`

Merged **per-key** using the same precedence rule applied per key. A sparse overlay can add or override one attribute without clobbering the others.

#### Node cohesive-object field: `aggregate`

Overridden **wholesale** by the highest-precedence setter. `aggregate` is one cohesive unit (`{ serves, minChildren, priority, over }`); it is never field-merged across sources.

#### Collections: `accessPaths`, `capabilities`, `relationships`

Identity-keyed **union** across all contributors. On key collision the highest-precedence entry wins **wholesale** — a binding is cohesive and is never field-merged across sources. First-seen key order is preserved. After merging, access paths are sorted by `preference` descending, then `id` ascending (codepoint order — language-neutral, not locale-dependent).

#### Top-level collection: `deviceTypes`

Identity-keyed **union** across all inputs, keyed by `key`. On collision the highest-precedence entry wins wholesale. The merged site carries the full union of device-type descriptors so that node `deviceType` references resolve against the merged document.

### 3.4 Tombstones (`removed: true`)

An element with `removed: true` in a fragment/overlay is a tombstone. Tombstone semantics:

- A tombstone of authority A suppresses all same-key entries of authority ≤ A.
- A document of authority > A may re-introduce the element (the higher-authority entry survives). The tombstone acts as a **barrier**: when a node is re-introduced above a removal, only contributors ranked **strictly above the highest tombstone** participate in its field/bag/collection merge — sub-barrier (lower-authority) discovery data is **not** resurrected. (A node merges field-by-field across its contributors, so this barrier is what stops a repudiated discovery's attributes/access-paths/capabilities from leaking back when a higher authority re-asserts the node's existence.)
- The merged document **omits** tombstoned elements and MUST NOT emit `removed` in its output.
- Removing a node also drops all relationships that reference it (referential integrity; a warning is emitted per dropped relationship — see §6).
- A tombstone matches **exactly by its identity key** (§3.1). To remove a specific access-path offer, the tombstone must name that `accessPath`; a bare `{ capability, removed: true }` with no `accessPath` targets **only** the access-path-less (derived) offer — it does not remove access-path offers for that capability.
- A tombstone whose key matches nothing is a no-op (no warning).

### 3.5 Determinism

Given a fixed ordered input list, `merge` is deterministic:

- Node order in the output = first-seen across inputs (input order, then within-document order).
- Access paths sorted by `preference` descending, then `id` ascending (codepoint order — language-neutral, not locale-dependent; matches batpred behaviour).
- When two setters tie on (authority, docVersion) with conflicting scalar values, the first-in-input-order value is used and a warning is emitted.

### 3.6 Trust & authority

`producer.authority` is a **merge-ordering input, not a trust assertion.** The merge applies it mechanically; it does not establish that a producer is *allowed* to claim that authority. A consumer MUST decide which producers/authorities to trust out-of-band — via local policy and/or authenticated transport (signed/verified fragment provenance) — and SHOULD NOT blindly accept `authority` from an untrusted fragment. Defining an authenticated-provenance mechanism is out of scope for this draft.

---

## 4. Merged provenance and versioning

The merged document is produced by the merger, not by any input. Its provenance is **synthetic**, not inherited.

### 4.1 Synthetic producer

```jsonc
{
  "producer": {
    "name": "lattice-merge",
    "provider": "lattice-merge",
    "inputs": [
      { "name": "<source name>", "provider": "<source provider>", "authority": <int>, "docVersion": <int> },
      ...
    ]
  }
}
```

The `inputs` sidecar records each contributing source for provenance and audit. It lives inside `producer` (which is `additionalProperties: true`) — no top-level schema change is required.

### 4.2 Content-digest `docVersion`

The merged document's `docVersion` is **reminted** as a deterministic content digest — a stable 31-bit FNV-1a hash of the merged site with `docVersion` excluded — and is **never inherited** from any input. The digest changes whenever any merged content changes.

The cross-language corpus (`conformance/merge/`) normalizes `site.docVersion` out before comparing: each language mints its own deterministic value, making the exact integer implementation-defined. The "`docVersion` is a positive integer that changes with content" property is pinned by an **in-language** unit test, not the cross-language corpus. (`producer.inputs[].docVersion` echoes each input's version and IS pinned in the corpus.)

### 4.3 Site identity (`id`)

The merged document's `id` is taken from the highest-authority input that sets it. It is the **site's own identity** (the subject the document describes, e.g. a home), not provenance, and is legitimately named by the authoritative source. If no input sets `id`, the merged document omits it.

### 4.4 `topologyVersion`

Set to the inputs' shared version. Inputs MUST share a major (see §6 — a major mismatch is the one hard error).

### 4.5 Capability `ref` minting

Data-plane refs (`cap_ref`) are **minted by the merger** on the `site` output:

- One ref per `(node, capability)`: all access-path siblings of the same capability on the same node share one ref.
- Minted deterministically by node order then offer order within the node (sequential integers starting at 1).
- A source-supplied `ref` in a fragment/overlay is **ignored and re-minted** — fragments need not carry `ref`.
- Refs are **deliberately unstable across merged `docVersion`s**: adding a node renumbers later refs. Because `docVersion` is a content digest it always changes when refs do, and a consumer rebinds on an unknown `docVersion` (the schema's existing protocol). Refs are stable only within a `docVersion`.

---

## 5. Overlay = fragment

An overlay is a **`scope:"fragment"`** document with higher `producer.authority` and, optionally, tombstones. There is **no new `scope` value**. Specifically:

- `removed: true` is meaningful only in a `fragment` or overlay.
- A `site` document carries no tombstones: it is a semantic **error** (reported by `checkSemanticInvariants`) if `removed` appears anywhere under `scope:"site"` — on a node, access path, capability offer, or relationship — because tombstones are already applied by the time a site doc is produced. (This is a conformance check on a document, distinct from the single hard error `merge` itself throws — see §6.)
- An overlay may be sparse: it need only carry the fields and elements it asserts. Fields not mentioned are unaffected.

The gateway's runtime loop does not distinguish "overlay" from "discovery fragment" structurally — both are fragments. The difference is entirely in `producer.authority`: low for on-device discovery, higher for installer and cloud overlays.

---

## 6. Output validity, errors, and warnings

`merge` is **total** — it always returns `{ site, warnings }` — with exactly **two hard errors**:

| Condition | Behaviour |
|-----------|-----------|
| Empty input list (`merge([])`) | **Throw** — there is nothing to merge |
| `topologyVersion` major differs across inputs | **Throw** — incompatible versions cannot be merged |

Everything else resolves; where resolution is ambiguous or lossy, a warning is appended to `warnings`:

| Situation | Resolution | Warning emitted? |
|-----------|------------|-----------------|
| Equal (authority, docVersion) tie on a conflicting scalar | First-in-input-order wins | Yes |
| Tombstone of an absent element | No-op | No |
| Removing a node drops relationships referencing it | Relationship dropped | Yes, per relationship |
| Offer references a non-surviving access path | Offer kept faithfully in output | No (dangling ref check is a separate conformance pass) |

### Separation of concerns: structural vs. semantic validity

`merge` produces a **structurally-valid candidate** site document — it validates against the schema. It does NOT guarantee semantic completeness. For example, `merge` keeps an offer whose `accessPath` was tombstoned rather than silently dropping data (the relationship may be dangling, but no data is lost). Semantic validation (dangling refs, ref/accessPath integrity) is a **separate conformance pass** run on the candidate, exactly as for any site doc. `merge` does not duplicate it.

### Warnings are part of the conformance surface

Warnings are not a private side channel — they are **pinned in the merge corpus**. Each golden entry in `conformance/merge/` is the JSON-normalised `{ site, warnings }`. Two implementations that produce the same `site` but disagree on diagnostics will diverge on the golden. The corpus includes cases that produce warnings (equal-precedence tie; dropped dangling relationship) and cases that produce none (tombstone no-op). This makes diagnostics a first-class, cross-language contract.

---

## 7. Conformance

### 7.1 The corpus is the cross-language contract

The `conformance/merge/` corpus (`cases.json` + `expected.json`) is the normative cross-language contract for `merge`. The twelve cases cover:

1. **union** — same node via two peer providers → one node, both access paths ranked, capabilities unioned.
2. **override** — low-authority `kind=inverter` vs higher-authority `kind=gateway` → `gateway`, other fields intact (per-field precedence).
3. **sparse-override** — a high-authority overlay setting only `kind` MUST NOT clobber the discovered node's access paths, capabilities, or attributes.
4. **add** — overlay introduces a node and a `contains` edge discovery missed.
5. **remove-node** — overlay tombstones a phantom node; its relationships dropped (with warning).
6. **remove-offer** — overlay tombstones a misdetected access-path offer (`(capability, accessPath)`) on a real node.
7. **recency tiebreak** — equal authority, higher `docVersion` wins.
8. **tie-warns** — equal authority and `docVersion`, conflicting `kind` → first-in-order wins and a warning is pinned.
9. **survival** — `merge([D, U])` and `merge([D′, U])` (fresh, higher-`docVersion` discovery) both keep U's override, satisfying the discovery-composition §2.3 requirement.
10. **tombstone-noop** — tombstoning an absent element changes nothing and emits no warnings.
11. **deviceTypes** — device-type descriptor carried into the merged site so node `deviceType` references resolve.
12. **site.id survival** — `site.id` set by a low-authority input survives when the higher-authority overlay omits `id` (highest-authority setter wins; here only one input sets it).
13. **tiebreak** — equal-preference access paths sort by `id` codepoint order (not locale).
14. **tombstone-barrier** — a node tombstoned by a mid-authority overlay and re-introduced by a higher-authority one carries ONLY the above-barrier data; the original low-authority discovery's attributes/access-paths/capabilities are not resurrected.

Plus unit cases: schema gating for tombstone forms; a bare-`capability` tombstone removes only the derived (access-path-less) offer, not access-path offers; synthetic `producer` + digest `docVersion`; incompatible-major throw.

### 7.2 Reference implementation

`editor/src/merge-engine.ts` is the reference. The exported `merge(docs: Doc[]): MergeResult` function is the normative algorithm implementation in TypeScript.

### 7.3 Downstream adopters

batpred and the gateway MUST adopt the identical `conformance/merge/` corpus — using the same `cases.json` and `expected.json` golden — to be considered conformant. Divergence on any golden output (site or warnings) constitutes a non-conformance.

Adoption by batpred and the gateway is a downstream requirement; as of this writing only the editor reference implementation is confirmed conformant.

---

## 8. Vocabulary

- **Producer** — a system that emits a schema-valid `scope:"fragment"` document: the gateway, a cloud enumerator, or an installer tool.
- **Fragment** — a producer's slice; `scope:"fragment"`; represents one source's knowledge.
- **Overlay** — a fragment with higher `producer.authority` and (optionally) tombstones; asserted to correct or extend a discovery fragment. Not a distinct schema `scope`.
- **Site document** — a `scope:"site"` document; the output of `merge`; an already-merged graph. Never carries tombstones.
- **Authority** — the integer `producer.authority` rank; higher wins in precedence. On-device discovery = 0 (low); installer/cloud overlays higher.
- **Tombstone** — an element with `removed: true`; carries only its identity key; suppresses same-key entries of equal or lower authority in the merged output.
- **Content digest** — the deterministic 31-bit FNV-1a hash of the merged site (with `docVersion` excluded), used as the reminted `docVersion` of the merged output.
- **Identity key** — the field or field tuple that uniquely identifies an element for merge purposes (see §3.1).
