import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ControlResultJournal,
  validateControlAck,
} from "./.gen/control-result-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CASES_PATH = resolve(here, "..", "..", "conformance", "control-result", "cases.json");
export const EXPECTED_PATH = resolve(here, "..", "..", "conformance", "control-result", "expected.json");

export function loadCases() {
  return JSON.parse(readFileSync(CASES_PATH, "utf8"));
}

export function runCase(testCase) {
  if (testCase.kind === "validate") return validateControlAck(testCase.ack);

  let journal = new ControlResultJournal({ maxEntries: 8, ttlMs: 10_000 });
  let executorCalls = 0;
  const results = [];
  for (const operation of testCase.operations ?? []) {
    if (operation.op === "execute") {
      const commandId = operation.ack.command_id;
      results.push(journal.executeOnce(commandId, operation.fingerprint, operation.now_ms, () => {
        executorCalls += 1;
        return operation.ack;
      }));
    } else if (operation.op === "restart") {
      journal = new ControlResultJournal({
        maxEntries: 8,
        ttlMs: 10_000,
        snapshot: journal.snapshot(operation.now_ms),
      });
    } else if (operation.op === "lookup") {
      results.push(journal.lookup(operation.command_id, operation.now_ms));
    }
  }
  return JSON.parse(JSON.stringify({ executor_calls: executorCalls, results }));
}
