# PredBat Integration — Fragment Merge & Entity Projection — Design

**Status:** Draft (brainstorm) — 2026-06-17
**Authors:** Mark Gascoyne, with Claude
**Companions:** *Capability & Topology Model* (`2026-06-17-capability-topology-model-design.md`) defines the model; *Topology Discovery, Descriptors & Composition* (`2026-06-17-topology-discovery-composition-design.md`) defines how the graph is built/shared. **This** doc covers *how PredBat consumes that model* — producing per-integration fragments, merging them, and projecting onto PredBat's control surface.
**Scope:** storage-agnostic; describes the data flow and the projection, not wire formats.

---

## 1. Purpose

Make PredBat's control surface a **projection of the merged site graph** rather than per-provider bespoke code. Each integration (and the gateway) produces a topology **fragment** describing what *it* can read/control; PredBat cloud **merges** the fragments by identity into one site graph; a **projection layer** maps a **curated** set of `(capability, scope)` pairs onto PredBat's **existing `predbat.*` entities**, routing reads/writes through `resolve_read` / `resolve_control`.

Two decisions frame this doc:
- **Projection sits *over* the existing entity model** (incremental) — a capability is "on the graph" once its entity routes through `resolve_*`; everything else is unchanged. No planner rewrite.
- **Curated mapping** — a defined table of the `(capability, scope)` pairs the planner needs, not an auto-generated entity per capability.

**The OpenAPI analogy (the end-state).** This is *OpenAPI for device topology & control*: a cloud provider (or the gateway) publishes a single **conformant doc** describing the nodes, capabilities, bindings and access paths it offers — and PredBat, or any consumer, ingests it **generically, with zero per-provider code**. Onboarding a new provider becomes "they output a doc — done", exactly as adding an API client becomes "point it at the `openapi.json`." This is also what makes the spec a real *standard* (a published doc format + a meta-schema + tooling), not just our internal model.

---

## 2. Architecture (data flow)

```
 producers (fragments)            merge (PredBat cloud)         projection            PredBat
 ─────────────────────            ─────────────────────         ──────────            ───────
 gateway        ─┐                                          curated table
 GivEnergy Cloud ─┤   identity-keyed   ┌───────────────┐   (capability,scope)   ┌──────────────┐
 Solis Cloud     ─┼───────────────────▶│  site graph   │──────────────────────▶│ predbat.*    │──▶ planner
 Enode (EV)      ─┤   merge            │ (one node per │   read = resolve_read  │ entities     │
 Octopus / Axle  ─┘                    │  device, with │   write= resolve_ctrl  └──────────────┘
                                       │  N access pths)│
                                       └───────────────┘
```

- **Producers** emit fragments. **Cloud** merges + hosts the graph + projection. **Planner** keeps reading/writing entities.

---

## 3. Fragment producers — each publishes a conformant doc

Each producer publishes a **conformant topology/capability doc** (its fragment): the slice it can see plus the **access paths it offers**, declaring only what it can actually do. Two modes, both yielding the same doc shape:

- **Vendor-published (the OpenAPI model)** — a provider that knows its own API/devices *authors and serves* its doc directly (GivEnergy Cloud, Solis Cloud, Enode for EV/EVSE, Octopus tariff, Axle VPP, …). No probing — they simply output the doc.
- **Discovered** — the gateway probes unknown *local* devices, fingerprint-matches descriptors (Discovery doc §3), and emits the resulting doc *upward* over MQTT.

A doc = nodes (by **identity**) + per-capability **bindings** + the **access path/provider** they're served on. A producer that can only read declares read-only; one that can control declares the control binding — that's what makes the merged graph's ranked access-paths real.

**OpenAPI parallels** (why this shape standardises well):

| OpenAPI | This standard |
|---|---|
| `openapi.json` document | a provider's topology/capability doc (the fragment) |
| JSON Schema meta-schema | the normative schema defining a *valid* doc |
| paths + operations | capabilities (read/control affordances) |
| `servers` | access paths / providers (ranked, with fallback) |
| components / `$ref` | device-type descriptors / binding templates (reused, versioned) |
| Swagger UI · codegen · mock servers · validators | future tooling: validator · simulator · entity-projection generator |
| publish at a URL / `/.well-known/` | a provider serves its doc at a known location; consumers ingest generically |

