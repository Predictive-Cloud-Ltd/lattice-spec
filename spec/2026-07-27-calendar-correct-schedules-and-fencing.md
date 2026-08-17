# Lattice 0.4: calendar-correct schedules, fencing, and bounded results

Status: **normative for the `0.4.0/` artifacts**.

This document defines the runtime semantics of
`Control.absolute_schedule_intent` (field 7), controller fencing, structured
rejections, and schedule application results. It supersedes the local-HHMM
schedule semantics for senders and receivers that advertise Lattice 0.4. The
frozen 0.2 and 0.3 contracts remain unchanged.

The v0.4 fencing profile is deliberately **schedule-only**. `controller` and
`lease` are required with `absolute_schedule_intent`; their presence does not
retroactively change scalar, legacy field-5, or v0.3 field-6 behavior. A future
version may generalize the same envelope to other payloads.

## 1. Compatibility boundary

- A sender uses field 7 only against a retained `topologyVersion: "0.4.0"`
  schedule offer.
- A v0.3 decoder does not know field 7. It therefore sees the `Control.payload`
  oneof as unset and must nack/no-op. It must not guess a legacy field-5 or
  field-6 schedule.
- Fields 1–6 of `Control` and fields 1–7 of `ControlAck` retain their v0.3
  numbers and layouts.
- A v0.4 receiver may continue to implement v0.3 field 6 as a separately
  negotiated compatibility profile. It must never reinterpret field 6 as field
  7.

## 2. Temporal model

An `AbsoluteScheduleIntent` is a one-shot complete replacement plan.

- `valid_from_ts_ms` is inclusive.
- `valid_until_ts_ms` is exclusive and must be greater than
  `valid_from_ts_ms`.
- Every slot is the half-open interval `[start_ts_ms, end_ts_ms)`.
- All four boundary fields are Unix epoch milliseconds denoting UTC instants.
- Slots must be sorted, non-empty, non-overlapping, and contained by the
  validity interval.
- Adjacency is exact: one slot may start at the preceding slot's end. No minute
  is shared and there is no implicit inclusive-end conversion.
- A slot may cross a local midnight or span more than one local calendar day.
  The receiver performs no midnight splitting.
- `diagnostic_timezone` is a bounded IANA timezone name for logs and UI. It
  never changes a boundary instant and is not an input to execution.

The producer performs any calendar-to-instant conversion before encoding the
control. Consequently:

- A nonexistent wall time in a spring DST gap cannot appear ambiguously on the
  wire; the producer must resolve or reject it before sending.
- The first and second occurrence of an autumn-fold wall time have different
  UTC instants.
- Receivers with different timezone-database versions execute the same
  instants.
- "Today", "tomorrow", and midnight are not receiver-local concepts.

The language-neutral corpus includes Europe/London gap and fold examples, but
the rule is timezone-independent.

## 3. Gaps, defaults, modes, and execution

Every 0.4 schedule offer declares:

- `timeBasis: "absolute_utc_ms"`;
- a non-empty `supportedModes` set;
- `gapPolicy: "DEFAULT_MODE" | "REJECT"`;
- one or both `executionModes`;
- `leaseRequired: true`;
- a finite `maxSlots` and accepted `slotFields`.

Both slot `mode` and `default_mode` must occur in `supportedModes`.
Unsupported modes reject the whole plan; they are never silently mapped.

With `gapPolicy: "DEFAULT_MODE"`, `default_mode` is required if any portion of
the validity interval is uncovered, including an empty slot list. It applies
exactly to those uncovered instants. With `gapPolicy: "REJECT"`, slots must
cover the whole validity interval and no implicit state is retained from a
previous plan.

`NATIVE` means the receiver installs the complete plan into the target's native
scheduler. `CONTROLLER_STEPPED` means the receiver durably owns the plan and
applies transitions at boundaries. Both are atomic plan-replacement semantics;
neither permits applying a valid prefix of an invalid plan.

## 4. Authenticated controller context

`ControllerContext` contains an `origin_id` and a coarse `controller_class`.
They are diagnostic claims, not credentials and not priority.

The receiver obtains the authenticated principal from the transport/session
and obtains class plus priority from trusted local or lease-authority policy.
It must compare the byte claims with that authenticated context before any
write. A mismatch is `AUTHENTICATED_ORIGIN_MISMATCH`.

There is deliberately no priority integer in `Control`. A client cannot gain
authority by writing a larger number or a more privileged class into the
message.

## 5. Lease and fencing state machine

The receiver derives a canonical control scope from the resolved capability
offer and exact owned target set. It compares that value with
`LeaseFence.scope_id`; clients cannot narrow or change scope to evade
ownership.

Per canonical scope, durable receiver state contains:

- the maximum accepted `fencing_token`;
- the active lease identity, owner, class-policy priority, token, and exclusive
  expiry;
- optional UNKNOWN quarantine state.

Rules:

1. A lease id and scope are required. Token must be positive and expiry must be
   after admission time.
2. A token below the durable high-water mark is stale, including after reboot
   or lease expiry.
3. Commands under the exact active lease may reuse its token and exact expiry.
4. Renewal requires the same lease/owner and a strictly higher token. Expiry
   cannot be extended under an unchanged token.
