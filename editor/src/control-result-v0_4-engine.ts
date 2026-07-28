import type {
  ControllerContext,
  FallbackSafety,
  LeaseFence,
  RejectionReason,
} from "./control-v0_4-engine.js";

export type ControlResult = "APPLIED" | "NOT_APPLIED" | "UNKNOWN";
export type ScheduleVerification =
  | "ACCEPTED_ONLY"
  | "DURABLE_STORE_READBACK"
  | "NATIVE_TARGET_READBACK";

export type ScheduleField =
  | "TARGET_SOC"
  | "RESERVE_SOC"
  | "CHARGE_POWER_LIMIT"
  | "DISCHARGE_POWER_LIMIT";

export type ScheduleClamp = {
  slot_index: number;
  field: ScheduleField;
  requested: number;
  applied: number;
};

export type AppliedSchedule = {
  plan_digest: string;
  accepted_slot_count: number;
  durably_accepted: boolean;
  verification: ScheduleVerification;
  clamps: ScheduleClamp[];
  clamp_count: number;
  clamps_truncated: boolean;
  valid_from_ts_ms: number;
  valid_until_ts_ms: number;
};

export type AppliedScheduleCancellation = {
  cancelled_plan_digest: string;
  writer_exclusion_released: boolean;
  verification: Exclude<ScheduleVerification, "ACCEPTED_ONLY">;
};

export type ControlRejection = {
  reason:
    | RejectionReason
    | "EXECUTION_FAILED"
    | "EXECUTION_AMBIGUOUS"
    | "VERIFICATION_FAILED"
    | "INTERNAL"
    | "UNSPECIFIED";
  fallback: FallbackSafety;
  detail: string;
  scope_id?: string;
};

export type ControlAckV04 = {
  command_id: string;
  ok: boolean;
  error: string;
  result: ControlResult | "UNSPECIFIED";
  applied_scalar?: { i?: number; d?: number; b?: boolean };
  verified?: boolean;
  completed_ts_ms: number;
  rejection?: ControlRejection;
  applied_schedule?: AppliedSchedule;
  accepted_lease?: LeaseFence;
  controller?: ControllerContext;
  applied_schedule_cancellation?: AppliedScheduleCancellation;
};

export type AckValidation = { ok: boolean; errors: string[] };

const MAX_CLAMPS = 8;
const MAX_TEXT_BYTES = {
  command_id: 63,
  error: 160,
  detail: 96,
  scope_id: 47,
  plan_digest_hex: 64,
} as const;

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

function requireBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  errors: string[],
  allowEmpty = false,
): value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    errors.push(`${label} ${allowEmpty ? "must be a string" : "is required"}`);
    return false;
  }
  if (bytes(value) > maxBytes) {
    errors.push(`${label} exceeds ${maxBytes} UTF-8 bytes`);
    return false;
  }
  return true;
}

