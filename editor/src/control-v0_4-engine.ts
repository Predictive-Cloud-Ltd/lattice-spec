export type ScheduleExecution = "NATIVE" | "CONTROLLER_STEPPED";
export type ControllerClass = "AUTOMATION" | "MANUAL" | "SAFETY" | "GRID";

export type AbsoluteScheduleSlot = {
  start_ts_ms: number;
  end_ts_ms: number;
  mode: string;
  target_soc?: number;
  reserve_soc?: number;
  charge_power_limit?: number;
  discharge_power_limit?: number;
  enable?: boolean;
};

export type AbsoluteScheduleIntent = {
  slots: AbsoluteScheduleSlot[];
  default_mode?: string;
  valid_from_ts_ms: number;
  valid_until_ts_ms: number;
  diagnostic_timezone: string;
  execution: ScheduleExecution;
};

export type ControllerContext = {
  origin_id: string;
  controller_class: ControllerClass;
};

export type LeaseFence = {
  lease_id: string;
  scope_id: string;
  fencing_token: number;
  expires_ts_ms: number;
};

export type AbsoluteScheduleControl = {
  command_id?: string;
  doc_version?: number;
  cap_ref?: number;
  absolute_schedule_intent?: AbsoluteScheduleIntent;
  controller?: ControllerContext;
  lease?: LeaseFence;
};

export type RejectionReason =
  | "MALFORMED"
  | "STALE_DOCUMENT"
  | "UNSUPPORTED_OFFER"
  | "INVALID_SCHEDULE"
  | "UNSUPPORTED_MODE"
  | "AUTHENTICATED_ORIGIN_MISMATCH"
  | "LEASE_EXPIRED"
  | "STALE_FENCE"
  | "LEASE_CONFLICT"
  | "SCOPE_MISMATCH"
  | "SCOPE_QUARANTINED"
  | "SCOPE_BUSY"
  | "INTERNAL";

export type FallbackSafety = "SAFE" | "BLOCKED";

export type Rejection = {
  reason: RejectionReason;
  fallback: FallbackSafety;
  detail: string;
  scope_id?: string;
};

export type ScheduleValidation = {
  ok: boolean;
  errors: string[];
  rejection?: Rejection;
  plan?: AbsoluteScheduleIntent;
};

const SLOT_FIELDS = [
  "target_soc",
  "reserve_soc",
  "charge_power_limit",
  "discharge_power_limit",
  "enable",
] as const;

