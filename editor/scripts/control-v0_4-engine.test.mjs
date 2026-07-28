import test from "node:test";
import assert from "node:assert/strict";

import {
  ScheduleFenceRegistry,
  canonicalScheduleScopeSerialization,
  deriveCanonicalScheduleScopeId,
  validateScheduleTransitionControl,
  validateAbsoluteScheduleIntent,
} from "./.gen/control-v0_4-engine.js";
import { validateControlAckV04 } from "./.gen/control-result-v0_4-engine.js";
import {
  CommandIdentityRegistry,
  ScheduleAuthorityRegistry,
} from "./.gen/schedule-authority-v0_4-engine.js";

const scope = "site:GW-1:battery.mode";
const controller = { origin_id: "predbat", controller_class: "AUTOMATION" };
const authenticated = {
  authenticated: true,
  profile: "MQTT_BROKER",
  session_id: "broker-session-predbat",
  principal_id: "predbat",
  policy_controller_class: "AUTOMATION",
  policy_priority: 10,
};
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

const replacementApplied = (planDigest) => ({
  result: "APPLIED",
  evidence: {
    kind: "REPLACEMENT",
    plan_digest: planDigest,
    durably_accepted: true,
  },
});

const cancellationApplied = (planDigest) => ({
  result: "APPLIED",
  evidence: {
    kind: "CANCELLATION",
    cancelled_plan_digest: planDigest,
    writer_exclusion_released: true,
    verification: "DURABLE_STORE_READBACK",
  },
});

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

  const badPriority = registry.admit(
    control,
    { ...authenticated, policy_priority: -1 },
    scope,
    1000,
  );
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

test("canonical scope is receiver-derived from pinned resolution inputs", async () => {
  const input = {
    doc_version: 12,
    cap_ref: 41,
    altitude: "leaves",
    owned_node_ids: ["battery-\u03b2", "GW-1", "battery-a"],
  };
  assert.equal(
    canonicalScheduleScopeSerialization(input),
    "lattice-schedule-scope-v1\n" +
      "doc_version:12\n" +
      "cap_ref:41\n" +
      "altitude:leaves\n" +
      "owned_node_count:3\n" +
      "owned_node:4:GW-1\n" +
      "owned_node:9:battery-a\n" +
      "owned_node:10:battery-\u03b2\n",
  );
  assert.equal((await deriveCanonicalScheduleScopeId(input)).length, 43);
  await assert.rejects(
    deriveCanonicalScheduleScopeId({ ...input, altitude: "auto" }),
    /altitude/,
  );
  await assert.rejects(
    deriveCanonicalScheduleScopeId({ ...input, owned_node_ids: ["GW-1", "GW-1"] }),
    /duplicates/,
  );
});

test("explicit schedule transition accepts one replacement or guarded cancellation", () => {
  const doc = {
    docVersion: 12,
    nodes: [{
      id: "GW-1",
      capabilities: [{
        capability: "battery.mode",
        ref: 41,
        shape: "schedule",
        control: { protocol: "lattice-executor", address: "site-schedule" },
        scheduleSpec: {
          maxSlots: 8,
          slotFields: [],
          timeBasis: "absolute_utc_ms",
          supportedModes: ["self_use"],
          gapPolicy: "REJECT",
          executionModes: ["NATIVE"],
          leaseRequired: true,
          transitionEnvelope: "atomic_replace_cancel",
          cancellationGuard: "expected_plan_digest",
          writerExclusionRelease: "applied_ending_transition",
        },
      }],
    }],
  };
  const base = { command_id: "cmd", doc_version: 12, cap_ref: 41 };
  const cancellation = validateScheduleTransitionControl(
    doc,
    {
      ...base,
      schedule_transition: {
        cancellation: {
          expected_plan_digest: "1".repeat(64),
          reason: "VALIDITY_END",
        },
      },
    },
    1000,
  );
  assert.equal(cancellation.ok, true);
  const ambiguous = validateScheduleTransitionControl(
    doc,
    {
      ...base,
      schedule_transition: {
        replacement: {
          slots: [],
          valid_from_ts_ms: 2000,
          valid_until_ts_ms: 3000,
          diagnostic_timezone: "UTC",
          execution: "NATIVE",
        },
        cancellation: {
          expected_plan_digest: "1".repeat(64),
          reason: "VALIDITY_END",
        },
      },
    },
    1000,
  );
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.rejection.reason, "MALFORMED");
});

