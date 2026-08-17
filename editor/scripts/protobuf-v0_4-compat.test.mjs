import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const protocAvailable = spawnSync("protoc", ["--version"], { encoding: "utf8" }).status === 0;

function protoc(args, input) {
  const result = spawnSync("protoc", args, {
    cwd: repo,
    input,
    encoding: input == null ? "utf8" : undefined,
  });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

function encodeV04(message, text) {
  return protoc(
    [
      "--proto_path=0.4.0",
      `--encode=predbat.topology.dataplane.v0.${message}`,
      "topology-data-plane.proto",
    ],
    Buffer.from(text),
  );
}

test("all frozen protobuf artifacts plus additive v0.4 compile", { skip: !protocAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lattice-v04-proto-"));
  try {
    for (const version of ["0.2.0", "0.3.0", "0.4.0"]) {
      protoc([
        `--proto_path=${version}`,
        `--descriptor_set_out=${join(dir, `${version}.pb`)}`,
        "topology-data-plane.proto",
      ]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a v0.3 decoder sees field 7 as an unset payload and cannot execute it", { skip: !protocAvailable }, () => {
  const encoded = encodeV04(
    "Control",
    'command_id:"cmd-v04" doc_version:12 cap_ref:41 ' +
      "absolute_schedule_intent { valid_from_ts_ms:1785189600000 valid_until_ts_ms:1785207600000 " +
      'diagnostic_timezone:"Europe/London" execution:SCHEDULE_EXECUTION_NATIVE ' +
      'default_mode:"self_use" slots { start_ts_ms:1785189600000 end_ts_ms:1785207600000 mode:"force_charge" } } ' +
      'controller { origin_id:"predbat" controller_class:CONTROLLER_CLASS_AUTOMATION } ' +
      'lease { lease_id:"lease-a" scope_id:"site:GW-1:battery.mode" fencing_token:11 expires_ts_ms:1785211200000 }\n',
  );
  const decoded = protoc(
    [
      "--proto_path=0.3.0",
      "--decode=predbat.topology.dataplane.v0.Control",
      "topology-data-plane.proto",
    ],
    encoded,
  ).toString();

  assert.match(decoded, /command_id: "cmd-v04"/);
  assert.match(decoded, /doc_version: 12/);
  assert.match(decoded, /cap_ref: 41/);
  assert.doesNotMatch(decoded, /scalar \{/);
  assert.doesNotMatch(decoded, /schedule \{/);
  assert.doesNotMatch(decoded, /schedule_intent \{/);
});

test("a v0.3 decoder preserves terminal ACK fields and ignores v0.4 receipt fields", { skip: !protocAvailable }, () => {
  const encoded = encodeV04(
    "ControlAck",
    'command_id:"cmd-v04" ok:true result:CONTROL_RESULT_APPLIED verified:true completed_ts_ms:1785189000000 ' +
      "applied_schedule { plan_digest:\"01234567890123456789012345678901\" accepted_slot_count:1 " +
      "durably_accepted:true verification:SCHEDULE_VERIFICATION_DURABLE_STORE_READBACK " +
      "clamp_count:0 valid_from_ts_ms:1785189600000 valid_until_ts_ms:1785207600000 } " +
      'accepted_lease { lease_id:"lease-a" scope_id:"site:GW-1:battery.mode" fencing_token:11 expires_ts_ms:1785211200000 }\n',
  );
  const decoded = protoc(
    [
      "--proto_path=0.3.0",
      "--decode=predbat.topology.dataplane.v0.ControlAck",
      "topology-data-plane.proto",
    ],
    encoded,
  ).toString();

  assert.match(decoded, /command_id: "cmd-v04"/);
  assert.match(decoded, /result: CONTROL_RESULT_APPLIED/);
  assert.match(decoded, /verified: true/);
  assert.doesNotMatch(decoded, /applied_schedule/);
  assert.doesNotMatch(decoded, /accepted_lease/);
});

test("embedded maximum control and ACK protobuf sizes are pinned", { skip: !protocAvailable }, () => {
  const commandId = "c".repeat(63);
  const mode = "m".repeat(24);
  const timezone = `Area/${"t".repeat(42)}`;
  const origin = "o".repeat(36);
  const leaseId = "l".repeat(36);
  const scopeId = "s".repeat(47);
  const slot =
    `slots { start_ts_ms:1785189600000 end_ts_ms:1785193200000 mode:"${mode}" ` +
    "target_soc:100 reserve_soc:100 charge_power_limit:6000 discharge_power_limit:6000 enable:true } ";
  const control = encodeV04(
    "Control",
    `command_id:"${commandId}" doc_version:4294967295 cap_ref:4294967295 ` +
      "absolute_schedule_intent { " +
      slot.repeat(8) +
      `default_mode:"${mode}" valid_from_ts_ms:1785189600000 valid_until_ts_ms:1785207600000 ` +
      `diagnostic_timezone:"${timezone}" execution:SCHEDULE_EXECUTION_CONTROLLER_STEPPED } ` +
      `controller { origin_id:"${origin}" controller_class:CONTROLLER_CLASS_AUTOMATION } ` +
      `lease { lease_id:"${leaseId}" scope_id:"${scopeId}" fencing_token:18446744073709551615 ` +
      "expires_ts_ms:18446744073709551615 }\n",
  );

  const clamp =
    "clamps { slot_index:7 field:SCHEDULE_FIELD_DISCHARGE_POWER_LIMIT " +
    "requested:1.7976931348623157e+308 applied:6000 } ";
  const ack = encodeV04(
    "ControlAck",
    `command_id:"${commandId}" ok:true result:CONTROL_RESULT_APPLIED verified:true ` +
      "completed_ts_ms:18446744073709551615 applied_schedule { " +
      'plan_digest:"01234567890123456789012345678901" accepted_slot_count:8 durably_accepted:true ' +
      "verification:SCHEDULE_VERIFICATION_NATIVE_TARGET_READBACK " +
      clamp.repeat(8) +
      "clamp_count:8 valid_from_ts_ms:1785189600000 valid_until_ts_ms:1785207600000 } " +
      `accepted_lease { lease_id:"${leaseId}" scope_id:"${scopeId}" fencing_token:18446744073709551615 ` +
      "expires_ts_ms:18446744073709551615 } " +
      `controller { origin_id:"${origin}" controller_class:CONTROLLER_CLASS_AUTOMATION }\n`,
  );

  // Exact values catch accidental wire growth; the ceiling is the embedded
  // nanopb MQTT payload profile shared by control and ACK.
  assert.equal(control.byteLength, 964);
  assert.equal(ack.byteLength, 486);
  assert.ok(control.byteLength <= 1024);
  assert.ok(ack.byteLength <= 1024);
});
