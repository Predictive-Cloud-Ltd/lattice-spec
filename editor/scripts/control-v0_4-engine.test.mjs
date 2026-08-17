import test from "node:test";
import assert from "node:assert/strict";

import {
  ScheduleFenceRegistry,
  validateAbsoluteScheduleIntent,
} from "./.gen/control-v0_4-engine.js";
import { validateControlAckV04 } from "./.gen/control-result-v0_4-engine.js";

const scope = "site:GW-1:battery.mode";
const controller = { origin_id: "predbat", controller_class: "AUTOMATION" };
const authenticated = { ...controller, priority: 10 };
const lease = {
  lease_id: "lease-a",
  scope_id: scope,
  fencing_token: 1,
  expires_ts_ms: 5000,
};
const control = {
  command_id: "cmd-1",
  doc_version: 12,
  cap_ref: 41,
  controller,
  lease,
};

test("wire controller claims cannot self-assert identity, class, or local priority", () => {
  const registry = new ScheduleFenceRegistry();
  const wrongOrigin = registry.admit(
    { ...control, controller: { ...controller, origin_id: "attacker" } },
    authenticated,
    scope,
    1000,
  );
  assert.equal(wrongOrigin.ok, false);
  assert.equal(wrongOrigin.rejection.reason, "AUTHENTICATED_ORIGIN_MISMATCH");
  assert.equal(wrongOrigin.rejection.fallback, "BLOCKED");

  const badPriority = registry.admit(control, { ...authenticated, priority: -1 }, scope, 1000);
  assert.equal(badPriority.ok, false);
  assert.equal(badPriority.rejection.reason, "AUTHENTICATED_ORIGIN_MISMATCH");
});

test("UNKNOWN can quarantine only the command admitted for that exact scope", () => {
  const registry = new ScheduleFenceRegistry();
  assert.throws(
    () => registry.markUnknown(scope, "cmd-1", 1000),
    /only the command admitted/,
  );
  assert.equal(registry.admit(control, authenticated, scope, 1000).ok, true);
  assert.throws(
    () => registry.markUnknown(scope, "different-command", 1100),
    /only the command admitted/,
  );
  registry.markUnknown(scope, "cmd-1", 1100);
  const blocked = registry.admit(control, authenticated, scope, 1200);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rejection.reason, "SCOPE_QUARANTINED");
});

test("a scope admits one command at a time and terminal completion releases it", () => {
  const registry = new ScheduleFenceRegistry();
  assert.equal(registry.admit(control, authenticated, scope, 1000).ok, true);
  const busy = registry.admit(
    { ...control, command_id: "cmd-2" },
    authenticated,
    scope,
    1100,
  );
  assert.equal(busy.ok, false);
  assert.equal(busy.rejection.reason, "SCOPE_BUSY");
  assert.equal(busy.rejection.fallback, "BLOCKED");

  registry.complete(scope, "cmd-1", "APPLIED", 1200);
  assert.equal(
    registry.admit(
      { ...control, command_id: "cmd-2" },
      authenticated,
      scope,
      1300,
    ).ok,
    true,
  );
});

test("receiver clock and embedded eight-slot limit fail closed independently of offer data", () => {
  const invalidClock = new ScheduleFenceRegistry().admit(
    control,
    authenticated,
    scope,
    0,
  );
  assert.equal(invalidClock.ok, false);
  assert.equal(invalidClock.rejection.reason, "INTERNAL");
  assert.equal(invalidClock.rejection.fallback, "BLOCKED");

  const slots = Array.from({ length: 9 }, (_, index) => ({
    start_ts_ms: 2000 + index * 1000,
    end_ts_ms: 3000 + index * 1000,
    mode: "self_use",
  }));
  const offer = {
    scheduleSpec: {
      maxSlots: 64,
      slotFields: [],
      timeBasis: "absolute_utc_ms",
      supportedModes: ["self_use"],
      gapPolicy: "REJECT",
      executionModes: ["NATIVE"],
    },
  };
  const intent = {
    slots,
    valid_from_ts_ms: 2000,
    valid_until_ts_ms: 11000,
    diagnostic_timezone: "UTC",
    execution: "NATIVE",
  };
  const tooMany = validateAbsoluteScheduleIntent({}, offer, intent, 1000);
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.errors.includes("schedule has 9 slots; embedded maximum is 8"));

  const noClock = validateAbsoluteScheduleIntent({}, offer, intent, Number.NaN);
  assert.equal(noClock.ok, false);
  assert.equal(noClock.rejection.reason, "INTERNAL");
  assert.equal(noClock.rejection.fallback, "BLOCKED");
});

