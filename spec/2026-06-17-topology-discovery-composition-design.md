# Topology Discovery, Descriptors & Composition — Design

**Status:** Draft (brainstorm) — 2026-06-17
**Authors:** Mark Gascoyne, with Claude
**Companion:** *Capability & Topology Model — Design* (`2026-06-17-capability-topology-model-design.md`) defines the model — nodes/graph, capabilities, read/control routes, bindings, aggregation, constraints, participants. **This** doc covers *how that model is recognised, built, distributed, and kept in sync.*
**Scope:** storage-agnostic — the *content* of descriptors and the *steps* of building; not the on-disk/wire format.

---

## 1. Purpose & relationship to the Model doc

The Model doc answers **"what is the model and how does resolution work?"** This doc answers **"how do we produce and maintain that model for a real site?"** — recognising devices, assembling the graph, distributing the knowledge needed to talk to them, and keeping multiple participants in sync.

The connective tissue is the **device-type descriptor** (§3): the model's `bindings` and `capabilities` for a device come *from* a descriptor, and discovery *recognises* a device *by* a descriptor's fingerprint. Descriptors are the unit that crosses the model/build boundary.

---

## 2. Goals (build & distribution)

1. **Buildable from multiple sources, part-auto/part-manual** — a repeatable pipeline that merges on-device discovery, manufacturer-cloud data, installer input, and curated history; no single source sees the whole picture.
2. **Data-driven, updatable discovery** — *how to fingerprint and bind a device* is a distributable **descriptor** (flash / OTA / cloud-sync), so new device families are recognised **without a firmware rebuild**.
3. **Regenerate without losing manual declarations** — rediscovering `gateway → inverter` must never wipe a user's `control via cloud` choice; everything is identity-keyed and merged.
4. **Participants self-identify, publish, and take input elsewhere** — the gateway contributes the devices it fronts and the access paths it offers, and executes control authored elsewhere.

---

## 3. Device-type descriptors — templates + fingerprints, as distributable data

A **device-type descriptor** is a reusable, data-only definition keyed by `(manufacturer, model, firmware)` that bundles:

- **Fingerprint** — how to *recognise* the device: which registers/endpoints to probe and what values identify it (e.g. DTC `0x8001` + capacity register present → `GE-AIO`; a firmware register → version). This is the **discovery schema, as data**.
- **Capabilities** it offers, their **bindings** (concrete addresses/scaling — see Model §5.6), default **constraints** and **attributes**, and any **relationships** it implies (a gateway descriptor implies `contains` edges to the inverters it fronts).

Because the descriptor is *data*, the catalog of "how to recognise and talk to device X" is **distributable**:

- shipped in **device flash**,
- **OTA-updated**,
- or synced from the **cloud**,

so a gateway learns to fingerprint and bind a *new* device family without a firmware rebuild. This decisively answers an old open question — *"are inference rules data or code?"* → **data**. The catalog itself rides the participant/sharing model (§5): it is a shared artifact a participant carries and updates.

> **Versioning (per GPT review):** descriptors are templates, not per-instance copies. `GE-AIO-v2`/`v3`/`v4` are descriptor versions; thousands of identical devices reference one. A firmware change is a new descriptor version, not a rewrite of every node.

---

## 4. Building the topology

The Model is the *target representation*. Building it for a real site is a pipeline that **merges multiple sources** and is **partly automated, partly manual**. Guiding principle: **infer everything reliably inferable; declare only what genuinely can't be.**

### 4.1 Gather from multiple sources (factors)
- **On-device discovery** — our gateway probes reachable endpoints and **matches each against the fingerprint in its device-type descriptor catalog (§3)** to identify make/model/firmware, then instantiates the node with that descriptor's capabilities, bindings, and constraints. Records identity, attributes, and reachability (incl. "answered once but flaky"). The catalog is flash-resident and OTA-updatable, so new device families need no firmware rebuild.
- **Manufacturer / cloud enumeration** — a brand's cloud (GivEnergy Cloud, Solis Cloud…) can list the plant, serials, relationships, and an *alternative access path* to the same nodes.
- **Installer / onboarding input** — relationships, partial coverage, phase assignment, and control-path choices a probe can't infer.
- **Curated / historical data** — prior known facts (capacity, scaling, declarations) keyed by identity.

These are **merged by stable identity** (§4.5); conflicts reconciled by source trust/recency.

### 4.2 Infer structure
Derive the graph where unambiguous: a gateway's child inverters from its registers (`contains`); an EMS's managed inverters (`controls`); devices sharing a bus; a device that aggregates others' telemetry (`measures`).