function validateAppliedSchedule(schedule: AppliedSchedule, errors: string[]): void {
  if (
    typeof schedule.plan_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(schedule.plan_digest) ||
    bytes(schedule.plan_digest) !== MAX_TEXT_BYTES.plan_digest_hex
  ) {
    errors.push("applied_schedule.plan_digest must be 32-byte SHA-256 lowercase hex");
  }
  if (!Number.isInteger(schedule.accepted_slot_count) || schedule.accepted_slot_count < 0) {
    errors.push("applied_schedule.accepted_slot_count must be a non-negative integer");
  }
  if (schedule.durably_accepted !== true) {
    errors.push("APPLIED schedule must be durably accepted before ack");
  }
  if (!["ACCEPTED_ONLY", "DURABLE_STORE_READBACK", "NATIVE_TARGET_READBACK"].includes(schedule.verification)) {
    errors.push("applied_schedule.verification is invalid");
  }
  if (!Array.isArray(schedule.clamps)) {
    errors.push("applied_schedule.clamps must be an array");
    return;
  }
  if (schedule.clamps.length > MAX_CLAMPS) {
    errors.push(`applied_schedule.clamps exceeds embedded maximum ${MAX_CLAMPS}`);
  }
  if (!Number.isInteger(schedule.clamp_count) || schedule.clamp_count < 0) {
    errors.push("applied_schedule.clamp_count must be a non-negative integer");
  } else {
    const returnedCount = Math.min(schedule.clamp_count, MAX_CLAMPS);
    if (schedule.clamps.length !== returnedCount) {
      errors.push("applied_schedule.clamps must return min(clamp_count, 8) entries");
    }
    const expectedTruncation = schedule.clamp_count > MAX_CLAMPS;
    if (schedule.clamps_truncated !== expectedTruncation) {
      errors.push("applied_schedule.clamps_truncated must match the embedded clamp bound");
    }
  }
  for (const [index, clamp] of schedule.clamps.entries()) {
    if (!Number.isInteger(clamp.slot_index) || clamp.slot_index < 0) {
      errors.push(`applied_schedule.clamps[${index}].slot_index is invalid`);
    }
    if (![
      "TARGET_SOC",
      "RESERVE_SOC",
      "CHARGE_POWER_LIMIT",
      "DISCHARGE_POWER_LIMIT",
    ].includes(clamp.field)) {
      errors.push(`applied_schedule.clamps[${index}].field is invalid`);
    }
    if (!Number.isFinite(clamp.requested) || !Number.isFinite(clamp.applied)) {
      errors.push(`applied_schedule.clamps[${index}] values must be finite`);
    }
  }
  if (
    !Number.isSafeInteger(schedule.valid_from_ts_ms) ||
    !Number.isSafeInteger(schedule.valid_until_ts_ms) ||
    schedule.valid_from_ts_ms >= schedule.valid_until_ts_ms
  ) {
    errors.push("applied_schedule validity must be a non-empty half-open interval");
  }
}

function validateAppliedScheduleCancellation(
  cancellation: AppliedScheduleCancellation,
  errors: string[],
): void {
  if (
    typeof cancellation.cancelled_plan_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(cancellation.cancelled_plan_digest)
  ) {
    errors.push("applied_schedule_cancellation.cancelled_plan_digest must be 32-byte SHA-256 lowercase hex");
  }
  if (cancellation.writer_exclusion_released !== true) {
    errors.push("APPLIED cancellation must confirm writer exclusion release");
  }
  if (!["DURABLE_STORE_READBACK", "NATIVE_TARGET_READBACK"].includes(cancellation.verification)) {
    errors.push("APPLIED cancellation requires durable or native readback verification");
  }
}

