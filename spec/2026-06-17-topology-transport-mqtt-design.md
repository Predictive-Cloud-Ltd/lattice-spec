# Topology Data Plane over MQTT — Design

**Status:** Draft (brainstorm) — 2026-06-17
**Authors:** Mark Gascoyne, with Claude
**Companions:** model · discovery/composition · PredBat projection · doc-format. **This** doc defines the **runtime data plane** — how telemetry and control flow over MQTT, *typed by* the topology doc.
**Normative artifact:** [`../0.3.0/topology-data-plane.proto`](../0.3.0/topology-data-plane.proto).

---

## 1. Principle — the doc is the codec; protobuf carries the bytes

The description plane (the topology doc) assigns each capability a stable **`cap_ref`** and a **`docVersion`**. The data-plane protobuf messages carry compact `(cap_ref, value)` tuples; the doc of the matching `doc_version` decodes `cap_ref → node / capability / unit`.

**Wire principle: engineering values + intents only.** Raw registers and value transforms never cross the wire — the device applies them (the read transform *before* publishing telemetry; control resolution *after* receiving a command). Telemetry and control are therefore symmetric. Adding a device/capability → a new doc + new `cap_ref`s, with **no `.proto` change and no firmware rebuild** (the data-plane version of "telemetry schema is derived from the capability layer").

## 2. Relationship to Sparkplug B

**v0.3 decision:** keep [`../0.3.0/topology-data-plane.proto`](../0.3.0/topology-data-plane.proto) as the normative wire artifact, but define it as **Sparkplug-aligned**, not a competing semantic layer and not yet a formal Sparkplug profile.

The mapping is deliberate:
- retained `.../topology` doc ≈ an enriched Sparkplug birth certificate;
- `cap_ref` ≈ Sparkplug metric alias;
- `Telemetry.samples[]` ≈ aliased metric data;
- units, ranges and capability meaning live in the topology doc, not in every data message.

Before v0.2 or external standardisation, an RFC must decide whether this becomes a formal Sparkplug profile/extension or remains a standalone Lattice protobuf with a normative Sparkplug mapping. Until then, implementations should preserve the alias/doc-version semantics so the migration path stays open.

## 3. Topics (`predbat/devices/<device_id>/…`)

| topic | direction | encoding | retain | plane |
|---|---|---|---|---|
| `…/topology` | device→cloud | JSON (the doc/fragment) | **yes** | description (slow) |
| `…/telemetry` | device→cloud | protobuf `Telemetry` | no | data — read |
| `…/control` | cloud→device | protobuf `Control` | no | data — write (intent) |
| `…/ack/<command_id>` | device→cloud | protobuf `ControlAck` | no | write ack |
| `…/result/get/<command_id>` | cloud→device | protobuf `ControlResultRequest` | no | replay/query |

A clean evolution of today's gateway topics: `discovered → topology`, `status → telemetry` (already protobuf), `command → control` (+ `ack`); the existing schedule message is superseded by typed `Control.schedule_intent`.

## 4. Description plane — `…/topology`

The producer's doc (fragment), **retained JSON**, carrying `docVersion` and a per-capability `ref`. Slow-changing; re-published (with a bumped `docVersion`) when the topology changes. This is the retained "truth" the data plane is decoded against.

## 5. Telemetry plane — `…/telemetry`

`Telemetry { doc_version, base_ts_ms, samples[] }`; `Sample { cap_ref, group, ts_off_ms, value }`.
- **Engineering values** (the device already applied the read transform). `group` carries the index for vector/grouped capabilities (phase / cell / unit — e.g. per-AIO SOC).
- **Batched** per interval into one message (base timestamp + per-sample deltas); a **non-retained stream**.
- `doc_version` ties the bytes to a doc; on an unknown version the consumer re-reads the retained `…/topology`.

## 6. Control plane — `…/control` + `…/ack/<command_id>`

`Control { command_id, doc_version, cap_ref, scalar | schedule_intent }` — **high-level intent**.
The device resolves locally: `cap_ref → (node, capability, control binding)` → `resolve_control` (clamp to constraints, transform to raw, distribute, write via the best available access path) → `ControlAck { command_id, ok, error, result, … }`.
- `doc_version` guards against stale `cap_ref`s (nack with `"stale doc_version"`).
- Register knowledge never crosses the wire; the cloud expresses *what*, the device decides *how*.
- This is where the **access-path fallback** lands operationally: if the preferred path (gateway-local Modbus) fails, resolution falls to the next (GivEnergy-Cloud) and the ack still reports success — Phil's fix, at run time.

### Schedule intent

