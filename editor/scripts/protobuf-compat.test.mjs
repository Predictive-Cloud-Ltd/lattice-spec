import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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

test("both frozen protobuf artifacts compile", { skip: !protocAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lattice-proto-"));
  try {
    protoc(["--proto_path=.", `--descriptor_set_out=${join(dir, "020.pb")}`, "0.2.0/topology-data-plane.proto"]);
    protoc(["--proto_path=.", `--descriptor_set_out=${join(dir, "030.pb")}`, "0.3.0/topology-data-plane.proto"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a v0.2 decoder keeps legacy ACK fields and ignores v0.3 result fields", { skip: !protocAvailable }, () => {
  const encoded = protoc(
    [
      "--proto_path=0.3.0",
      "--encode=predbat.topology.dataplane.v0.ControlAck",
      "topology-data-plane.proto",
    ],
    Buffer.from(
      'command_id:"cmd-ack" ok:true result:CONTROL_RESULT_APPLIED ' +
      'applied_scalar { i:5000 } verified:true completed_ts_ms:1234\n',
    ),
  );
  const decoded = protoc(
    [
      "--proto_path=0.2.0",
      "--decode=predbat.topology.dataplane.v0.ControlAck",
      "topology-data-plane.proto",
    ],
    encoded,
  ).toString();
  assert.match(decoded, /command_id: "cmd-ack"/);
  assert.match(decoded, /ok: true/);
  assert.doesNotMatch(decoded, /result:/);
  assert.doesNotMatch(decoded, /applied_scalar:/);
});

test("a v0.2 decoder sees schedule_intent field 6 with its known payload unset", { skip: !protocAvailable }, () => {
  const encoded = protoc(
    [
      "--proto_path=0.3.0",
      "--encode=predbat.topology.dataplane.v0.Control",
      "topology-data-plane.proto",
    ],
    Buffer.from(
      'command_id:"cmd-control" doc_version:7 cap_ref:11 ' +
      'schedule_intent { default_mode:"self_use" slots { start_hhmm:30 end_hhmm:430 mode:"force_charge" } }\n',
    ),
  );
  const decoded = protoc(
    [
      "--proto_path=0.2.0",
      "--decode=predbat.topology.dataplane.v0.Control",
      "topology-data-plane.proto",
    ],
    encoded,
  ).toString();
  assert.match(decoded, /command_id: "cmd-control"/);
  assert.doesNotMatch(decoded, /scalar \{/);
  assert.doesNotMatch(decoded, /schedule \{/);
});
