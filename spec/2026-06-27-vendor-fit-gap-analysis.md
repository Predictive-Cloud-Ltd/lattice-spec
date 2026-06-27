# Lattice — Vendor-Fit Gap Analysis (n=4 real families)

**Status:** Findings — 2026-06-27
**Method:** Modelled four structurally-different battery-control families against the `0.1.0` schema, grounded in the real driver code (not memory): Fox (`batpred/apps/predbat/fox.py`), Solax (`solax.py`), Solis (`solis.py` + gateway `driver_solis.cpp`), and the Modbus voltage-rate drivers (`driver_sofar/deye/alphaess/growatt.cpp` + `rate_convert.h`). Purpose: turn "is the model generic?" from assertion into evidence, and find the next constructs.

This is the second-implementer stress test the model needed (everything prior was GivEnergy + a synthetic example). The headline: **the model holds structurally; the gaps are well-shaped, clustered, and additive** — none invalidate the design.

---

## 1. What held up (no change needed)

- **Per-access-path divergence + ranked fallback.** Every family has a local (Modbus) path *and* a cloud path; the same capability as separate `(capability, accessPath)` offers, each with its own binding/shape/tier, handles it cleanly. The model's strongest validated idea.
- **Transform vocabulary.** Covers every rate conversion seen: voltage-based (Sofar/Deye — `nominal_voltage` param), percent-of-rated (Growatt — `ref rated_power`), GivEnergy's quirks. The new `{source}` param even covers a *live* voltage if a vendor scaled by a runtime reading.
- **`readModifyWrite`, conformance tiers (L1/L2), `u32_hl`/vector encodings, descriptor-by-firmware** (Fox scheduler-vs-legacy, Solis V1-vs-V2 are just fingerprint `fw` ranges), **capability absence** (AlphaESS has no rate register → simply not offered). All fit.

## 2. The vendor shapes (evidence)

- **Fox** — control is a whole **schedule object** (`groups[]`) written as a unit, **read-modify-write** (read current, diff, write if changed), plus independent flat settings. Slot fields: `enable, start/end (inclusive-minute), workMode, maxSoc (charge target), fdSoc (discharge floor), fdPwr (force power), minSocOnGrid (reserve)`. Constraints `fdpwr_max`/`fdsoc_min` are **read from the device** and used to clamp writes. Identity: `deviceSN` (field named `sn` for settings, `deviceSN` for scheduler). Derived reads: `battery_flow = discharge − charge`; capacity = Σ cell capacities.
- **Solax** — **two coupled calls**: `set_work_mode(minSoc, chargeUpperSoc, chargeFromGridEnable, charge/discharge windows)` and `soc_target_control_mode(targetSoc, chargeDischargPower)` — `chargeDischargPower` is **one signed field for both charge and discharge**. Base mode + VPP override (two layers). Identity: **`plant_id` (reads) vs `snList` (control)** — distinct. Derived reads: `load = pv − battery − grid`; `battery_size_max = remaining×100/soc`.
- **Solis** — cloud CID-per-field (every write requires the **prior value** `yuanzhi`), and a storage-mode register (**CID 636 / `FORCE_MODE`**) that is a **bitmask**: self-use, TOU, allow-grid-charge, backup, feed-in… each a bit; named modes are bit combinations; writes are RMW preserving other bits. Schedules: V1 = whole plan packed into **one delimited string CID**; V2 = independent CIDs per slot. Derived reads: `load = pv − grid − battery`; capacity = `Ah × nominal_voltage`.
- **Modbus voltage-rate (Sofar/Deye/AlphaESS/Growatt)** — rate via fixed `nominal_voltage` (Sofar centi-amps, Deye amps), or percent-of-rated (Growatt, hard-fail if rated unknown). Mode/enable is a **different multi-register macro per vendor** (Growatt charge-enable = 3 registers; Deye = PROGRAM1/2; AlphaESS = shared flag, disable by zeroing windows). Derived reads everywhere (`load = pv − grid − battery`).

