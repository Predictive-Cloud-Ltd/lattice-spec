import { Handle, Position } from "@xyflow/react";
import type { CapGraphNode } from "./inspector-model";

export type CapabilityNodeData = CapGraphNode & Record<string, unknown>;

// Derived capabilities get the highlight ring (the admin highlights
// power-flow caps instead — a generic lattice doc has no such notion).
export function CapabilityNode({ data }: { data: CapabilityNodeData }) {
  const derived = data.kind === "derived";
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className={`lg-card lg-cap${derived ? " lg-derived" : ""}`}>
        <div className="lg-row">
          <span className="lg-capname" title={data.capability}>{data.capability}</span>
          <span className={`lg-chip${derived ? " lg-chip-derived" : ""}`}>
            {derived ? "⚙ derived" : "read"}
          </span>
        </div>
        <div className="lg-detail" title={data.detail}>{data.detail}</div>
        <div className={`lg-value${derived ? " lg-value-derived" : ""}`}>{data.value}</div>
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
