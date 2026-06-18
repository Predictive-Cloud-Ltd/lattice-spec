# Topology & Capability Document Format — Design

**Standard:** **Lattice** (provisional name — see [`standard/README.md`](../README.md)). A Lattice document is an instance of this format.
**Status:** Draft (brainstorm) — 2026-06-17
**Authors:** Mark Gascoyne, with Claude
**Companions:** the model (`2026-06-17-capability-topology-model-design.md`), discovery/composition (`…-topology-discovery-composition-design.md`), and PredBat projection (`…-predbat-integration-projection-design.md`). **This** doc defines the **publishable document format** — the OpenAPI-style artifact that makes the model machine-emittable and validatable.

**Normative artifacts:**
- **Meta-schema:** [`../0.1.0/topology-capability-doc.schema.json`](../0.1.0/topology-capability-doc.schema.json) — JSON Schema (draft 2020-12) defining a *valid* doc.
- **Worked example:** [`../0.1.0/examples/example-site.topology.json`](../0.1.0/examples/example-site.topology.json) — a vendor-neutral home site (validates against the meta-schema).

---

## 1. What this is

"**OpenAPI for device topology & control.**" A provider — a cloud integration or the gateway — publishes a single conformant document describing its slice of a site: the nodes, the capabilities each offers, the concrete bindings, and the access paths it serves them on. Any consumer (PredBat today; anyone tomorrow) ingests *any* conformant doc generically — **no per-provider code**. Onboarding a provider becomes "they output a doc — done," exactly as adding an API client becomes "point it at the `openapi.json`."

The meta-schema is the keystone: a vendor validates their doc against it; the gateway's descriptor engine emits docs that conform; PredBat ingests docs that conform. One format, three users.

## 2. Document shape (summary — schema is normative)

```
{
  topologyVersion: "0.1.0",        // spec semver
  id, scope: "fragment" | "site",  // fragment = one producer's slice (merged by identity)
  producer: { name, provider },
  deviceTypes: [ { key, fingerprint, capabilities, aggregate } ],   // reusable templates ($ref equiv)
  nodes: [ {
    id,                            // stable identity = the MERGE KEY across producers
    kind,                          // domain-agnostic class (battery/inverter/gateway/ems/heat_pump/structural/…)
    deviceType?, attributes?,      // attributes incl. phase, ratedW, capacityWh, geo
    accessPaths: [ { id, provider, locality, transport, preference } ],
    aggregate?: { serves, minChildren, priority, over },             // data-driven primary selection
    capabilities: [ {
      capability,                  // domain-agnostic name (no vendor terms)
      accessPath,                  // which access path serves this offer
      read?:    { protocol, address, op, encoding, transform, count },   // concrete binding
      control?: { … },
      reducer?, groupBy?, distribution?, constraints?, schedule?
    } ]
  } ],
  relationships: [ { from, to, type } ]   // directed: contains / measures / controls / powers
}
```

## 3. Key rules

- **Identity is the merge key.** The same `node.id` from two producers is **one** node carrying both their access paths — that's how "control via gateway *or* cloud, with fallback" arises (the worked example shows it on the AIO's `charge_rate`).
- **Multiple offers per capability = ranked alternatives.** Repeat a `capabilityOffer` for the same capability, one per `accessPath`; the consumer orders them by `accessPath.preference` and fails over.
- **Vendor-specificity lives only in `deviceType` keys, `binding`s and `transform`s** — never in `capability`/`kind` names. A capability that names a vendor or device is non-conformant.
- **Scale-free.** The same constructs describe a cell, a device, a site, or a city; a `structural` node aggregates (a plant, a district, a city). City scale just merges more fragments at a higher scope.
- **Schema + semantic conformance.** JSON Schema validates document shape; the conformance harness also checks cross-reference invariants such as relationship endpoints, `accessPath` references, and `cap_ref` uniqueness.

## 4. Versioning & extensibility

- **`topologyVersion`** is semver of *this spec*. Consumers accept any doc whose major matches.
- **Namespaced extensions.** New `capability`/`kind`/`transform`/`encoding` values that aren't in the core set use a prefix (`x-acme:…`). Core names are governed; extensions are free. This keeps interop while letting vendors innovate.
- **Device-type descriptors are versioned templates** keyed by (make, model, firmware) — a firmware change is a new descriptor, not a per-node rewrite — and are themselves distributable (flash/OTA/cloud, per the discovery doc).

## 5. Conformance profiles

A consumer/producer declares which profile it supports:
- **L1 — Read:** nodes + read bindings + relationships. (Telemetry only.)
- **L2 — Control:** adds control bindings, constraints, distribution.
- **L3 — Aggregation & federation:** adds `aggregate`, multi-access-path ranking, and cross-fragment merge by identity (the city/VPP scale).

## 6. Publishing & discovery (sketch — see discovery doc)

A provider serves its doc at a known location (e.g. a well-known URL or an MQTT topic for the gateway). The consumer fetches each producer's fragment and merges them. *Exact* publish/transport mechanics are the discovery/composition doc's concern.

## 7. Prior art to position against (open)

To be a credible *open* standard it must map to, not reinvent, the neighbours: **W3C WoT Thing Description** (closest — affordances/forms ≈ capabilities/bindings), **SAREF / SAREF4ENER / SAREF4CITY** (ETSI device+city ontology), **IEC CIM** (grid/utility, city scale), **Brick** / **Project Haystack** (buildings), **FIWARE NGSI-LD** (smart cities), **DTDL**, **SunSpec / IEC 61850 / OCPP** (device level). The differentiator to defend: a unified **read-route ≠ control-route over a graph, with ranked access-paths and data-driven fingerprint+bindings, scale-free from cell to city**. A prior-art gap analysis (align-vs-greenfield) is a pending task.

## 8. Non-goals (here)

- Governance/RFC process for the standard (separate track).
- The descriptor-engine implementation (the gateway plan).
- Transport/auth specifics of publishing.