### 4.3 Compose routes, groupings, redundancy & access paths
Per capability, derive obvious routes: a standalone device reads/controls itself; an additive aggregator gets a `sum` read route; redundant readings collapse to `representative` per group (grid voltage → per phase); multiple known access paths to a node become **ranked route alternatives** (Model §5.7).

### 4.4 Declare the residue
Pin what inference can't: read-here/control-there splits (Phil), partial coverage, which control path for an aggregate, phase assignment, **preferred vs fallback access path**, ownership.

### 4.5 Bind by identity & re-resolve
Everything keyed by stable **identity** so re-discovery / re-cabling / slot changes re-attach known facts to the same node and routes re-resolve — the graph changes without losing knowledge, and **manual declarations survive rediscovery**.

---

## 5. Sharing & sync (the distributed mechanics)

The Model says *any participant can attach to and contribute the shared topology* (Model §5.10). This section is the **how** — and is the least-settled part of the design (mostly open questions). (Recall the node/participant split: the hub *device* is a node; its *software* is a participant — Model §5.10.)

- **Self-identification** — a participant matches itself (and the nodes it fronts) to identities in the shared model.
- **Publication** — a participant advertises the nodes it has discovered and the **access paths it offers** to their capabilities; resolution can then route a capability to whichever participant offers the best path.
- **Convergence** — multiple participants contributing slices must converge on one shared model; this needs an authoritative copy (or a merge/CRDT-style reconciliation) and a transport.
- **Catalog distribution** — the descriptor catalog (§3) is itself shared: flash, OTA, and cloud copies must reconcile to a known version.

How participants advertise/discover one another, what carries the shared model on the wire, and who is authoritative are **open** (see §7).

---

## 6. Vocabulary (build & descriptors)

- **Device-type descriptor** — a data-only definition keyed by (make, model, firmware) bundling a **fingerprint**, capabilities, bindings, and default constraints/attributes/relationships; distributable via flash / OTA / cloud.
- **Fingerprint** — the probe + match rules that recognise a device as a given type/version (the discovery schema, as data).
- **Binding template** — the binding part of a descriptor; instances reference it instead of copying it (Model §5.6).
- **Descriptor catalog** — the set of descriptors a participant carries; flash-resident, OTA/cloud-updatable.
- **Participant / Provider** — as in the Model doc; here, the *active* sources that discover, publish, and execute.
- **Build pipeline** — gather-from-many-sources → infer → compose → declare → bind-by-identity.

---

## 7. Open questions (build & distribution)

1. **Hosting & discovery split** — what runs on-device vs cloud; where the authoritative model and catalog live.
2. **Sharing & sync** — how participants advertise/discover each other and converge; who holds the authoritative copy; resolving concurrent contributions; wire transport.
3. **Descriptor catalog** — format/versioning of descriptors; matching an instance to one via fingerprint; reconciling flash vs OTA vs cloud copies; handling unknown or new firmware.
4. **Source reconciliation** — trust/recency policy when discovery, cloud, installer, and history disagree.
5. **Auto-vs-declared balance** — how far inference goes before declaration is required.
6. **Who declares** — installer at onboarding, an admin/curation UI, or a cloud rules layer.

> **Resolved 2026-06-28 (#2, #4):** convergence, authority, and source reconciliation are now
> normative — see `2026-06-28-export-overlay-merge.md`. Sources carry an explicit
> `producer.authority` rank; a pure identity-keyed `merge` composes fragments + overlays
> (higher authority wins, `docVersion` recency breaks ties), with removal tombstones and
> deterministic output. Manual/upstream declarations survive rediscovery because the durable
> inputs (a fresh discovery fragment + stored overlays) are re-merged each cycle (§2.3). The
> remaining parts of #2/#3 (wire transport for distribution, who physically hosts the
> authoritative copy) stay open.

---

## 8. Success criteria (build & distribution)

- A **new device family** is supported by shipping/OTA-ing a **device-type descriptor** (fingerprint + bindings) — **no firmware rebuild** — and the gateway recognises and binds it from flash.
- The topology can be **regenerated from discovery without losing manual declarations** (identity-keyed merge).
- The build pipeline produces the Model's graph **with minimal human input**, from multiple sources, reconciled by identity.
- Any **participant** (gateway, cloud, app) can **self-identify, publish its slice, and execute intents routed to it** — control authored in one place runs wherever the access path lives.