export function validateControlAckV04(ack: unknown): AckValidation {
  const errors: string[] = [];
  if (!ack || typeof ack !== "object") return { ok: false, errors: ["ack must be an object"] };
  const value = ack as Partial<ControlAckV04>;
  requireBoundedText(value.command_id, "command_id", MAX_TEXT_BYTES.command_id, errors);
  requireBoundedText(value.error, "error", MAX_TEXT_BYTES.error, errors, value.result === "APPLIED");
  if (!["APPLIED", "NOT_APPLIED", "UNKNOWN"].includes(String(value.result))) {
    errors.push("result must be APPLIED, NOT_APPLIED, or UNKNOWN");
  }
  if (!Number.isSafeInteger(value.completed_ts_ms) || Number(value.completed_ts_ms) <= 0) {
    errors.push("completed_ts_ms must be a positive safe integer");
  }

  const hasScalar = value.applied_scalar != null;
  const hasSchedule = value.applied_schedule != null;
  const hasCancellation = value.applied_schedule_cancellation != null;
  if (value.result === "APPLIED") {
    if (value.ok !== true) errors.push("legacy ok must be true for APPLIED");
    if (value.error !== "") errors.push("legacy error must be empty for APPLIED");
    if (value.rejection != null) errors.push("APPLIED must not carry rejection");
    if (Number(hasScalar) + Number(hasSchedule) + Number(hasCancellation) !== 1) {
      errors.push("APPLIED must carry exactly one applied scalar, replacement, or cancellation payload");
    }
    if (hasSchedule) validateAppliedSchedule(value.applied_schedule!, errors);
    if (hasCancellation) {
      validateAppliedScheduleCancellation(value.applied_schedule_cancellation!, errors);
    }
    if ((hasSchedule || hasCancellation) && !value.accepted_lease) {
      errors.push("APPLIED schedule transition must echo accepted_lease");
    }
    if ((hasSchedule || hasCancellation) && !value.controller) {
      errors.push("APPLIED schedule transition must echo controller");
    }
    if (hasSchedule) {
      const verification = value.applied_schedule!.verification;
      const shouldVerify = verification === "DURABLE_STORE_READBACK" || verification === "NATIVE_TARGET_READBACK";
      if (Boolean(value.verified) !== shouldVerify) {
        errors.push("legacy verified must mirror schedule verification readback");
      }
    }
    if (hasCancellation && value.verified !== true) {
      errors.push("legacy verified must be true for definite schedule authority release");
    }
  } else if (value.result === "NOT_APPLIED" || value.result === "UNKNOWN") {
    if (value.ok !== false) errors.push(`legacy ok must be false for ${value.result}`);
    if (typeof value.error !== "string" || value.error.length === 0) {
      errors.push(`legacy error is required for ${value.result}`);
    }
    if (hasScalar || hasSchedule || hasCancellation) {
      errors.push(`${value.result} must not carry an applied payload`);
    }
    if (value.verified === true) errors.push(`verified is invalid for ${value.result}`);
    if (!value.rejection) {
      errors.push(`${value.result} requires structured rejection`);
    } else {
      if (value.rejection.reason === "UNSPECIFIED") errors.push("rejection reason must be specified");
      if (!["SAFE", "BLOCKED"].includes(value.rejection.fallback)) {
        errors.push("rejection fallback classification must be specified");
      }
      requireBoundedText(
        value.rejection.detail,
        "rejection.detail",
        MAX_TEXT_BYTES.detail,
        errors,
      );
      if (
        value.rejection.scope_id != null &&
        (typeof value.rejection.scope_id !== "string" ||
          bytes(value.rejection.scope_id) > MAX_TEXT_BYTES.scope_id)
      ) {
        errors.push("rejection.scope_id exceeds embedded bound");
      }
      if (value.result === "UNKNOWN") {
        if (value.rejection.reason !== "EXECUTION_AMBIGUOUS") {
          errors.push("UNKNOWN requires EXECUTION_AMBIGUOUS reason");
        }
        if (value.rejection.fallback !== "BLOCKED") {
          errors.push("UNKNOWN must block fallback");
        }
        if (!value.rejection.scope_id) errors.push("UNKNOWN must identify quarantined scope");
      }
      const blockedReasons = new Set([
        "AUTHENTICATED_ORIGIN_MISMATCH",
        "LEASE_EXPIRED",
        "STALE_FENCE",
        "LEASE_CONFLICT",
        "SCOPE_MISMATCH",
        "SCOPE_QUARANTINED",
        "SCOPE_BUSY",
        "COMMAND_ID_COLLISION",
        "NO_ACTIVE_SCHEDULE",
        "PLAN_DIGEST_MISMATCH",
        "AUTHORITY_RELEASE_UNCONFIRMED",
        "EXECUTION_AMBIGUOUS",
        "INTERNAL",
      ]);
      if (
        blockedReasons.has(value.rejection.reason) &&
        value.rejection.fallback !== "BLOCKED"
      ) {
        errors.push(`${value.rejection.reason} must block fallback`);
      }
    }
  }

  if (hasScalar) {
    const scalar = value.applied_scalar as Record<string, unknown>;
    const present = ["i", "d", "b"].filter((key) => hasOwn(scalar, key));
    if (present.length !== 1) errors.push("applied_scalar must contain exactly one scalar value");
  }
  return { ok: errors.length === 0, errors };
}
