# Contributing to Lattice

Thanks for helping build an open standard. Lattice is vendor-neutral and royalty-free; contributions are welcome from anyone.

## How to propose a change

1. **Open an issue** describing the problem or gap (a use case the standard can't express, an ambiguity, a bug in the schema/example).
2. For **normative** changes (anything that affects what a conformant document or data-plane message looks like), write a short **RFC** in the issue:
   - **Motivation** — the real use case / device / topology that needs it.
   - **Proposal** — the change to the model, schema, or `.proto`.
   - **Compatibility** — is it additive (minor) or breaking (major)?
   - **Prior art** — how do Sparkplug B / WoT-TD / SAREF / CIM handle it (align, don't reinvent)?
3. Discuss; once there's maintainer consensus, open a **PR** with the spec/schema/example changes.

Editorial changes (typos, clarifications, examples) can go straight to a PR.

## Invariants reviewers will enforce

- **Capability and node-kind names are domain-agnostic.** No vendor or device terms (`AIO_*`, `GE_*`, …). Vendor specifics belong only in `deviceType` keys, `binding`s, and `transform`s. *A capability name that names a vendor or device fails review.*
- **The example must validate** against the meta-schema. Add/extend an example for any new construct.
- **Bindings carry the concrete "how" as data** (protocol/address/encoding/transform) — never as code branches.
- **Compose, don't reinvent.** New capabilities/transports should map to an existing standard where one exists (cite it in the RFC).
- **Conformance** — state which profile (L1/L2/L3) a change touches.

## Validating locally

The conformance harness validates every example in `0.1.0/examples/` against the JSON Schema (draft 2020-12), then runs semantic checks the schema cannot express:

```
cd editor
npm ci
npm run test:conformance
```

The harness checks invariants such as unique node IDs, valid relationship endpoints, capability `accessPath` references, and `ref`/`cap_ref` uniqueness rules.

## Sign-off (DCO)

Sign commits off (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/). Contributions are under the project licences (`LICENSE.md`).
