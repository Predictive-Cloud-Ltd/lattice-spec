// Merge multiple producer fragments into one site graph, keyed by node identity.
// The same node id from two producers becomes ONE node carrying BOTH their access
// paths (deduped, ranked by the consumer) — this is the multi-vendor composition
// at the heart of the standard.

type Frag = any;

export type MergeInfo = {
  id: string;
  kind?: string;
  providers: string[];   // which producers contributed this node
  accessPaths: { id: string; provider: string; preference: number }[];
  multi: boolean;        // contributed by >1 producer OR has >1 access path
};

export type MergeOutput = { doc: any; merges: MergeInfo[]; nodeCount: number };

export function mergeFragments(frags: Frag[]): MergeOutput {
  const nodes = new Map<string, any>();
  const contributors = new Map<string, Set<string>>();
  const rels: any[] = [];
  const relSeen = new Set<string>();

  for (const f of frags) {
    if (!f || typeof f !== "object") continue;
    const prov = f?.producer?.provider ?? "?";

    for (const n of f.nodes ?? []) {
      const id = n?.id;
      if (!id) continue;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          kind: n.kind,
          deviceType: n.deviceType,
          attributes: { ...(n.attributes ?? {}) },
          aggregate: n.aggregate,
          accessPaths: [],
          capabilities: [],
        });
        contributors.set(id, new Set());
      }
      const m = nodes.get(id);
      contributors.get(id)!.add(prov);

      for (const a of n.accessPaths ?? []) {
        if (a?.id && !m.accessPaths.some((x: any) => x.id === a.id)) m.accessPaths.push(a);
      }
      for (const c of n.capabilities ?? []) {
        const dup = m.capabilities.some((x: any) => x.capability === c.capability && x.accessPath === c.accessPath);
        if (!dup) m.capabilities.push(c);
      }
      Object.assign(m.attributes, n.attributes ?? {});
      if (!m.kind && n.kind) m.kind = n.kind;
      if (!m.deviceType && n.deviceType) m.deviceType = n.deviceType;
      if (!m.aggregate && n.aggregate) m.aggregate = n.aggregate;
    }

    for (const r of f.relationships ?? []) {
      if (!r?.from || !r?.to || !r?.type) continue;
      const k = `${r.from}|${r.type}|${r.to}`;
      if (!relSeen.has(k)) {
        relSeen.add(k);
        rels.push(r);
      }
    }
  }

  const doc = {
    topologyVersion: frags.find((f) => f?.topologyVersion)?.topologyVersion ?? "0.1.0",
    scope: "site",
    id: "site:merged",
    producer: { name: "Merged (consumer)", provider: "merge" },
    nodes: [...nodes.values()],
    relationships: rels,
  };

  const merges: MergeInfo[] = [...nodes.keys()].map((id) => {
    const provs = [...(contributors.get(id) ?? [])];
    const node = nodes.get(id);
    const aps = (node.accessPaths ?? []).map((a: any) => ({ id: a.id, provider: a.provider, preference: a.preference ?? 0 }));
    return { id, kind: node.kind, providers: provs, accessPaths: aps, multi: provs.length > 1 || aps.length > 1 };
  });

  return { doc, merges, nodeCount: nodes.size };
}
