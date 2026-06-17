# Prior-Art Positioning & Gap Analysis — Design

**Status:** Draft (brainstorm) — 2026-06-17. *Verified against public sources (June 2026); re-check specifics before any external publication.*
**Authors:** Mark Gascoyne, with Claude
**Purpose:** Decide whether the topology/capability standard should **align/extend** existing standards or be **greenfield** — by honestly mapping it against the incumbents. A new energy/IoT standard that ignores prior art won't be recognised; this defines the defensible niche and the alignment path.

---

## 1. Headline finding

**Eclipse Sparkplug B already does, almost exactly, our data plane.** Its node/device **birth certificate (N/DBIRTH)** declares every metric a device offers — name, datatype, value, timestamp, and **properties including engineering units and range limits** — and assigns each an **integer alias**; subsequent **DATA messages reference metrics by alias** in compact protobuf over MQTT, *report-by-exception*. That is precisely our "the doc assigns a `cap_ref`; telemetry carries `(cap_ref, value)`" design. We independently reconverged on a proven, widely-adopted Eclipse standard.

**Implication:** our **data plane should align with / profile Sparkplug B** rather than invent a parallel format — instant credibility, existing tooling, an obvious foundation home. Our novel contribution is the **description layer above it** (the graph + routing), which Sparkplug does *not* have.

## 2. The landscape

| Standard | Layer it owns | Has a topology **graph**? | **Capabilities + concrete bindings**? | **read ≠ control** routing? | **ranked multi-access-path** / provider fallback? | Scale |
|---|---|---|---|---|---|---|
| **W3C WoT Thing Description** | per-Thing affordances + protocol bindings (Forms) | links to related Things only | **yes** (Properties/Actions/Events + Forms, multi-protocol) | no (affordance = its own endpoint) | no (Forms list, not ranked fallback) | device |
| **Eclipse Sparkplug B** | MQTT data plane (birth-cert + aliased protobuf) | no (flat metrics) | metrics w/ units+ranges; no control binding model | no | no | device/line |
| **SAREF (4ENER/4SYST/4CITY)** | semantic ontology (RDF/OWL) | 4SYST = systems+interconnections; 4CITY topology | functions/commands/measurements (semantic, not protocol) | no | no | device→city |
| **IEC CIM (61970/61968)** | grid/utility asset+network model | **yes** (connectivity, grid-scale) | grid assets, not device control bindings | n/a | no | grid/city |
| **Brick / Haystack** | building equipment + points (RDF / tags) | **yes** (building graph) | points/telemetry; weak on control bindings | no | no | building |
| **FIWARE NGSI-LD** | smart-city context graph (entities/rels) | **yes** (generic) | generic properties; not energy/control specific | no | no | city |
| **DTDL (Azure Digital Twins)** | twin interfaces (telemetry/property/command/relationship/component) | yes (relationships/components) | yes (vendor-leaning, JSON-LD) | no | no | device→site |
| **IEEE 2030.5 / OpenADR** | grid-facing DER control / demand response | no (function sets) | DER control functions | n/a | no | grid↔site |
| **Matter / Matter-Energy** | consumer device interop (clusters/attrs/cmds) | no | yes (clusters ≈ capabilities) | no | no | home device |
| **SunSpec / OCPP** | device register/protocol models | no | the *raw* register/protocol our bindings target | n/a | no | device |
| **THIS standard** | **site/grid topology + capability orchestration** | **yes (typed, scale-free)** | **yes (domain-agnostic + concrete bindings)** | **yes** | **yes** | **cell → city** |

## 3. Closest neighbours, by layer

- **Description / affordances → W3C WoT Thing Description (closest).** Properties/Actions/Events + Forms (multi-protocol bindings per Thing) map cleanly onto our capabilities + bindings, and TD's architecture already names Thing-to-Gateway/Cloud/federation patterns. What it lacks: a first-class **topology graph**, **read-route ≠ control-route**, **ranked access-path fallback**, and **scale-free aggregation**. → *Reuse its affordance + Forms model; add the graph/routing above it.*
- **Data plane → Eclipse Sparkplug B (near-identical).** Birth-cert-defines-metrics-with-aliases-units-ranges + aliased protobuf over MQTT = our `cap_ref` codec. → *Profile/align rather than reinvent.*
- **Semantic vocabulary → SAREF (4ENER/4SYST/4CITY).** RDF ontology for device functions/commands/measurements; 4SYST already models systems + interconnections, 4CITY adds topology. Heavier (semantic web). → *Map our capability names to SAREF concepts for semantic interop; don't adopt RDF as the core format.*
- **City/grid scale → IEC CIM + NGSI-LD; grid-facing control → IEEE 2030.5 / OpenADR.** These are complementary, not competitors: they're the grid↔site control wire and the utility asset model. Our site doc *feeds* a VPP that speaks 2030.5/OpenADR. (Note: EPRI + Kraken/Octopus are actively pushing DER interop here — an adoption channel, since Octopus is already an integration.)
- **Buildings / twins / home → Brick/Haystack, DTDL, Matter.** Adjacent graphs/affordances in neighbouring domains; sources of vocabulary and proof the graph approach is accepted.

