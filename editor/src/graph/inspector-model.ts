// Lattice doc -> graph view-model. Adapted from predbat-saas
// src/lib/lattice/inspector-model.ts: no positions (see layout.ts), no
// POWER_FLOW_CAPS coupling, context chips from generic node attributes,
// and binding detail strings tolerate description-only offers (read: {}).
import { evalNodeCapability } from "./eval.js";

export interface GraphEdge { id: string; source: string; target: string; label: string; }
export interface DeviceGraphNode {
  id: string; kind: string; aggregate: boolean; aggregateOver?: string;
  capCount: number; keyValues: { label: string; value: string }[];
}
export interface TopologyModel { nodes: DeviceGraphNode[]; edges: GraphEdge[]; }
export interface CapGraphNode {
  id: string; capability: string; kind: "read" | "derived";
  detail: string; value: string; depth: number;
}
export interface NodeDetail {
  caps: CapGraphNode[]; edges: GraphEdge[];
  controls: { capability: string; detail: string }[];
  context: { label: string; value: string }[];
}

const fmtTransform = (t: any) => (typeof t === "string" ? t : t?.kind ?? "");
const fmtVal = (v: number | undefined) => (v == null ? "—" : String(v));
const fmtBinding = (b: any, fallbackOp: string) => {
  const op = b?.op ?? fallbackOp;
  const addr = b?.address !== undefined ? ` @${b.address}` : "";
  const tf = b?.transform ? ` · ${fmtTransform(b.transform)}` : "";
  return `${op}${addr}${tf}`;
};

export function buildTopologyModel(
  doc: any,
  samples: Record<string, Record<string, number>> | null,
): TopologyModel {
  const dnodes: any[] = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const rels: any[] = Array.isArray(doc?.relationships) ? doc.relationships : [];
  const edges: GraphEdge[] = rels
    .filter((r) => r && typeof r === "object" && "from" in r && "to" in r)
    .map((r, i) => ({ id: `rel-${i}`, source: String(r.from), target: String(r.to), label: String(r.type ?? "") }));

  const nodes: DeviceGraphNode[] = dnodes
    .filter((n) => n && typeof n === "object" && "id" in n)
    .map((n) => {
      const ns = samples?.[n.id] ?? {};
      const keyValues = (n.capabilities ?? [])
        .filter((o: any) => o.read || o.derived)
        .map((o: any) => ({ label: o.capability, raw: evalNodeCapability(n, o.capability, ns) }))
        .filter((kv: any) => kv.raw != null)
        .slice(0, 3)
        .map((kv: any) => ({ label: kv.label, value: fmtVal(kv.raw) }));
      return {
        id: String(n.id), kind: String(n.kind ?? "device"),
        aggregate: !!n.aggregate?.serves, aggregateOver: n.aggregate?.over,
        capCount: (n.capabilities ?? []).length, keyValues,
      };
    });
  return { nodes, edges };
}

export function buildNodeDetail(node: any, nodeSamples: Record<string, number>): NodeDetail {
  const offers: any[] = node?.capabilities ?? [];
  const byName: Record<string, any> = {};
  offers.forEach((o) => (byName[o.capability] = o));

  const depthOf = (cap: string, seen = new Set<string>()): number => {
    if (seen.has(cap)) return 0;
    seen.add(cap);
    const o = byName[cap];
    if (!o?.derived) return 0;
    // Clone `seen` per branch so a shared sub-node reached via two paths is
    // counted on each, not blocked as a cycle after the first visit.
    const ins = (o.derived.inputs ?? []).map((i: any) => depthOf(i.ref, new Set(seen)));
    return 1 + (ins.length ? Math.max(...ins) : 0);
  };

  const caps: CapGraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const o of offers) {
    if (!o.read && !o.derived) continue; // control-only handled below
    const cap = o.capability;
    const detail = o.derived
      ? `${o.derived.op ?? "sum"}(${(o.derived.inputs ?? [])
          .map((i: any) => `${i.ref}${i.weight !== undefined && i.weight !== 1 ? `×${i.weight}` : ""}`)
          .join(", ")})`
      : fmtBinding(o.read, "read");
    caps.push({
      id: cap, capability: cap, kind: o.derived ? "derived" : "read",
      detail, value: fmtVal(evalNodeCapability(node, cap, nodeSamples)), depth: depthOf(cap),
    });
    if (o.derived) (o.derived.inputs ?? []).forEach((inp: any, i: number) =>
      edges.push({
        id: `${cap}<-${inp.ref}-${i}`, source: inp.ref, target: cap,
        label: inp.weight !== undefined && inp.weight !== 1 ? `×${inp.weight}` : "",
      }));
  }
  // Every edge endpoint must exist as a node or React Flow drops the edge.
  const capIds = new Set(caps.map((c) => c.id));
  for (const edge of edges) {
    if (!capIds.has(edge.source)) {
      caps.push({
        id: edge.source, capability: edge.source, kind: "read",
        detail: "external input", value: fmtVal(nodeSamples[edge.source]), depth: 0,
      });
      capIds.add(edge.source);
    }
  }
  const controls = offers.filter((o) => o.control).map((o) => ({
    capability: o.capability, detail: fmtBinding(o.control, "write"),
  }));
  const context = Object.entries(node?.attributes ?? {})
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .slice(0, 4)
    .map(([k, v]) => ({ label: k, value: String(v) }));
  return { caps, edges, controls, context };
}