test("fence snapshots fail closed on duplicate or corrupt durable state", () => {
  const validState = {
    scope_id: scope,
    high_water_token: 1,
    active: { ...lease, ...controller, priority: 10 },
    admitted_command_id: "cmd-1",
  };
  assert.throws(
    () => new ScheduleFenceRegistry({ scopes: [validState, structuredClone(validState)] }),
    /duplicate/,
  );
  assert.throws(
    () => new ScheduleFenceRegistry({
      scopes: [{ ...validState, high_water_token: 2 }],
    }),
    /active lease/,
  );
  assert.throws(
    () => new ScheduleFenceRegistry({
      scopes: [{
        ...validState,
        quarantine: { command_id: "not-admitted", since_ts_ms: 1000 },
      }],
    }),
    /quarantine/,
  );
  assert.throws(
    () => new ScheduleFenceRegistry({
      scopes: [{
        scope_id: scope,
        high_water_token: 0,
        admitted_command_id: "cmd-orphaned",
      }],
    }),
    /without active lease/,
  );
  assert.throws(
    () => new ScheduleFenceRegistry({
      scopes: [{
        ...validState,
        high_water_token: 0,
        active: {
          ...validState.active,
          fencing_token: 0,
        },
      }],
    }),
    /active lease/,
  );
});

test("reason-to-fallback invariants block authority, fencing, quarantine, and internal failures", () => {
  for (const reason of [
    "AUTHENTICATED_ORIGIN_MISMATCH",
    "LEASE_EXPIRED",
    "STALE_FENCE",
    "LEASE_CONFLICT",
    "SCOPE_MISMATCH",
    "SCOPE_QUARANTINED",
    "INTERNAL",
  ]) {
    const result = validateControlAckV04({
      command_id: "cmd-rejected",
      ok: false,
      error: "rejected",
      result: "NOT_APPLIED",
      completed_ts_ms: 1000,
      rejection: {
        reason,
        fallback: "SAFE",
        detail: "must not authorize fallback",
        scope_id: scope,
      },
    });
    assert.equal(result.ok, false, `${reason} unexpectedly allowed SAFE fallback`);
    assert.ok(result.errors.some((error) => error.includes("must block fallback")));
  }
});

test("applied schedule clamp receipt is bounded and reports truncation exactly", () => {
  const clamps = Array.from({ length: 9 }, (_, slot_index) => ({
    slot_index,
    field: "TARGET_SOC",
    requested: 101,
    applied: 100,
  }));
  const result = validateControlAckV04({
    command_id: "cmd-applied",
    ok: true,
    error: "",
    result: "APPLIED",
    verified: true,
    completed_ts_ms: 1000,
    applied_schedule: {
      plan_digest: "0".repeat(64),
      accepted_slot_count: 8,
      durably_accepted: true,
      verification: "DURABLE_STORE_READBACK",
      clamps,
      clamp_count: 9,
      clamps_truncated: false,
      valid_from_ts_ms: 2000,
      valid_until_ts_ms: 3000,
    },
    accepted_lease: lease,
    controller,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("maximum 8")));
  assert.ok(result.errors.some((error) => error.includes("clamps_truncated")));
});
