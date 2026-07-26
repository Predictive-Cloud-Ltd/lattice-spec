import test from "node:test";
import assert from "node:assert/strict";

import {
  ControlResultJournal,
  validateControlAck,
} from "./.gen/control-result-engine.js";

const applied = (overrides = {}) => ({
  command_id: "cmd-1",
  ok: true,
  error: "",
  result: "APPLIED",
  applied_scalar: { i: 5000 },
  verified: false,
  completed_ts_ms: 1000,
  ...overrides,
});

test("APPLIED may report the post-clamp scalar without claiming verification", () => {
  assert.deepEqual(validateControlAck(applied()), { ok: true, errors: [] });
});

test("UNSPECIFIED and inconsistent legacy fields are rejected", () => {
  assert.equal(validateControlAck(applied({ result: "UNSPECIFIED" })).ok, false);
  assert.equal(validateControlAck(applied({ result: 0 })).ok, false);
  assert.equal(validateControlAck(applied({ ok: false })).ok, false);
  assert.equal(validateControlAck(applied({ result: "UNKNOWN", ok: false, error: "" })).ok, false);
});

test("lost ACK lookup returns the exact durable terminal result after restart", () => {
  let executions = 0;
  const journal = new ControlResultJournal({ maxEntries: 8, ttlMs: 10_000 });
  const first = journal.executeOnce("cmd-1", "sha256:request-a", 1000, () => {
    executions += 1;
    return applied();
  });
  assert.equal(first.replayed, false);

  // Simulate the MQTT ACK being lost and the gateway restarting from durable state.
  const restarted = new ControlResultJournal({
    maxEntries: 8,
    ttlMs: 10_000,
    snapshot: journal.snapshot(1500),
  });
  assert.deepEqual(restarted.lookup("cmd-1", 2000), first.ack);
  assert.equal(executions, 1);
});

test("duplicate command_id replays the original result and never executes twice", () => {
  let executions = 0;
  const journal = new ControlResultJournal();
  const execute = () => {
    executions += 1;
    return applied();
  };
  const first = journal.executeOnce("cmd-1", "sha256:same", 1000, execute);
  const duplicate = journal.executeOnce("cmd-1", "sha256:same", 1100, execute);
  assert.equal(executions, 1);
  assert.equal(duplicate.replayed, true);
  assert.deepEqual(duplicate.ack, first.ack);
});

test("reused command_id with different bytes still replays original and flags conflict", () => {
  let executions = 0;
  const journal = new ControlResultJournal();
  journal.executeOnce("cmd-1", "sha256:first", 1000, () => {
    executions += 1;
    return applied();
  });
  const conflict = journal.executeOnce("cmd-1", "sha256:different", 1100, () => {
    executions += 1;
    return applied({ applied_scalar: { i: 1000 } });
  });
  assert.equal(executions, 1);
  assert.equal(conflict.replayed, true);
  assert.equal(conflict.fingerprintConflict, true);
  assert.deepEqual(conflict.ack.applied_scalar, { i: 5000 });
});

test("journal is bounded by TTL and capacity", () => {
  const journal = new ControlResultJournal({ maxEntries: 1, ttlMs: 100 });
  journal.complete("cmd-1", "a", applied(), 1000);
  journal.complete("cmd-2", "b", applied({ command_id: "cmd-2" }), 1010);
  assert.equal(journal.lookup("cmd-1", 1020), undefined);
  assert.ok(journal.lookup("cmd-2", 1020));
  assert.equal(journal.lookup("cmd-2", 1110), undefined);
});