const MAX_TEXT = {
  command_id: 63,
  mode: 24,
  timezone: 47,
  origin_id: 36,
  lease_id: 36,
  scope_id: 47,
} as const;

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  errors: string[],
): value is string {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} is required`);
    return false;
  }
  if (byteLength(value) > maxBytes) {
    errors.push(`${label} exceeds ${maxBytes} UTF-8 bytes`);
    return false;
  }
  return true;
}

function epochMs(value: unknown, label: string, errors: string[]): value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    errors.push(`${label} must be a positive safe-integer epoch millisecond`);
    return false;
  }
  return true;
}

// IANA names are diagnostics only. This deliberately validates the portable
// name grammar, not the receiver's installed timezone database.
function validDiagnosticTimezone(value: unknown): value is string {
  if (typeof value !== "string" || byteLength(value) > MAX_TEXT.timezone) return false;
  if (value === "UTC") return true;
  if (!/^(?:Etc\/)?[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

function scheduleOffersForRef(doc: any, capRef: number): { node: any; offer: any }[] {
  const matches: { node: any; offer: any }[] = [];
  for (const node of doc?.nodes ?? []) {
    for (const offer of node?.capabilities ?? []) {
      if (offer?.ref === capRef && offer?.control && offer?.shape === "schedule") {
        matches.push({ node, offer });
      }
    }
  }
  return matches;
}

function numericBounds(node: any, field: string): { min?: number; max?: number } {
  const capability = `battery.${field}`;
  const sibling = (node?.capabilities ?? []).find((offer: any) => offer?.capability === capability);
  const min = typeof sibling?.constraints?.min === "number" ? sibling.constraints.min : undefined;
  const max = typeof sibling?.constraints?.max === "number" ? sibling.constraints.max : undefined;
  return { min, max };
}

function rejected(
  errors: string[],
  reason: RejectionReason,
  fallback: FallbackSafety = "SAFE",
  scopeId?: string,
): ScheduleValidation {
  return {
    ok: false,
    errors,
    rejection: {
      reason,
      fallback,
      detail: errors.join("; ").slice(0, 96),
      ...(scopeId ? { scope_id: scopeId } : {}),
    },
  };
}

export function validateAbsoluteScheduleIntent(
  node: any,
  offer: any,
  intent: unknown,
  nowMs: number,
): ScheduleValidation {
  const errors: string[] = [];
  if (!intent || typeof intent !== "object") {
    return rejected(["absolute_schedule_intent must be an object"], "MALFORMED");
  }

  const schedule = intent as AbsoluteScheduleIntent;
  const spec = offer?.scheduleSpec ?? {};
  const slots = Array.isArray(schedule.slots) ? schedule.slots : [];
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return rejected(
      ["receiver now_ms must be a positive safe-integer epoch millisecond"],
      "INTERNAL",
      "BLOCKED",
    );
  }
  if (!Array.isArray(schedule.slots)) errors.push("absolute_schedule_intent.slots must be an array");
  if (spec.timeBasis !== "absolute_utc_ms") {
    errors.push("schedule offer must declare timeBasis absolute_utc_ms");
  }
  if (!Number.isInteger(spec.maxSlots) || spec.maxSlots < 1) {
    errors.push("schedule offer must declare a positive maxSlots");
  } else if (slots.length > spec.maxSlots) {
    errors.push(`schedule has ${slots.length} slots; maximum is ${spec.maxSlots}`);
  }
  if (slots.length > 8) {
    errors.push(`schedule has ${slots.length} slots; embedded maximum is 8`);
  }

  const validFromOk = epochMs(schedule.valid_from_ts_ms, "valid_from_ts_ms", errors);
  const validUntilOk = epochMs(schedule.valid_until_ts_ms, "valid_until_ts_ms", errors);
  if (validFromOk && validUntilOk) {
    if (schedule.valid_from_ts_ms >= schedule.valid_until_ts_ms) {
      errors.push("validity interval must be non-empty and half-open");
    }
    if (schedule.valid_until_ts_ms <= nowMs) {
      errors.push("schedule validity has expired");
    }
  }
  if (!validDiagnosticTimezone(schedule.diagnostic_timezone)) {
    errors.push("diagnostic_timezone must be a bounded IANA timezone name");
  }

  const executionModes = new Set(spec.executionModes ?? []);
  if (!["NATIVE", "CONTROLLER_STEPPED"].includes(String(schedule.execution))) {
    errors.push("execution must be NATIVE or CONTROLLER_STEPPED");
  } else if (!executionModes.has(schedule.execution)) {
    errors.push(`execution ${schedule.execution} is not offered`);
  }

  const supportedModes = new Set(
    Array.isArray(spec.supportedModes)
      ? spec.supportedModes.filter((mode: unknown) => typeof mode === "string")
      : [],
  );
  if (supportedModes.size === 0) errors.push("schedule offer must declare supportedModes");
  if (hasOwn(schedule, "default_mode")) {
    if (!boundedText(schedule.default_mode, "default_mode", MAX_TEXT.mode, errors)) {
      // boundedText records the error.
    } else if (!supportedModes.has(schedule.default_mode)) {
      errors.push(`unsupported default_mode ${schedule.default_mode}`);
    }
  }

  const allowedFields = new Set(spec.slotFields ?? []);
  let previousEnd = schedule.valid_from_ts_ms;
  let hasGap = false;
  for (const [index, slot] of slots.entries()) {
    const label = `slot ${index}`;
    if (!slot || typeof slot !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }

    const startOk = epochMs(slot.start_ts_ms, `${label} start_ts_ms`, errors);
    const endOk = epochMs(slot.end_ts_ms, `${label} end_ts_ms`, errors);
    if (startOk && endOk) {
      if (slot.start_ts_ms >= slot.end_ts_ms) {
        errors.push(`${label} must have a non-empty half-open interval`);
      }
      if (validFromOk && slot.start_ts_ms < schedule.valid_from_ts_ms) {
        errors.push(`${label} starts before schedule validity`);
      }
      if (validUntilOk && slot.end_ts_ms > schedule.valid_until_ts_ms) {
        errors.push(`${label} ends after schedule validity`);
      }
      if (slot.start_ts_ms < previousEnd) {
        errors.push(`${label} overlaps or is not ordered`);
      } else if (slot.start_ts_ms > previousEnd) {
        hasGap = true;
      }
      previousEnd = Math.max(previousEnd, slot.end_ts_ms);
    }

    if (!boundedText(slot.mode, `${label} mode`, MAX_TEXT.mode, errors)) {
      // boundedText records the error.
    } else if (!supportedModes.has(slot.mode)) {
      errors.push(`${label} uses unsupported mode ${slot.mode}`);
    }

    for (const field of SLOT_FIELDS) {
      if (!hasOwn(slot, field)) continue;
      if (!allowedFields.has(field)) errors.push(`${label} field ${field} is not offered by scheduleSpec`);

      const value = slot[field];
      if (field === "enable") {
        if (typeof value !== "boolean") errors.push(`${label} field enable must be boolean`);
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${label} field ${field} must be a finite number`);
        continue;
      }
      const bounds = numericBounds(node, field);
      if (bounds.min != null && value < bounds.min) errors.push(`${label} field ${field} is below ${bounds.min}`);
      if (bounds.max != null && value > bounds.max) errors.push(`${label} field ${field} is above ${bounds.max}`);
    }
  }

  if (validUntilOk && previousEnd < schedule.valid_until_ts_ms) hasGap = true;
  if (slots.length === 0 && validFromOk && validUntilOk) hasGap = true;
  if (spec.gapPolicy === "REJECT" && hasGap) {
    errors.push("schedule contains a gap but gapPolicy is REJECT");
  } else if (spec.gapPolicy === "DEFAULT_MODE" && hasGap && !schedule.default_mode) {
    errors.push("schedule gaps require default_mode");
  } else if (!["REJECT", "DEFAULT_MODE"].includes(String(spec.gapPolicy))) {
    errors.push("schedule offer must declare gapPolicy");
  }

  if (errors.length) {
    const unsupported = errors.some(
      (error) => error.includes("unsupported mode") || error.includes("unsupported default_mode"),
    );
    return rejected(errors, unsupported ? "UNSUPPORTED_MODE" : "INVALID_SCHEDULE");
  }
  return { ok: true, errors: [], plan: structuredClone(schedule) };
}

