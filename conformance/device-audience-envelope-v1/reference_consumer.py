#!/usr/bin/env python3
"""Independent stdlib consumer for the Lattice signed control envelope v1."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

DOMAIN = b"LATTICE-CONTROL-DEVICE-AUDIENCE-V1\x00"
MESSAGE_KIND_CONTROL = 1
PREIMAGE_VERSION = 1
ALGORITHM_ES256 = 1
MAX_CONTROL_BYTES = 1024
MAX_ENVELOPE_BYTES = 1548
MAX_ENVELOPE_BASE64URL_CHARS = 2064
MAX_VALIDITY_MS = 300_000
MAX_FUTURE_SKEW_MS = 30_000
MAX_UINT32 = (1 << 32) - 1
MAX_UINT64 = (1 << 64) - 1

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)

DEVICE_RE = re.compile(r"pbgw_[0-9a-f]{12}\Z")
KEY_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,63}\Z")
BASE64URL_43_RE = re.compile(r"[A-Za-z0-9_-]{43}\Z")


class EnvelopeError(ValueError):
    """A fail-closed contract rejection."""


def b64url_decode_canonical(value: str) -> bytes:
    if not value or "=" in value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise EnvelopeError("non-canonical base64url")
    try:
        decoded = base64.urlsafe_b64decode(
            value + "=" * ((4 - len(value) % 4) % 4)
        )
    except (ValueError, base64.binascii.Error) as error:
        raise EnvelopeError("invalid base64url") from error
    canonical = base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=")
    if canonical != value:
        raise EnvelopeError("non-canonical base64url")
    return decoded


def _inverse(value: int, modulus: int) -> int:
    return pow(value, -1, modulus)


def _point_add(
    left: tuple[int, int] | None,
    right: tuple[int, int] | None,
) -> tuple[int, int] | None:
    if left is None:
        return right
    if right is None:
        return left
    x1, y1 = left
    x2, y2 = right
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if left == right:
        slope = ((3 * x1 * x1 + A) * _inverse(2 * y1 % P, P)) % P
    else:
        slope = ((y2 - y1) * _inverse((x2 - x1) % P, P)) % P
    x3 = (slope * slope - x1 - x2) % P
    return x3, (slope * (x1 - x3) - y1) % P


def _point_multiply(
    scalar: int, point: tuple[int, int]
) -> tuple[int, int] | None:
    result = None
    addend = point
    while scalar:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    return result


def verify_es256_low_s(
    public_key: bytes, message: bytes, signature: bytes
) -> None:
    if len(public_key) != 65 or public_key[0] != 4:
        raise EnvelopeError(
            "public key must be 65-byte uncompressed SEC1 P-256"
        )
    q = (
        int.from_bytes(public_key[1:33], "big"),
        int.from_bytes(public_key[33:65], "big"),
    )
    if not (0 <= q[0] < P and 0 <= q[1] < P):
        raise EnvelopeError("public key coordinate out of range")
    if (q[1] * q[1] - (q[0] * q[0] * q[0] + A * q[0] + B)) % P:
        raise EnvelopeError("public key is not on P-256")
    if len(signature) != 64:
        raise EnvelopeError("signature must be exactly 64 bytes")
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    if not (1 <= r < N and 1 <= s < N):
        raise EnvelopeError("signature scalar out of range")
    if s > N // 2:
        raise EnvelopeError("signature is not canonical low-S")
    digest = int.from_bytes(hashlib.sha256(message).digest(), "big")
    inverse_s = _inverse(s, N)
    point = _point_add(
        _point_multiply((digest * inverse_s) % N, G),
        _point_multiply((r * inverse_s) % N, q),
    )
    if point is None or point[0] % N != r:
        raise EnvelopeError("signature verification failed")


class Reader:
    def __init__(self, value: bytes):
        self.value = value
        self.offset = 0

    def take(self, length: int) -> bytes:
        end = self.offset + length
        if length < 0 or end > len(self.value):
            raise EnvelopeError("truncated envelope")
        result = self.value[self.offset : end]
        self.offset = end
        return result

    def u8(self) -> int:
        return self.take(1)[0]

    def u16(self) -> int:
        return struct.unpack(">H", self.take(2))[0]

    def u32(self) -> int:
        return struct.unpack(">I", self.take(4))[0]

    def u64(self) -> int:
        return struct.unpack(">Q", self.take(8))[0]

    def text(self, label: str, maximum: int) -> str:
        length = self.u16()
        if length < 1 or length > maximum:
            raise EnvelopeError(f"{label} length out of range")
        raw = self.take(length)
        try:
            return raw.decode("utf-8", "strict")
        except UnicodeDecodeError as error:
            raise EnvelopeError(f"{label} is not UTF-8") from error


class ProtoReader:
    """Strict canonical protobuf reader for the bounded binding subset."""

    def __init__(self, value: bytes):
        self.value = value
        self.offset = 0

    def take(self, length: int) -> bytes:
        end = self.offset + length
        if length < 0 or end > len(self.value):
            raise EnvelopeError("truncated Control protobuf")
        result = self.value[self.offset : end]
        self.offset = end
        return result

    def varint(self, label: str, maximum: int = MAX_UINT64) -> int:
        start = self.offset
        value = 0
        for shift in range(0, 70, 7):
            byte = self.take(1)[0]
            if shift == 63 and byte > 1:
                raise EnvelopeError(f"{label} varint overflows uint64")
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                encoded_length = self.offset - start
                minimal_length = max(1, (value.bit_length() + 6) // 7)
                if encoded_length != minimal_length:
                    raise EnvelopeError(f"{label} varint is not canonical")
                if value > maximum:
                    raise EnvelopeError(f"{label} is out of range")
                return value
        raise EnvelopeError(f"{label} varint is too long")

    def field(self, label: str) -> tuple[int, int]:
        key = self.varint(f"{label} field key")
        number = key >> 3
        wire_type = key & 7
        if number == 0:
            raise EnvelopeError(f"{label} field number zero")
        return number, wire_type

    def length_delimited(self, label: str) -> bytes:
        length = self.varint(f"{label} length", MAX_CONTROL_BYTES)
        return self.take(length)


def _decode_proto_text(raw: bytes, label: str, maximum: int) -> str:
    if not raw or len(raw) > maximum:
        raise EnvelopeError(f"{label} length out of range")
    try:
        return raw.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise EnvelopeError(f"{label} is not UTF-8") from error


def _decode_controller(value: bytes) -> tuple[str, int]:
    reader = ProtoReader(value)
    seen: set[int] = set()
    origin_id: str | None = None
    controller_class: int | None = None
    while reader.offset < len(value):
        number, wire_type = reader.field("Control.controller")
        if number in seen:
            raise EnvelopeError("duplicate Controller.controller field")
        seen.add(number)
        if number == 1 and wire_type == 2:
            origin_id = _decode_proto_text(
                reader.length_delimited("Control.controller.origin_id"),
                "Control.controller.origin_id",
                36,
            )
        elif number == 2 and wire_type == 0:
            controller_class = reader.varint(
                "Control.controller.controller_class", MAX_UINT32
            )
        else:
            raise EnvelopeError(
                "unknown or wrong-wire Controller.controller field"
            )
    if origin_id is None or controller_class is None:
        raise EnvelopeError("Control.controller bindings are missing")
    return origin_id, controller_class


def _decode_lease_scope(value: bytes) -> str:
    reader = ProtoReader(value)
    seen: set[int] = set()
    scope_id: str | None = None
    while reader.offset < len(value):
        number, wire_type = reader.field("Control.lease")
        if number in seen:
            raise EnvelopeError("duplicate Control.lease field")
        seen.add(number)
        if number in (1, 2) and wire_type == 2:
            label = (
                "Control.lease.lease_id"
                if number == 1
                else "Control.lease.scope_id"
            )
            text = _decode_proto_text(
                reader.length_delimited(label),
                label,
                36 if number == 1 else 47,
            )
            if number == 2:
                scope_id = text
        elif number in (3, 4) and wire_type == 0:
            label = (
                "Control.lease.fencing_token"
                if number == 3
                else "Control.lease.expires_ts_ms"
            )
            reader.varint(label)
        else:
            raise EnvelopeError("unknown or wrong-wire Control.lease field")
    if scope_id is None:
        raise EnvelopeError("Control.lease.scope_id is missing")
    return scope_id


def _decode_schedule_transition(value: bytes) -> None:
    reader = ProtoReader(value)
    operation_seen = False
    while reader.offset < len(value):
        number, wire_type = reader.field("Control.schedule_transition")
        if number not in (1, 2) or wire_type != 2:
            raise EnvelopeError(
                "schedule_transition has an unknown or wrong-wire operation"
            )
        if operation_seen:
            raise EnvelopeError("schedule_transition has multiple operations")
        operation_seen = True
        reader.length_delimited("Control.schedule_transition operation")
    if not operation_seen:
        raise EnvelopeError(
            "schedule_transition must contain replacement or cancellation"
        )


def decode_control_bindings(control: bytes) -> dict[str, object]:
    """Decode the exact v0.4 field-10 Control binding surface."""

    reader = ProtoReader(control)
    seen: set[int] = set()
    payload_seen = False
    command_id: str | None = None
    doc_version: int | None = None
    cap_ref: int | None = None
    origin_id: str | None = None
    controller_class: int | None = None
    scope_id: str | None = None

    while reader.offset < len(control):
        number, wire_type = reader.field("Control")
        if number in seen:
            raise EnvelopeError("duplicate Control field")
        seen.add(number)
        if number == 1 and wire_type == 2:
            command_id = _decode_proto_text(
                reader.length_delimited("Control.command_id"),
                "Control.command_id",
                63,
            )
        elif number == 2 and wire_type == 0:
            doc_version = reader.varint(
                "Control.doc_version", MAX_UINT32
            )
        elif number == 3 and wire_type == 0:
            cap_ref = reader.varint("Control.cap_ref", MAX_UINT32)
        elif number == 8 and wire_type == 2:
            origin_id, controller_class = _decode_controller(
                reader.length_delimited("Control.controller")
            )
        elif number == 9 and wire_type == 2:
            scope_id = _decode_lease_scope(
                reader.length_delimited("Control.lease")
            )
        elif number == 10 and wire_type == 2:
            payload_seen = True
            _decode_schedule_transition(
                reader.length_delimited("Control.schedule_transition")
            )
        elif number in (4, 5, 6, 7) and wire_type == 2:
            raise EnvelopeError(
                "unsupported Control payload; "
                "schedule_transition field 10 is required"
            )
        else:
            raise EnvelopeError("unknown or wrong-wire Control field")

    bindings = (
        command_id,
        doc_version,
        cap_ref,
        origin_id,
        controller_class,
        scope_id,
    )
    if None in bindings:
        raise EnvelopeError("Control binding field is missing")
    if not payload_seen:
        raise EnvelopeError("Control payload is missing")
    return {
        "command_id": command_id,
        "doc_version": doc_version,
        "cap_ref": cap_ref,
        "controller_origin_id": origin_id,
        "controller_class": controller_class,
        "scope_id": scope_id,
    }


def _select_verification_key(
    key_id: str,
    algorithm_id: int,
    key_allowlist: list[dict[str, object]],
) -> bytes:
    matches = [
        entry for entry in key_allowlist if entry.get("key_id") == key_id
    ]
    if not matches:
        raise EnvelopeError("unknown key_id")
    if len(matches) != 1:
        raise EnvelopeError("ambiguous key_id")
    entry = matches[0]
    if entry.get("status") not in ("active", "retained"):
        raise EnvelopeError("verification key is disabled")
    if entry.get("algorithm_id") != algorithm_id:
        raise EnvelopeError("verification key algorithm mismatch")
    public_key_hex = entry.get("public_key_sec1_hex")
    if not isinstance(public_key_hex, str):
        raise EnvelopeError("verification key is missing")
    try:
        return bytes.fromhex(public_key_hex)
    except ValueError as error:
        raise EnvelopeError("public key is not hexadecimal") from error


def consume(
    encoded: str,
    key_allowlist: list[dict[str, object]],
    *,
    now_ms: int,
    receiving_device_id: str,
    transport_topic: str,
    pinned_topology_doc_version: int,
    pinned_topology_digest_hex: str,
) -> dict[str, object]:
    if len(encoded) > MAX_ENVELOPE_BASE64URL_CHARS:
        raise EnvelopeError("encoded envelope exceeds maximum size")
    wire = b64url_decode_canonical(encoded)
    if len(wire) > MAX_ENVELOPE_BYTES:
        raise EnvelopeError("envelope exceeds maximum size")

    reader = Reader(wire)
    if reader.take(len(DOMAIN)) != DOMAIN:
        raise EnvelopeError("unsupported domain")
    if reader.u8() != MESSAGE_KIND_CONTROL:
        raise EnvelopeError("unsupported message kind")
    if reader.u8() != PREIMAGE_VERSION:
        raise EnvelopeError("unsupported preimage version")
    algorithm_id = reader.u8()
    if algorithm_id != ALGORITHM_ES256:
        raise EnvelopeError("unsupported algorithm")

    key_id = reader.text("key_id", 63)
    audience = reader.text("audience_device_id", 17)
    topic = reader.text("control_topic", 95)
    command_id = reader.text("command_id", 63)
    origin_id = reader.text("controller_origin_id", 36)
    controller_class = reader.u8()
    scope_id = reader.text("scope_id", 43)
    doc_version = reader.u32()
    topology_digest = reader.take(32)
    cap_ref = reader.u32()
    control_length = reader.u32()
    control_digest = reader.take(32)
    not_before_ms = reader.u64()
    expires_at_ms = reader.u64()
    preimage_end = reader.offset

    # Step 1: finish bounded structural parsing and exact end-of-input.
    if control_length < 1 or control_length > MAX_CONTROL_BYTES:
        raise EnvelopeError("control length out of range")
    signature = reader.take(64)
    control = reader.take(control_length)
    if reader.offset != len(wire):
        raise EnvelopeError("trailing envelope bytes")
    if not KEY_ID_RE.fullmatch(key_id):
        raise EnvelopeError("key_id is not canonical ASCII")
    if not DEVICE_RE.fullmatch(audience):
        raise EnvelopeError("audience_device_id is not canonical")
    if topic != f"predbat/devices/{audience}/control":
        raise EnvelopeError(
            "control_topic does not match the exact device audience"
        )
    if controller_class not in (1, 2, 3, 4):
        raise EnvelopeError(
            "controller class is not a concrete v0.4 class"
        )
    if not BASE64URL_43_RE.fullmatch(scope_id):
        raise EnvelopeError("scope_id is not canonical")
    if doc_version == 0 or cap_ref == 0:
        raise EnvelopeError("topology reference must be non-zero")

    # Step 2: trusted admission context and bounded validity.
    if receiving_device_id != audience:
        raise EnvelopeError(
            "receiving device does not match signed audience"
        )
    if transport_topic != topic:
        raise EnvelopeError(
            "transport topic does not match signed control_topic"
        )
    try:
        pinned_digest = bytes.fromhex(pinned_topology_digest_hex)
    except ValueError as error:
        raise EnvelopeError(
            "pinned topology digest is not hexadecimal"
        ) from error
    if len(pinned_digest) != 32:
        raise EnvelopeError(
            "pinned topology digest must be exactly 32 bytes"
        )
    if (
        pinned_topology_doc_version != doc_version
        or pinned_digest != topology_digest
    ):
        raise EnvelopeError(
            "signed topology artifact is not currently pinned"
        )
    if not_before_ms >= expires_at_ms:
        raise EnvelopeError("invalid time window")
    if expires_at_ms - not_before_ms > MAX_VALIDITY_MS:
        raise EnvelopeError("time window exceeds maximum validity")
    if now_ms + MAX_FUTURE_SKEW_MS < not_before_ms:
        raise EnvelopeError("envelope is not yet valid")
    if now_ms >= expires_at_ms:
        raise EnvelopeError("envelope is expired")

    # Steps 3-5: key selection/signature, payload integrity, then decode.
    public_key = _select_verification_key(
        key_id, algorithm_id, key_allowlist
    )
    preimage = wire[:preimage_end]
    verify_es256_low_s(public_key, preimage, signature)
    if hashlib.sha256(control).digest() != control_digest:
        raise EnvelopeError("Control digest mismatch")
    decoded = decode_control_bindings(control)
    expected_bindings = {
        "command_id": command_id,
        "doc_version": doc_version,
        "cap_ref": cap_ref,
        "controller_origin_id": origin_id,
        "controller_class": controller_class,
        "scope_id": scope_id,
    }
    for label, expected in expected_bindings.items():
        if decoded[label] != expected:
            raise EnvelopeError(
                f"Control {label} does not match signed claim"
            )

    fingerprint = hashlib.sha256(preimage).hexdigest()
    return {
        "profile": "lattice-control-device-audience-v1",
        "key_id": key_id,
        "audience_device_id": audience,
        "control_topic": topic,
        "command_id": command_id,
        "controller_origin_id": origin_id,
        "controller_class": controller_class,
        "scope_id": scope_id,
        "topology_doc_version": doc_version,
        "topology_digest_hex": topology_digest.hex(),
        "cap_ref": cap_ref,
        "control_length": control_length,
        "control_digest_hex": control_digest.hex(),
        "not_before_ms": not_before_ms,
        "expires_at_ms": expires_at_ms,
        "preimage_sha256_hex": fingerprint,
        "idempotency_fingerprint_hex": fingerprint,
    }


def _consume_case(
    case: dict[str, object],
    corpus: dict[str, object],
) -> dict[str, object]:
    positive = corpus["positive"]
    admission = corpus["admission"]
    allowlists = corpus["key_allowlists"]
    return consume(
        case.get(
            "envelope_base64url", positive["envelope_base64url"]
        ),
        allowlists[case.get("key_allowlist", "active")],
        now_ms=case.get(
            "now_ms", positive["admission_now_ms"]
        ),
        receiving_device_id=case.get(
            "receiving_device_id", admission["receiving_device_id"]
        ),
        transport_topic=case.get(
            "transport_topic", admission["transport_topic"]
        ),
        pinned_topology_doc_version=case.get(
            "pinned_topology_doc_version",
            admission["pinned_topology_doc_version"],
        ),
        pinned_topology_digest_hex=case.get(
            "pinned_topology_digest_hex",
            admission["pinned_topology_digest_hex"],
        ),
    )


def self_test(path: Path) -> None:
    corpus = json.loads(path.read_text())
    admission = corpus["admission"]
    artifact_digest = hashlib.sha256(
        corpus["topology_artifact_utf8"].encode()
    ).hexdigest()
    if artifact_digest != admission["pinned_topology_digest_hex"]:
        raise AssertionError("topology artifact digest fixture mismatch")

    actual = _consume_case({}, corpus)
    expected = corpus["positive"]["expected"]
    if actual != expected:
        raise AssertionError(
            f"positive vector mismatch:\n{actual}\n{expected}"
        )
    for acceptance in corpus["acceptance_cases"]:
        _consume_case(acceptance, corpus)
    for mutation in corpus["mutations"]:
        try:
            _consume_case(mutation, corpus)
        except EnvelopeError as error:
            if mutation["error"] not in str(error):
                raise AssertionError(
                    f"{mutation['name']}: expected "
                    f"{mutation['error']!r}, got {error!r}"
                ) from error
        else:
            raise AssertionError(
                f"{mutation['name']}: mutation was accepted"
            )
    print(
        "device-audience-envelope-v1: "
        f"1 primary + {len(corpus['acceptance_cases'])} "
        f"additional positive + {len(corpus['mutations'])} "
        "negative vectors passed"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "corpus",
        nargs="?",
        type=Path,
        default=Path(__file__).with_name("vectors.json"),
    )
    args = parser.parse_args()
    try:
        self_test(args.corpus)
    except (
        EnvelopeError,
        AssertionError,
        KeyError,
        TypeError,
        json.JSONDecodeError,
    ) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
