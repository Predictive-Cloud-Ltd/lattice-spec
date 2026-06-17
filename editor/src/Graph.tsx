import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";

const KIND_COLOR: Record<string, string> = {
  gateway: "#6ea8fe",
  inverter: "#22c55e",
  battery: "#f59e0b",
  ems: "#a78bfa",
  meter: "#f472b6",
  ev_charger: "#34d399",
  ev: "#2dd4bf",
  heat_pump: "#fb7185",
  hvac: "#fb7185",
  heating_zone: "#fda4af",
  pv: "#facc15",
  grid: "#94a3b8",
  switch: "#cbd5e1",
  structural: "#64748b",
};

export function Graph({ doc }: { doc: unknown }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const d = doc as { nodes?: unknown[]; relationships?: unknown[] } | null;
    const nodes = Array.isArray(d?.nodes) ? d!.nodes : [];
    const rels = Array.isArray(d?.relationships) ? d!.relationships : [];

    const elements: cytoscape.ElementDefinition[] = [
      ...nodes
        .filter((n): n is { id: unknown; kind?: unknown } => !!n && typeof n === "object" && "id" in n)
        .map((n) => ({
          data: {
            id: String((n as any).id),
            label: `${(n as any).id}\n(${(n as any).kind ?? "?"})`,
            kind: String((n as any).kind ?? ""),
          },
        })),
      ...rels
        .filter((r): r is { from: unknown; to: unknown; type?: unknown } =>
          !!r && typeof r === "object" && "from" in r && "to" in r,
        )
        .map((r, i) => ({
          data: {
            id: `e${i}`,
            source: String((r as any).from),
            target: String((r as any).to),
            label: String((r as any).type ?? ""),
          },
        })),
    ];

    const cy = cytoscape({
      container: ref.current,
      elements,
      style: [
        {
          selector: "node",
          style: {
            "background-color": (e: cytoscape.NodeSingular) => KIND_COLOR[e.data("kind")] || "#64748b",
            label: "data(label)",
            "font-size": 9,
            "text-wrap": "wrap",
            "text-valign": "center",
            "text-halign": "center",
            color: "#0b1020",
            "font-weight": 600,
            width: 58,
            height: 58,
          } as cytoscape.Css.Node,
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#475569",
            "target-arrow-color": "#475569",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 8,
            color: "#9fb0cf",
            "text-rotation": "autorotate",
            "text-background-color": "#0b1020",
            "text-background-opacity": 1,
            "text-background-padding": "2",
          } as cytoscape.Css.Edge,
        },
      ],
      layout: { name: "breadthfirst", directed: true, padding: 24, spacingFactor: 1.3 } as cytoscape.LayoutOptions,
    });

    return () => cy.destroy();
  }, [doc]);

  return <div ref={ref} className="graph" />;
}