export function validateAbsoluteScheduleControl(
  doc: any,
  control: AbsoluteScheduleControl,
  nowMs: number,
): ScheduleValidation {
  const errors: string[] = [];
  if (!control || typeof control !== "object") {
    return rejected(["control must be an object"], "MALFORMED");
  }
  boundedText(control.command_id, "command_id", MAX_TEXT.command_id, errors);
  if (!Number.isInteger(control.doc_version) || control.doc_version !== doc?.docVersion) {
    return rejected([...errors, "stale doc_version"], "STALE_DOCUMENT");
  }
  if (!Number.isInteger(control.cap_ref)) errors.push("cap_ref is required");
  if (!hasOwn(control, "absolute_schedule_intent")) {
    errors.push("control must contain absolute_schedule_intent field 7");
  }
  if (errors.length) return rejected(errors, "MALFORMED");

  const matches = scheduleOffersForRef(doc, control.cap_ref!);
  if (matches.length !== 1) {
    return rejected(["cap_ref does not identify exactly one schedule control offer"], "UNSUPPORTED_OFFER");
  }
  return validateAbsoluteScheduleIntent(
    matches[0].node,
    matches[0].offer,
    control.absolute_schedule_intent,
    nowMs,
  );
}

export type AuthenticatedController = ControllerContext & {
  // Deployment-local policy. This value is never accepted from Control bytes.
  priority: number;
};

type ActiveLease = LeaseFence & ControllerContext & { priority: number };
type Quarantine = { command_id: string; since_ts_ms: number };
type ScopeState = {
  scope_id: string;
  high_water_token: number;
  active?: ActiveLease;
  quarantine?: Quarantine;
  admitted_command_id?: string;
};

export type FenceSnapshot = { scopes: ScopeState[] };
export type FenceDecision =
  | { ok: true; lease: LeaseFence; renewed: boolean; preempted: boolean }
  | { ok: false; rejection: Rejection };

function fenceRejected(
  reason: RejectionReason,
  detail: string,
  scopeId?: string,
): FenceDecision {
  return {
    ok: false,
    rejection: {
      reason,
      fallback: "BLOCKED",
      detail: detail.slice(0, 96),
      ...(scopeId ? { scope_id: scopeId } : {}),
    },
  };
}

export class ScheduleFenceRegistry {
  private scopes = new Map<string, ScopeState>();