## 4. The gap (our defensible niche)

No incumbent unifies all of:
1. a **vendor-neutral, scale-free topology graph** (cell → device → site → district → city) with typed relationships,
2. **domain-agnostic capabilities** with **concrete, data-driven bindings**,
3. **read-route ≠ control-route** resolving independently over the graph,
4. **ranked multi-access-path / multi-provider** with fallback (gateway *or* cloud),
5. **device-type descriptors that double as discovery fingerprints + binding templates**,
6. an **OpenAPI-style published doc** any consumer ingests generically.

WoT-TD has (2) per-Thing; Sparkplug has the data plane; SAREF/CIM/Brick/NGSI-LD have graphs in single domains. **The orchestration layer — (1)+(3)+(4)+(5)+(6) across vendors and scales — is unclaimed.** That is the contribution.

## 5. Recommendation — **hybrid: "compose, don't reinvent"**

- **Align the data plane to Eclipse Sparkplug B** — `cap_ref` ≈ Sparkplug alias; our topology doc ≈ an enriched birth certificate; reuse its protobuf/MQTT + report-by-exception. (Possibly publish our data plane as a Sparkplug profile/extension.)
- **Model capabilities on W3C WoT Thing Description** affordances + Forms; our per-node capability set is essentially a TD, and the new layer is the graph + routing connecting many TDs.
- **Map vocabulary to SAREF** (4ENER/4SYST/4CITY) for semantic interop; **map city/grid scale to IEC CIM / NGSI-LD**; treat **IEEE 2030.5 / OpenADR** as the grid-facing layer we feed.
- **Define as genuinely new** only the orchestration layer (§4 items 1,3,4,5,6).

This maximises credibility and adoption (ride proven standards' tooling + communities) while staking a clear, defensible novelty — and it names the natural **home**: the **Eclipse Foundation** (where Sparkplug lives) and/or **LF Energy**, with **W3C WoT** and **ETSI SAREF** as alignment liaisons.

## 6. Concrete implications

- **Rename / neutral identity** (vendor-neutral name + canonical URL; the schema `$id` should not be `predbat.com`).
- **Data-plane spec** should add a normative "Relationship to Sparkplug B" section and, ideally, a Sparkplug-compatible binding.
- **Doc-format spec** should add "Relationship to WoT Thing Description" (capability/binding ↔ affordance/Form mapping).
- **Positioning one-liner:** *"WoT Thing Descriptions describe one device; Sparkplug moves its data; this standard is the vendor-neutral, scale-free graph that composes many of them — with independent read/control routing and access-path fallback — from a single cell to a whole city."*

## 7. Open / to verify before external publication

- Exact extent of WoT-TD 2.0's `links`/composition (could it host more of the graph than assumed?).
- Whether to formally pursue a **Sparkplug profile** vs an independent (Sparkplug-aligned) data plane.
- SAREF mapping depth (full ontology alignment vs a lightweight crosswalk).
- Licensing/IPR posture required by each candidate home (Eclipse EFSP, LF, W3C, ETSI differ).

## Sources

- W3C WoT Thing Description 1.1 — https://www.w3.org/TR/wot-thing-description11/ ; Architecture 1.1 — https://w3c.github.io/wot-architecture/ ; Binding Templates — https://w3c.github.io/wot-binding-templates/
- Eclipse Sparkplug 3.0 specification — https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf ; project — https://github.com/eclipse-sparkplug/sparkplug
- ETSI SAREF — https://saref.etsi.org/ ; SAREF4ENER — https://saref.etsi.org/saref4ener/v2.1.1/ ; SAREF4SYST — https://saref.etsi.org/saref4syst/v1.1.2/
- EPRI/Kraken DER interoperability (VPP) — https://www.utilitydive.com/news/epri-kraken-advance-der-interoperability-standards-to-boost-virtual-power-plants/731437/
- IEC 61850-7-420 / IEEE 2030.5 / OpenADR — DER interoperability (see Sandia DER security report) — https://www.sandia.gov/app/uploads/sites/273/2025/02/Design-and-Implementation-of-a-Secure.pdf
