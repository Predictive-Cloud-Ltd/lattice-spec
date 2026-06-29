// Pure, doc-driven merge: composes producer fragments + upstream overlays into one `site` doc.
// Identity-keyed, authority-ranked, with per-field / per-key / wholesale override and removal
// tombstones. Mirrors the spec's export + overlay/merge contract
// (spec/2026-06-28-export-overlay-merge.md) so the editor, batpred, and the gateway can each run
// the SAME function — pinned across languages by conformance/merge/.

type Doc = any;

export type MergeResult = { site: Doc; warnings: string[] };

type Rank = { authority: number; recency: number; order: number };
type Contrib = { item: Doc; rank: Rank };

const authOf = (doc: Doc): number => (Number.isInteger(doc?.producer?.authority) ? doc.producer.authority : 0);
const recencyOf = (doc: Doc): number => (Number.isInteger(doc?.docVersion) ? doc.docVersion : 0);
const majorOf = (v: unknown): string => String(v ?? "").split(".")[0];

// a beats b: higher authority, then higher docVersion (recency), then earlier input order.
function better(a: Rank, b: Rank): boolean {
  if (a.authority !== b.authority) return a.authority > b.authority;
  if (a.recency !== b.recency) return a.recency > b.recency;
  return a.order < b.order;
}

function topBy(contribs: Contrib[]): Contrib {
  return contribs.reduce((best, cur) => (better(cur.rank, best.rank) ? cur : best));
}

// Highest-ranked setter of a scalar/cohesive-object field; undefined if no contributor sets it.
// Warns when two setters tie on (authority, recency) with different values.
function pickField(contribs: Contrib[], field: string, nodeId: string, warnings: string[]): unknown {
  let best: unknown;
  let bestRank: Rank | undefined;
  for (const { item, rank } of contribs) {
    if (item[field] === undefined) continue;
    if (bestRank === undefined || better(rank, bestRank)) {
      best = item[field];
      bestRank = rank;
    }
  }
  if (bestRank === undefined) return undefined;
  for (const { item, rank } of contribs) {
    if (item[field] === undefined) continue;
    if (rank.authority === bestRank.authority && rank.recency === bestRank.recency && JSON.stringify(item[field]) !== JSON.stringify(best)) {
      warnings.push(`node "${nodeId}" field "${field}": conflicting values at equal precedence; kept first`);
      break;
    }
  }
  return best;
}

// Per-key bag merge (attributes, parameters): each key from its highest-ranked setter.
function mergeBag(contribs: Contrib[], field: string): Record<string, unknown> | undefined {
  const byKey = new Map<string, { value: unknown; rank: Rank }>();
  for (const { item, rank } of contribs) {
    const bag = item[field];
    if (!bag || typeof bag !== "object") continue;
    for (const [k, v] of Object.entries(bag)) {
      const prev = byKey.get(k);
      if (!prev || better(rank, prev.rank)) byKey.set(k, { value: v, rank });
    }
  }
  if (byKey.size === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, { value }] of byKey) out[k] = value;
  return out;
}

// Identity-keyed collection union (accessPaths, capabilities). Highest-ranked entry per key wins
// wholesale; a winning tombstone omits the key. First-seen key order preserved.
function mergeCollection(contribs: Contrib[], field: string, keyOf: (x: Doc) => string | null): Doc[] {
  const order: string[] = [];
  const byKey = new Map<string, Contrib>();
  for (const { item: node, rank } of contribs) {
    const items = Array.isArray(node[field]) ? node[field] : [];
    for (const entry of items) {
      if (!entry || typeof entry !== "object") continue;
      const key = keyOf(entry);
      if (key == null) continue;
      if (!byKey.has(key)) order.push(key);
      const prev = byKey.get(key);
      if (!prev || better(rank, prev.rank)) byKey.set(key, { item: entry, rank });
    }
  }
  const out: Doc[] = [];
  for (const key of order) {
    const { item } = byKey.get(key)!;
    if (item.removed === true) continue;
    const { removed, ...clean } = item;
    out.push(clean);
  }
  return out;
}

const apKey = (ap: Doc): string | null => (ap.id != null ? String(ap.id) : null);
// Offer identity is (capability, accessPath). A derived offer has no accessPath, so it keys on
// `cap|` — a bare-capability tombstone therefore targets ONLY the access-path-less (derived) offer.
const offerKey = (o: Doc): string | null => (o.capability != null ? `${String(o.capability)}|${o.accessPath ?? ""}` : null);

// Deterministic content digest (FNV-1a, 31-bit) → a stable positive integer docVersion.
function digest(obj: Doc): number {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 2147483647) + 1; // 1..2147483647, schema-valid integer
}

function mergeNode(contribs: Contrib[], warnings: string[]): Doc {
  const top = topBy(contribs);
  const nodeId = String(top.item.id);
  const node: Doc = { id: top.item.id, kind: pickField(contribs, "kind", nodeId, warnings) };

  const deviceType = pickField(contribs, "deviceType", nodeId, warnings);
  if (deviceType !== undefined) node.deviceType = deviceType;
  const aggregate = pickField(contribs, "aggregate", nodeId, warnings);
  if (aggregate !== undefined) node.aggregate = aggregate;

  const attributes = mergeBag(contribs, "attributes");
  if (attributes) node.attributes = attributes;
  const parameters = mergeBag(contribs, "parameters");
  if (parameters) node.parameters = parameters;

  const accessPaths = mergeCollection(contribs, "accessPaths", apKey);
  accessPaths.sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  if (accessPaths.length) node.accessPaths = accessPaths;

  const capabilities = mergeCollection(contribs, "capabilities", offerKey);
  if (capabilities.length) node.capabilities = capabilities;

  return node;
}

