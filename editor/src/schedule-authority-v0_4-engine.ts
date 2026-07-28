import type {
  FallbackSafety,
  RejectionReason,
  ScheduleCancellation,
  ScheduleExecution,
} from "./control-v0_4-engine.js";

export type CommandDomain =
  | "SCALAR"
  | "LEGACY_SCHEDULE"
  | "ABSOLUTE_SCHEDULE_REPLACEMENT"
  | "ABSOLUTE_SCHEDULE_CANCELLATION";

export type CommandIdentity = {
  command_id: string;
  domain: CommandDomain;
  // SHA-256 of the exact received Control protobuf bytes, lowercase hex.
  request_digest: string;
  scope_id: string;
};

export type CommandIdentitySnapshot = { commands: CommandIdentity[] };
export type CommandIdentityDecision =
  | { ok: true; replay: boolean; identity: CommandIdentity }
  | {
      ok: false;
      rejection: {
        reason: RejectionReason;
        fallback: FallbackSafety;
        detail: string;
        scope_id: string;
      };
    };

const MAX_COMMAND_ID_BYTES = 63;
const MAX_SCOPE_ID_BYTES = 47;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const sha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function compareUtf8(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function validIdentity(identity: CommandIdentity): boolean {
  return (
    Boolean(identity) &&
    typeof identity.command_id === "string" &&
    identity.command_id.length > 0 &&
    bytes(identity.command_id) <= MAX_COMMAND_ID_BYTES &&
    ["SCALAR", "LEGACY_SCHEDULE", "ABSOLUTE_SCHEDULE_REPLACEMENT", "ABSOLUTE_SCHEDULE_CANCELLATION"]
      .includes(identity.domain) &&
    sha256Hex(identity.request_digest) &&
    typeof identity.scope_id === "string" &&
    identity.scope_id.length > 0 &&
    bytes(identity.scope_id) <= MAX_SCOPE_ID_BYTES
  );
}

// The command-id namespace is receiver-global, not per scope or payload
// domain. Entries live at least as long as the durable result journal.
export class CommandIdentityRegistry {
  private commands = new Map<string, CommandIdentity>();

  constructor(snapshot?: CommandIdentitySnapshot) {
    for (const identity of snapshot?.commands ?? []) {
      if (!validIdentity(identity)) throw new Error("corrupt command identity snapshot");
      if (this.commands.has(identity.command_id)) {
        throw new Error("duplicate command id in identity snapshot");
      }
      this.commands.set(identity.command_id, structuredClone(identity));
    }
  }

  claim(identity: CommandIdentity): CommandIdentityDecision {
    if (!validIdentity(identity)) {
      return {
        ok: false,
        rejection: {
          reason: "MALFORMED",
          fallback: "BLOCKED",
          detail: "command identity is malformed or unbounded",
          scope_id: identity?.scope_id ?? "",
        },
      };
    }
    const existing = this.commands.get(identity.command_id);
    if (!existing) {
      this.commands.set(identity.command_id, structuredClone(identity));
      return { ok: true, replay: false, identity: structuredClone(identity) };
    }
    if (
      existing.domain === identity.domain &&
      existing.request_digest === identity.request_digest &&
      existing.scope_id === identity.scope_id
    ) {
      return { ok: true, replay: true, identity: structuredClone(existing) };
    }
    return {
      ok: false,
      rejection: {
        reason: "COMMAND_ID_COLLISION",
        fallback: "BLOCKED",
        detail: "command_id is already bound to different immutable request bytes",
        scope_id: existing.scope_id,
      },
    };
  }

  snapshot(): CommandIdentitySnapshot {
    return {
      commands: structuredClone(
        [...this.commands.values()].sort((left, right) =>
          compareUtf8(left.command_id, right.command_id)),
      ),
    };
  }
}

export type InstalledScheduleAuthority = {
  command_id: string;
  plan_digest: string;
  valid_until_ts_ms: number;
  execution: ScheduleExecution;
};

export type ScheduleReplacementAuthority = InstalledScheduleAuthority & {
  kind: "REPLACE";
};

export type ScheduleCancellationAuthority = {
  kind: "CANCEL";
  command_id: string;
  cancellation: ScheduleCancellation;
};

export type ScheduleAuthorityTransition =
  | ScheduleReplacementAuthority
  | ScheduleCancellationAuthority;

export type ScheduleAuthorityAppliedEvidence =
  | {
      kind: "REPLACEMENT";
      plan_digest: string;
      durably_accepted: true;
    }
  | {
      kind: "CANCELLATION";
      cancelled_plan_digest: string;
      writer_exclusion_released: true;
      verification: "DURABLE_STORE_READBACK" | "NATIVE_TARGET_READBACK";
    };

export type ScheduleAuthorityTerminalOutcome =
  | { result: "NOT_APPLIED" | "UNKNOWN" }
  | { result: "APPLIED"; evidence: ScheduleAuthorityAppliedEvidence };

type PendingAuthorityTransition = ScheduleAuthorityTransition & {
  outcome: "PENDING" | "UNKNOWN";
};

type AuthorityScopeState = {
  scope_id: string;
  installed?: InstalledScheduleAuthority;
  pending?: PendingAuthorityTransition;
  quarantine_since_ts_ms?: number;
};

export type ScheduleAuthoritySnapshot = { scopes: AuthorityScopeState[] };
export type AuthorityDecision =
  | { ok: true; writer_excluded: true }
  | {
      ok: false;
      rejection: {
        reason: RejectionReason;
        fallback: "BLOCKED";
        detail: string;
        scope_id: string;
      };
    };

function validInstalled(value: InstalledScheduleAuthority): boolean {
  return (
    Boolean(value) &&
    typeof value.command_id === "string" &&
    value.command_id.length > 0 &&
    bytes(value.command_id) <= MAX_COMMAND_ID_BYTES &&
    sha256Hex(value.plan_digest) &&
    Number.isSafeInteger(value.valid_until_ts_ms) &&
    value.valid_until_ts_ms > 0 &&
    ["NATIVE", "CONTROLLER_STEPPED"].includes(value.execution)
  );
}

function validTransition(value: PendingAuthorityTransition): boolean {
  if (!value || !["PENDING", "UNKNOWN"].includes(value.outcome)) return false;
  if (value.kind === "REPLACE") return validInstalled(value);
  return (
    value.kind === "CANCEL" &&
    typeof value.command_id === "string" &&
    value.command_id.length > 0 &&
    bytes(value.command_id) <= MAX_COMMAND_ID_BYTES &&
    sha256Hex(value.cancellation?.expected_plan_digest) &&
    ["VALIDITY_END", "SUPERSEDED", "OPERATOR", "SAFETY"].includes(
      value.cancellation?.reason,
    )
  );
}

function authorityRejected(
  scopeId: string,
  reason: RejectionReason,
  detail: string,
): AuthorityDecision {
  return {
    ok: false,
    rejection: {
      reason,
      fallback: "BLOCKED",
      detail: detail.slice(0, 96),
      scope_id: scopeId,
    },
  };
}

// This registry models only target-visible schedule authority. Lease expiry is
// deliberately absent: it controls admission, not release of an applied plan.
export class ScheduleAuthorityRegistry {
  private scopes = new Map<string, AuthorityScopeState>();

  constructor(snapshot?: ScheduleAuthoritySnapshot) {
    for (const state of snapshot?.scopes ?? []) {
      if (
        !state ||
        typeof state.scope_id !== "string" ||
        state.scope_id.length === 0 ||
        bytes(state.scope_id) > MAX_SCOPE_ID_BYTES ||
        this.scopes.has(state.scope_id) ||
        (state.installed != null && !validInstalled(state.installed)) ||
        (state.pending != null && !validTransition(state.pending)) ||
        (state.pending?.kind === "CANCEL" &&
          (!state.installed ||
            state.pending.cancellation.expected_plan_digest !== state.installed.plan_digest)) ||
        ((state.pending?.outcome === "UNKNOWN") !==
          (state.quarantine_since_ts_ms != null)) ||
        (state.quarantine_since_ts_ms != null &&
          (!Number.isSafeInteger(state.quarantine_since_ts_ms) ||
            state.quarantine_since_ts_ms <= 0))
      ) {
        throw new Error("corrupt schedule authority snapshot");
      }
      this.scopes.set(state.scope_id, structuredClone(state));
    }
  }

  begin(scopeId: string, transition: ScheduleAuthorityTransition): AuthorityDecision {
    if (
      typeof scopeId !== "string" ||
      scopeId.length === 0 ||
      bytes(scopeId) > MAX_SCOPE_ID_BYTES
    ) {
      return authorityRejected(scopeId, "MALFORMED", "canonical scope_id is malformed");
    }
    const pending = { ...structuredClone(transition), outcome: "PENDING" } as PendingAuthorityTransition;
    if (!validTransition(pending)) {
      return authorityRejected(scopeId, "MALFORMED", "schedule authority transition is malformed");
    }

    const state = this.scopes.get(scopeId) ?? { scope_id: scopeId };
    if (state.pending) {
      return authorityRejected(scopeId, "SCOPE_BUSY", "scope already has an ending or replacement transition");
    }
    if (transition.kind === "CANCEL") {
      if (!state.installed) {
        return authorityRejected(scopeId, "NO_ACTIVE_SCHEDULE", "scope has no installed schedule to cancel");
      }
      if (transition.cancellation.expected_plan_digest !== state.installed.plan_digest) {
        return authorityRejected(
          scopeId,
          "PLAN_DIGEST_MISMATCH",
          "cancellation does not name the installed schedule",
        );
      }
    }
    state.pending = pending;
    this.scopes.set(scopeId, state);
    return { ok: true, writer_excluded: true };
  }

  complete(
    scopeId: string,
    commandId: string,
    outcome: ScheduleAuthorityTerminalOutcome,
    completedTsMs: number,
  ): void {
    const state = this.scopes.get(scopeId);
    if (
      !state?.pending ||
      state.pending.command_id !== commandId ||
      !outcome ||
      typeof outcome !== "object" ||
      !["APPLIED", "NOT_APPLIED", "UNKNOWN"].includes(outcome.result) ||
      !Number.isSafeInteger(completedTsMs) ||
      completedTsMs <= 0
    ) {
      throw new Error("completion must bind the exact pending schedule transition");
    }
    if (outcome.result === "APPLIED") {
      const evidence = outcome.evidence;
      if (
        state.pending.kind === "REPLACE" &&
        (!evidence ||
          evidence.kind !== "REPLACEMENT" ||
          evidence.plan_digest !== state.pending.plan_digest ||
          evidence.durably_accepted !== true)
      ) {
        throw new Error("APPLIED replacement requires matching durable acceptance evidence");
      }
      if (
        state.pending.kind === "CANCEL" &&
        (!state.installed ||
          state.pending.cancellation.expected_plan_digest !== state.installed.plan_digest ||
          !evidence ||
          evidence.kind !== "CANCELLATION" ||
          evidence.cancelled_plan_digest !== state.installed.plan_digest ||
          evidence.writer_exclusion_released !== true ||
          !["DURABLE_STORE_READBACK", "NATIVE_TARGET_READBACK"].includes(
            evidence.verification,
          ))
      ) {
        throw new Error("APPLIED cancellation requires matching verified authority-release evidence");
      }
    } else if ("evidence" in outcome) {
      throw new Error("non-APPLIED outcome must not carry application evidence");
    }

    if (outcome.result === "UNKNOWN") {
      state.pending.outcome = "UNKNOWN";
      state.quarantine_since_ts_ms = completedTsMs;
    } else {
      if (outcome.result === "APPLIED") {
        if (state.pending.kind === "REPLACE") {
          const { kind: _kind, outcome: _outcome, ...installed } = state.pending;
          state.installed = installed;
        } else {
          delete state.installed;
        }
      }
      delete state.pending;
      delete state.quarantine_since_ts_ms;
    }
    this.scopes.set(scopeId, state);
  }

  reconcile(
    scopeId: string,
    commandId: string,
    outcome: ScheduleAuthorityTerminalOutcome,
    completedTsMs: number,
  ): boolean {
    const state = this.scopes.get(scopeId);
    if (
      !state?.pending ||
      state.pending.outcome !== "UNKNOWN" ||
      state.pending.command_id !== commandId ||
      !outcome ||
      outcome.result === "UNKNOWN"
    ) {
      return false;
    }
    this.complete(scopeId, commandId, outcome, completedTsMs);
    return true;
  }

  writerExcluded(scopeId: string): boolean {
    const state = this.scopes.get(scopeId);
    return Boolean(state?.installed || state?.pending);
  }

  endingTransitionRequired(scopeId: string, nowMs: number): boolean {
    const state = this.scopes.get(scopeId);
    return Boolean(
      state?.installed &&
        Number.isSafeInteger(nowMs) &&
        nowMs >= state.installed.valid_until_ts_ms,
    );
  }

  installed(scopeId: string): InstalledScheduleAuthority | undefined {
    const installed = this.scopes.get(scopeId)?.installed;
    return installed ? structuredClone(installed) : undefined;
  }

  snapshot(): ScheduleAuthoritySnapshot {
    return {
      scopes: structuredClone(
        [...this.scopes.values()].sort((left, right) =>
          left.scope_id < right.scope_id ? -1 : left.scope_id > right.scope_id ? 1 : 0),
      ),
    };
  }
}
