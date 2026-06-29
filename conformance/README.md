# Lattice conformance corpus

Language-neutral golden fixtures that pin **resolution behaviour** — how a consumer turns
a query (`capability` + `side`) against a Lattice document into a concrete plan (which node,
which access path, which binding, clamped how, delegated to whom).

The spec prose says *what* a resolver must do. This corpus says it *exactly*, as data, so the
independent reference implementations — the editor's TypeScript resolver, the gateway's C++
descriptor engine, batpred's Python projection — can each be proven to produce **identical**
results. "Similar implementation" only means "interoperable" if it's pinned to the same bytes.

## Layout

```
conformance/
  resolve/
    cases.json      # inputs: an array of { name, query, doc }
    expected.json   # golden outputs: { [case.name]: <observable result> }
  README.md         # this file
```

## The case format (`resolve/cases.json`)

An array of objects:

```jsonc
{
  "name": "control: setpoint clamps an over-range intent to max",  // unique key into expected.json
  "query": {
    "capability": "battery.charge_power_limit",  // class.function capability identity
    "side": "control",                            // "read" | "control"
    "intent": 9000,                               // control only: the value the caller wants to set
    "offline": ["gw-local"],                      // optional: access-path ids treated as unreachable
    "altitude": "auto"                            // optional: "auto" | "aggregate" | "leaves" (default "auto")
  },
  "doc": { /* a complete, schema-valid Lattice document */ }
}
```

Each case carries its **own** self-contained document — small, hand-authored to isolate one
behaviour. The corpus is the union of those behaviours, not a single big topology.

## The observable result (`resolve/expected.json`)

The value pinned per case is the **JSON-serialisable projection** of the resolver result — the
subset of fields a conformant resolver must agree on. Keys whose value is `undefined` are absent
(standard JSON). The full field set and meaning:

| Field | When | Meaning |
|-------|------|---------|
| `ok` | always | resolution succeeded |
| `side` | always | `read` or `control`, echoing the query |
| `node` | always | id of the node the command/read targets |
| `nodeKind` | always | that node's `kind` |
| `chosenAccessPath` | reads + direct control | the access-path id selected (highest preference, online) |
| `fellBack` | reads + direct control | true if the preferred (highest-preference) path was offline and a lower one was used |
| `reducer` | aggregate reads | how sibling values combine (e.g. `sum`) |
| `routeNodeCount` | always | number of nodes in the chosen route |
| `strategy` | control | `direct` (act on the node) or `delegated` (an aggregate coordinator acts for its children) |
| `planNodes` | control | the nodes actually commanded |
| `distribution` | delegated control | how the coordinator spreads the intent (e.g. `replicate`) |
| `ownedNodes` | always | the physical nodes whose state this resolution governs |
| `ownershipNote` | sometimes | human note when ownership is non-obvious |
| `unit` | always | the capability's unit |
| `shape` | control | `setpoint` \| `switch` \| `schedule` |
| `tier` | control | conformance tier of the binding (1 = declarative, 2 = provider code) |
| `controlGroup` | grouped control | the coupled-binding group id |
| `groupMembers` | grouped control | the other capabilities written by the same atomic command |
| `derived` | derived reads | the computed expression (e.g. `sum(pv.power + -1×meter.grid_power + …)`) |
| `clamped` | control setpoint | the intent after clamping to constraints |
| `clampMin` / `clampMaxLabel` | control setpoint | the resolved bounds (`clampMaxLabel` shows the source, e.g. `rated = 5000`) |
| `binding` | reads + direct control | the concrete `{protocol, op?, address, transform?, readModifyWrite?}` |
| `intent` | control | the value the caller requested, echoed |
| `message` | failures | why resolution could not produce a plan |

## Reference implementation (TypeScript, editor)

The editor's `src/resolve-engine.ts` is the executable spec. Its runner lives in
`editor/scripts/`:

```bash
cd editor
npm run build:ref        # tsc-compile resolve-engine.ts → scripts/.gen/ (gitignored)
npm run test:resolve     # assert runCase(case) deepEquals expected[case.name]
npm run resolve:record   # regenerate expected.json from the reference resolver
```

`npm test` runs schema conformance, the unit suite, **and** this corpus.

### Mapping a case to a `resolve()` call

```js
resolve(doc, query.capability, query.side, query.intent,
        new Set(query.offline ?? []), query.altitude ?? "auto")
```

Then project the result to the field set above and JSON-normalise (round-trip through
`JSON.stringify`/`parse`) so undefined-valued keys drop out — that normalised object is what
the golden stores and what every language compares against.

## Adopting the corpus in another language (C++ gateway, Python batpred)

1. Read `resolve/cases.json`.
2. For each case, run your resolver over `case.doc` with `case.query`.
3. Project your result down to the field set above (omit fields you don't yet implement —
   but a field you *do* emit must match).
4. Serialise to canonical JSON (drop undefined/absent keys; stable key order is not required
   for a structural compare, only for a textual diff).
5. Assert structural equality against `expected[case.name]`.

A divergence is either a bug in that implementation or a deliberate behaviour change — in which
case update `cases.json`/regenerate `expected.json` in the **same** change across all runners,
and review the diff. The golden is the contract; it should never drift silently.

## merge/ — overlay/merge conformance

Pins the **export + overlay/merge contract**: how producer fragments and upstream overlays compose
into one `site` document. The reference is the editor's `src/merge-engine.ts` (`merge(docs) -> {site, warnings}`),
a pure, identity-keyed, authority-ranked function (see `spec/2026-06-28-export-overlay-merge.md`).

### Case format (`merge/cases.json`)

```jsonc
{ "name": "unique key into expected.json",
  "inputs": [ /* an ordered list of schema-valid docs (fragments/overlays), each with producer.authority */ ] }
```

### Observable result (`merge/expected.json`)

Per case, the JSON-normalised `{ site, warnings }`:
- `site` — the merged `scope:"site"` document (nodes, relationships, minted `ref`s, top-level identity from the highest-authority input).
- `warnings` — non-fatal notes (equal-precedence scalar conflicts, dropped dangling relationships).

> **`docVersion` is normalized out of the cross-language comparison.** The merged `site.docVersion` is a content digest; its exact value is implementation-defined (each language mints its own deterministic, content-derived value). The corpus golden and every runner therefore delete `site.docVersion` before comparing. The "`docVersion` is a positive integer that changes with content" property is pinned by an **in-language** unit test, not by this corpus. (`producer.inputs[].docVersion`, which echoes each input's version, IS pinned.)

### Running / adopting

```bash
cd editor
npm run build:ref      # compile resolve-engine.ts + merge-engine.ts → scripts/.gen/
npm run test:merge     # engine unit tests + corpus deepEqual against expected.json
npm run merge:record   # regenerate expected.json after an intentional behaviour change
```

Another language adopts the corpus exactly like `resolve/`: read `cases.json`, run its `merge`,
JSON-normalise `{site, warnings}`, assert structural equality against `expected[case.name]`. A divergence
is a bug or a deliberate change — in the latter case update across all runners and review the diff.

## Regenerating the golden

`npm run resolve:record` rewrites `resolve/expected.json` from the TypeScript reference. Run it only
after an **intentional** behaviour change, then review the diff — an unexpected line in that
diff is a regression caught early.

Likewise, `npm run merge:record` regenerates `merge/expected.json` from the reference merge engine.

## Scope (today)

`resolve/` covers read routing (single offer, ranked access-path fallback, derived sibling
reads) and control routing (setpoint clamping against static and runtime-sourced bounds,
aggregate delegation, divergent-per-access-path selection). It does **not** yet pin transform
*evaluation* (engineering↔raw value math, rounding, ref resolution) — that lives in the
gateway's `test_topology_*` parity tests and is the natural next corpus to lift here once a
second language needs it.
