# Capability & Topology Model — Design

**Status:** Draft (brainstorm) — 2026-06-17
**Authors:** Mark Gascoyne, with Claude
**Companion:** *Topology Discovery, Descriptors & Composition — Design* (`2026-06-17-topology-discovery-composition-design.md`) covers how this model is **recognised, built, distributed, and kept in sync**. **This** doc covers *what the model is and how reads/controls resolve over it.*
**Scope:** deliberately **storage-agnostic** — no schema, wire format, or persistence here.

---

## 1. Problem

Today a site's device **topology** and its **control rules** are encoded as hardcoded, per-model logic — split across the gateway firmware and, to a lesser extent, the cloud:

- A single "primary" device is chosen by fixed rules (`updatePrimaryDongles()`: EMS → primary; gateway + >1 AIO → gateway; otherwise the AIO), and everything else is skipped by the poll loop.
- Register maps are baked in per device model: single-phase / AIO battery rate = `HR111/112` scaled by *battery capacity/2*; gateway / EMS = `HR313/314` as *% of inverter power*; 3-phase = `HR1108/1110`; and so on.
- **Read and control are implicitly assumed to be on the same device, reached the same way.**

This breaks the moment a real site doesn't match the baked-in assumptions, because the topology and the "which register, where, via what" mapping aren't *described* anywhere — they're *inferred* by brittle rules.

**Concrete failure that prompted this (2026-06-17):** a customer's All-in-One battery sits *behind* a GivEnergy gateway on a weak Wi-Fi link. The firmware polled the gateway, never reliably read the inverter's capacity register, and tried to control charge rate via the inverter's `HR111/112` — a path it couldn't reach reliably — so the battery sat idle for days. Nothing captured *this inverter's capacity is read here, controlled there, and if the local link is down there's a cloud path that still works.*

**The shape generalises far beyond batteries.** The same structure recurs across solar inverters, EV chargers, EVs, **HVAC, heat pumps, and wet (hydronic) heating**, and across arbitrary aggregation and access:

- A device can aggregate a whole set of others — **fully or partially**.
- The level at which you can **read** a quantity is frequently **not** the level at which you can **control** it (a switch reports downstream power; control needs each sub-device).
- A reading can be **redundant** across devices (every AC inverter reports grid voltage → read one; one per phase if they span phases).
- There can be **multiple routes to the same thing** — e.g. control a battery via *our gateway* (local Modbus) **or** the *GivEnergy Cloud* API.
- A site can mix **multiple manufacturers and cloud providers**.
- Devices relate in **several overlapping ways at once** — physical containment, measurement/aggregation, and control — so the topology is a **graph, not a single tree** (a meter and an EMS can both relate to the same inverter: one *measures* it, the other *controls* it).

**What we need:** one declarative way to describe *any* site's topology and, for every quantity to measure or action to take, *where in the graph the read comes from, where the control goes, and via which (possibly several) access paths* — so behaviour is data-driven instead of special-cased.

---

## 2. Goals (the model)

