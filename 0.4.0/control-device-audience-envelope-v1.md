# Lattice v0.4 signed device-audience Control envelope v1

## 1. Scope

This profile authenticates one exact Lattice `Control` protobuf for one exact
gateway and MQTT control topic. It is a contract boundary only. It does not
define key issuance, a cloud publisher, MQTT delivery, gateway admission
wiring, ACK/webhook handling, or a physical write.

The profile has one algorithm:

- algorithm id `1`: ECDSA over NIST P-256 and SHA-256 (`ES256`);
- public key: exactly 65-byte uncompressed SEC1 form `04 || X || Y`;
- signature: exactly 64-byte IEEE P1363 form `r || s`.

The XIAO ESP32-S3 profile already enables mbedTLS ECDSA and secp256r1. Deno
WebCrypto returns P1363 signatures for P-256. Deno does not guarantee low-S,
so a signer MUST normalize `s` to `min(s, n - s)` after signing, where:

```text
n = ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
```

A verifier MUST reject a signature unless `1 <= r < n` and
`1 <= s <= floor(n/2)`. It MUST reject DER, truncated/extended signatures,
zero scalars, out-of-range scalars, high-S twins, invalid public points, and
keys not on P-256. This gives one canonical signature representation, although
ECDSA signing itself may still produce different valid low-S signatures.

## 2. Binary envelope

The wire value is binary. MQTT or HTTP systems that need text encode the whole
binary value as unpadded base64url. Padding, standard-base64 `+` or `/`,
whitespace, and encodings that do not round-trip byte-for-byte to the same
unpadded base64url string are invalid.

The binary value is:

```text
signed_preimage || signature[64] || control[control_length]
```

The signing input is exactly `signed_preimage`; it is not JSON and is not a
protobuf re-encoding. This avoids JSON duplicate-member and number
canonicalization ambiguities. A JSON object containing these fields is never a
conforming wire envelope.

Integers are unsigned, fixed-width, network byte order. `text16` is a two-byte
unsigned byte length followed by that many strict UTF-8 bytes. Text is
byte-exact: no case folding, trimming, Unicode normalization, or replacement of
invalid UTF-8 is allowed.

| Order | Field | Encoding and v1 constraint |
|---:|---|---|
| 1 | domain | exact 35 bytes `LATTICE-CONTROL-DEVICE-AUDIENCE-V1\0` |
| 2 | message kind | `uint8`, exact value `1` (Control) |
| 3 | preimage version | `uint8`, exact value `1` |
| 4 | algorithm id | `uint8`, exact value `1` (ES256) |
| 5 | key id | `text16`, 1–63 ASCII bytes matching `[A-Za-z0-9._-]+` |
| 6 | audience device id | `text16`, exact 17-byte `pbgw_[0-9a-f]{12}` |
| 7 | control topic | `text16`, exact `predbat/devices/{audience_device_id}/control`, at most 95 bytes |
| 8 | command id | `text16`, 1–63 UTF-8 bytes |
| 9 | controller origin id | `text16`, 1–36 UTF-8 bytes |
| 10 | controller class | `uint8`, one of the concrete v0.4 values `1..4` |
| 11 | canonical scope id | `text16`, exactly 43 unpadded base64url bytes |
| 12 | topology document version | `uint32`, non-zero |
| 13 | topology document digest | exactly 32 bytes, SHA-256 |
| 14 | capability ref | `uint32`, non-zero |
| 15 | Control byte length | `uint32`, `1..1024` |
| 16 | Control byte digest | exactly 32 bytes, SHA-256 |
| 17 | not-before | `uint64`, Unix epoch milliseconds |
| 18 | expiry | `uint64`, Unix epoch milliseconds |

At the maximum text and Control bounds, the preimage is at most 460 bytes and
the complete binary envelope is at most 1,548 bytes. A receiver MUST enforce
these bounds before allocation or cryptographic work and MUST reject trailing
bytes.

## 3. Binding and admission

The topology digest is SHA-256 over the exact retained UTF-8 bytes of the
immutable topology document artifact identified by `topology document
version`. It is not a digest of a locally reserialized JSON object. A publisher
and receiver therefore retain or address the same artifact bytes. Both version
and digest must match the receiver's currently pinned document.

The Control digest is SHA-256 over the exact appended protobuf bytes. The
receiver MUST verify that the appended byte count and digest match the signed
claims. Protobuf-equivalent but byte-different Controls are different requests.

