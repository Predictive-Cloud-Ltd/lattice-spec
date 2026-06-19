# Lattice Control Model — Shapes + Vocabulary (proposal)

**Status:** Draft for discussion — 2026-06-19
**Resolves / supersedes:** [#3 coupled / mode / read-modify-write control](https://github.com/Predictive-Cloud-Ltd/lattice-spec/issues/3)
**Companions:** *Capability & Topology Model* (read/topology), *Device Mapping & Sensors* (the near-term read scope).

> Motivated by review feedback while implementing control against real inverters (GivEnergy, Solis, Fox, Solax): a first attempt routed **independent per-capability writes** (`charge_rate`, then `target_soc`…). That was wrong twice over — it's an arbitrary subset ("why a rate but not a start/end time?"), and it has no agreed meaning ("who knows what charge_rate relates to"). A second idea — make everything a **schedule** (like Fox) — is also wrong: **not all devices have a schedule** (a relay, an immersion heater, a heat-pump setpoint, a "charge now at 16 A" EV). This doc defines a control model that fits both.

---

## 1. The three things control actually needs

Control is not one shape and not one register. A usable common control API has to pin down **three** separate concerns. Conflating them is what produced the earlier mess.

1. **Intent — *what* you want, with agreed meaning.** A defined vocabulary per device class (a battery's `target_soc` means the same thing everywhere). Without this, control is "poke a register and hope".
2. **Shape — *how* the device accepts that intent.** Set-now, switch-now, or a forward schedule. Different devices, different shapes.
3. **Binding — *how* it's executed** on a given provider (Modbus register, cloud CID, schedule API call). Per-provider; may be declarative (data) or imperative (code).

A provider declares, per controllable function, an **(intent, shape, binding)** triple. The consumer (e.g. the PredBat planner) expresses intent in the declared shape; the provider executes it.

---

## 2. Shapes (finite, closed set)

| Shape | Meaning | Applied as | Examples |
|---|---|---|---|
| **setpoint** | set a numeric value, effective now | write value | charge-rate now, EV current limit, heat-pump temperature, export limit |
| **switch** | set an enum / on-off, effective now | write state | relay on/off, charge-enable, HVAC `{heat,cool,off}`, battery `mode{charge,discharge,export,idle}` |
| **schedule** | a list of time-windowed states, applied as one unit | replace the plan | battery charge/discharge slots, EV scheduled charging |

Notes:
- **schedule** is *one* shape, not the model. A "dumb" inverter that only does "charge now at X" declares `setpoint`+`switch`, not `schedule`.
- A **schedule is applied atomically** — the whole plan is written (a natural read-modify-write). This is what dissolves the coupling/mode/RMW problem from #3: mode + power + target are *facets of a slot*, written together, not independently-poked registers.
- For non-schedule devices that nonetheless have coupled writes (Solax's `(target, power, mode)` in one call), a **control group** (see §4) provides the same atomicity for `setpoint`/`switch`.

---

## 3. Intent vocabulary (per device class)

A common API needs agreed semantics, and semantics are **per device class** — there is no single flat vocabulary across a battery, an EV charger, and a heat pump. Each class defines named control functions with a stated meaning, unit, and the shape(s) it's typically expressed in. Starter set (namespaced + extensible):

**`battery`**
| function | meaning | unit | typical shape |
|---|---|---|---|
| `mode` | charge / discharge / export / idle / self-use | enum | switch / schedule |
| `charge_power_limit` | max charge power | W | setpoint / schedule |
| `discharge_power_limit` | max discharge power | W | setpoint / schedule |
| `target_soc` | SoC to charge toward | % | setpoint / schedule |
| `reserve_soc` | floor below which the battery won't discharge | % | setpoint / schedule |

**`ev_charger`** — `charge_current_limit` (A, setpoint), `state{charge,stop}` (switch), `target_soc` (%, optional).
**`thermal`** — `setpoint` (°C, setpoint), `mode{heat,cool,off}` (switch).
**`switch`** — `state{on,off}` (switch). (immersion heater, relay)

Every function carries: name, unit, value domain/constraints, and the shape(s) the device supports for it. A device's **control profile** is the set of `(class.function, shape, constraints, binding)` it offers — and *only* those. (This is what fixes "rate but not start/end": a device that schedules declares the *whole* battery schedule vocabulary in the `schedule` shape, so a slot inherently carries time + power + target + mode together.)

---

## 4. Atomicity / coupling (the #3 case)

Some devices cannot set one function without others (Solax `soc_target_control_mode(target, power, mode)`). Model this as a **control group**: a named set of functions that resolve and execute together. The consumer supplies all members; the binding emits one operation. `schedule` shape is implicitly a group (the whole plan); `setpoint`/`switch` groups are declared explicitly. The resolver gathers all group members' values before invoking the binding, and reads current state for any member the consumer didn't supply.

---

## 5. Conformance tiers

Make non-declarative control explicitly in-spec rather than a silent gap:

- **Level 1 — declarative binding.** The (intent, shape) maps to a data-described binding (register/op/transform) with zero provider code. Modbus, Solis CIDs.
- **Level 2 — provider-implemented.** The binding is imperative provider code (schedule rebuild, coupled mode call, OAuth cloud write). Fox, Solax.

A provider declares its tier per function. Consumers know whether control is portable data or provider code.

---

## 6. Worked examples

- **GivEnergy battery (gateway/Modbus):** class `battery`; `mode`/`charge_power_limit`/`target_soc`/`reserve_soc`; shape `schedule` (slot registers) or `setpoint` (immediate rate); Level 1.
- **Fox battery (cloud):** class `battery`; same vocabulary; shape `schedule` (set_scheduler groups, applied atomically); Level 2.
- **Solax battery (cloud):** class `battery`; control group `{mode, target_soc, *_power_limit}` → one `soc_target_control_mode` call; shape `schedule`/`setpoint` inside a group; Level 2.
- **EV charger:** class `ev_charger`; `charge_current_limit` (setpoint) + `state` (switch); Level 1/2 per API.
- **Immersion / relay:** class `switch`; `state{on,off}` (switch); Level 1.

---

## 7. How a consumer drives it (PredBat)

The planner emits **intent**, not register pokes: for each controllable node, the desired `mode`/power/target — as a setpoint, switch, or schedule depending on the node's declared shape. Lattice resolves the best available access path (per the topology model) and the provider applies it (per its binding/tier). The planner never needs per-brand code; it speaks the per-class vocabulary in the declared shape.

---

## 8. Scope / sequencing

- This is the **complex, longer-term half** (per maintainer feedback: "good idea, not a short-term thing"). It should be agreed *before* control code is written — defining the per-class vocabularies + shapes + tiers across inverter/EV/thermal is real standards work and is where domain expertise matters most.
- The **near-term, low-risk half is READ** — *map the devices + expose sensors* — which needs none of this (see the *Device Mapping & Sensors* doc). Control follows once this model is agreed.

## 9. Open questions

1. Slot fields for the `schedule` shape — minimal `{start, end, mode, power_limit, target_soc, reserve_soc}` vs. per-slot export limit / grid-charge flag.
2. How modes compose with schedules (a slot's `mode` vs. a device-level `mode` switch).
3. Vocabulary governance — namespacing, versioning, how a new device class is added.
4. Whether `target_soc` "by time T" (deadline semantics) is a distinct intent from a schedule slot.
