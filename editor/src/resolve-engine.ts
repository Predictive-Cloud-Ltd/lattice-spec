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

export type Altitude = "auto" | "aggregate" | "leaves";

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
  binding?: { protocol?: string; op?: string; address?: unknown; transform?: string; readModifyWrite?: boolean };
  unit?: string;
  shape?: string;
  tier?: number;
  controlGroup?: string;
  groupMembers?: string[];
  intent?: number;
  clamped?: number;
  clampMin?: number;
  clampMaxLabel?: string;
  // §5 control altitude & aggregation
  strategy?: "direct" | "delegated" | "expanded";
  planNodes?: string[];
  distribution?: string;
  // §6 ownership & arbitration
  ownedNodes?: string[];
  ownershipNote?: string;
};

const asNum = (x: unknown) => (typeof x === "number" ? x : undefined);

function fmtParam(v: unknown): string {
  if (v && typeof v === "object" && "ref" in (v as any)) {
    const r = v as { ref: string; factor?: number };
    return r.factor != null ? `ref ${r.ref}×${r.factor}` : `ref ${r.ref}`;
  }
  return String(v);
}

export function formatTransform(t: any): string | undefined {
  if (!t || typeof t !== "object" || typeof t.kind !== "string") return undefined;
  if (t.kind === "pipeline") {
    const steps = Array.isArray(t.steps) ? t.steps.map(formatTransform).filter(Boolean) : [];
    return `pipeline[${steps.join(", ")}]`;
  }
  const keys = ["num", "den", "scale", "offset", "min", "max"].filter((k) => t[k] != null);
  const extra: string[] = [];
  if (t.round && t.round !== "trunc") extra.push(`round=${t.round}`);
  if (t.onRefUnavailable === "max") extra.push("fail-open");
  const parts = [...keys.map((k) => `${k}=${fmtParam(t[k])}`), ...extra];
  if (!parts.length) return t.kind;
  return `${t.kind}(${parts.join(", ")})`;
}

function childrenOf(doc: Doc, nodeId: string, rel: string): string[] {
  return (doc?.relationships ?? []).filter((r: any) => r?.from === nodeId && r?.type === rel).map((r: any) => r.to);
}

function childCount(doc: Doc, nodeId: string, rel: string): number {
  return childrenOf(doc, nodeId, rel).length;
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
  altitude: Altitude = "auto",
): ResolveResult {
  const offering = nodesOffering(doc, cap, side);
  if (!offering.length) {
    return { ok: false, side, accessPaths: [], message: `No node offers ${side} for "${cap}".` };
  }

  // §5 control altitude: a qualifying aggregator can take ONE delegated command (its
  // firmware fans out to its children); else the hub *expands* to the leaves directly.
  let agg: any = null;
  let aggPrio = -1;
  for (const o of offering) {
    const a = o.node.aggregate;
    if (!a?.serves) continue;
    if (childCount(doc, o.node.id, a.over ?? "contains") >= (a.minChildren ?? 0) && (a.priority ?? 0) >= aggPrio) {
      agg = o;
      aggPrio = a.priority ?? 0;
    }
  }
  const leaves = offering.filter((o) => !o.node.aggregate?.serves);

  // pick the route for the requested altitude
  let routeNodes: any[];
  let strategy: ResolveResult["strategy"];
  let ownershipNote: string | undefined;
  if (agg && (altitude === "auto" || altitude === "aggregate")) {
    routeNodes = [agg];
    strategy = "delegated";
  } else {
    routeNodes = leaves.length ? leaves : offering;
    strategy = routeNodes.length > 1 ? "expanded" : "direct";
    if (agg && altitude === "leaves") {
      ownershipNote = `${agg.node.id} serves as coordinator for these — commanding the leaves directly contends with it (§6). Prefer the aggregate altitude.`;
    } else if (!agg && altitude === "aggregate") {
      ownershipNote = "No qualifying coordinator for this capability — falling back to per-leaf (expanded).";
    }
  }

  // §6 ownership: the chosen altitude claims a subtree; the other altitude is then off-limits
  const ownedNodes =
    strategy === "delegated"
      ? childrenOf(doc, agg.node.id, agg.node.aggregate?.over ?? "contains")
      : routeNodes.map((o) => o.node.id);

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
    strategy,
    planNodes: routeNodes.map((o) => o.node.id),
    distribution: primary.offers.find((o: any) => o?.distribution)?.distribution,
    ownedNodes,
    ownershipNote,
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
  if (b) result.binding = { protocol: b.protocol, op: b.op, address: b.address, transform: formatTransform(b.transform), readModifyWrite: b.readModifyWrite || undefined };
  result.unit = chosenOffer.unit;
  result.shape = chosenOffer.shape;
  result.tier = chosenOffer.tier;
  result.controlGroup = chosenOffer.controlGroup;
  if (side === "control" && chosenOffer.controlGroup) {
    // The group resolves + executes as one op: gather the sibling members on this node + access path.
    result.groupMembers = (node.capabilities ?? [])
      .filter((o: any) => o?.controlGroup === chosenOffer.controlGroup && o?.accessPath === chosenOffer.accessPath)
      .map((o: any) => String(o.capability));
  }

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