After signature verification, the receiver decodes the appended v0.4
`Control`. This cloud-to-XIAO profile admits only the explicit
`schedule_transition` oneof at field 10 (replacement or cancellation).
Scalar field 4, deprecated Schedule field 5, ScheduleIntent field 6, and the
replacement-only AbsoluteScheduleIntent field 7 MUST reject. This restriction
prevents the signed path from recreating the legacy non-Lattice scalar-control
route. Field 10 MUST itself contain exactly one known operation: replacement
field 1 or cancellation field 2; an empty transition, unknown operation, or
multiple operations rejects. The receiver MUST use the claims parsed from the
verified preimage, not values from a second parse or an unsigned side channel.
It MUST require exact equality:

- `Control.command_id` = signed command id;
- `Control.doc_version` = signed topology document version;
- `Control.cap_ref` = signed capability ref;
- `Control.controller.origin_id` = signed controller origin id;
- numeric `Control.controller.controller_class` = signed controller class;
- `Control.lease.scope_id` = signed canonical scope id.

The receiving device MUST equal the signed audience, and the transport topic
MUST equal the signed control topic. The authenticated transport principal and
local controller-class policy checks from the v0.4 schedule authority contract
remain mandatory. A valid signature does not replace scope derivation, lease
fencing, command replay, topology lookup, semantic validation, or physical
write authorization.

An envelope verifier therefore takes the actual receiving device id, actual
transport topic, and currently pinned topology document version and digest as
trusted admission context. It MUST NOT infer any of those values from the
unverified envelope. The signed audience, topic, topology version, and topology
digest must match that context byte-for-byte before signature verification.

Time validity is strict:

- `not_before_ms < expires_at_ms`;
- `expires_at_ms - not_before_ms <= 300000` (five minutes);
- admission may tolerate at most 30000 ms of future clock skew:
  `now_ms + 30000 >= not_before_ms`;
- expiry is exclusive with no grace: `now_ms < expires_at_ms`.

Overflow while evaluating time is a rejection. Implementations should compare
with subtraction or checked arithmetic.

## 4. Keys, replay, and identity

`key_id` is signed but initially untrusted. It selects one active or explicitly
retained verification key from a deployment-local allowlist. Unknown,
disabled, wrong-algorithm, or ambiguous ids reject. This document does not
define how that allowlist is provisioned or rotated.

Each allowlist entry binds one exact `key_id` to one status (`active`,
`retained`, or `disabled`), algorithm id, and public-key bytes. Selection
requires exactly one matching entry. `active` and explicitly `retained` are the
only admissible statuses; a matching entry with any other status fails closed.
The selected entry's algorithm must equal the signed algorithm id before its
key can be used.

The envelope idempotency fingerprint is:

```text
SHA-256(signed_preimage)
```

It binds all canonical claims, including the Control digest, without depending
on randomized ECDSA output. It is not a replacement for the v0.4
receiver-global command identity tuple or durable result journal. Re-signing
the same preimage may change signature bytes but cannot create a distinct
logical command.

## 5. Required validation order

A receiver fails closed before protobuf admission:

1. enforce total size, canonical base64url when applicable, domain, versions,
   fixed widths, text bounds/UTF-8, profile forms, claimed Control bound, and
   exact end-of-input;
2. enforce the time-window and actual receiver/topic/pinned-topology invariants;
3. select the allowlisted P-256 key and verify canonical low-S ES256 over the
   exact preimage bytes;
4. verify appended Control length and SHA-256;
5. decode the Control once, require field-10 `schedule_transition`, compare
   every duplicated binding above, and only then enter the existing topology,
   authority, lease, replay, and execution pipeline.

No rejected envelope may create a command reservation, mutate fencing state,
publish a terminal result, or reach any target-visible write.

## 6. Conformance

`conformance/device-audience-envelope-v1/vectors.json` freezes an exact
positive wire value, acceptance-boundary cases, independently and correctly
signed semantic-invalid envelopes, key-selection failures, signature-form
failures, and encoding mutations. Its positive Control is a real v0.4 field-10
replacement protobuf. The dependency-free Python consumer implements binary
parsing, actual receiver/topic/topology matching, key-id allowlist selection,
SHA-256, canonical P-256 ECDSA verification, a strict minimal v0.4 Control
decoder, all six duplicated binding checks, and every vector rejection without
calling the TypeScript reference or an external crypto package. The corpus
contains only public test material; none of its keys are deployment keys.

The corpus JSON is only a fixture container. It is parsed as trusted repository
test data and is not an alternate protocol representation.
