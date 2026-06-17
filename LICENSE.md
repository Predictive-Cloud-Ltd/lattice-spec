# Lattice — Licensing

Lattice is open and **royalty-free**. It is dual-licensed so that both the prose specification and the machine-readable artifacts can be reused as widely as possible.

| Part | Licence | SPDX |
|---|---|---|
| Specification text & documentation (the `*.md` design/spec docs) | **Creative Commons Attribution 4.0 International** | `CC-BY-4.0` |
| Schema (`*.schema.json`), protobuf (`*.proto`), examples, and reference code | **Apache License 2.0** | `Apache-2.0` |

- CC-BY-4.0: https://creativecommons.org/licenses/by/4.0/
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0

**Why dual-license:** CC-BY is the convention for specification *text* (it's documentation, freely shareable with attribution); Apache-2.0 is the convention for *implementable artifacts* (schema/proto/code) — it grants an explicit, royalty-free patent licence, which matters for a standard people build products on. This mirrors how OpenAPI and JSON Schema are licensed.

Implementing Lattice — producing or consuming a conformant document — requires **no fee and no licence beyond the above**.

> Full licence texts (`LICENSE-APACHE-2.0.txt`, `LICENSE-CC-BY-4.0.txt`) and a `NOTICE` file are added when the standard is extracted to its dedicated public repository. Until then, the canonical texts are at the URLs above and the SPDX identifiers are authoritative.
