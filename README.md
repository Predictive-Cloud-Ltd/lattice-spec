# Lattice

**An open standard for describing device topology & capability — "OpenAPI for energy devices."**

[![spec](https://img.shields.io/badge/spec-v0.1%20draft-blue)](spec/) [![licence](https://img.shields.io/badge/licence-CC--BY--4.0%20%2F%20Apache--2.0-green)](LICENSE.md)

> **Status:** Draft v0.1 (pre-release). Canonical home: **https://lattice-spec.org**. The name *Lattice* is provisional pending a trademark check. Incubated within [PredBat](https://predbat.com); intended for donation to a neutral foundation (LF Energy / Eclipse Foundation) once external adopters exist.

## What it is

A vendor-neutral, machine-readable way to describe a site's devices — what's there, how it's wired together, what each can measure or do, and concretely how to read/control it — as a published **document** any consumer ingests with **zero per-vendor controller-planning code** (for conformant L1 reads/controls; per-protocol adapters and tier-2 execution still exist). The same model is **scale-free**: it describes a single battery cell, a home, a building, or an entire city.

Just as a web API ships an `openapi.json` and any client talks to it without bespoke code, a device (or a vendor's cloud) publishes a **Lattice document** and any consumer can read and control it.

## One model, layered

- **Topology** — a graph of nodes connected by typed, directed relationships (`contains` / `measures` / `controls` / `powers`).
- **Capabilities** — domain-agnostic read/control affordances (`battery.soc`, `battery.charge_power_limit`, `thermal.temperature`, …). Telemetry and control are the read-face and control-face of one capability.
- **Bindings** — the concrete "how" (protocol / address / encoding / scaling), reachable via one or more **ranked access paths** with fallback (local gateway *or* manufacturer cloud).
- **Data plane** — protobuf telemetry + high-level control intents over MQTT, *typed by* the document (a `cap_ref` codec; aligns with Eclipse Sparkplug B).

## Normative artifacts (v0.1.0)

- **Meta-schema** (JSON Schema 2020-12): [`0.1.0/topology-capability-doc.schema.json`](0.1.0/topology-capability-doc.schema.json) — canonical `$id`: `https://lattice-spec.org/0.1.0/topology-capability-doc.schema.json`
- **Data plane** (protobuf): [`0.1.0/topology-data-plane.proto`](0.1.0/topology-data-plane.proto)
- **Worked example** (vendor-neutral; validates against the schema): [`0.1.0/examples/example-site.topology.json`](0.1.0/examples/example-site.topology.json)
- **Conformance corpora** (language-neutral golden tests): [`conformance/merge/`](conformance/merge/) and [`conformance/resolve/`](conformance/resolve/)

## Implementing

New to Lattice or porting it to another language/runtime? See **[`IMPLEMENTING.md`](IMPLEMENTING.md)** — the adopter's guide: the core model, a minimum implementation profile, the merge/controller rules, and a self-certification checklist backed by the conformance corpora.

## Specification (drafts)

See [`spec/`](spec/): the model, how a document is built (discovery/descriptors/merge), how a consumer uses it, the document format, the MQTT data plane, and prior-art positioning.

## Editor

A live editor + validator (Swagger-Editor style) is planned at **editor.lattice-spec.org** — paste a Lattice document, validate against the schema, and visualise the topology graph.

## Positioning

Lattice **composes** with existing standards rather than reinventing them: the data plane aligns with **Eclipse Sparkplug B**, capabilities map to **W3C WoT Thing Description**, vocabulary to **ETSI SAREF**, city/grid scale to **IEC CIM / NGSI-LD**, and it feeds grid-facing control (**IEEE 2030.5 / OpenADR**). Its novel contribution is the cross-vendor, scale-free orchestration graph with independent read/control routing and access-path fallback. See [`spec/2026-06-17-prior-art-positioning-design.md`](spec/2026-06-17-prior-art-positioning-design.md).

## Licence

Open and royalty-free. Specification text under **CC-BY-4.0**; schema, `.proto`, examples and reference code under **Apache-2.0**. See [`LICENSE.md`](LICENSE.md).

## Governance & contributing

Open, vendor-neutral, RFC-based — see [`GOVERNANCE.md`](GOVERNANCE.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). By participating you agree to the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
