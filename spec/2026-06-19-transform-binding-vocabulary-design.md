# Lattice — Transform & Binding Vocabulary (generic core + parameter references)

**Status:** Draft for discussion — 2026-06-19
**Targets:** schema **0.2.0**. Prototyped in the mutable `0.1.0/` draft, cut as a frozen `0.2.0/` once agreed. `0.1.0/` is the live pre-freeze draft, not a released version.
**Companions:** *Read Model — Shapes, Canonical Units, Aggregation & Derived Bindings* (defines canonical units + derived bindings; this doc pins the transform **vocabulary** those bindings draw from); *Control Model — Shapes + Vocabulary* (the control mirror); *Capability & Topology Model* (the model).

---

## 1. Problem

A binding's `transform` converts a device's native representation to/from a capability's canonical unit. Today (0.1.0) `transform` is `{ kind: string, num, den }`, and the schema explicitly says:

> *"'kind' values beyond the core set are vendor/adapter extensions (namespaced). Vendor-specificity is allowed HERE … never in capability names."*

That loophole has already leaked: the reference gateway producer hardcodes **vendor-named transform kinds** — `GE_RATE_HALF`, `GE_RATE_FULL`, `GE_CAPACITY` — as engine enum values. That breaks Lattice's core promise ("any consumer ingests with zero per-vendor code"): adding a new vendor means new enum values and new engine code, which is exactly what the model is meant to eliminate.

Two facts make this fixable cleanly:

1. The *example* kinds the 0.1.0 schema already lists (`identity, scale, negate_scale, ratio, hhmm`) are generic. The vendor names were never required by the spec — the gateway invented them.
2. The one thing that genuinely *felt* like it needed a vendor name — `GE_RATE_HALF` — is special only because it scales by a **runtime node value** (battery `capacity`), which `{num, den}` (literals) cannot express. That is an *expressiveness* gap, not a vendor-naming need.

## 2. Principle — OpenAPI alignment

OpenAPI does not let you *compose* a value format from primitives; it defines a **named `format` vocabulary** (`date-time`, `int64`, `uuid`, …) with spec-defined meanings, maintains a **Format Registry**, and allows **unregistered (extension) formats** for the long tail. Specificity lives in the schema's *parameters*, never in inventing a non-standard core format.

Lattice transforms adopt the same shape, with one rule that closes the loophole:

> **The core transform registry is a fixed set of GENERIC, parameterised kinds. Vendor-specificity lives only in a binding's *parameters* — or, as a last resort, in a *namespaced extension* kind (`x-<vendor>:…`). A vendor name MUST NOT appear as a core kind.**

This mirrors the model's existing rule for capability names (always universal); it extends the same discipline to transform kinds. "GivEnergy HR111 = 0–50 where 50 = capacity/2" is not a *kind* — it's the generic `ratio` kind with GivEnergy's *numbers* (and a reference to `capacity`) in the parameters.

## 3. The core transform registry

A small, fixed set of generic kinds. `0.2.0/` declares these normatively (name + parameter schema + raw↔engineering semantics). Each transform is invertible where a control binding needs the write direction.

| kind | params | engineering = f(raw) | notes |
|---|---|---|---|
| `identity` | — | `raw` | passthrough |
| `affine` | `scale`, `offset` (both **value-or-ref**, default scale=1, offset=0) | `raw * scale + offset` | the workhorse; `scale` may be a ref (§4) |
| `ratio` | `num`, `den` (value-or-ref) | `raw * num / den` | integer-friendly affine; back-compat with 0.1.0 `{num,den}` |
| `negate` | — | `-raw` | sign flip (compose with `affine` for negate+scale) |
| `clamp` | `min`, `max` (value-or-ref) | `min(max(raw, min), max)` | bounds may be refs (e.g. `max = rated_power`) |
| `hhmm` | — | passthrough HHMM time-of-day | |
| `pipeline` | `steps: [transform]` | left-to-right composition | for the rare 2-step case (e.g. `affine` then `clamp`) |