5. While a lease is live, a different owner may pre-empt it only when trusted
   local policy gives that authenticated owner higher priority **and** its
   trusted lease grant has a higher token.
6. Equal/lower priority owners receive `LEASE_CONFLICT`.
7. After expiry, an authenticated owner may acquire the scope only with a token
   above the durable high-water mark.
8. Accepted high-water state is persisted before execution. Reboot must not
   make an old token current again.
9. Each scope has at most one admitted command awaiting a terminal outcome.
   A different command receives `SCOPE_BUSY`, even under the same lease/token.
   Duplicate bytes with the same command id are handled by durable result
   replay. `APPLIED`/`NOT_APPLIED` completion releases the in-flight slot;
   `UNKNOWN` retains it under quarantine until positive reconciliation.

Lease expiry controls admission of new commands; it does not retroactively
cancel an already `APPLIED` schedule or prove that its target-visible effects
stopped. An applied `NATIVE` or `CONTROLLER_STEPPED` plan remains authoritative
until its exclusive `valid_until_ts_ms` or an explicit, atomically accepted
replacement/cancellation. The two execution modes have the same ownership
semantics even though one stores the plan in the target and the other stores it
in the receiver.

A newly authorized owner may atomically supersede the installed plan. It must
not write through a scalar/legacy path in parallel merely because the previous
admission lease expired. Senders that require execution to stop with a lease
must bound `valid_until_ts_ms` by that lease expiry or send an explicit
replacement/cancellation before handoff.

The reference TypeScript state machine and fencing corpus pin these rules.

## 6. UNKNOWN quarantine

`UNKNOWN` means a target-visible effect may have happened. The receiver:

- durably stores the terminal result;
- quarantines the canonical scope before publishing the ACK;
- rejects new control for that scope with `SCOPE_QUARANTINED`;
- retains the quarantine across reboot.

Only positive reconciliation of the quarantining command to `APPLIED` or
`NOT_APPLIED`, or an explicitly audited administrative recovery operation,
clears quarantine. Timeout, lease expiry, a new lease, or a higher priority
does not clear it.

This is scope quarantine, not merely command-id deduplication. It prevents a
new command or fallback path from creating a conflicting state while the first
outcome is ambiguous.

## 7. Structured rejection and fallback

Every `NOT_APPLIED` and `UNKNOWN` ACK carries `ControlRejection`:

- a machine-readable `reason`;
- `SAFE` or `BLOCKED` fallback classification;
- bounded human detail;
- the canonical scope when known.

`SAFE` means an equivalent intent may be attempted through another
**already-authorized Lattice access path** without double-writing. It does not
authorize a legacy protocol downgrade, a different intent, or bypassing lease
policy. Authentication, lease conflict, stale-fence, scope mismatch, and
quarantine rejections are `BLOCKED`.

Every `UNKNOWN` is `EXECUTION_AMBIGUOUS`, `BLOCKED`, and identifies the
quarantined scope.

## 8. Applied schedule and verification

An `APPLIED` schedule ACK carries an `AppliedSchedule` receipt instead of
echoing the full plan:

- a 32-byte SHA-256 digest over the receiver's canonical applied plan;
- accepted slot count and validity;
- `durably_accepted`;
- a verification level;
- clamp count and at most eight clamp details.

`clamp_count` is the total. `clamps_truncated` is true exactly when that total
exceeds the returned list. A receiver must never omit the fact that additional
clamps occurred.

Verification values mean:

- `ACCEPTED_ONLY`: the coordinator accepted the plan but no durable/native
  readback was completed.
- `DURABLE_STORE_READBACK`: the exact durable controller plan was read back.
  This does not assert future child boundary writes.
- `NATIVE_TARGET_READBACK`: the complete native target schedule was read back.

The legacy `ControlAck.verified` bit is true exactly for the two readback
levels. `APPLIED` requires durable acceptance. If durable acceptance cannot be
proved, the result is not `APPLIED`.

## 9. Embedded profile

The normative embedded profile pins:

- at most 8 input slots;
- at most 8 returned clamp details;
- 63-byte command ids (64-byte nanopb arrays include NUL);
- 36-byte origin and lease ids (UUID profile);
- 47-byte diagnostic timezone names;
- 47-byte opaque canonical scope ids (base64url digest profile);
- 24-byte mode strings;
- 160-byte legacy error and 96-byte structured detail;
- exactly 32 digest bytes.

The protobuf compatibility test builds maximum-profile messages, records their
encoded sizes, and enforces a 1024-byte maximum for both `Control` and
`ControlAck`. Implementations may negotiate smaller offer limits but must not
silently truncate input schedules.

## 10. Conformance order

A receiver performs these gates before target-visible work:

1. Decode and enforce embedded bounds.
2. Match document and schedule offer.
3. Validate the complete absolute plan.
4. Verify authenticated controller context.
5. Derive and match canonical scope.
6. Admit the durable lease/fence state.
7. Stage, persist, and verify the complete plan.
8. Atomically promote/install it.
9. Persist terminal result and any UNKNOWN quarantine.
10. Publish ACK.

Failures before target-visible work are `NOT_APPLIED`. A definite execution
failure is `NOT_APPLIED` only after verified rollback. Any ambiguity is
`UNKNOWN`, never optimistic fallback.
