# Lattice Control Model — Shapes + Vocabulary (proposal)

**Status:** Draft for discussion — 2026-06-19
**Targets:** schema **0.2.0** — the `class.function` identity change is breaking. These changes are being prototyped **in** the mutable `0.1.0/` draft (so `0.1.0/` files *do* change as we iterate) and will be cut as a frozen `0.2.0/` once the design is agreed. `0.1.0/` is pre-freeze and not yet depended on externally; treat it as the live draft, not a released version.
**Resolution for** [#3 coupled / mode / read-modify-write control](https://github.com/Predictive-Cloud-Ltd/lattice-spec/issues/3). **Implemented (PR-C):** the `0.1.0/` schema now carries `shape` (`setpoint`/`switch`/`schedule`), `controlGroup` (coupled atomic writes), `tier` (L1/L2), and a `readModifyWrite` binding flag, with conformance + a worked example. **Ownership/arbitration stays runtime-only** by decision (a claim is live, time-bounded state; the resolver derives the claimed subtree from `contains`/`aggregate` relationships — no schema construct; see §6). The **scheme vocabulary content** is adopted as a **v1 set now** (§3.x) — `battery.mode` stays an open string (extends via `x-<vendor>:`); maintainer review is folded in later rather than blocking.
**Companions:** *Capability & Topology Model* (read/topology), *Device Mapping & Sensors* (the near-term read scope).

> Motivated by review feedback while implementing control against real inverters (GivEnergy, Solis, Fox, Solax): a first attempt routed **independent per-capability writes** (`charge_rate`, then `target_soc`…). That was wrong twice over — it's an arbitrary subset ("why a rate but not a start/end time?"), and it has no agreed meaning ("who knows what charge_rate relates to"). A second idea — make everything a **schedule** (like Fox) — is also wrong: **not all devices have a schedule** (a relay, an immersion heater, a heat-pump setpoint, a "charge now at 16 A" EV). This doc defines a control model that fits both.

---

## 1. The four things control actually needs

Control is not one shape and not one register. A usable common control API has to pin down **four** separate concerns. Conflating them is what produced the earlier mess.

1. **Intent — *what* you want, with agreed meaning.** A defined vocabulary per device class (a battery's `target_soc` means the same thing everywhere). Without this, control is "poke a register and hope".
2. **Shape — *how* the device accepts that intent.** Set-now, switch-now, or a forward schedule. Different devices, different shapes.
3. **Binding — *how* it's executed** on a given provider (Modbus register, cloud CID, schedule API call). Per-provider; may be declarative (data) or imperative (code).
4. **Scope — *which node, at what altitude*** the intent is addressed to: a single leaf device, or an aggregate (a real EMS, a gateway, or a virtual "all batteries" group) treated as a black box. Same intent, different altitude. See §5–6.

A provider declares, per controllable function, an **(intent, shape, binding)** triple, on one or more **nodes** (the scope). The consumer (e.g. the PredBat planner) expresses intent against a node in the declared shape; Lattice resolves the altitude and the binding executes it.

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

### Shape is per access path — the same control can be completely divergent across paths

`shape`, `tier`, `controlGroup` and `readModifyWrite` are properties of a **capability *offer*** (a `(capability, accessPath)` pair), not of the capability. So one physical control reached two ways — e.g. a battery's `battery.target_soc` over a **local gateway** and over the **vendor cloud** — may have completely divergent control formats: the local path a scalar `setpoint` written to its own Modbus register, **independent** of the other functions (L1); the cloud path **coupled** with `battery.charge_power_limit` in a `controlGroup`, applied read-modify-write as a single cloud POST (L2). Both offers share the capability identity (and its data-plane `ref`); they diverge on binding, shape, tier, grouping and RMW independently. The resolver ranks a capability's offers by access-path `preference`, picks one (failing over on unavailability), and returns *that* path's shape + binding — the consumer expresses intent in the chosen shape, or an L2 provider absorbs the translation. A format that is none of the three shapes is carried by an L2 (provider-coded) binding, or — for an opaque vendor command — a namespaced `x-<vendor>:` capability; never a new core shape. (Worked example: `INV-0001` `battery.target_soc` in `0.1.0/examples/example-site.topology.json`.)

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

### Scheduled schemes are the primary battery control form

For batteries, the control you actually want to express is a **scheme (named mode) over a time window** — *"max self-use from 16:00–19:00", "force charge 00:30–04:30", "export 17:00–19:00"* — not a stream of low-level register writes. So `battery.mode` is the **headline** control, the `schedule` shape is how it's normally expressed, and the other functions (`charge_power_limit`, `target_soc`, `reserve_soc`) are **optional refinements within a slot** — frequently *implied by the scheme itself* (self-use implies "don't grid-charge, don't force-export").

A battery control plan is therefore an ordered list of `(window → scheme [+ optional refinements])`, plus a **default scheme** for any time not covered by a window. This is exactly the shape PredBat's planner already emits, and the shape a user understands.

**The scheme vocabulary is the heart of the battery class.** This is the **v1 set — adopted now** (not blocked on maintainer sign-off, which we'll seek and fold in later); `battery.mode` stays an open string so the set extends via `x-<vendor>:` without a schema change:

| scheme | meaning |
|---|---|
| `self_use` | cover load from battery/PV; don't grid-charge, don't force-export |
| `max_self_use` | self-use, maximised (e.g. hold reserve low to use as much stored energy as possible) |
| `force_charge` | charge (optionally to a `target_soc`, at a `charge_power_limit`), incl. from grid |
| `force_export` / `export` | discharge to grid (at a `discharge_power_limit`) |
| `idle` / `hold` | neither charge nor discharge (hold SoC) |
| `backup` | reserve for outage (hold a high `reserve_soc`) |
| `eco` / `dynamic` | vendor's adaptive default |

"max self-use" vs "self-use" shows schemes may need **intensity/parameters**, not just a flat enum — open question (§11).

**Scheme → device mapping is where the tiers (§7) bite.** A device with a native operating-mode register (GivEnergy Eco/Dynamic, etc.) maps a scheme declaratively (L1). A device without one *synthesises* the scheme from primitives — e.g. `self_use` = charge-enable off + discharge-enable on + no export window — which is provider code (L2). Either way the consumer just schedules `self_use`.

### Capability identity is `class.function` (decided)

The **identity** of a capability — the key that decides whether two declarations are "the same thing" (and so merge, resolve, and fan out together) — is the qualified `class.function`, **not** a bare name. `battery.charge_power_limit` (W) and `ev_charger.charge_current_limit` (A) are different identities; nothing ever groups them.

This matters because a flat name silently conflates unrelated controls. Concretely: in the editor's example, a battery inverter and an EV charger both used a bare `charge_rate` — so "charge all batteries" swept the EV charger in and tried to set its current to a battery wattage. The `unit` field (W vs A) was present in the doc but isn't part of identity, so it didn't help. Qualifying by class makes the collision impossible by construction: the EV charger simply doesn't have `battery.charge_power_limit`.

The class reflects the **function's** domain, not the node's kind — a `gateway` node may offer `battery.charge_power_limit` (as the aggregate control point for the batteries it coordinates) *and* `meter.grid_power` (its own grid sensing). The same convention applies to reads/sensors (`battery.soc`, `meter.grid_voltage`). Vendor/domain extensions still namespace further (`x-acme:foo`); a capability name still MUST NOT name a vendor or device.

---

## 4. Atomicity / coupling (the #3 case)

Some devices cannot set one function without others (Solax `soc_target_control_mode(target, power, mode)`). Model this as a **control group**: a named set of functions that resolve and execute as **one operation**.

- **One group, one binding.** All members sharing a `controlGroup` on a node carry the **same** `control` binding (identical protocol/op/address) — that single binding *is* the one operation; the per-member offers exist only to declare each function's membership, shape, tier and constraints. Conformance enforces this (members with divergent bindings are rejected). `schedule` shape is implicitly its own atomic unit (the whole plan), so it needs no explicit group; `setpoint`/`switch` couplings are declared via `controlGroup`.
- **The resolver gathers.** On resolving any grouped function, the resolver collects all sibling members on that node + access path, gathers their values (reading current device state for any the consumer didn't supply — the read-modify-write case), and invokes the single binding once with the full set. (The editor's Resolution Playground surfaces the gathered member list.)
- **Worked example:** `INV-0001` `battery.target_soc` + `battery.charge_power_limit` on `vendor-cloud` share `controlGroup: "cloud_plan"` and one `POST …/soc-target-control` binding — a single coupled call. The *same* two functions on `gw-local` are independent Modbus registers (no group). That is the divergent-format case from §2: decomposed locally, coupled in one op on the cloud.

---

## 5. Control altitude & aggregation

Control isn't always addressed to a single device. The hub may want to treat a group as a **black box** — "set all batteries to charge", like an EMS — or to command **one battery directly**. Both must use the *same* intent vocabulary; only the addressed **node** differs. This is the Composite pattern: every node is a *controller for its own subtree*.

- **Leaf** (one inverter/battery): controls itself → direct write.
- **Aggregate**: controls its children as a black box. Two kinds:
  - a **real coordinator** — a physical EMS or gateway that already coordinates its inverters (parallel-AIO sync, phase balancing);
  - a **virtual group** — the site, or an ad-hoc "all batteries", with no physical controller.

How an aggregate realises the black box (its binding **strategy**):

| Strategy | Who fans out | When |
|---|---|---|
| **delegated** | the device itself (real coordinator) | a physical EMS/gateway exists — send it one command |
| **expanded** | the **hub** (acting as a virtual EMS) | no coordinator — the hub issues one direct command per leaf |

The consumer declares intent over a **target set** of devices (or the site) and Lattice computes a **control plan** — the fewest controller commands that cover the set:

```
resolve_control(intent, target_set):
  cover target_set with the fewest controller nodes,
    preferring a real coordinator that *wholly* owns a subtree (delegated),
    else the hub over the remaining leaves (expanded);
  a request spanning two coordinators yields two delegated commands
    (there is no single physical black box for both);
  each chosen node claims ownership of its subtree (§6).
```

**Default policy:** prefer the real coordinator when one exists (it encodes coordination the hub can't reproduce from outside, and commanding the units behind it instead has historically broken control); fall back to hub-expanded only where no coordinator covers the leaves. A consumer may always **override the altitude explicitly** (e.g. target one battery for a fault or an experiment). Routing knowledge lives in the topology graph, not in the consumer — the planner says "charge these", not "which unit is the controller".

---

## 6. Ownership & arbitration

Because the same devices can be controlled at more than one altitude (the EMS *and* its batteries), the model must guarantee **exactly one controller owns a given device-subtree at a time**. Without this you get dual-control contention — two writers fighting over one inverter, which is a real, observed failure mode (e.g. an external VPP and the planner both writing the same battery).

- Choosing an altitude **claims** ownership of that subtree; the levels below it are off-limits while the claim holds (you never command an EMS *and* its leaves at once).
- Ownership is explicit and transferable: an external controller (a VPP dispatch, a manual override) can hold the claim for a window, and the planner defers to it rather than contending.
- A claim has a holder and a scope (subtree); resolution (§5) must refuse a plan that would write into a subtree owned by someone else, surfacing the conflict instead of racing.

---

## 7. Conformance tiers

Make non-declarative control explicitly in-spec rather than a silent gap:

- **Level 1 — declarative binding.** The (intent, shape) maps to a data-described binding (register/op/transform) with zero provider code. Modbus, Solis CIDs.
- **Level 2 — provider-implemented.** The binding is imperative provider code (schedule rebuild, coupled mode call, OAuth cloud write). Fox, Solax.

A provider declares its tier per function. Consumers know whether control is portable data or provider code.

---

## 8. Worked examples

- **GivEnergy battery (gateway/Modbus):** class `battery`; `mode`/`charge_power_limit`/`target_soc`/`reserve_soc`; shape `schedule` (slot registers) or `setpoint` (immediate rate); Level 1.
- **Fox battery (cloud):** class `battery`; same vocabulary; shape `schedule` (set_scheduler groups, applied atomically); Level 2.
- **Solax battery (cloud):** class `battery`; control group `{mode, target_soc, *_power_limit}` → one `soc_target_control_mode` call; shape `schedule`/`setpoint` inside a group; Level 2.
- **EV charger:** class `ev_charger`; `charge_current_limit` (setpoint) + `state` (switch); Level 1/2 per API.
- **Immersion / relay:** class `switch`; `state{on,off}` (switch); Level 1.
- **GivEnergy EMS / multi-AIO gateway (aggregate, §5):** a coordinator node exposing the `battery` vocabulary; **delegated** strategy — "charge all" sends one command, firmware drives the AIOs. Claims ownership of its inverter subtree.
- **Mixed fleet with no coordinator (aggregate, §5):** a virtual "site batteries" node; **expanded** strategy — the hub issues one direct `battery.mode` command per leaf.

---

## 9. How a consumer drives it (PredBat)

The planner emits **intent**, not register pokes: for a target node (a leaf, or an aggregate it treats as a black box) the desired `mode`/power/target — as a setpoint, switch, or schedule depending on the node's declared shape. Lattice resolves the altitude (§5), the best available access path (per the topology model), and ownership (§6); the provider applies it (per its binding/tier). The planner never needs per-brand or per-site code; it says "charge these batteries" and speaks the per-class vocabulary in the declared shape.

---

## 10. Sequencing

- This is the **complex, longer-term half** (per maintainer feedback: "good idea, not a short-term thing"). It should be agreed *before* control code is written — defining the per-class vocabularies + shapes + tiers + aggregation across inverter/EV/thermal is real standards work and is where domain expertise matters most.
- The **near-term, low-risk half is READ** — *map the devices + expose sensors* — which needs none of this (see the *Device Mapping & Sensors* doc). Control follows once this model is agreed.

## 11. Open questions

1. ~~Slot fields for the `schedule` shape~~ — **DECIDED (PR-C):** a slot is `{start, end, mode, charge_power_limit?, target_soc?, reserve_soc?}` plus a document-level default mode for uncovered time; refinements are optional and often implied by the scheme. Per-slot export-limit / grid-charge flag deferred until a device needs it (YAGNI). The slot set is a control-time payload contract, not a topology-document construct.
2. ~~How modes compose with schedules~~ — **DECIDED (PR-C):** `battery.mode` IS the scheme; a slot's `mode` is the scheme for that window, and a non-schedule device expresses the same scheme via the `switch` shape. One headline control, not two overlapping ones.
2a. The **scheme vocabulary** itself — **DECIDED (v1, adopted now):** the set in §3.x (`self_use`, `max_self_use`, `force_charge`, `export`, `idle`, `backup`, `eco`) is in effect; `battery.mode` stays an open string so it extends via `x-<vendor>:` without a schema change. Maintainer review (and whether schemes carry intensity/parameters — "max self-use" vs "self-use") is a later refinement, not a blocker.
3. Vocabulary governance — namespacing, versioning, how a new device class is added.
4. Whether `target_soc` "by time T" (deadline semantics) is a distinct intent from a schedule slot.
5. Aggregate semantics when a coordinator only *partially* covers a target set — command the coordinator for its part + hub-expand the rest, or drop wholly to leaves?
6. Does a delegated aggregate need per-child *feedback* (did every AIO take the command), or is the coordinator's single ack sufficient?
7. Ownership lifecycle — how claims are acquired/released/expired, and how an external owner (VPP) advertises and hands back a claim.