test("command identity is immutable across payload domains and power loss", () => {
  const first = {
    command_id: "cmd-global",
    domain: "SCALAR",
    request_digest: "a".repeat(64),
    scope_id: "s".repeat(43),
  };
  let registry = new CommandIdentityRegistry();
  assert.deepEqual(registry.claim(first).ok, true);
  registry = new CommandIdentityRegistry(registry.snapshot());
  assert.equal(registry.claim(first).replay, true);
  const collision = registry.claim({
    ...first,
    domain: "ABSOLUTE_SCHEDULE_REPLACEMENT",
    request_digest: "b".repeat(64),
  });
  assert.equal(collision.ok, false);
  assert.equal(collision.rejection.reason, "COMMAND_ID_COLLISION");
  assert.equal(collision.rejection.fallback, "BLOCKED");
});

test("clock expiry and power loss retain writer exclusion until a definite ending transition", () => {
  const scopeId = "s".repeat(43);
  const planDigest = "1".repeat(64);
  let registry = new ScheduleAuthorityRegistry();
  assert.equal(
    registry.begin(scopeId, {
      kind: "REPLACE",
      command_id: "cmd-install",
      plan_digest: planDigest,
      valid_until_ts_ms: 5000,
      execution: "CONTROLLER_STEPPED",
    }).ok,
    true,
  );
  registry.complete(scopeId, "cmd-install", replacementApplied(planDigest), 1000);
  assert.equal(registry.writerExcluded(scopeId), true);
  assert.equal(registry.endingTransitionRequired(scopeId, 6000), true);
  registry = new ScheduleAuthorityRegistry(registry.snapshot());
  assert.equal(registry.writerExcluded(scopeId), true);

  assert.equal(
    registry.begin(scopeId, {
      kind: "CANCEL",
      command_id: "cmd-end",
      cancellation: {
        expected_plan_digest: planDigest,
        reason: "VALIDITY_END",
      },
    }).ok,
    true,
  );
  registry.complete(scopeId, "cmd-end", { result: "UNKNOWN" }, 6100);
  registry = new ScheduleAuthorityRegistry(registry.snapshot());
  assert.equal(registry.writerExcluded(scopeId), true);
  assert.equal(
    registry.reconcile(scopeId, "cmd-end", cancellationApplied(planDigest), 6200),
    true,
  );
  assert.equal(registry.writerExcluded(scopeId), false);
});

