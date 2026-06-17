// A small, doc-driven resolver used by the editor's Resolution Playground.
// Mirrors the spec's route → access-path → clamp logic on the parsed document,
// so the editor can show *live* what no static viewer can: read ≠ control
// routing, ranked access-path fallback, aggregation, and constraint clamping.

type Doc = any;

export type AccessChoice = {
  id: string;
  provider: string;
  preference: number;
  available: boolean;
  chosen: boolean;
};

export type ResolveResult = {
  ok: boolean;
  side: "read" | "control";
  message?: string;
  node?: string;
  nodeKind?: string;
  routeNodeCount?: number;
  reducer?: string;
  accessPaths: AccessChoice[];
  chosenAccessPath?: string;
  fellBack?: boolean;
  binding?: { protocol?: string; op?: string; address?: unknown; transform?: string };
  unit?: string;
  intent?: number;
  clamped?: number;
  clampMin?: number;
  clampMaxLabel?: string;
};

const asNum = (x: unknown) => (typeof x === "number" ? x : undefined);

function childCount(doc: Doc, nodeId: string, rel: string): number {
  return (doc?.relationships ?? []).filter((r: any) => r?.from === nodeId && r?.type === rel).length;
}

function resolveMax(maxSpec: unknown, node: any): { value?: number; label: string } {
  if (typeof maxSpec === "number") return { value: maxSpec, label: String(maxSpec) };
  const rated = node?.attributes?.ratedW;
  const cap = node?.attributes?.capacityWh;
  if (maxSpec === "rated") return { value: rated, label: `rated = ${rated ?? "?"}` };
  if (typeof maxSpec === "string" && maxSpec.includes("capacity/2")) {
    const half = cap != null ? cap / 2 : undefined;
    const v = half != null && rated != null ? Math.min(half, rated) : half ?? rated;
    return { value: v, label: `min(cap/2 = ${half ?? "?"}, rated = ${rated ?? "?"}) = ${v ?? "?"}` };
  }
  return { label: maxSpec == null ? "—" : String(maxSpec) };
}

// nodes offering `cap` on the requested side, with their matching offers
function nodesOffering(doc: Doc, cap: string, side: "read" | "control") {
  const out: { node: any; offers: any[] }[] = [];
  for (const n of doc?.nodes ?? []) {
    const offers = (n.capabilities ?? []).filter(
      (c: any) => c?.capability === cap && (side === "read" ? c.read : c.control),
    );
    if (offers.length) out.push({ node: n, offers });
  }
  return out;
}

export function listCapabilities(doc: Doc): string[] {
  const s = new Set<string>();
  for (const n of doc?.nodes ?? []) for (const c of n.capabilities ?? []) if (c?.capability) s.add(c.capability);
  return [...s].sort();
}

export function listAccessPaths(doc: Doc): string[] {
  const s = new Set<string>();
  for (const n of doc?.nodes ?? []) for (const a of n.accessPaths ?? []) if (a?.id) s.add(a.id);
  return [...s];
}

export function resolve(
  doc: Doc,
  cap: string,
  side: "read" | "control",
  intent: number | undefined,
  offline: Set<string>,
): ResolveResult {
  const offering = nodesOffering(doc, cap, side);
  if (!offering.length) {
    return { ok: false, side, accessPaths: [], message: `No node offers ${side} for "${cap}".` };
  }

  // aggregate-aware route: prefer a qualifying aggregator, else the leaves
  let best: any = null;
  let bestPrio = -1;
  for (const o of offering) {
    const agg = o.node.aggregate;
    if (!agg?.serves) continue;
    const over = agg.over ?? "contains";
    const min = agg.minChildren ?? 0;
    if (childCount(doc, o.node.id, over) >= min && (agg.priority ?? 0) >= bestPrio) {
      best = o;
      bestPrio = agg.priority ?? 0;
    }
  }
  let routeNodes = best ? [best] : offering.filter((o) => !o.node.aggregate?.serves);
  if (!routeNodes.length) routeNodes = offering;

  const primary = routeNodes[0];
  const node = primary.node;

  // rank this node's offers (= access paths) by preference desc
  const apById = new Map<string, any>((node.accessPaths ?? []).map((a: any) => [a.id, a]));
  const ranked = primary.offers
    .map((offer: any) => ({ offer, ap: apById.get(offer.accessPath) }))
    .filter((x: any) => x.ap)
    .sort((a: any, b: any) => (b.ap.preference ?? 0) - (a.ap.preference ?? 0));

  const accessPaths: AccessChoice[] = ranked.map((x: any) => ({
    id: x.ap.id,
    provider: x.ap.provider,
    preference: x.ap.preference ?? 0,
    available: !offline.has(x.ap.id),
    chosen: false,
  }));

  const result: ResolveResult = {
    ok: false,
    side,
    node: node.id,
    nodeKind: node.kind,
    routeNodeCount: routeNodes.length,
    reducer: routeNodes.length > 1 ? primary.offers[0]?.reducer ?? "mean" : primary.offers[0]?.reducer,
    accessPaths,
  };

  const chosenIdx = ranked.findIndex((x: any) => !offline.has(x.ap.id));
  if (chosenIdx < 0) {
    result.message = "All access paths offline — unresolved.";
    return result;
  }
  accessPaths[chosenIdx].chosen = true;
  result.ok = true;
  result.chosenAccessPath = accessPaths[chosenIdx].id;
  result.fellBack = chosenIdx > 0;

  const chosenOffer = ranked[chosenIdx].offer;
  const b = side === "read" ? chosenOffer.read : chosenOffer.control;
  if (b) result.binding = { protocol: b.protocol, op: b.op, address: b.address, transform: b.transform?.kind };
  result.unit = chosenOffer.unit;

  if (side === "control" && intent != null && !Number.isNaN(intent)) {
    const cons = chosenOffer.constraints ?? {};
    const min = asNum(cons.min) ?? 0;
    const mx = resolveMax(cons.max, node);
    let c = intent;
    if (c < min) c = min;
    if (mx.value != null && c > mx.value) c = mx.value;
    result.intent = intent;
    result.clamped = c;
    result.clampMin = min;
    result.clampMaxLabel = mx.label;
  }

  return result;
}
