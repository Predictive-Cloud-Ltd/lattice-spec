# Topology Data Plane over MQTT — Design

**Status:** Draft (brainstorm) — 2026-06-17
**Authors:** Mark Gascoyne, with Claude
**Companions:** model · discovery/composition · PredBat projection · doc-format. **This** doc defines the **runtime data plane** — how telemetry and control flow over MQTT, *typed by* the topology doc.
**Normative artifact:** [`../0.1.0/topology-data-plane.proto`](../0.1.0/topology-data-plane.proto).

---

## 1. Principle — the doc is the codec; protobuf carries the bytes

The description plane (the topology doc) assigns each capability a stable **`cap_ref`** and a **`docVersion`**. The data-plane protobuf messages carry compact `(cap_ref, value)` tuples; the doc of the matching `doc_version` decodes `cap_ref → node / capability / unit`.

**Wire principle: engineering values + intents only.** Raw registers and value transforms never cross the wire — the device applies them (the read transform *before* publishing telemetry; control resolution *after* receiving a command). Telemetry and control are therefore symmetric. Adding a device/capability → a new doc + new `cap_ref`s, with **no `.proto` change and no firmware rebuild** (the data-plane version of "telemetry schema is derived from the capability layer").

## 2. Topics (`predbat/devices/<device_id>/…`)

| topic | direction | encoding | retain | plane |
|---|---|---|---|---|
| `…/topology` | device→cloud | JSON (the doc/fragment) | **yes** | description (slow) |
| `…/telemetry` | device→cloud | protobuf `Telemetry` | no | data — read |
| `…/control` | cloud→device | protobuf `Control` | no | data — write (intent) |
| `…/ack/<command_id>` | device→cloud | protobuf `ControlAck` | no | write ack |

A clean evolution of today's gateway topics: `discovered → topology`, `status → telemetry` (already protobuf), `command → control` (+ `ack`); the existing `schedule` message is subsumed by `Control.schedule`.

## 3. Description plane — `…/topology`

The producer's doc (fragment), **retained JSON**, carrying `docVersion` and a per-capability `ref`. Slow-changing; re-published (with a bumped `docVersion`) when the topology changes. This is the retained "truth" the data plane is decoded against.

## 4. Telemetry plane — `…/telemetry`

`Telemetry { doc_version, base_ts_ms, samples[] }`; `Sample { cap_ref, group, ts_off_ms, value }`.
- **Engineering values** (the device already applied the read transform). `group` carries the index for vector/grouped capabilities (phase / cell / unit — e.g. per-AIO SOC).
- **Batched** per interval into one message (base timestamp + per-sample deltas); a **non-retained stream**.
- `doc_version` ties the bytes to a doc; on an unknown version the consumer re-reads the retained `…/topology`.

## 5. Control plane — `…/control` + `…/ack/<command_id>`

`Control { command_id, doc_version, cap_ref, scalar | schedule }` — **high-level intent**.
The device resolves locally: `cap_ref → (node, capability, control binding)` → `resolve_control` (clamp to constraints, transform to raw, distribute, write via the best available access path) → `ControlAck { command_id, ok, error }`.
- `doc_version` guards against stale `cap_ref`s (nack with `"stale doc_version"`).
- Register knowledge never crosses the wire; the cloud expresses *what*, the device decides *how*.
- This is where the **access-path fallback** lands operationally: if the preferred path (gateway-local Modbus) fails, resolution falls to the next (GivEnergy-Cloud) and the ack still reports success — Phil's fix, at run time.

## 6. Versioning handshake (`docVersion`)

`docVersion` bumps on **any** doc change, including `ref` (re)assignment. Telemetry and control both carry it. The consumer always decodes/encodes against the doc of the matching version and re-reads the retained topology on an unknown one. This is what safely decouples the (fast) bytes from the (slow) meaning.

## 7. Mapping to today's gateway

Incremental and familiar — the gateway already speaks protobuf for `status`/`schedule`. Migration: publish a `…/topology` doc; move `status` content into `Telemetry` keyed by `cap_ref`; accept `Control` intents and resolve via descriptors; emit `ack`s. Each capability moves onto the data plane independently.

## 8. Conformance / encoding rules

- Data-plane messages carry **engineering values only**; raw registers/transforms are device-side.
- `cap_ref` is stable **within** a `docVersion`; changing refs ⇒ bump `docVersion`.
- Telemetry is a **non-retained stream**; the topology doc is **retained** state.
- Control **requires** an ack; unknown/stale `cap_ref` or `doc_version` ⇒ nack, never a silent no-op.

## 9. Non-goals (here)

- MQTT auth/TLS/ACL (the existing per-device JWT + EMQX ACL stand).
- The descriptor-engine implementation (the gateway plan) and the cloud merge/projection (the projection doc).
- Transport choices other than MQTT (the same `(cap_ref, value)` framing maps to other transports if needed).