test("authority transitions preserve the prior state for every non-APPLIED outcome", () => {
  const scopeId = "s".repeat(43);
  const planDigest = "1".repeat(64);
  let registry = new ScheduleAuthorityRegistry();

  const noPlan = registry.begin(scopeId, {
    kind: "CANCEL",
    command_id: "cmd-no-plan",
    cancellation: {
      expected_plan_digest: planDigest,
      reason: "OPERATOR",
    },
  });
  assert.equal(noPlan.ok, false);
  assert.equal(noPlan.rejection.reason, "NO_ACTIVE_SCHEDULE");

  registry.begin(scopeId, {
    kind: "REPLACE",
    command_id: "cmd-maybe-install",
    plan_digest: planDigest,
    valid_until_ts_ms: 5000,
    execution: "NATIVE",
  });
  registry.complete(scopeId, "cmd-maybe-install", { result: "UNKNOWN" }, 1000);
  registry = new ScheduleAuthorityRegistry(registry.snapshot());
  assert.equal(registry.writerExcluded(scopeId), true);
  assert.equal(
    registry.reconcile(
      scopeId,
      "cmd-maybe-install",
      { result: "NOT_APPLIED" },
      1100,
    ),
    true,
  );
  assert.equal(registry.writerExcluded(scopeId), false);

  registry.begin(scopeId, {
    kind: "REPLACE",
    command_id: "cmd-install",
    plan_digest: planDigest,
    valid_until_ts_ms: 5000,
    execution: "NATIVE",
  });
  registry.complete(scopeId, "cmd-install", replacementApplied(planDigest), 1200);
  const mismatch = registry.begin(scopeId, {
    kind: "CANCEL",
    command_id: "cmd-wrong-plan",
    cancellation: {
      expected_plan_digest: "2".repeat(64),
      reason: "OPERATOR",
    },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.rejection.reason, "PLAN_DIGEST_MISMATCH");
  assert.equal(registry.writerExcluded(scopeId), true);

  registry.begin(scopeId, {
    kind: "CANCEL",
    command_id: "cmd-not-applied",
    cancellation: {
      expected_plan_digest: planDigest,
      reason: "OPERATOR",
    },
  });
  registry.complete(scopeId, "cmd-not-applied", { result: "NOT_APPLIED" }, 1300);
  assert.equal(registry.writerExcluded(scopeId), true);
  assert.equal(registry.installed(scopeId).plan_digest, planDigest);
});

test("authority snapshots fail closed when cancellation and installed digest are unrelated", () => {
  const scopeId = "s".repeat(43);
  const installed = {
    command_id: "cmd-install",
    plan_digest: "1".repeat(64),
    valid_until_ts_ms: 5000,
    execution: "NATIVE",
  };
  const pending = {
    kind: "CANCEL",
    command_id: "cmd-end",
    cancellation: {
      expected_plan_digest: "1".repeat(64),
      reason: "VALIDITY_END",
    },
    outcome: "PENDING",
  };
  assert.throws(
    () => new ScheduleAuthorityRegistry({
      scopes: [{ scope_id: scopeId, pending }],
    }),
    /corrupt schedule authority snapshot/,
  );
  assert.throws(
    () => new ScheduleAuthorityRegistry({
      scopes: [{
        scope_id: scopeId,
        installed,
        pending: {
          ...pending,
          cancellation: {
            ...pending.cancellation,
            expected_plan_digest: "2".repeat(64),
          },
        },
      }],
    }),
    /corrupt schedule authority snapshot/,
  );
  assert.throws(
    () => new ScheduleAuthorityRegistry({
      scopes: [{
        scope_id: scopeId,
        installed,
        pending: { ...pending, outcome: "UNKNOWN" },
      }],
    }),
    /corrupt schedule authority snapshot/,
  );
});

test("bare APPLIED or mismatching receipt evidence cannot release schedule authority", () => {
  const scopeId = "s".repeat(43);
  const planDigest = "1".repeat(64);
  const registry = new ScheduleAuthorityRegistry();
  registry.begin(scopeId, {
    kind: "REPLACE",
    command_id: "cmd-install",
    plan_digest: planDigest,
    valid_until_ts_ms: 5000,
    execution: "NATIVE",
  });
  registry.complete(scopeId, "cmd-install", replacementApplied(planDigest), 1000);
  registry.begin(scopeId, {
    kind: "CANCEL",
    command_id: "cmd-end",
    cancellation: {
      expected_plan_digest: planDigest,
      reason: "VALIDITY_END",
    },
  });

  assert.throws(
    () => registry.complete(scopeId, "cmd-end", "APPLIED", 1100),
    /exact pending schedule transition/,
  );
  assert.throws(
    () => registry.complete(
      scopeId,
      "cmd-end",
      cancellationApplied("2".repeat(64)),
      1100,
    ),
    /matching verified authority-release evidence/,
  );
  assert.equal(registry.writerExcluded(scopeId), true);
  assert.equal(registry.installed(scopeId).plan_digest, planDigest);

  registry.complete(scopeId, "cmd-end", cancellationApplied(planDigest), 1200);
  assert.equal(registry.writerExcluded(scopeId), false);
});

test("durable snapshots use deterministic UTF-8 ordering instead of locale collation", () => {
  const identity = (command_id) => ({
    command_id,
    domain: "SCALAR",
    request_digest: command_id === "z" ? "1".repeat(64) : "2".repeat(64),
    scope_id: "s".repeat(43),
  });
  const commands = new CommandIdentityRegistry();
  commands.claim(identity("\u00e4"));
  commands.claim(identity("z"));
  assert.deepEqual(
    commands.snapshot().commands.map((entry) => entry.command_id),
    ["z", "\u00e4"],
  );

  const fences = new ScheduleFenceRegistry();
  for (const [scopeId, token] of [["z", 1], ["A", 2]]) {
    fences.admit(
      {
        ...control,
        command_id: `cmd-${scopeId}`,
        lease: { ...lease, scope_id: scopeId, fencing_token: token },
      },
      authenticated,
      scopeId,
      1000,
    );
  }
  assert.deepEqual(
    fences.snapshot().scopes.map((entry) => entry.scope_id),
    ["A", "z"],
  );
});

test("APPLIED cancellation requires verified writer-exclusion release", () => {
  const ack = {
    command_id: "cmd-end",
    ok: true,
    error: "",
    result: "APPLIED",
    verified: false,
    completed_ts_ms: 6200,
    applied_schedule_cancellation: {
      cancelled_plan_digest: "1".repeat(64),
      writer_exclusion_released: false,
      verification: "ACCEPTED_ONLY",
    },
    accepted_lease: lease,
    controller,
  };
  const invalid = validateControlAckV04(ack);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("writer exclusion")));
  assert.ok(invalid.errors.some((error) => error.includes("readback")));
  assert.ok(invalid.errors.some((error) => error.includes("verified")));
});
