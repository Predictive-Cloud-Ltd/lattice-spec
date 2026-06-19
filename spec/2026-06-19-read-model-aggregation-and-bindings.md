# Lattice Read Model — Shapes, Canonical Units, Aggregation & Derived Bindings

**Status:** Draft for discussion — 2026-06-19
**Companions:** *Control Model — Shapes + Vocabulary* (the mirror), *Device Mapping & Sensors* (the near-term read subset).

> The read side is the **mirror image** of control. Control fans *out* (one intent → many devices); read rolls *up* (many device values → one aggregate). Same topology graph, opposite direction. This doc pins down how a heterogeneous fleet (different units, different representations, values you must *calculate*) becomes one clean, comparable read surface.

---

## 1. The symmetry

| Concern | Control | Read |
|---|---|---|
| **Identity** | `class.function` | same (`battery.soc`, `meter.grid_power`) |
| **Shape** | setpoint / switch / schedule | scalar / vector / series / counter (§3) |
| **Binding** | how to write | how to read — incl. normalising + derived (§4) |
| **Scope + aggregation** | fan-out: delegated / expanded | roll-up: delegated / computed (§5) |
| **Safety** | ownership / arbitration (one writer) | none needed — reads are non-exclusive; **freshness** instead (§6) |

The `contains` edges that route control *down* are the same edges read aggregation rolls *up*.

## 2. Read is non-exclusive (the big simplification)

There is no ownership or arbitration on the read side — any number of consumers can read any node at any altitude simultaneously. §6 of the control model simply doesn't apply. What replaces it is **freshness** (§6 below).

## 3. Read shapes (value structure)

A read's "shape" is about the *structure of the value*, not how you set it:

- **scalar** — an instantaneous value (`battery.soc` now).
- **vector** — per-element (per-cell voltage, per-phase grid voltage); the schema's `count` + `groupBy`.
- **series** — a time history (`battery.soc` over time). Read-specific and important: PredBat's *prediction* consumes history; control has no analog.
- **counter** — cumulative, periodically resets (`energy_today`); reduces by `sum`, not `mean`.

The shape drives interpretation and reduction: a counter sums, cells take `spread` (imbalance), a series is for charting/forecasting, not point reduction.

## 4. Canonical units + normalising/derived bindings

The motivating mess: the *same* capability arrives in different physical representations — `battery.capacity` is **Wh** on one device, **Ah** on another, and on a third you must **calculate** it.

**Rule: each capability has ONE canonical unit (in the vocabulary); the binding normalises the device's native representation to it.** `battery.capacity` is canonically **Wh**. The consumer *only ever sees Wh*. All per-device messiness lives in the binding's transform — exactly where vendor-specificity is allowed and capability names are not.

| Device reports | Binding |
|---|---|
| Wh directly | `transform: identity` |
| Ah | `transform: scale` by nominal voltage → Ah × V = Wh |
| a raw register needing /2, ratio | existing `scale` / `capacity_ratio` transforms (the GivEnergy HR111/112 cap/2 case) |

**Parameterised transforms.** Ah→Wh needs the battery's nominal voltage, which isn't in the Ah reading — so a transform may pull its factor from a **node attribute** (`attributes.nominalV`) rather than a constant.

**Derived bindings (decided).** When a value must be *calculated* from more than one input (`Ah_register × voltage_register`, `rated_capacity × nominalV`), the binding is a **small declared expression over other capabilities/attributes** — deterministic and declarative, so it belongs in the doc. This extends today's single-address binding with an expression kind + a tiny safe evaluator.

**The line: declared/derived vs estimated/learned.** A *derived* value is a deterministic function of declared inputs (in scope — the binding computes it, the consumer sees canonical units). An *estimated/learned* value (real usable capacity inferred from charge throughput + SOC behaviour over time, degradation) is **consumer-side analytics** — it must NOT masquerade as a declared reading. The doc declares what a device exposes or can deterministically compute; it does not encode PredBat's calibration.

## 5. Read altitude & reduction

Reading at an aggregate altitude has two strategies, mirroring control's delegated/expanded:

- **Delegated read** — a real device already exposes the rolled-up value (the gateway reports whole-site `meter.grid_power`). One read, authoritative.
- **Computed read** — no aggregate sensor exists, so the hub **reduces from the children** with the `reducer` (`sum` / `mean` / `min` / `max` / `spread` / `representative`).

**Default (decided): prefer the device's aggregate, else compute.** If a coordinator exposes the aggregate, trust it (one read); only reduce from children when no aggregate sensor exists.

**Weighted reducers.** `mean` is wrong across unequal units — site SOC must be **capacity-weighted** (`battery.soc` weighted by `battery.capacity`). Reducers may carry a weight attribute; control never needs this.

**Normalise at the source, reduce in canonical units.** Because each leaf's binding already produced canonical Wh/%/W, the reducer only ever sees one unit and `sum`/weighted-`mean` just work. Never let native units survive to the reduction step.

## 6. Freshness (read's version of safety)

What ownership is to control, **staleness** is to read:

- Every read carries an **age / timestamp**.
- An aggregate (computed) read is only as fresh as its **stalest input** — a reduction must surface worst-case freshness.
- The access-path choice trades latency (local Modbus fast vs cloud delayed) — the same preference/fallback ranking as control, but the cost is *freshness*, not contention.

## 7. Schema implications (the new bits)

- **Canonical unit** per capability declared in the vocabulary (not just a per-offer `unit` hint).
- **Transforms may reference node attributes** (e.g. `nominalV`) for parameterised conversions.
- **A derived/expression binding kind** — value computed from other capabilities/attributes via a small, safe, side-effect-free expression.
- Reducers may take a **weight**.

## 8. Already built

- batpred read-only fragments + `resolve_sensor` already do **access-path preference** (gateway entity over cloud).
- The schema/editor already have `reducer` / `groupBy` and single-input `transform`s (incl. `capacity_ratio`).
- New here: canonical units, parameterised + derived bindings, read shapes (esp. series/counter), weighted reduction, freshness.

## 9. Open questions

1. Canonical unit set — fix the table (`battery.capacity` = Wh, `*.power` = W, `soc` = %, energy = Wh…) and how a new capability declares its canonical unit.
2. Expression language for derived bindings — how small/safe (arithmetic + named inputs only?), and how it references other capabilities (by `class.function` on the same node? on children?).
3. How `series` reads are declared and bounded (window, resolution) without bloating the topology doc.
4. Where weighted-reduction weights live (a fixed attribute vs a per-reducer reference).