## 3. Gaps (what doesn't fit)

| # | Gap | Forced by | Status |
|---|-----|-----------|--------|
| 1 | **Schedule slot payload** unschematized (needs ≥2 SoC fields, per-slot enable, default-fill, inclusive-minute) | Fox `groups[]`, GE slots | open (was deferred) |
| 2 | **Coupled-binding field map** — which capability → which payload field (+ per-member transform, e.g. signed shared field) | Solax `soc_target_control_mode` | **ADDRESSED here** (`groupSlot.field`) |
| 3 | **Bit-field binding** — multiple capabilities own bit-ranges of one register, RMW | Solis CID 636 | **ADDRESSED here** (`groupSlot.bits`) |
| 4 | **One capability → many fixed writes** ("write macro") | Growatt/Deye/Sofar enable | open (or accept as L2) |
| 5 | **Cross-producer identity correlation** (plant-id vs serial) | Solax, Solis | open (flagged in #3 issue) |
| 6 | **Multi-input derived reads** (`load = pv − batt − grid`, etc.) | all | open (read-model doc) |
| 7 | **Runtime-sourced constraints** (clamp bound read from device) | Fox `fdpwr_max`/`fdsoc_min` | open (reuse `{source}` for constraint bounds) |
| 8 | **Encoding variants** (inclusive minute; whole-schedule-as-string) | Fox, Solis V1 | open (binding encoding layer) |

## 4. The honest meta-finding

The biggest signal isn't any single gap — it's **how much real battery control is L2 (provider code)**: Solax's base-mode-plus-override, every vendor's bespoke enable-register macro, Fox's legacy path. **L1 (declarative) is strong for reads and simple setpoints; L2 carries most real mode/schedule/coupled control.** The declarative core is real and valuable, but the *interesting* control is provider-implemented behind tiered bindings, not eliminated. Claims should say so: "consumers resolve conformant documents with no per-vendor planner logic; L1 executes declaratively; L2 provider execution is declared and isolated."

## 5. What this change adds — `groupSlot` (gaps #2 + #3)

A `controlGroup`'s members execute as one operation (one shared binding — already enforced). `groupSlot` now says **where each member's value goes** in that operation:

- **`groupSlot.field`** — a named payload field (Solax: `battery.target_soc → "targetSoc"`, `battery.charge_power_limit → "chargeDischargPower"`).
- **`groupSlot.bits` `{ lsb, width }`** — a bit-range of the shared register, written RMW preserving other bits (Solis CID 636: `battery.mode → bits[0..1]`, `x-solis:allow_grid_charge → bits[5]`).

The member's own `control.transform` still applies (e.g. negate a discharge value into a shared signed field). Conformance enforces: every member of a ≥2-member group declares a `groupSlot`; no two members share a `field`; no two members' `bits` overlap. The editor's resolve panel lists the gathered members and where each value lands. Worked example: `INV-0001` `cloud_plan` (Solax-style); the Solis bit-field is covered by schema + conformance tests.

## 6. Roadmap for the remaining gaps (priority order)

1. **Schedule slot schema (#1)** — highest value next; battery control is *primarily* schedules. Define `scheduleSlot` (`{start, end, mode, target_soc?, reserve_soc?, charge_power_limit?, discharge_power_limit?, enable?}`) + a default mode; an `encoding` note for inclusive-minute / packed-string variants (#8).
2. **Multi-input derived reads (#6)** — finish the read-model doc's derived-binding grammar (tiny safe evaluator over declared capabilities).
3. **Runtime-sourced constraints (#7)** — let `constraints.min`/`max` be `{ source: capability }` (reuse the `paramValue` mechanism — cheap).
4. **Identity correlation (#5)** — a node `aliases`/identity-map so a cloud `plant_id`+`sn` and a local `serial` merge to one node.
5. **Write-macro (#4)** — decide: a declarative multi-write construct, or formally accept the per-vendor enable macro as L2. Lower urgency (L2 already covers it).
