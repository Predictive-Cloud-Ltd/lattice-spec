import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ScheduleFenceRegistry,
  canonicalScheduleScopeSerialization,
  deriveCanonicalScheduleScopeId,
  validateAbsoluteScheduleControl,
  validateScheduleTransitionControl,
} from "./.gen/control-v0_4-engine.js";
import { validateControlAckV04 } from "./.gen/control-result-v0_4-engine.js";
import {
  CommandIdentityRegistry,
  ScheduleAuthorityRegistry,
} from "./.gen/schedule-authority-v0_4-engine.js";

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

export async function runCase(testCase, doc) {
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

  if (testCase.kind === "transition") {
    return validateScheduleTransitionControl(
      doc,
      {
        command_id: testCase.command_id ?? "fixture-command",
        doc_version: doc.docVersion,
        cap_ref: 41,
        schedule_transition: testCase.transition,
      },
      testCase.now_ms,
    );
  }

  if (testCase.kind === "scope") {
    return {
      serialization: canonicalScheduleScopeSerialization(testCase.scope),
      scope_id: await deriveCanonicalScheduleScopeId(testCase.scope),
    };
  }

  if (testCase.kind === "identity") {
    let registry = new CommandIdentityRegistry();
    const results = [];
    for (const operation of testCase.operations) {
      if (operation.op === "claim") results.push(registry.claim(operation.identity));
      else if (operation.op === "restart") {
        registry = new CommandIdentityRegistry(registry.snapshot());
        results.push({ restarted: true });
      }
    }
    return { results, snapshot: registry.snapshot() };
  }

  if (testCase.kind === "authority") {
    let registry = new ScheduleAuthorityRegistry();
    const results = [];
    for (const operation of testCase.operations) {
      if (operation.op === "begin") {
        results.push(registry.begin(testCase.scope_id, operation.transition));
      } else if (operation.op === "complete") {
        registry.complete(
          testCase.scope_id,
          operation.command_id,
          operation.outcome,
          operation.completed_ts_ms,
        );
        results.push({
          completed: operation.outcome.result,
          writer_excluded: registry.writerExcluded(testCase.scope_id),
        });
      } else if (operation.op === "reconcile") {
        results.push({
          reconciled: registry.reconcile(
            testCase.scope_id,
            operation.command_id,
            operation.outcome,
            operation.completed_ts_ms,
          ),
          writer_excluded: registry.writerExcluded(testCase.scope_id),
        });
      } else if (operation.op === "check") {
        results.push({
          writer_excluded: registry.writerExcluded(testCase.scope_id),
          ending_transition_required: registry.endingTransitionRequired(
            testCase.scope_id,
            operation.now_ms,
          ),
          installed: registry.installed(testCase.scope_id) ?? null,
        });
      } else if (operation.op === "restart") {
        registry = new ScheduleAuthorityRegistry(registry.snapshot());
        results.push({ restarted: true });
      }
    }
    return { results, snapshot: registry.snapshot() };
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

export async function runCorpus() {
  const corpus = loadCorpus();
  const entries = [];
  for (const testCase of corpus.cases) {
    entries.push([
      testCase.name,
      JSON.parse(JSON.stringify(await runCase(testCase, corpus.doc))),
    ]);
  }
  return Object.fromEntries(entries);
}
