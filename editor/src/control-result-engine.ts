export type ControlResult = "APPLIED" | "NOT_APPLIED" | "UNKNOWN";

export type AppliedScalar =
  | { i: number }
  | { d: number }
  | { b: boolean };

export type ControlAck = {
  command_id: string;
  ok: boolean;
  error: string;
  result: ControlResult | "UNSPECIFIED" | 0;
  applied_scalar?: AppliedScalar;
  verified?: boolean;
  completed_ts_ms: number;
};

export type ResultValidation = {
  ok: boolean;
  errors: string[];
};

export function validateControlAck(ack: unknown): ResultValidation {
  const errors: string[] = [];
  if (!ack || typeof ack !== "object") return { ok: false, errors: ["ack must be an object"] };
  const value = ack as Partial<ControlAck>;
  if (!value.command_id) errors.push("command_id is required");
  if (!["APPLIED", "NOT_APPLIED", "UNKNOWN"].includes(String(value.result))) {
    errors.push("result must be APPLIED, NOT_APPLIED, or UNKNOWN");
  }
  if (!Number.isInteger(value.completed_ts_ms) || Number(value.completed_ts_ms) <= 0) {
    errors.push("completed_ts_ms must be a positive integer");
  }

  if (value.result === "APPLIED") {
    if (value.ok !== true) errors.push("legacy ok must be true for APPLIED");
    if (value.error !== "") errors.push("legacy error must be empty for APPLIED");
  } else if (value.result === "NOT_APPLIED" || value.result === "UNKNOWN") {
    if (value.ok !== false) errors.push(`legacy ok must be false for ${value.result}`);
    if (typeof value.error !== "string" || value.error.length === 0) {
      errors.push(`legacy error is required for ${value.result}`);
    }
  }

  if (value.applied_scalar != null && value.result !== "APPLIED") {
    errors.push("applied_scalar is valid only for APPLIED");
  }
  if (value.verified === true && value.result !== "APPLIED") {
    errors.push("verified is valid only for APPLIED");
  }
  if (value.applied_scalar != null) {
    const scalar = value.applied_scalar as Record<string, unknown>;
    const present = ["i", "d", "b"].filter((key) =>
      Object.prototype.hasOwnProperty.call(scalar, key),
    );
    if (present.length !== 1) errors.push("applied_scalar must contain exactly one scalar value");
  }
  return { ok: errors.length === 0, errors };
}

type JournalRecord = {
  command_id: string;
  request_fingerprint: string;
  ack: ControlAck;
  stored_at_ms: number;
};

export type JournalSnapshot = {
  records: JournalRecord[];
};

export type JournalOptions = {
  maxEntries?: number;
  ttlMs?: number;
  snapshot?: JournalSnapshot;
};

export class ControlResultJournal {
  readonly maxEntries: number;
  readonly ttlMs: number;
  private records = new Map<string, JournalRecord>();

  constructor(options: JournalOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1024;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) throw new Error("maxEntries must be positive");
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1) throw new Error("ttlMs must be positive");
    for (const record of options.snapshot?.records ?? []) {
      this.records.set(record.command_id, structuredClone(record));
    }
  }

  private prune(nowMs: number) {
    for (const [commandId, record] of this.records) {
      if (nowMs - record.stored_at_ms >= this.ttlMs) this.records.delete(commandId);
    }
    while (this.records.size > this.maxEntries) {
      const oldest = [...this.records.values()].sort((a, b) => a.stored_at_ms - b.stored_at_ms)[0];
      this.records.delete(oldest.command_id);
    }
  }

  lookup(commandId: string, nowMs: number): ControlAck | undefined {
    this.prune(nowMs);
    const record = this.records.get(commandId);
    return record ? structuredClone(record.ack) : undefined;
  }

  complete(
    commandId: string,
    requestFingerprint: string,
    ack: ControlAck,
    nowMs: number,
  ): { ack: ControlAck; replayed: boolean; fingerprintConflict: boolean } {
    this.prune(nowMs);
    const existing = this.records.get(commandId);
    if (existing) {
      return {
        ack: structuredClone(existing.ack),
        replayed: true,
        fingerprintConflict: existing.request_fingerprint !== requestFingerprint,
      };
    }

    const validation = validateControlAck(ack);
    if (!validation.ok) throw new Error(validation.errors.join("; "));
    if (ack.command_id !== commandId) throw new Error("ack command_id does not match journal key");
    this.records.set(commandId, {
      command_id: commandId,
      request_fingerprint: requestFingerprint,
      ack: structuredClone(ack),
      stored_at_ms: nowMs,
    });
    this.prune(nowMs);
    return { ack: structuredClone(ack), replayed: false, fingerprintConflict: false };
  }

  executeOnce(
    commandId: string,
    requestFingerprint: string,
    nowMs: number,
    execute: () => ControlAck,
  ): { ack: ControlAck; replayed: boolean; fingerprintConflict: boolean } {
    const existing = this.lookup(commandId, nowMs);
    if (existing) {
      const stored = this.records.get(commandId)!;
      return {
        ack: existing,
        replayed: true,
        fingerprintConflict: stored.request_fingerprint !== requestFingerprint,
      };
    }
    return this.complete(commandId, requestFingerprint, execute(), nowMs);
  }

  snapshot(nowMs: number): JournalSnapshot {
    this.prune(nowMs);
    return { records: structuredClone([...this.records.values()]) };
  }
}
