import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ScheduleFenceRegistry,
  validateAbsoluteScheduleControl,
} from "./.gen/control-v0_4-engine.js";
import { validateControlAckV04 } from "./.gen/control-result-v0_4-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CASES_PATH = resolve(
  here,
  "..",
  "..",
  "conformance",
  "schedule-v0.4",
  "cases.json",
);
export const EXPECTED_PATH = resolve(
  here,
  "..",
  "..",
  "conformance",
  "schedule-v0.4",
  "expected.json",
);

export function loadCorpus() {
  return JSON.parse(readFileSync(CASES_PATH, "utf8"));
}

export function runCase(testCase, doc) {
  if (testCase.kind === "schedule") {
    return validateAbsoluteScheduleControl(
      doc,
      {
        command_id: "fixture-command",
        doc_version: doc.docVersion,
        cap_ref: 41,
        absolute_schedule_intent: testCase.intent,
      },
      testCase.now_ms,
    );
  }

  if (testCase.kind === "result") {
    return validateControlAckV04(testCase.ack);
  }

  if (testCase.kind === "fence") {
    let registry = new ScheduleFenceRegistry();
    const results = [];
    for (const operation of testCase.operations) {
      if (operation.op === "admit") {
        results.push(
          registry.admit(
            {
              command_id: operation.command_id ?? "fixture-command",
              doc_version: doc.docVersion,
              cap_ref: 41,
              controller: operation.controller,
              lease: operation.lease,
            },
            operation.authenticated,
            testCase.scope_id,
            operation.now_ms,
          ),
        );
      } else if (operation.op === "unknown") {
        registry.markUnknown(testCase.scope_id, operation.command_id, operation.now_ms);
        results.push({ unknown_quarantined: operation.command_id });
      } else if (operation.op === "restart") {
        registry = new ScheduleFenceRegistry(registry.snapshot());
        results.push({ restarted: true });
      } else if (operation.op === "complete") {
        registry.complete(
          testCase.scope_id,
          operation.command_id,
          operation.result,
          operation.now_ms,
        );
        results.push({ completed: operation.result });
      } else if (operation.op === "reconcile") {
        results.push({
          reconciled: registry.reconcile(
            testCase.scope_id,
            operation.command_id,
            operation.result,
          ),
        });
      }
    }
    return { results, snapshot: registry.snapshot() };
  }

  throw new Error(`unknown fixture kind ${testCase.kind}`);
}

export function runCorpus() {
  const corpus = loadCorpus();
  return Object.fromEntries(
    corpus.cases.map((testCase) => [
      testCase.name,
      JSON.parse(JSON.stringify(runCase(testCase, corpus.doc))),
    ]),
  );
}
