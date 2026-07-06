// Per-node capability evaluation: register-backed reads come from samples,
// derived offers compute a weighted sum (the only op the spec's producers emit).
// Ported from predbat-saas src/lib/lattice/consumer.ts (evalCap).
export type NodeSamples = Record<string, number>;

export function evalNodeCapability(
  node: any,
  cap: string,
  nodeSamples: NodeSamples,
): number | undefined {
  return evalCap(node, cap, nodeSamples, new Set<string>());
}

// A register-backed sample is only usable if it is a finite number. Sample JSON
// is typed by hand in the editor, so it can contain strings/booleans/nulls;
// those decline to evaluate (undefined -> the card shows "—") rather than
// leaking a wrong value such as the literal "NaN".
function sampleOf(nodeSamples: NodeSamples, cap: string): number | undefined {
  const v = nodeSamples[cap];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function evalCap(
  node: any,
  cap: string,
  nodeSamples: NodeSamples,
  seen: Set<string>,
): number | undefined {
  if (seen.has(cap)) return undefined; // cycle guard
  seen.add(cap);
  const offer = (node?.capabilities || []).find((o: any) => o.capability === cap);
  if (!offer) return sampleOf(nodeSamples, cap); // undeclared ref -> direct sample
  if (offer.derived) {
    // Only "sum" (and absent op, treated as sum) is implemented. Anything else
    // returns undefined so the UI shows "—" rather than a wrong number.
    const op: string | undefined = offer.derived.op;
    if (op !== undefined && op !== "sum") return undefined;
    let total = 0;
    for (const inp of offer.derived.inputs || []) {
      // Clone `seen` per branch: a capability legitimately reached via two
      // derivation paths is not a cycle. Only the ancestor chain (real cycles)
      // is carried down; sibling visits stay isolated.
      const v = evalCap(node, inp.ref, nodeSamples, new Set(seen));
      if (v == null) return undefined;
      total += (inp.weight ?? 1) * v;
    }
    return total;
  }
  return sampleOf(nodeSamples, cap); // register-backed read -> sampled value
}
