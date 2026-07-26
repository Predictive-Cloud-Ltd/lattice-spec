import test from "node:test";
import assert from "node:assert/strict";

import { validateControl } from "./.gen/control-engine.js";

const doc = {
  topologyVersion: "0.3.0",
  docVersion: 7,
  nodes: [{
    id: "GW-1",
    capabilities: [
      {
        capability: "battery.mode",
        ref: 11,
        shape: "schedule",
        control: { protocol: "modbus", address: "schedule" },
        scheduleSpec: {
          maxSlots: 2,
          slotFields: ["target_soc", "charge_power_limit", "enable"],
          requiresDefaultMode: true,
        },
      },
      { capability: "battery.target_soc", constraints: { min: 0, max: 100 }, read: {} },
      { capability: "battery.charge_power_limit", constraints: { min: 0, max: 6000 }, read: {} },
    ],
  }],
};

const base = (overrides = {}) => ({
  command_id: "cmd-1",
  doc_version: 7,
  cap_ref: 11,
  schedule_intent: {
    default_mode: "self_use",
    slots: [{
      start_hhmm: 30,
      end_hhmm: 430,
      mode: "force_charge",
      target_soc: 90,
      charge_power_limit: 0,
      enable: false,
    }],
  },
  ...overrides,
});

test("typed schedule validates and preserves presence-aware zero/false fields", () => {
  const result = validateControl(doc, base());
  assert.equal(result.ok, true);
  assert.equal(result.plan.slots[0].charge_power_limit, 0);
  assert.equal(result.plan.slots[0].enable, false);
  assert.equal(Object.hasOwn(result.plan.slots[0], "charge_power_limit"), true);
  assert.equal(Object.hasOwn(result.plan.slots[0], "enable"), true);
});

test("an old decoder seeing unknown field 6 has no payload and cannot produce a plan", () => {
  const oldDecoded = { command_id: "cmd-1", doc_version: 7, cap_ref: 11 };
  const result = validateControl(doc, oldDecoded);
  assert.equal(result.ok, false);
  assert.equal(result.plan, undefined);
  assert.ok(result.errors.some((error) => error.includes("exactly one payload")));
});

test("legacy field 5 is rejected rather than guessing what value means", () => {
  const result = validateControl(doc, {
    command_id: "cmd-1",
    doc_version: 7,
    cap_ref: 11,
    schedule: { slots: [{ start_hhmm: 30, end_hhmm: 430, value: 90 }] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.plan, undefined);
  assert.ok(result.errors.some((error) => error.includes("ambiguous")));
});

test("invalid schedules are rejected atomically with no partial plan", () => {
  const result = validateControl(doc, base({
    schedule_intent: {
      slots: [
        { start_hhmm: 900, end_hhmm: 1100, mode: "force_charge", target_soc: 101 },
        { start_hhmm: 1000, end_hhmm: 1200, mode: "", reserve_soc: 20 },
        { start_hhmm: 1300, end_hhmm: 1200, mode: "self_use" },
      ],
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.plan, undefined);
  assert.ok(result.errors.some((error) => error.includes("maximum")));
  assert.ok(result.errors.some((error) => error.includes("default_mode")));
  assert.ok(result.errors.some((error) => error.includes("above 100")));
  assert.ok(result.errors.some((error) => error.includes("overlaps")));
  assert.ok(result.errors.some((error) => error.includes("requires mode")));
  assert.ok(result.errors.some((error) => error.includes("reserve_soc is not offered")));
  assert.ok(result.errors.some((error) => error.includes("must end after")));
});

test("stale documents and non-schedule refs are rejected", () => {
  const stale = validateControl(doc, base({ doc_version: 6 }));
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.includes("stale doc_version"));

  const wrongRef = validateControl(doc, base({ cap_ref: 999 }));
  assert.equal(wrongRef.ok, false);
  assert.ok(wrongRef.errors.some((error) => error.includes("schedule control offer")));
});

test("empty schedule explicitly clears windows only when a default is supplied", () => {
  const clear = validateControl(doc, base({ schedule_intent: { slots: [], default_mode: "self_use" } }));
  assert.equal(clear.ok, true);

  const ambiguous = validateControl(doc, base({ schedule_intent: { slots: [] } }));
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.plan, undefined);
});