  constructor(snapshot?: FenceSnapshot) {
    for (const state of snapshot?.scopes ?? []) {
      if (
        !state ||
        typeof state.scope_id !== "string" ||
        state.scope_id.length === 0 ||
        byteLength(state.scope_id) > MAX_TEXT.scope_id
      ) {
        throw new Error("corrupt fence snapshot scope_id");
      }
      if (this.scopes.has(state.scope_id)) throw new Error("duplicate fence snapshot scope_id");
      if (!Number.isSafeInteger(state.high_water_token) || state.high_water_token < 0) {
        throw new Error("corrupt fence snapshot high_water_token");
      }
      if (state.active) {
        if (
          state.active.scope_id !== state.scope_id ||
          state.high_water_token <= 0 ||
          state.active.fencing_token <= 0 ||
          state.active.fencing_token !== state.high_water_token ||
          !state.active.lease_id ||
          byteLength(state.active.lease_id) > MAX_TEXT.lease_id ||
          !state.active.origin_id ||
          byteLength(state.active.origin_id) > MAX_TEXT.origin_id ||
          !["AUTOMATION", "MANUAL", "SAFETY", "GRID"].includes(state.active.controller_class) ||
          !Number.isSafeInteger(state.active.priority) ||
          state.active.priority < 0 ||
          state.active.priority > 65535 ||
          !Number.isSafeInteger(state.active.expires_ts_ms) ||
          state.active.expires_ts_ms <= 0
        ) {
          throw new Error("corrupt fence snapshot active lease");
        }
      } else if (state.high_water_token !== 0) {
        throw new Error("corrupt fence snapshot missing active lease");
      }
      if (
        state.admitted_command_id != null &&
        (typeof state.admitted_command_id !== "string" ||
          state.admitted_command_id.length === 0 ||
          byteLength(state.admitted_command_id) > MAX_TEXT.command_id)
      ) {
        throw new Error("corrupt fence snapshot admitted command");
      }
      if (state.admitted_command_id != null && !state.active) {
        throw new Error("corrupt fence snapshot admitted command without active lease");
      }
      if (state.quarantine) {
        if (
          !state.active ||
          !state.admitted_command_id ||
          state.quarantine.command_id !== state.admitted_command_id ||
          !Number.isSafeInteger(state.quarantine.since_ts_ms) ||
          state.quarantine.since_ts_ms <= 0
        ) {
          throw new Error("corrupt fence snapshot quarantine");
        }
      }
      this.scopes.set(state.scope_id, structuredClone(state));
    }
  }

  admit(
    control: AbsoluteScheduleControl,
    authenticated: AuthenticatedController,
    canonicalScopeId: string,
    nowMs: number,
  ): FenceDecision {
    const controller = control.controller;
    const lease = control.lease;
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      return fenceRejected("INTERNAL", "receiver clock is unavailable or invalid", canonicalScopeId);
    }
    if (!control.command_id || byteLength(control.command_id) > MAX_TEXT.command_id) {
      return fenceRejected("MALFORMED", "command_id is required and bounded", canonicalScopeId);
    }
    if (
      !controller ||
      controller.origin_id !== authenticated.origin_id ||
      controller.controller_class !== authenticated.controller_class ||
      !controller.origin_id ||
      byteLength(controller.origin_id) > MAX_TEXT.origin_id ||
      !["AUTOMATION", "MANUAL", "SAFETY", "GRID"].includes(controller.controller_class)
    ) {
      return fenceRejected(
        "AUTHENTICATED_ORIGIN_MISMATCH",
        "controller context does not match authenticated transport principal",
        canonicalScopeId,
      );
    }
    if (
      !Number.isSafeInteger(authenticated.priority) ||
      authenticated.priority < 0 ||
      authenticated.priority > 65535
    ) {
      return fenceRejected(
        "AUTHENTICATED_ORIGIN_MISMATCH",
        "authenticated controller has no local priority policy",
        canonicalScopeId,
      );
    }
    if (!lease || !lease.lease_id || !lease.scope_id) {
      return fenceRejected("MALFORMED", "lease identity and scope are required", canonicalScopeId);
    }
    if (
      byteLength(lease.lease_id) > MAX_TEXT.lease_id ||
      byteLength(lease.scope_id) > MAX_TEXT.scope_id
    ) {
      return fenceRejected("MALFORMED", "lease identity or scope exceeds embedded bounds", canonicalScopeId);
    }
    if (lease.scope_id !== canonicalScopeId) {
      return fenceRejected(
        "SCOPE_MISMATCH",
        "lease scope does not match receiver-derived target scope",
        canonicalScopeId,
      );
    }
    if (!Number.isSafeInteger(lease.fencing_token) || lease.fencing_token <= 0) {
      return fenceRejected("MALFORMED", "fencing_token must be a positive safe integer", canonicalScopeId);
    }
    if (!Number.isSafeInteger(lease.expires_ts_ms) || lease.expires_ts_ms <= nowMs) {
      return fenceRejected("LEASE_EXPIRED", "lease has expired", canonicalScopeId);
    }