**Evaluation semantics (normative, pinned by `conformance/transform/`).** Each kind is evaluated in
two directions: `toEng(raw)` (read) per the table above, and `fromEng(eng)` (write) as the algebraic
inverse — `affine` ↔ `(eng−offset)/scale`, `ratio` ↔ `eng·den/num`, `negate`/`identity`/`hhmm`
self-inverse, `clamp` idempotent, `pipeline` reverse-order-and-invert. Division is sign-aware with
the transform's `round` mode (a transform carries one `round`, applied to both directions). A `ref`
that cannot resolve yields no value (`null`) on read; on write it yields `null` (fail-closed)
unless `onRefUnavailable: "max"` (emit the transform's `max`, fail-open). The `conformance/transform/`
corpus is the cross-language contract; the editor `transform-engine.ts` is the reference.

Encodings (`u16`, `i16`, `u32_hl`, `u16_vec`, …) stay a separate `binding.encoding` concern — decode-then-transform. No vendor encodings.

**Rounding.** The dividing kinds (`ratio`, `affine`) take an optional `round` mode — `trunc` (default: integer division toward zero, the existing behaviour), `half_up` (round half away from zero), or `half_even` (banker's). This is the piece that lets device registers which **round half-up** be expressed generically rather than as vendor kinds: GivEnergy's rate-cap registers round half-up because the firmware treats only the *exact* maximum as "unrestricted", so a truncated near-max value snaps back to the true rate. `round: half_up` reproduces that exactly. (Added in PR-T2.)

**Degradation / robustness.** Two more generic primitives let device-safety behaviour be expressed as data rather than engine code: an **input clamp** (a `pipeline` `clamp` step before the `ratio`, e.g. a 0–50 register guard so a garbage read can't report a nonsense rate), and **`onRefUnavailable`** (`zero` default = fail-closed; `max` = fail-open: emit the clamp `max` when a `ref` can't be resolved — e.g. write the *unrestricted* rate cap until battery capacity is known). Together with refs + `round`, these make even GivEnergy's `GE_RATE_HALF` (capacity-scaled, round-half-up, clamp-50, unrestricted-when-unknown) a pure generic expression — see §7. (Proven in `predbat-gateway` PR #193.)

> Deliberately *not* a general expression DSL. `pipeline` over a fixed kind set covers observed devices; a free-form formula language is the "derived binding" escape hatch (§5), kept narrow.

## 4. Parameter references (the real fix)

A param value is **either a literal or a reference** to a declared node value:

```json
{ "kind": "ratio", "num": { "ref": "capacity", "factor": 0.5 }, "den": 50 }
```

- **Declared node parameters.** A node declares the values its transforms may reference under a `parameters` block — at minimum `capacity` (Wh), `rated_power` (W), `nominal_voltage` (V). These are the node's own already-canonical capabilities/attributes; a transform ref resolves against them at execution time. (Aligns with the read-model doc's "transforms may reference node attributes.")
- **Resolution + ordering.** A referenced value must itself be resolvable from a non-referencing binding (no cycles); the adapter resolves refs before applying the transform. If a ref is unavailable at runtime (capacity not yet read), the binding yields *no value* rather than a wrong one — same fail-closed stance the gateway already takes.
- **`factor`.** A ref may carry a constant `factor` (`capacity × 0.5`) so the common "half-C" / fractional cases need no extra kind.

This is the single new capability versus 0.1.0, and it is what lets every vendor "rate" transform become generic.

## 5. Derived bindings (multi-input) — IMPLEMENTED

When a value is calculated from **more than one** input (`load = pv − battery − grid`; `usable = remaining × 100 / soc`), that's a *derived binding* — now `$defs/derived` on a capability offer (in place of a `read`): `op: "sum"` (Σ weight×input) or `op: "ratio"` (factor×num/den), referencing sibling capabilities by `class.function`. The resolver gathers the inputs' current values and evaluates. This doc's `affine`/`ratio`+ref covers the single-input parameterised case (and `Ah × nominal_voltage` via the `nominal_voltage` node param); `derived` covers genuine multi-input calculation. Deliberately **not** a general expression DSL — the narrow op set covers every observed read (n=4 vendor analysis). The **declared/derived vs estimated/learned** line holds: deterministic functions of declared inputs only — never consumer-side analytics (PredBat calibration, degradation). Conformance resolves input refs, rejects cycles, and forbids a `control` on a derived (computed) value.

## 6. Extension policy

- Core kinds (§3): generic, normative, the only kinds a conformant consumer must implement.
- Vendor/adapter long tail: a **namespaced** `x-<vendor>:<name>` kind, used **only** when a device's conversion cannot be expressed by the core kinds + refs. Discouraged; a consumer may reject unknown extension kinds. (Same status as OpenAPI custom formats.)
- The 0.1.0 schema wording **changes** from "vendor-specificity is allowed here" to: *core kinds are generic; vendor-specifics live in binding parameters, or as a namespaced extension kind of last resort.*

## 7. Worked proof — gateway `Transform::GE_*` → generic core (corrected)

**Final outcome (proven in `predbat-gateway` PR #193 — all 47 native topology tests green, zero behaviour change).** *Every* `GE_*` maps to the generic core — **no vendor transform kind, and no manufacturer code in the engine at all.** It took three generic primitives beyond the original `{num,den}`: parameter **refs** (§4), a **`round`** mode (§3), and two degradation/robustness primitives — an **input clamp** (raw guard, expressible as a `pipeline` `clamp` step) and **`onRefUnavailable: max`** (fail-open: emit the clamp max when a `ref` is unresolved, vs the default `zero`). With those, even the `GE_RATE_HALF` "unrestricted when capacity unknown" fail-safe is generic data, not engine code. The mapping is:

| Gateway transform | Generic core expression |
|---|---|
| `IDENTITY` | `{ kind: identity }` |
| `NEGATE_SCALE` (e.g. batt power) | `{ kind: negate }` (= `-raw·num/den`, num=den=1) |
| `HHMM` | `{ kind: hhmm }` |
| `GE_CAPACITY` (HR55: ×317 if "CH" else ×51.2) | `{ kind: ratio, num: <per-model literal>, den: <…> }` — the CH-vs-non-CH choice is **two device-type descriptors selected by serial fingerprint** (`GE-AIO` 317/1, `GE-AIO-LV` 512/10); the engine never sees a serial condition |
| `GE_RATE_FULL` (HR313/314: read raw×rated/100 trunc; write watts→% round-half-up, clamp 100) | read `{ kind: ratio, num: { ref: "rated_power" }, den: 100 }`; write `{ kind: ratio, num: 100, den: { ref: "rated_power" }, round: half_up }` + clamp 100 |
| `GE_RATE_HALF` (HR111/112: scale by battery half-capacity; round-half-up; clamp 50; **unrestricted (50) when capacity unknown**) | read `pipeline[ clamp(max:50), ratio(num: { ref: "capacity" }, den: 100) ]`; write `{ kind: ratio, num: 100, den: { ref: "capacity" }, round: half_up, onRefUnavailable: max }` + clamp 50 |

No `GE_` token, no `serial_is_ch`, no bespoke rate helpers survive in the engine. GivEnergy-ness is **entirely** the numbers, the refs, the round mode, the degradation policy, and the per-model descriptor selection — all data. This is the design goal realised: a handler that understands the spec with no per-manufacturer code.

## 8. Schema delta (0.2.0)

1. `transform.kind` → constrained to the core registry (§3) **or** a namespaced `x-*` extension; drop the "vendor-specificity allowed" note.
2. `transform` params become **value-or-ref** (`{ ref: "<param>", factor?: number }` | number). Add `offset`, `clamp` bounds, `pipeline.steps`. Keep `num`/`den` as `ratio` for back-compat.
3. Node gains a `parameters` block (`capacity`, `rated_power`, `nominal_voltage`, …) that refs resolve against.
4. Conformance: a producer is transform-conformant if every binding uses only core kinds (+ resolvable refs); use of `x-*` kinds is reported, not silently accepted.

## 9. Scope

**In:** the transform vocabulary (core registry), parameter references, extension policy, schema delta, the `GE_*`→generic proof.
**Out:** control shapes/vocabulary (control-model doc); multi-input derived-binding expression grammar + evaluator (read-model doc); canonical-unit list per capability (read-model doc + vocabulary); the **gateway engine refit** to drop the `Transform::GE_*` enums in favour of the generic kinds (a downstream implementation task, not this spec doc).