export function merge(docs: Doc[]): MergeResult {
  const warnings: string[] = [];
  const inputs = (Array.isArray(docs) ? docs : []).filter((d) => d && typeof d === "object");
  if (inputs.length === 0) {
    throw new Error("cannot merge an empty document list");
  }

  const majors = new Set(inputs.map((d) => majorOf(d.topologyVersion)));
  if (majors.size > 1) {
    throw new Error(`cannot merge incompatible topologyVersion majors: ${[...majors].sort().join(", ")}`);
  }

  const ranked: Contrib[] = inputs.map((doc, order) => ({ item: doc, rank: { authority: authOf(doc), recency: recencyOf(doc), order } }));
  const top = topBy(ranked);

  // Gather node contributors by id, first-seen order preserved.
  const nodeOrder: string[] = [];
  const nodeContribs = new Map<string, Contrib[]>();
  for (const { item: doc, rank } of ranked) {
    for (const n of Array.isArray(doc.nodes) ? doc.nodes : []) {
      if (!n || n.id == null) continue;
      const id = String(n.id);
      if (!nodeContribs.has(id)) {
        nodeContribs.set(id, []);
        nodeOrder.push(id);
      }
      nodeContribs.get(id)!.push({ item: n, rank });
    }
  }

  const survivingNodeIds = new Set<string>();
  const mergedNodes: Doc[] = [];
  for (const id of nodeOrder) {
    const contribs = nodeContribs.get(id)!;
    if (topBy(contribs).item.removed === true) continue; // top-ranked contributor is a tombstone
    survivingNodeIds.add(id);
    mergedNodes.push(mergeNode(contribs.filter((c) => c.item.removed !== true), warnings));
  }

  // Relationships: keyed (from,to,type); union by rank; drop tombstoned + dangling.
  const relOrder: string[] = [];
  const relContribs = new Map<string, Contrib[]>();
  for (const { item: doc, rank } of ranked) {
    for (const rel of Array.isArray(doc.relationships) ? doc.relationships : []) {
      if (!rel || rel.from == null || rel.to == null || rel.type == null) continue;
      const key = `${String(rel.from)}|${String(rel.to)}|${String(rel.type)}`;
      if (!relContribs.has(key)) {
        relContribs.set(key, []);
        relOrder.push(key);
      }
      relContribs.get(key)!.push({ item: rel, rank });
    }
  }
  const mergedRelationships: Doc[] = [];
  for (const key of relOrder) {
    const winner = topBy(relContribs.get(key)!).item;
    if (winner.removed === true) continue;
    if (!survivingNodeIds.has(String(winner.from)) || !survivingNodeIds.has(String(winner.to))) {
      warnings.push(`relationship ${key} dropped: endpoint not in merged node set`);
      continue;
    }
    const { removed, ...clean } = winner;
    mergedRelationships.push(clean);
  }

  // Mint data-plane refs: per (node, capability); access-path siblings share one ref.
  let nextRef = 1;
  for (const node of mergedNodes) {
    if (!Array.isArray(node.capabilities)) continue;
    const refByCap = new Map<string, number>();
    for (const offer of node.capabilities) {
      const cap = String(offer.capability);
      if (!refByCap.has(cap)) refByCap.set(cap, nextRef++);
      offer.ref = refByCap.get(cap);
    }
  }

  // The merged doc is produced by the merger, not by any input: synthetic producer + provenance
  // sidecar (inside producer, which is additionalProperties:true). `id` is the site's own identity
  // (the subject), legitimately named by the authoritative input. docVersion is a content digest.
  const site: Doc = {
    topologyVersion: top.item.topologyVersion ?? "0.2.0",
    scope: "site",
    producer: {
      name: "lattice-merge",
      provider: "lattice-merge",
      inputs: ranked.map(({ item }) => ({
        name: item.producer?.name,
        provider: item.producer?.provider,
        authority: authOf(item),
        docVersion: recencyOf(item),
      })),
    },
    nodes: mergedNodes,
  };
  // deviceTypes union by `key`, so a node's deviceType reference resolves in the merged site (Fix A).
  const deviceTypes = mergeCollection(ranked, "deviceTypes", (dt) => (dt.key != null ? String(dt.key) : null));
  if (deviceTypes.length) site.deviceTypes = deviceTypes;
  // site `id` = the site's own identity, from the highest-authority input that SETS it (Fix B).
  const idContribs = ranked.filter((c) => c.item.id != null);
  if (idContribs.length) site.id = topBy(idContribs).item.id;
  if (mergedRelationships.length) site.relationships = mergedRelationships;
  site.docVersion = digest(site); // computed last, over the site WITHOUT docVersion

  return { site, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy symmetric-union preview used by the editor's Merge tab (Merge.tsx).
// Superseded by the authority-ranked `merge` above (the cross-language reference);
// retained so the existing UI keeps working. Do not use for new work.
// ─────────────────────────────────────────────────────────────────────────────

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
    topologyVersion: frags.find((f) => f?.topologyVersion)?.topologyVersion ?? "0.2.0",
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