    const state = this.scopes.get(canonicalScopeId) ?? {
      scope_id: canonicalScopeId,
      high_water_token: 0,
    };
    if (state.quarantine) {
      return fenceRejected(
        "SCOPE_QUARANTINED",
        `scope quarantined by UNKNOWN command ${state.quarantine.command_id}`,
        canonicalScopeId,
      );
    }
    if (
      state.admitted_command_id &&
      state.admitted_command_id !== control.command_id
    ) {
      return fenceRejected(
        "SCOPE_BUSY",
        `scope has in-flight command ${state.admitted_command_id}`,
        canonicalScopeId,
      );
    }

    const active = state.active;
    if (lease.fencing_token < state.high_water_token) {
      return fenceRejected("STALE_FENCE", "fencing token is below durable high-water mark", canonicalScopeId);
    }
    if (active && active.expires_ts_ms > nowMs) {
      const sameLease =
        active.lease_id === lease.lease_id &&
        active.origin_id === authenticated.origin_id &&
        active.controller_class === authenticated.controller_class;
      if (sameLease && lease.fencing_token === active.fencing_token) {
        if (lease.expires_ts_ms !== active.expires_ts_ms) {
          return fenceRejected(
            "STALE_FENCE",
            "lease expiry may change only with a higher fencing token",
            canonicalScopeId,
          );
        }
        state.admitted_command_id = control.command_id;
        this.scopes.set(canonicalScopeId, state);
        return { ok: true, lease: structuredClone(lease), renewed: false, preempted: false };
      }
      if (lease.fencing_token <= state.high_water_token) {
        return fenceRejected("STALE_FENCE", "fencing token is not newer than active lease", canonicalScopeId);
      }
      if (!sameLease && authenticated.priority <= active.priority) {
        return fenceRejected(
          "LEASE_CONFLICT",
          "active equal-or-higher priority controller owns scope",
          canonicalScopeId,
        );
      }

      state.high_water_token = lease.fencing_token;
      state.active = {
        ...structuredClone(lease),
        ...structuredClone(controller),
        priority: authenticated.priority,
      };
      state.admitted_command_id = control.command_id;
      this.scopes.set(canonicalScopeId, state);
      return {
        ok: true,
        lease: structuredClone(lease),
        renewed: sameLease,
        preempted: !sameLease,
      };
    }

    if (lease.fencing_token <= state.high_water_token) {
      return fenceRejected("STALE_FENCE", "fencing token is not newer than durable high-water mark", canonicalScopeId);
    }
    state.high_water_token = lease.fencing_token;
    state.active = {
      ...structuredClone(lease),
      ...structuredClone(controller),
      priority: authenticated.priority,
    };
    state.admitted_command_id = control.command_id;
    this.scopes.set(canonicalScopeId, state);
    return { ok: true, lease: structuredClone(lease), renewed: false, preempted: false };
  }

  markUnknown(scopeId: string, commandId: string, nowMs: number): void {
    this.complete(scopeId, commandId, "UNKNOWN", nowMs);
  }

  complete(
    scopeId: string,
    commandId: string,
    result: "APPLIED" | "NOT_APPLIED" | "UNKNOWN",
    nowMs: number,
  ): void {
    const state = this.scopes.get(scopeId);
    if (!state?.active || state.admitted_command_id !== commandId) {
      throw new Error("completion may bind only the command admitted for this scope");
    }
    if (
      !commandId ||
      byteLength(commandId) > MAX_TEXT.command_id ||
      !Number.isSafeInteger(nowMs) ||
      nowMs <= 0
    ) {
      throw new Error("invalid command completion input");
    }
    if (!["APPLIED", "NOT_APPLIED", "UNKNOWN"].includes(result)) {
      throw new Error("invalid command completion result");
    }
    if (result === "UNKNOWN") {
      state.quarantine = { command_id: commandId, since_ts_ms: nowMs };
    } else {
      delete state.admitted_command_id;
    }
    this.scopes.set(scopeId, state);
  }

  reconcile(
    scopeId: string,
    commandId: string,
    result: "APPLIED" | "NOT_APPLIED" | "UNKNOWN",
  ): boolean {
    const state = this.scopes.get(scopeId);
    if (!state?.quarantine || state.quarantine.command_id !== commandId || result === "UNKNOWN") {
      return false;
    }
    delete state.quarantine;
    delete state.admitted_command_id;
    return true;
  }

  snapshot(): FenceSnapshot {
    return {
      scopes: structuredClone(
        [...this.scopes.values()].sort((a, b) => a.scope_id.localeCompare(b.scope_id)),
      ),
    };
  }
}