`schedule_intent` is the complete replacement plan for the schedule-shaped
offer identified by `cap_ref` (normally `battery.mode`). Each slot carries
target-device-local `start_hhmm`/`end_hhmm`, a mandatory mode, and optional
typed refinements. Refinements MUST be a subset of the chosen offer's
`scheduleSpec.slotFields`; `maxSlots`, constraints, `endBound`, and
`requiresDefaultMode` come from that same offer.

The receiver validates the whole plan before executing it. Invalid time,
overlap/order, slot count, mode, refinement, constraint, document, or ref means
one nack and **no partial write**. A zero numeric refinement and `enable:false`
are present values, not omission.

Field 5 (`schedule`) remains on the protobuf only for wire compatibility. Its
integer `Slot.value` cannot identify watts versus percent (or another unit), so
v0.3 executors reject it unless an explicit capability-specific migration
adapter supplies the meaning. Typed schedules use field 6. Old decoders ignore
field 6 and see an unset oneof; they MUST nack/no-op. Senders therefore use
field 6 only when the retained topology advertises `topologyVersion >= 0.3.0`.

### Terminal results, idempotency, and lost acknowledgements

`ControlAck` fields 1–3 retain their v0.2 tags. v0.3 adds a required terminal
`result`:

- `APPLIED` — the binding completed successfully at the provider/device
  boundary. Merely queueing or accepting an asynchronous request is not enough;
  if final application cannot be determined, return `UNKNOWN`.
- `NOT_APPLIED` — the executor can prove no effect occurred (validation/stale
  document rejection, or a failure before the first write).
- `UNKNOWN` — the write may or may not have taken effect. The caller MUST NOT
  fail over, retry under another command id, or issue a compensating dual write.
  It reconciles by result lookup and, where available, capability echo-back.

`CONTROL_RESULT_UNSPECIFIED` is not terminal and a v0.3 consumer rejects it.
For legacy decoders, `ok` is true exactly for `APPLIED`; it is false for both
other outcomes. `error` is empty for `APPLIED` and explanatory otherwise.

`applied_scalar` is the post-constraint value submitted by a successful scalar
control. It is not proof of physical state. `verified:true` is reserved for a
subsequent read/echo-back that confirms the requested state; `APPLIED` with
`verified:false` remains a valid successful provider/device-boundary result.
Schedule outcomes do not carry `applied_scalar`.

The executor keeps a **durable, bounded result journal** keyed by `command_id`
(the reference profile defaults to 1,024 entries and a 24-hour TTL). It records
the terminal result before publishing the ack. During retention:

1. Re-delivery of the same command id replays the field-identical terminal
   result without executing again.
2. Reuse of a command id with different request bytes still replays the original
   result, performs no write, and logs a fingerprint conflict.
3. `…/result/get/<command_id>` returns the same result on
   `…/ack/<command_id>`, including after executor restart.

If the bounded journal no longer contains the id, lookup returns `UNKNOWN`
(`ok:false`, `"result unavailable or expired"`); that absence never licenses a
fallback write. Requests and responses are non-retained MQTT messages so broker
retained state cannot outlive the executor's idempotency window.

## 7. Versioning handshake (`docVersion`)

`docVersion` bumps on **any** doc change, including `ref` (re)assignment. Telemetry and control both carry it. The consumer always decodes/encodes against the doc of the matching version and re-reads the retained topology on an unknown one. This is what safely decouples the (fast) bytes from the (slow) meaning.

## 8. Mapping to today's gateway

Incremental and familiar — the gateway already speaks protobuf for `status`/`schedule`. Migration: publish a `…/topology` doc; move `status` content into `Telemetry` keyed by `cap_ref`; accept `Control` intents and resolve via descriptors; emit `ack`s. Each capability moves onto the data plane independently.

## 9. Conformance / encoding rules

- Data-plane messages carry **engineering values only**; raw registers/transforms are device-side.
- `cap_ref` is stable **within** a `docVersion`; changing refs ⇒ bump `docVersion`.
- Telemetry is a **non-retained stream**; the topology doc is **retained** state.
- Control **requires** an ack; unknown/stale `cap_ref` or `doc_version` ⇒ nack, never a silent no-op.
- A control with an unset/unknown payload ⇒ nack/no-op.
- A schedule is atomic: validate the entire replacement plan before the first write.
- A command id is an idempotency key; record its terminal result durably before ack publication.
- Lost ack ⇒ query/replay the same id; `UNKNOWN` never permits a dual write.

## 10. Non-goals (here)

- MQTT auth/TLS/ACL (the existing per-device JWT + EMQX ACL stand).
- The descriptor-engine implementation (the gateway plan) and the cloud merge/projection (the projection doc).
- Transport choices other than MQTT (the same `(cap_ref, value)` framing maps to other transports if needed).
