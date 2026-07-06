import { Handle, Position } from "@xyflow/react";
import type { DeviceGraphNode } from "./inspector-model";

// Kind colours carried over from the old cytoscape Graph.tsx.
export const KIND_COLOR: Record<string, string> = {
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

export type DeviceNodeData = DeviceGraphNode & { selected: boolean } & Record<string, unknown>;

export function DeviceNode({ data }: { data: DeviceNodeData }) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <div className={`lg-card${data.selected ? " lg-selected" : ""}`}>
        <div className="lg-row">
          <span className="lg-kind" style={{ background: KIND_COLOR[data.kind] ?? "#64748b" }}>
            {data.kind}
          </span>
          <span className="lg-id" title={data.id}>{data.id}</span>
        </div>
        {data.aggregate && (
          <div className="lg-agg">⚙ aggregate · {data.aggregateOver ?? ""}</div>
        )}
        <div className="lg-muted">
          {data.capCount} {data.capCount === 1 ? "capability" : "capabilities"}
        </div>
        {data.keyValues.length > 0 && (
          <div className="lg-kvs">
            {data.keyValues.map((kv) => (
              <div key={kv.label} className="lg-kv">
                <span className="lg-muted lg-trunc">{kv.label}</span>
                <span className="lg-val">{kv.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}