1. **Describe any topology** — an arbitrary graph of energy devices across all domains (battery, PV, grid, EVC, EV, HVAC, heat pump, wet heating, metering, switching/contactors, gateways, EMS controllers, …), no fixed list of "supported shapes".
2. **Model as a graph** — typed relationships (`contains`/`measures`/`controls`/`powers`) with a derived tree view, so shared measurements and multiple control planes don't force ownership ambiguity.
3. **Separate read paths from control paths** — per capability, read source and control target are described independently and may live at different levels.
4. **Express aggregation (full/partial) and redundancy** — roll up some-or-all children for reads; fan control out to children; collapse redundant readings to one representative per equivalence group (e.g. per phase).
5. **Support multiple routes to the same thing** — a capability can be served by more than one access path (our gateway over local Modbus *and* the manufacturer's cloud API), expressed as **ranked alternatives with preference + fallback**.
6. **Be multi-vendor / multi-provider** — a site can mix manufacturers, each with its own gateway/cloud; the model and adapters are provider-pluralistic, not GivEnergy-specific.
7. **Be device- and protocol-agnostic** — a "setpoint" is a setpoint whether it's a heat pump on Modbus or a charger on OCPP.
8. **Deterministic resolution** — given the model + an intent, one well-defined resolution into concrete operations on concrete nodes via a chosen access path.
9. **Replace special-cases with data** — the concrete register/endpoint + scaling for each capability is *binding data* (§5.6), not selection-code branches.
10. **Honest about partiality & health** — express "readable but not controllable here", "partial coverage", "structure-only", "reachable but flaky".
11. **Cover scheduled control, not just instantaneous** — many controls are time-indexed plans (charge windows, heating schedules, OCPP profiles), not single setpoints.
12. **Respect constraints** — nodes/capabilities carry limits, valid modes, and interlocks that resolution must honour (clamp, reject, split by headroom).
13. **Shared & multi-participant** — any participant (gateway, cloud/PredBat, app) can attach to, read, and contribute the model (§5.10).

---

## 3. Non-goals (out of scope for this document)

- **Storage / persistence** (NVS, DB tables, files) and **wire/serialization format**.
- **The adapter engine** that *executes* a binding (the actual Modbus/OCPP/HTTP transaction). The binding **descriptors** it consumes — register address, function, encoding, scaling, units (§5.6) — are **in scope as data**; only the transaction code is out.
- **Final decision on hosting** (firmware vs cloud vs hybrid).
- **Multi-controller ownership/conflict policy** — noted as an open question (§8.4).
- **Discovery, fingerprinting, the build pipeline, descriptor distribution & sync** → see the companion *Discovery, Descriptors & Composition* doc.

---

## 4. Motivating cases (the model must express all of these)

| # | Case | Why it's hard |
|---|------|---------------|
| A | **AIO behind a gateway** (Phil). Capacity readable on the inverter, control reliable only via a different path; weak link. | Read node ≠ control node; reachability varies. |
| B | **Switch/contactor over many loads.** Read total power at the switch; control each downstream device. | One read node aggregates; control fans out to leaves. |
| C | **EMS controlling multiple AC3 inverters.** EMS aggregates plant telemetry; control at EMS *or* per inverter. | Aggregate read at parent; control at parent *or* children. |
| D | **Gateway + multiple parallel AIOs.** Whole-plant control via the gateway; per-unit telemetry from each AIO. | Control at parent, reads at children. |
| E | **Zoned wet heating.** Heat pump → manifold → zones; valve controls a zone; flow temp at the manifold. | Non-electrical domain, same shape. |
| F | **Partial aggregation.** A meter covers 3 of 4 sub-circuits; the 4th is separate. | "Aggregate" ≠ "all children". |
| G | **Redundant reading.** Every AC reports grid voltage; read one (single phase) or one per phase. | Same value across nodes; representative per group, don't sum. |
| H | **Multiple routes to one device.** Battery charge rate controllable via *our gateway* (local Modbus) **or** *GivEnergy Cloud*. | One capability, several access paths; preference + fallback. |
| I | **Mixed manufacturers / clouds.** One site has GivEnergy + another brand, each via its own gateway/cloud. | Heterogeneous providers in one topology; no single-vendor assumption. |

If the model expresses A–I cleanly, it's general enough.

---

## 5. Conceptual model

### 5.1 Nodes & relationships — the topology graph
The topology is a **graph of nodes connected by typed relationships** — `contains`, `aggregates`/`measures`, `controls`, `powers`. A node is *anything in the site*: battery, inverter, PV string, grid connection, EV charger, EV, heat pump, HVAC unit, heating zone, meter, switch/contactor, gateway, EMS — **or a pure structural/aggregator node with no telemetry of its own**. Every node has a stable **identity** (e.g. a serial) so it's referable independently of position; position can change (re-discovery, re-cabling) without changing identity.

A node carries **attributes/tags** (electrical phase, nominal ratings, role) that routing/grouping reference, and **zero or more access paths** (§5.7) — distinct ways to reach it, each via a **provider**.

Why a graph, not a tree: a node can relate to several others *at once and differently* — a grid meter `measures` an inverter while an EMS `controls` it; an inverter is `contained` by a gateway but `measured` by the meter. Containment edges alone give a **derived tree view** for display, but the model itself is a graph — which is also what lets multiple participants (§5.10) attach to the same node without ownership ambiguity.

**Relationships are directed**, read subject → object, each with a named inverse for traversal:
- `A contains B` — A physically/logically contains/fronts B (gateway contains inverter); inverse *contained-by*.
- `A measures B` — A observes or aggregates B's quantities (meter measures inverter; plant aggregates AIOs); inverse *measured-by*.
- `A controls B` — A can command B (EMS controls inverter); inverse *controlled-by*.
- `A powers B` — A is electrically upstream of B in the nominal supply direction (grid powers the main; main powers the loads); inverse *powered-by*. Physical flow may reverse (export) — the direction is the *connection's* orientation, not the instantaneous sign.

**Structural / aggregator nodes are first-class.** A node need not be a physical device — a `plant battery system` node can `contain`/`measure` several AIOs and is where aggregate capabilities live (`plant.soc.read = mean(aios)`, §5.4). These "virtual" nodes keep aggregates explicit instead of synthesising them ad hoc.

**Depth is unbounded — the graph also nests *downward*.** Below the inverter sit the battery pack, modules, and cells (a BMS exposes per-cell voltages/temps, SoH, cycle count, balancing). These are more `contains` levels: `inverter contains pack contains module contains cell`. A sub-level becomes its **own node** when it is independently addressable/controllable (e.g. per-module balancing); otherwise its many like elements are a **vector-valued capability** on the parent (§5.4) rather than hundreds of nodes.

### 5.2 Capabilities — first-class, domain-agnostic
A **capability** is a thing you can measure or do, named generically and independent of device type:
- **Measurements:** power, voltage, current, state-of-charge, temperature, flow, energy counters, status/mode…
- **Controls:** on/off, setpoint, rate/limit, mode, schedule…

Capabilities are **not** baked into a device "type". A node *offers* capabilities; the same name means the same thing across domains; only the binding differs.

### 5.3 Capability routing — independent read and control paths
For a capability *at a scope* (e.g. "the battery system's charge rate"), the model holds **two independent routes**:
- a **read route** → node(s) exposing the reading;
- a **control route** → node(s) accepting the action.

They may resolve to the **same** node, **different** nodes, or **different cardinalities**; a capability may be read-only or control-only. **Each route is a ranked list of alternatives (§5.7), not a single binding** — so the same capability can be served via different access paths/providers with fallback. (A "route" is just the **read side** or **control side** of a capability — not a separate object to navigate; it bundles the alternatives with how they combine, §5.4.)

> Phil: `battery.charge_rate` read route = the gateway/aggregate; control route = the AIO leaf, served by `[via our-gateway (preferred), via GivEnergy-Cloud (fallback)]`.

### 5.4 Aggregation, redundancy & fan-out
When a route spans multiple nodes — or a single reading is itself an array — the model says *how they combine*:
- **Read reducer:** `sum` (power), `mean` (temperature), `min`/`max`, **`spread`** (max−min, e.g. cell imbalance), `direct` (node measures it), or **`representative`** (shared/redundant value — read one healthy one, e.g. grid voltage).
- **Vector readings:** a capability can be **vector-valued** — an array of like elements (per-cell voltage, per-cell temperature). The same reducers collapse the vector (`min`/`max`/`mean`/`spread`) or it can be exposed element-wise. This is the downward analogue of grouping: one capability, many elements (cells), not many nodes.
- **Grouping dimension:** partition the covered set by an attribute (e.g. *phase*) → one result per group. Grid voltage → group by phase, `representative` → `{V_L1[,V_L2,V_L3]}`; total power → no grouping, `sum`.
- **Control distribution:** `replicate` (same command to each), `split` (a quantity across them: proportional / by-headroom), `first-that-accepts`.
- **Coverage:** a route may be **partial** — an explicit *subset*; "aggregate" never silently means "all".

Attached **per capability**, because they differ.

### 5.5 Resolution — intent → operations
1. **Read(capability, scope)** → follow the read route → pick the best available access-path alternative → apply grouping + reducer over covered, reachable node(s) → value(s) + coverage/health metadata.
2. **Control(capability, scope, intent)** → follow the control route → pick the best available alternative → apply the distribution → concrete operations on concrete node(s) via the chosen access path.
Resolution is pure given the model; it embeds no device-specific knowledge.

### 5.6 Bindings — the concrete "how", as data
A binding is *how a node serves a capability on a given access path*, captured as **data** so behaviour is table-driven, not hardcoded. It carries the **abstract** side (capability + engineering units) **and the concrete access descriptor**:
- **protocol** — Modbus / OCPP / HTTP / cloud-API…
- **address** — register number or range; API endpoint/field; OCPP action.
- **access op** — e.g. read-holding-register, write-multiple-registers, GET/POST.
- **encoding** — data type, word/byte order, bit field.
- **value transform** — raw ⇄ engineering units, including derived scaling. E.g. capacity = `HR55_raw × 317` Wh; charge-rate watts = `value × capacity ÷ 100`; `value 50 = max`.

This is the crux of making the system data-driven: the choice of `HR111/112` vs `HR313/314` vs `HR1108/1110`, and the capacity-based scaling, become **binding data** attached to the node/access-path — not branches in firmware. Out of scope is only the **adapter engine** that *executes* a binding.

**Bindings are templated, not copied.** A node instance doesn't carry its own register map — it references a **binding template** keyed by `(manufacturer, model, firmware version)`. The template is the binding part of a **device-type descriptor**, defined and distributed by the companion *Discovery, Descriptors & Composition* doc.

### 5.7 Access paths, providers & route selection
A node's capabilities may be reachable by **more than one access path**, each belonging to a **provider** (a manufacturer system or transport): our gateway over local Modbus, the manufacturer's cloud API (GivEnergy Cloud, Solis Cloud…), a local LAN API, OCPP, etc. Access paths differ in:
- **locality** (local vs cloud), **latency**, **reliability/health**, **cost/rate-limits**, and **coverage** (a cloud API may control but offer only slow telemetry; a local path may be fast but flaky).

Therefore a **route is a ranked list of alternatives** — each `(node, access-path/provider, binding)` — with **preference + fallback**. Resolution picks the best *available, healthy* alternative per policy (prefer local for speed; fall back to cloud when the local link is down).

A site is thus **multi-provider**: different nodes — or the *same* node — can be served by different providers, and the model carries all of them. This directly addresses Phil and case H: if the gateway link is too weak, charge-rate control still lands via GivEnergy Cloud.

### 5.8 Time & scheduling
Capabilities are **instantaneous or scheduled**:
- **Instantaneous** — read the value now / set the value now.
- **Scheduled** — the control payload is a **time-indexed plan**: charge/discharge windows, a heating schedule, an OCPP charging profile, a tariff-driven setpoint series.

Scheduling rides the same machinery: a scheduled control still has a control route, distribution, and binding — the *payload* is a series, not a scalar. Distribution still applies (replicate the whole schedule to each child, or split per-period). A node's binding declares whether it accepts a **device-native schedule** (GE charge windows, OCPP profile) or must be **stepped** by the controller executing the plan point-in-time — so the resolver knows whether to hand over a schedule or drive setpoints live.

### 5.9 Constraints & limits
Capabilities and nodes carry **constraints** that resolution must respect:
- **Bounds** — min/max (max charge rate, SOC 0–100 %, max flow temp).
- **Valid set** — allowed modes/enum values.
- **Interlocks** — mutually-exclusive states (can't export while force-charging), preconditions.
- **Rate limits** — max rate-of-change.
- **Scope** — a constraint is **capability-level** (SOC 0–100 %), **node-level** (an inverter's rated power), or **site/topology-level** (max grid import 100 A; export capped at 3.68 kW under G98/G99); resolution respects all that apply.

Constraints may be **static** (rated power) or **derived** from live readings (headroom = capacity − current SOC). Resolution **clamps** a setpoint into range, **rejects** an invalid mode, and when **splitting** a quantity across children respects each child's headroom (§5.4). This generalises the real charge-rate work: "max = `min(capacity/2, rated)`" and "value 50 = max, anything that rounds to 49 snaps back" are just a derived bound + valid-set on the `charge_rate` capability — expressed once in the model, not re-coded per device.

### 5.10 Participants — operating on the shared model
A **participant is a software process/actor** that publishes or operates through one or more node **access paths** — it is *not itself a node in the graph*. The topology is **not owned by one process**: any participant can read and contribute it — the gateway's software, the cloud/PredBat, the app, a worker, manufacturer integrations, even peer gateways.

**Node vs participant (important):**
- The **PredBat hub/gateway *device*** is a **node** — an aggregator that `contains`/`fronts`/`measures`/`controls` downstream devices.
- The **cloud / app / worker** are **participants** — software actors that resolve intents and execute actions; they never appear in the graph.
- A gateway/hub is therefore **both**: a topology **node** (it aggregates/fronts devices) *and* the backing of a **participant** (its software publishes and executes access paths).

A participant can:
- **Self-identify** — match itself, and the nodes it fronts, to identities in the shared model.
- **Publish** — contribute the slice it knows: discovered nodes, attributes, and the **access paths it offers** to their capabilities ("I can read/control these serials over local Modbus").
- **Take input elsewhere** — receive a read/control intent that *resolves to a node it offers an access path for*, even though another participant authored it (PredBat plans in the cloud; the gateway executes because it holds the access path).

So a **provider (§5.7) is the published offering of a participant**, and resolution routes each capability to whichever participant offers the best available access path. *How* participants advertise, discover one another, and stay in sync is build/transport mechanics — see the companion doc.

---

## 6. Vocabulary

- **Node** — any device or **structural/aggregator (virtual) element** (e.g. a `plant`); stable identity, attributes/tags, zero+ access paths. A hub/gateway *device* is a node.
- **Topology** — the **graph** of nodes + typed relationships for a site (containment gives a derived tree view).
- **Relationship (edge)** — a **directed** typed link, read subject → object, with a named inverse: `contains` / `measures`(aggregates) / `controls` / `powers`.
- **Capability** — a generic measurement or control.
- **Route** — a **ranked list of alternatives** serving a capability; the read side / control side of it.
- **Access path** — a way to reach a node's capabilities via a **provider/transport**; has locality, reliability, coverage.
- **Provider** — a manufacturer system or transport behind an access path (our gateway, GivEnergy Cloud, …); a site may have several.
- **Participant** — a **software actor** that publishes/operates through node access paths (cloud/PredBat, app, worker, gateway software); **not** a graph node, though a hub *device* is a node *and* backs a participant. Backs one or more providers.
- **Binding** — the concrete, data-driven "how a node serves this capability on an access path": protocol, address (register/endpoint), access op, encoding, value transform/scaling. *Executed* by an adapter. (Templated via a **device-type descriptor** — companion doc.)
- **Reducer** — how read sources combine: sum / mean / min / max / direct / **representative**.
- **Grouping dimension** — an attribute (e.g. phase) partitioning a route into per-group results.
- **Distribution** — how one control maps to targets: replicate / split / first-accepts.
- **Coverage** — which children a route accounts for (full or partial).
- **Constraint / limit** — a bound, valid set, interlock, or rate-limit on a capability/node/site that resolution must respect; static or derived.
- **Schedule / profile** — a time-indexed control payload (windows, setpoints over time) vs an instantaneous set.

---

## 7. Worked examples (cases → model)

- **A — AIO behind gateway:** `charge_rate.read = {gateway, direct}`; `charge_rate.control = [{aio, via gateway}(pref), {aio, via givenergy-cloud}(fallback)]`.
- **B — Switch over loads:** `circuit.power.read = {switch, direct}`; `load.on_off.control = {load1..N, replicate}`.
- **C — EMS + AC3s:** `plant.power.read = {ems, direct}`; `charge_rate.control = {ems, split}` *or* `{ac3_*, split}`.
- **D — Gateway + parallel AIOs:** `charge_rate.control = {gateway,…}`; `unit.soc.read = {aio_i, direct}`; `plant.soc.read = {aios, mean}`.
- **E — Zoned wet heating:** `flow_temp.read = {manifold, direct}`; `zone.demand.control = {zone_valve_i, replicate}`.
- **F — Partial aggregation:** `house_meter.power.read` coverage = {A,B,C}; circuit D has its own route.
- **G — Redundant grid voltage:** `grid.voltage.read = {ac_1..N, group_by: phase, reducer: representative}`; `grid.power.read = {ac_1..N, reducer: sum}`.
- **H — Multi-route control:** as A's control route — ranked `[gateway, givenergy-cloud]`.
- **I — Mixed vendors:** `givenergy_aio` (via our-gateway / GE-cloud) and `solis_inv` (via solis-cloud / local) coexist; same model, different providers/bindings.

---

## 8. Open questions (the model)

1. **Aggregation/grouping depth** — fixed reducer/distribution/grouping set, or expressions?
2. **Route-selection policy** — preference rules + when to fail over between access paths/providers; per-capability or global.
3. **Reachability vs capability** — representing "reachable but unreliable" so reads cache/fall back while control stays honest.
4. **Control ownership/conflict** — PredBat vs VPP (Axle) vs manual vs manufacturer cloud targeting the same capability; who wins, how contention resolves. *(The one deferred facet.)*
5. **Identity & re-parenting** — stable-identity keying so the graph changes without losing per-node knowledge.
6. **Versioning/evolution** — representing how a site's topology changes over time.
7. **Schedule execution** — declaring device-native schedules vs controller-stepped plans, and translating between them.
8. **Derived-limit refresh** — how dynamic constraints (headroom from SOC) are computed and kept current during resolution.

---

## 9. Success criteria (the model)

- Cases A–I (and new ones) are expressible **by describing them**, with **zero** new branches in topology/selection code.
- Any capability's **read** and **control** bind independently to different nodes/levels, and to **multiple ranked access paths** with automatic fallback.
- Redundant readings collapse to one-per-group; partial aggregation is explicit, never silently full.
- The topology is a **graph** with a derived tree view, so shared measurements and multiple control planes don't force ownership ambiguity.
- The concrete register/endpoint + scaling for every capability lives in **bindings as data** — so **no hardcoded register maps remain**.
- Scheduled controls (windows/profiles) and constraints (bounds/modes/interlocks/site-limits) are expressible.
- The model is **multi-provider** and domain-agnostic: the same constructs describe a GivEnergy battery, a Solis inverter, an OCPP charger, and a heating zone.
- Any **participant** (gateway, cloud, app) can self-identify, attach to, read, and contribute the shared model.
