// Shared dagre auto-layout for React Flow graphs. The same implementation
// lives in predbat-saas src/lib/lattice/layout.ts — keep them in sync.
import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

// Fixed dimensions per node type — no DOM measurement needed at this size.
const DIMENSIONS: Record<string, { width: number; height: number }> = {
  device: { width: 220, height: 110 },
  capability: { width: 240, height: 100 },
};
const DEFAULT_DIM = { width: 220, height: 110 };

export function layoutGraph<T extends Node>(
  nodes: T[],
  edges: Edge[],
  direction: "TB" | "LR",
): T[] {
  try {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 70 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of nodes) {
      g.setNode(n.id, { ...(DIMENSIONS[n.type ?? ""] ?? DEFAULT_DIM) });
    }
    for (const e of edges) {
      if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
    }
    dagre.layout(g);
    return nodes.map((n) => {
      const pos = g.node(n.id);
      const dim = DIMENSIONS[n.type ?? ""] ?? DEFAULT_DIM;
      // dagre positions are node centers; React Flow wants top-left corners.
      return { ...n, position: { x: pos.x - dim.width / 2, y: pos.y - dim.height / 2 } };
    });
  } catch (err) {
    // Never break the canvas over a layout failure — fitView still renders.
    console.warn("dagre layout failed; falling back to unpositioned nodes", err);
    return nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } }));
  }
}
