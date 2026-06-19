# Lattice — Device Mapping & Sensors (near-term read scope)

**Status:** Draft for discussion — 2026-06-19
**Companions:** *Capability & Topology Model* (the model), *Read Model — Shapes, Canonical Units, Aggregation & Derived Bindings* (the full read design this scopes a near-term subset of), *Control Model — Shapes + Vocabulary* (the deferred control half).

> Maintainer steer: *"I thought the idea was just to map out the devices in the network… there are also sensors. Generically controlling them needs a common API to be defined."* This doc scopes exactly that near-term half — **discover/map devices and expose their telemetry** — which needs **no** common control API and carries none of control's complexity or risk.

---

## 1. Scope

**In:**
- **Topology mapping** — each integration publishes a *fragment* describing the devices it sees (nodes by identity, kind/device-type, relationships, access paths). The cloud merges fragments by identity into one site graph (a device seen via two integrations becomes one node with ranked access paths).
- **Sensors (read)** — each node's telemetry capabilities (SoC, power, voltage, temperature, energy counters…) projected onto the existing consumer surface (e.g. `predbat.*` sensors), with reducers for aggregation (plant SoC = mean of units, plant power = sum).

**Out (deferred to the control model):**
- All control / actuation. No `would_handle`, no `apply`, no per-capability writes, no schedules. Read-only.

## 2. Why this is the right near-term piece

- **No common control API required.** Mapping + sensors is descriptive; it doesn't try to actuate anything, so it sidesteps the entire shapes/vocabulary/coupling problem.
- **Immediate value.** A unified, merged view of every device on a site (across gateway + clouds) plus normalised telemetry — useful for monitoring, support, and as the substrate the control model will later attach to.
- **Low risk.** Read-only; nothing touches the live control path.

## 3. Sensor vocabulary (read capabilities)

A small agreed set of telemetry functions per device class, each with unit + reducer for aggregation:

| function | unit | plant reducer |
|---|---|---|
| `soc` | % | mean |
| `power` (battery/grid/pv/load) | W | sum |
| `voltage` | V | representative |
| `temperature` | °C | mean / max |
| `energy_today` (pv/import/export/load) | kWh | sum |
| `capacity` | Wh | sum |

(Read semantics are far less contentious than control — a sensor reports a measured value; there is no "shape" question.)

## 4. Data flow

```
producers (fragments)        merge (identity)         sensor projection        consumer
gateway ─┐
ge-cloud ─┼──► one node per device, ──► (capability, scope) ──► existing sensor
fox      ─┤    ranked access paths        → reducer            entities
…        ─┘
```

## 5. First slice (predbat-saas)

- Each integration component publishes a read-only `lattice_fragment()` (nodes + sensor capabilities + access paths) — **no control capabilities declared**.
- A merge + sensor-projection step builds the merged site graph and surfaces normalised telemetry.
- Strictly additive; flag-gated; no control.

## 6. Relationship to control

The control model (separate doc) attaches *to the same merged graph* once its shapes + per-class vocabulary are agreed. Mapping + sensors is the foundation; control is a later, deliberate layer on top — not a prerequisite for delivering the read value now.