The consumer (PredBat) needs **zero per-provider code**: ingest any conformant doc → merge (§4) → project (§5).

---

## 4. Merge by identity

PredBat cloud merges all fragments into one site graph:

- **Same physical device from multiple producers → ONE node** carrying *every* producer's access paths, ranked (Model §5.7). Example: a GivEnergy inverter seen via the gateway (local Modbus) **and** GivEnergy Cloud becomes one node with access paths `[gateway (preferred), GE-Cloud (fallback)]`.
- **Distinct devices → sibling** nodes under the site root.
- **Correlation key = identity** (serial). Edge cases (missing/divergent serials across integrations) are an open question (§10).

The result is exactly the multi-provider graph the model describes — and it's where Phil's gateway-or-cloud fallback comes from for free.

---

## 5. Projection to entities (curated, over existing surface)

A **projection table** maps chosen `(capability, scope)` → existing `predbat.*` entity:

| capability | scope | entity | direction |
|---|---|---|---|
| `charge_rate` | battery-system | `predbat.charge_rate` | read+write |
| `soc` | plant | `predbat.soc` | read |
| `target_soc` | battery-system | `predbat.target_soc` | read+write |
| … | … | … | … |

- **Read** an entity → `resolve_read(capability, scope)` (reducers aggregate; grouping where relevant).
- **Write** a controllable entity → `resolve_control(capability, scope, value)` → picks the best available access path → the owning producer executes.
- **Scope is chosen per entry** (plant-level vs per-device).
- Routing through `resolve_*` **replaces the bespoke per-provider write code** for that capability; until an entity is added to the table it behaves exactly as today (incremental adoption).

---

## 6. Control precedence / ownership

When more than one producer can write a capability, resolution uses the **ranked access-path order** (e.g. prefer local gateway, fall back to cloud) plus a **policy** for genuine contention (e.g. a live VPP/Axle event taking priority, or manual override). This is the model's deferred **ownership/arbitration** facet (Model open-Q #4), made concrete at the projection boundary — the natural place to decide "who wins" because that's where an intent becomes operations.

---

## 7. Where it runs

- **Merge + projection:** PredBat cloud (it already aggregates integrations and holds the entity state).
- **Producers:** the gateway (firmware) and each cloud integration.
- **Planner:** unchanged — it reads/writes entities; resolution is invisible to it.

---

## 8. Worked example (Phil)

1. The GE inverter is discovered via the **gateway** (local Modbus) and via **GivEnergy Cloud** → merged by serial into **one node**, access paths `[gateway(pref), GE-Cloud(fallback)]`.
2. Projection: `(charge_rate, battery-system) → predbat.charge_rate`.
3. Planner writes `predbat.charge_rate` → `resolve_control` → gateway path. The gateway link is weak (−77 dBm) → resolution **falls back to GE-Cloud**. The battery charges either way — the failure that started this whole design is now handled by data, not code.

---

## 9. Relationship to current PredBat

- **Today:** per-provider control code paths + `entities_updates` → `consume_user_updates` → `set_state_external`; the planner reads/writes `predbat.*`.
- **With this:** the projection layer routes a *curated* set of those entities through `resolve_control`/`resolve_read` over the merged graph; per-provider write code for those capabilities is replaced; the entity surface and planner are untouched. Strictly additive and reversible per-capability.

---

## 10. Open questions

1. **Identity correlation** across integrations — serial match is primary; handling missing/divergent serials, and devices a cloud lists but the gateway can't see (and vice-versa).
2. **Precedence/ownership policy** specifics (VPP event vs planner vs manual).
3. **Fragment self-description** — does each integration ship its own descriptor (capabilities + bindings + access path), and where does it live (cloud-side per integration)?
4. **Fragment freshness / liveness** — integrations come and go online; how stale access paths are aged out and how the merged graph re-resolves.
5. **Rollout order** — which capability moves onto the graph first (likely battery charge/discharge rate, where the provider-fallback win is largest).

---

## 11. Non-goals

- The broader **open-standard** positioning/governance (separate track — see project notes).
- The **descriptor-engine implementation** itself (that's the gateway implementation plan).
- Replacing the planner or the entity model — this is a projection *over* them.
