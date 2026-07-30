#!/usr/bin/env python3
"""Generate deterministic TEST-ONLY device-audience envelope vectors."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import sys
from pathlib import Path

from reference_consumer import (
    ALGORITHM_ES256,
    DOMAIN,
    G,
    MESSAGE_KIND_CONTROL,
    N,
    PREIMAGE_VERSION,
    _point_multiply,
)

# Public fixture material derived from a descriptive label. Never use it as a
# deployment key. A deployment must provision an independently generated key.
TEST_PRIVATE_SCALAR = (
    int.from_bytes(
        hashlib.sha256(
            b"lattice-device-audience-envelope-v1-test-key"
        ).digest(),
        "big",
    )
    % (N - 1)
) + 1
SECOND_PRIVATE_SCALAR = (TEST_PRIVATE_SCALAR % (N - 2)) + 1

KEY_ID = "saas-control-test-2026-07"
DEVICE_ID = "pbgw_3c0f02df19b4"
TOPIC = f"predbat/devices/{DEVICE_ID}/control"
COMMAND_ID = "11111111-2222-4333-8444-555555555555"
ORIGIN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
SCOPE_ID = "WiL19AHtF1LTOmHspc211b9P_yYS7s1w77-EXnQZ9Ko"
DOC_VERSION = 12
CAP_REF = 41
NOT_BEFORE_MS = 1_785_513_300_000
EXPIRES_AT_MS = 1_785_513_600_000
TOPOLOGY_ARTIFACT = (
    '{"topologyVersion":"0.4.0","docVersion":12,'
    '"id":"device-audience-envelope-conformance"}\n'
).encode()
TOPOLOGY_DIGEST = hashlib.sha256(TOPOLOGY_ARTIFACT).digest()


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def varint(value: int) -> bytes:
    if value < 0:
        raise ValueError("varint is unsigned")
    result = bytearray()
    while value >= 0x80:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    result.append(value)
    return bytes(result)


def field_varint(number: int, value: int) -> bytes:
    return varint(number << 3) + varint(value)


def field_bytes(number: int, value: bytes) -> bytes:
    return varint((number << 3) | 2) + varint(len(value)) + value


def text16(value: str | bytes) -> bytes:
    raw = value.encode() if isinstance(value, str) else value
    return len(raw).to_bytes(2, "big") + raw


def public_key(private_scalar: int) -> bytes:
    point = _point_multiply(private_scalar, G)
    if point is None:
        raise AssertionError("invalid test private scalar")
    return (
        b"\x04"
        + point[0].to_bytes(32, "big")
        + point[1].to_bytes(32, "big")
    )


def deterministic_nonce(private_scalar: int, digest: bytes) -> int:
    key = b"\x00" * 32
    value = b"\x01" * 32
    secret = private_scalar.to_bytes(32, "big")
    # RFC 6979 §2.3.4 bits2octets: P-256 and SHA-256 both have a
    # 256-bit width, so bits2int is direct and the remaining step is mod n.
    digest_octets = (
        int.from_bytes(digest, "big") % N
    ).to_bytes(32, "big")
    key = hmac.new(
        key,
        value + b"\x00" + secret + digest_octets,
        hashlib.sha256,
    ).digest()
    value = hmac.new(key, value, hashlib.sha256).digest()
    key = hmac.new(
        key,
        value + b"\x01" + secret + digest_octets,
        hashlib.sha256,
    ).digest()
    value = hmac.new(key, value, hashlib.sha256).digest()
    while True:
        value = hmac.new(key, value, hashlib.sha256).digest()
        candidate = int.from_bytes(value, "big")
        if 1 <= candidate < N:
            return candidate
        key = hmac.new(
            key, value + b"\x00", hashlib.sha256
        ).digest()
        value = hmac.new(key, value, hashlib.sha256).digest()


def sign(
    preimage: bytes, private_scalar: int = TEST_PRIVATE_SCALAR
) -> bytes:
    digest = hashlib.sha256(preimage).digest()
    nonce = deterministic_nonce(private_scalar, digest)
    point = _point_multiply(nonce, G)
    if point is None:
        raise AssertionError("invalid deterministic nonce")
    r = point[0] % N
    numerator = int.from_bytes(digest, "big") + r * private_scalar
    s = (pow(nonce, -1, N) * numerator) % N
    if not r or not s:
        raise AssertionError("degenerate deterministic signature")
    s = min(s, N - s)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def build_schedule_transition() -> bytes:
    slot = (
        field_varint(1, 1_785_513_600_000)
        + field_varint(2, 1_785_531_600_000)
        + field_bytes(3, b"self_use")
    )
    replacement = (
        field_bytes(1, slot)
        + field_varint(3, 1_785_513_600_000)
        + field_varint(4, 1_785_531_600_000)
        + field_bytes(5, b"UTC")
        + field_varint(6, 1)
    )
    return field_bytes(1, replacement)


def build_schedule_cancellation() -> bytes:
    cancellation = field_bytes(
        1, hashlib.sha256(b"installed-plan").digest()
    ) + field_varint(2, 3)
    return field_bytes(2, cancellation)


def build_controller(
    origin_id: str | bytes = ORIGIN_ID,
    controller_class: int = 1,
) -> bytes:
    origin = (
        origin_id.encode() if isinstance(origin_id, str) else origin_id
    )
    return field_bytes(1, origin) + field_varint(2, controller_class)


def build_lease(scope_id: str | bytes = SCOPE_ID) -> bytes:
    scope = scope_id.encode() if isinstance(scope_id, str) else scope_id
    return (
        field_bytes(1, b"99999999-8888-4777-8666-555555555555")
        + field_bytes(2, scope)
        + field_varint(3, 11)
        + field_varint(4, 1_785_513_900_000)
    )


def build_control(
    *,
    command_id: str | bytes = COMMAND_ID,
    doc_version: int = DOC_VERSION,
    cap_ref: int = CAP_REF,
    origin_id: str | bytes = ORIGIN_ID,
    controller_class: int = 1,
    scope_id: str | bytes = SCOPE_ID,
    include_controller: bool = True,
    include_lease: bool = True,
    include_payload: bool = True,
    payload_field: int = 10,
    extra: bytes = b"",
) -> bytes:
    command = (
        command_id.encode() if isinstance(command_id, str) else command_id
    )
    result = (
        field_bytes(1, command)
        + field_varint(2, doc_version)
        + field_varint(3, cap_ref)
    )
    if include_controller:
        result += field_bytes(
            8, build_controller(origin_id, controller_class)
        )
    if include_lease:
        result += field_bytes(9, build_lease(scope_id))
    if include_payload:
        result += field_bytes(
            payload_field, build_schedule_transition()
        )
    return result + extra


def build_preimage(
    control: bytes,
    *,
    key_id: str | bytes = KEY_ID,
    audience: str | bytes = DEVICE_ID,
    topic: str | bytes = TOPIC,
    command_id: str | bytes = COMMAND_ID,
    origin_id: str | bytes = ORIGIN_ID,
    controller_class: int = 1,
    scope_id: str | bytes = SCOPE_ID,
    doc_version: int = DOC_VERSION,
    topology_digest: bytes = TOPOLOGY_DIGEST,
    cap_ref: int = CAP_REF,
    control_length: int | None = None,
    control_digest: bytes | None = None,
    not_before_ms: int = NOT_BEFORE_MS,
    expires_at_ms: int = EXPIRES_AT_MS,
) -> bytes:
    length = len(control) if control_length is None else control_length
    digest = (
        hashlib.sha256(control).digest()
        if control_digest is None
        else control_digest
    )
    return (
        DOMAIN
        + bytes(
            (MESSAGE_KIND_CONTROL, PREIMAGE_VERSION, ALGORITHM_ES256)
        )
        + text16(key_id)
        + text16(audience)
        + text16(topic)
        + text16(command_id)
        + text16(origin_id)
        + bytes((controller_class,))
        + text16(scope_id)
        + doc_version.to_bytes(4, "big")
        + topology_digest
        + cap_ref.to_bytes(4, "big")
        + length.to_bytes(4, "big")
        + digest
        + not_before_ms.to_bytes(8, "big")
        + expires_at_ms.to_bytes(8, "big")
    )


def build_envelope(
    control: bytes | None = None,
    *,
    private_scalar: int = TEST_PRIVATE_SCALAR,
    **claims: object,
) -> tuple[bytes, bytes, bytes]:
    body = build_control() if control is None else control
    preimage = build_preimage(body, **claims)
    return (
        preimage + sign(preimage, private_scalar) + body,
        preimage,
        body,
    )


def der_integer(value: int) -> bytes:
    raw = value.to_bytes(32, "big").lstrip(b"\x00") or b"\x00"
    if raw[0] & 0x80:
        raw = b"\x00" + raw
    return b"\x02" + bytes((len(raw),)) + raw


def der_signature(signature: bytes) -> bytes:
    sequence = der_integer(
        int.from_bytes(signature[:32], "big")
    ) + der_integer(int.from_bytes(signature[32:], "big"))
    return b"\x30" + bytes((len(sequence),)) + sequence


def noncanonical_tail(encoded: str) -> str:
    alphabet = (
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "abcdefghijklmnopqrstuvwxyz"
        "0123456789-_"
    )
    index = alphabet.index(encoded[-1])
    return encoded[:-1] + alphabet[index ^ 1]


def build_corpus() -> dict[str, object]:
    positive_wire, positive_preimage, positive_control = (
        build_envelope()
    )
    preimage_length = len(positive_preimage)
    positive_signature = positive_wire[
        preimage_length : preimage_length + 64
    ]
    test_public_key = public_key(TEST_PRIVATE_SCALAR)
    second_public_key = public_key(SECOND_PRIVATE_SCALAR)
    active_entry = {
        "key_id": KEY_ID,
        "status": "active",
        "algorithm_id": ALGORITHM_ES256,
        "public_key_sec1_hex": test_public_key.hex(),
    }
    key_allowlists = {
        "active": [active_entry],
        "retained": [{**active_entry, "status": "retained"}],
        "disabled": [{**active_entry, "status": "disabled"}],
        "wrong_algorithm": [{**active_entry, "algorithm_id": 99}],
        "ambiguous": [active_entry, dict(active_entry)],
        "wrong_key": [
            {
                **active_entry,
                "public_key_sec1_hex": second_public_key.hex(),
            }
        ],
        "bad_sec1_prefix": [
            {
                **active_entry,
                "public_key_sec1_hex": (
                    b"\x03" + test_public_key[1:]
                ).hex(),
            }
        ],
        "bad_sec1_length": [
            {
                **active_entry,
                "public_key_sec1_hex": test_public_key[:-1].hex(),
            }
        ],
        "bad_sec1_point": [
            {
                **active_entry,
                "public_key_sec1_hex": (
                    b"\x04" + b"\x00" * 64
                ).hex(),
            }
        ],
        "missing_key": [
            {
                "key_id": KEY_ID,
                "status": "active",
                "algorithm_id": ALGORITHM_ES256,
            }
        ],
    }

    mutations: list[dict[str, object]] = []

    def reject(
        name: str,
        error: str,
        wire: bytes | None = None,
        **overrides: object,
    ) -> None:
        case: dict[str, object] = {"name": name, "error": error}
        if wire is not None:
            case["envelope_base64url"] = b64url(wire)
        case.update(overrides)
        mutations.append(case)

    def reject_signed(
        name: str,
        error: str,
        control: bytes | None = None,
        **claims: object,
    ) -> None:
        wire, _, _ = build_envelope(control, **claims)
        reject(name, error, wire, correctly_signed=True)

    reject_signed(
        "signed invalid key-id character",
        "key_id is not canonical",
        key_id="bad/key",
    )
    reject_signed(
        "signed overlong key-id",
        "key_id length out of range",
        key_id="k" * 64,
    )
    reject_signed(
        "signed invalid audience profile",
        "audience_device_id is not canonical",
        audience="pbgw_3C0F02DF19B4",
        topic="predbat/devices/pbgw_3C0F02DF19B4/control",
    )
    reject_signed(
        "signed internally mismatching topic",
        "control_topic does not match",
        topic="predbat/devices/pbgw_000000000000/control",
    )
    reject_signed(
        "signed invalid command UTF-8",
        "command_id is not UTF-8",
        command_id=b"\xff",
    )
    reject_signed(
        "signed overlong command-id",
        "command_id length out of range",
        command_id="c" * 64,
    )
    reject_signed(
        "signed overlong controller origin",
        "controller_origin_id length out of range",
        origin_id="o" * 37,
    )
    reject_signed(
        "signed unspecified controller class",
        "controller class is not a concrete",
        controller_class=0,
    )
    reject_signed(
        "signed invalid canonical scope",
        "scope_id is not canonical",
        scope_id="!" + SCOPE_ID[1:],
    )
    reject_signed(
        "signed zero topology document version",
        "topology reference must be non-zero",
        doc_version=0,
    )
    reject_signed(
        "signed zero capability ref",
        "topology reference must be non-zero",
        cap_ref=0,
    )
    reject_signed(
        "signed empty Control",
        "control length out of range",
        control=b"",
    )
    reject_signed(
        "signed equal not-before and expiry",
        "invalid time window",
        not_before_ms=EXPIRES_AT_MS,
    )
    reject_signed(
        "signed excessive validity horizon",
        "time window exceeds maximum",
        expires_at_ms=EXPIRES_AT_MS + 1,
    )

    reject(
        "actual receiving device mismatch",
        "receiving device does not match",
        receiving_device_id="pbgw_000000000000",
    )
    reject(
        "actual transport topic mismatch",
        "transport topic does not match",
        transport_topic=(
            "predbat/devices/pbgw_000000000000/control"
        ),
    )
    reject(
        "pinned topology version mismatch",
        "signed topology artifact is not currently pinned",
        pinned_topology_doc_version=DOC_VERSION + 1,
    )
    reject(
        "pinned topology digest mismatch",
        "signed topology artifact is not currently pinned",
        pinned_topology_digest_hex=(b"\x00" * 32).hex(),
    )

    reject_signed(
        "unknown signed key-id",
        "unknown key_id",
        key_id="unknown-test-key",
    )
    reject(
        "disabled verification key",
        "verification key is disabled",
        key_allowlist="disabled",
    )
    reject(
        "wrong-algorithm verification key",
        "verification key algorithm mismatch",
        key_allowlist="wrong_algorithm",
    )
    reject(
        "ambiguous verification key",
        "ambiguous key_id",
        key_allowlist="ambiguous",
    )
    reject(
        "wrong verification key",
        "signature verification failed",
        key_allowlist="wrong_key",
    )
    reject(
        "invalid SEC1 point prefix",
        "65-byte uncompressed SEC1",
        key_allowlist="bad_sec1_prefix",
    )
    reject(
        "invalid SEC1 point length",
        "65-byte uncompressed SEC1",
        key_allowlist="bad_sec1_length",
    )
    reject(
        "invalid SEC1 point coordinates",
        "public key is not on P-256",
        key_allowlist="bad_sec1_point",
    )
    reject(
        "missing verification key",
        "verification key is missing",
        key_allowlist="missing_key",
    )

    reject_signed(
        "Control command-id binding mismatch",
        "Control command_id does not match",
        build_control(
            command_id=(
                "22222222-2222-4333-8444-555555555555"
            )
        ),
    )
    reject_signed(
        "Control doc-version binding mismatch",
        "Control doc_version does not match",
        build_control(doc_version=DOC_VERSION + 1),
    )
    reject_signed(
        "Control capability-ref binding mismatch",
        "Control cap_ref does not match",
        build_control(cap_ref=CAP_REF + 1),
    )
    reject_signed(
        "Control controller-origin binding mismatch",
        "Control controller_origin_id does not match",
        build_control(
            origin_id=(
                "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"
            )
        ),
    )
    reject_signed(
        "Control controller-class binding mismatch",
        "Control controller_class does not match",
        build_control(controller_class=2),
    )
    reject_signed(
        "Control scope binding mismatch",
        "Control scope_id does not match",
        build_control(scope_id="Y" + SCOPE_ID[1:]),
    )
    reject_signed(
        "duplicate Control command field",
        "duplicate Control field",
        build_control(
            extra=field_bytes(1, COMMAND_ID.encode())
        ),
    )
    reject_signed(
        "unknown Control field",
        "unknown or wrong-wire Control field",
        build_control(extra=field_bytes(11, b"")),
    )
    reject_signed(
        "Control field number zero",
        "Control field number zero",
        build_control(extra=b"\x00"),
    )
    noncanonical_control = (
        field_bytes(1, COMMAND_ID.encode())
        + b"\x10\x8c\x00"
        + field_varint(3, CAP_REF)
        + field_bytes(8, build_controller())
        + field_bytes(9, build_lease())
        + field_bytes(10, build_schedule_transition())
    )
    reject_signed(
        "noncanonical Control varint",
        "Control.doc_version varint is not canonical",
        noncanonical_control,
    )
    reject_signed(
        "invalid Control command UTF-8",
        "Control.command_id is not UTF-8",
        build_control(command_id=b"\xff"),
    )
    reject_signed(
        "overlong Control command-id",
        "Control.command_id length out of range",
        build_control(command_id=b"c" * 64),
    )
    reject_signed(
        "missing Control controller",
        "Control binding field is missing",
        build_control(include_controller=False),
    )
    reject_signed(
        "missing Control lease",
        "Control binding field is missing",
        build_control(include_lease=False),
    )
    reject_signed(
        "missing Control payload",
        "Control payload is missing",
        build_control(include_payload=False),
    )
    reject_signed(
        "legacy scalar Control payload",
        "schedule_transition field 10 is required",
        build_control(payload_field=4),
    )
    reject_signed(
        "deprecated Schedule Control payload",
        "schedule_transition field 10 is required",
        build_control(payload_field=5),
    )
    reject_signed(
        "legacy ScheduleIntent Control payload",
        "schedule_transition field 10 is required",
        build_control(payload_field=6),
    )
    reject_signed(
        "replacement-only AbsoluteScheduleIntent Control payload",
        "schedule_transition field 10 is required",
        build_control(payload_field=7),
    )
    reject_signed(
        "empty schedule_transition",
        "must contain replacement or cancellation",
        build_control(
            include_payload=False,
            extra=field_bytes(10, b""),
        ),
    )
    reject_signed(
        "unknown schedule_transition operation",
        "unknown or wrong-wire operation",
        build_control(
            include_payload=False,
            extra=field_bytes(10, field_bytes(3, b"")),
        ),
    )
    reject_signed(
        "multiple schedule_transition operations",
        "multiple operations",
        build_control(
            include_payload=False,
            extra=field_bytes(
                10,
                (
                    build_schedule_transition()
                    + build_schedule_cancellation()
                ),
            ),
        ),
    )
    reject_signed(
        "multiple Control payloads",
        "schedule_transition field 10 is required",
        build_control(extra=field_bytes(4, b"")),
    )
    reject_signed(
        "duplicate controller origin",
        "duplicate Controller.controller field",
        build_control(
            include_controller=False,
            extra=field_bytes(
                8,
                (
                    build_controller()
                    + field_bytes(1, ORIGIN_ID.encode())
                ),
            ),
        ),
    )
    reject_signed(
        "unknown controller field",
        "unknown or wrong-wire Controller.controller field",
        build_control(
            include_controller=False,
            extra=field_bytes(
                8, build_controller() + field_varint(3, 1)
            ),
        ),
    )
    reject_signed(
        "duplicate lease scope",
        "duplicate Control.lease field",
        build_control(
            include_lease=False,
            extra=field_bytes(
                9,
                (
                    build_lease()
                    + field_bytes(2, SCOPE_ID.encode())
                ),
            ),
        ),
    )
    reject_signed(
        "unknown lease field",
        "unknown or wrong-wire Control.lease field",
        build_control(
            include_lease=False,
            extra=field_bytes(
                9, build_lease() + field_varint(5, 1)
            ),
        ),
    )

    signature = bytearray(positive_signature)
    high_s = N - int.from_bytes(signature[32:], "big")
    reject(
        "canonical signature changed to high-S twin",
        "not canonical low-S",
        (
            positive_preimage
            + bytes(signature[:32])
            + high_s.to_bytes(32, "big")
            + positive_control
        ),
    )
    reject(
        "signature r zero",
        "signature scalar out of range",
        (
            positive_preimage
            + b"\x00" * 32
            + bytes(signature[32:])
            + positive_control
        ),
    )
    reject(
        "signature r equals curve order",
        "signature scalar out of range",
        (
            positive_preimage
            + N.to_bytes(32, "big")
            + bytes(signature[32:])
            + positive_control
        ),
    )
    reject(
        "signature s zero",
        "signature scalar out of range",
        (
            positive_preimage
            + bytes(signature[:32])
            + b"\x00" * 32
            + positive_control
        ),
    )
    reject(
        "signature s equals curve order",
        "signature scalar out of range",
        (
            positive_preimage
            + bytes(signature[:32])
            + N.to_bytes(32, "big")
            + positive_control
        ),
    )
    changed_signature = bytearray(positive_signature)
    changed_signature[0] ^= 1
    reject(
        "invalid P1363 signature",
        "signature verification failed",
        (
            positive_preimage
            + bytes(changed_signature)
            + positive_control
        ),
    )
    reject(
        "DER signature form",
        "trailing envelope bytes",
        (
            positive_preimage
            + der_signature(positive_signature)
            + positive_control
        ),
    )
    reject(
        "truncated signature",
        "truncated envelope",
        (
            positive_wire[: preimage_length + 63]
            + positive_control
        ),
    )
    reject(
        "extended signature",
        "trailing envelope bytes",
        (
            positive_wire[: preimage_length + 64]
            + b"\x00"
            + positive_control
        ),
    )
    changed_control = bytearray(positive_control)
    changed_control[-1] ^= 1
    reject(
        "Control payload digest mismatch",
        "Control digest mismatch",
        (
            positive_wire[: preimage_length + 64]
            + bytes(changed_control)
        ),
    )
    reject(
        "truncated Control payload",
        "truncated envelope",
        positive_wire[:-1],
    )
    reject(
        "trailing envelope byte",
        "trailing envelope bytes",
        positive_wire + b"\x00",
    )

    positive_encoded = b64url(positive_wire)
    reject(
        "padded base64url",
        "non-canonical base64url",
        envelope_base64url=positive_encoded + "=",
    )
    reject(
        "standard base64 alphabet",
        "non-canonical base64url",
        envelope_base64url=positive_encoded.replace(
            "-", "+"
        ).replace("_", "/"),
    )
    reject(
        "base64url whitespace",
        "non-canonical base64url",
        envelope_base64url=positive_encoded + "\n",
    )
    reject(
        "noncanonical base64url tail bits",
        "non-canonical base64url",
        envelope_base64url=noncanonical_tail(
            positive_encoded
        ),
    )
    reject(
        "oversized encoded envelope",
        "encoded envelope exceeds maximum",
        envelope_base64url="A" * 2065,
    )
    reject(
        "admission before skew allowance",
        "envelope is not yet valid",
        now_ms=NOT_BEFORE_MS - 30_001,
    )
    reject(
        "admission at exclusive expiry",
        "envelope is expired",
        now_ms=EXPIRES_AT_MS,
    )

    fingerprint = hashlib.sha256(positive_preimage).hexdigest()
    cancellation_control = build_control(
        include_payload=False,
        extra=field_bytes(10, build_schedule_cancellation()),
    )
    cancellation_wire = build_envelope(
        cancellation_control
    )[0]
    return {
        "profile": "lattice-control-device-audience-v1",
        "notes": (
            "Trusted repository fixture container. "
            "Correctly-signed invalid cases use the public "
            "TEST-ONLY scalar in generate_vectors.py."
        ),
        "topology_artifact_utf8": TOPOLOGY_ARTIFACT.decode(),
        "admission": {
            "receiving_device_id": DEVICE_ID,
            "transport_topic": TOPIC,
            "pinned_topology_doc_version": DOC_VERSION,
            "pinned_topology_digest_hex": (
                TOPOLOGY_DIGEST.hex()
            ),
        },
        "key_allowlists": key_allowlists,
        "positive": {
            "admission_now_ms": NOT_BEFORE_MS,
            "public_key_sec1_hex": test_public_key.hex(),
            "signature_base64url": b64url(
                positive_signature
            ),
            "control_base64url": b64url(positive_control),
            "preimage_hex": positive_preimage.hex(),
            "envelope_base64url": positive_encoded,
            "expected": {
                "profile": (
                    "lattice-control-device-audience-v1"
                ),
                "key_id": KEY_ID,
                "audience_device_id": DEVICE_ID,
                "control_topic": TOPIC,
                "command_id": COMMAND_ID,
                "controller_origin_id": ORIGIN_ID,
                "controller_class": 1,
                "scope_id": SCOPE_ID,
                "topology_doc_version": DOC_VERSION,
                "topology_digest_hex": (
                    TOPOLOGY_DIGEST.hex()
                ),
                "cap_ref": CAP_REF,
                "control_length": len(positive_control),
                "control_digest_hex": hashlib.sha256(
                    positive_control
                ).hexdigest(),
                "not_before_ms": NOT_BEFORE_MS,
                "expires_at_ms": EXPIRES_AT_MS,
                "preimage_sha256_hex": fingerprint,
                "idempotency_fingerprint_hex": fingerprint,
            },
        },
        "acceptance_cases": [
            {
                "name": "retained verification key",
                "key_allowlist": "retained",
            },
            {
                "name": "field-10 cancellation transition",
                "key_allowlist": "active",
                "envelope_base64url": b64url(
                    cancellation_wire
                ),
            },
            {
                "name": "admission at future-skew boundary",
                "key_allowlist": "active",
                "now_ms": NOT_BEFORE_MS - 30_000,
            },
            {
                "name": "admission immediately before expiry",
                "key_allowlist": "active",
                "now_ms": EXPIRES_AT_MS - 1,
            },
        ],
        "mutations": mutations,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Explicit destination for the generated corpus",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow replacing an existing destination",
    )
    args = parser.parse_args()
    if args.output.exists() and not args.force:
        print(
            f"refusing to overwrite existing {args.output}; "
            "pass --force explicitly",
            file=sys.stderr,
        )
        return 2
    encoded = json.dumps(build_corpus(), indent=2) + "\n"
    args.output.write_text(encoded)
    print(f"wrote {args.output} ({len(encoded.encode())} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
