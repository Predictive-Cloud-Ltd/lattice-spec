import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow, Background, Controls, Panel,
  useNodesState, useEdgesState,
  type Node, type Edge, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildNodeDetail } from "./inspector-model";
import { layoutGraph } from "./layout";
import { CapabilityNode, type CapabilityNodeData } from "./CapabilityNode";

const nodeTypes = { capability: CapabilityNode };

const edgeDefaults = {
  labelStyle: { fill: "#9fb0cf", fontSize: 10 },
  labelBgStyle: { fill: "#0a0f24" },
  style: { stroke: "#475569" },
};

interface NodeDetailGraphProps {
  node: any;
  nodeSamples: Record<string, number>;
}

export function NodeDetailGraph({ node, nodeSamples }: NodeDetailGraphProps) {
  const rf = useRef<ReactFlowInstance | null>(null);

  // Layout only recomputes when the node's structure changes.
  const { initialNodes, initialEdges } = useMemo(() => {
    const detail = buildNodeDetail(node, {});
    const rawNodes: Node<CapabilityNodeData>[] = detail.caps.map((cap) => ({
      id: cap.id, type: "capability" as const, position: { x: 0, y: 0 },
      data: { ...cap } as CapabilityNodeData,
    }));
    const edges: Edge[] = detail.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      label: e.label || undefined, ...edgeDefaults,
    }));
    return { initialNodes: layoutGraph(rawNodes, edges, "LR"), initialEdges: edges };
  }, [node]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // The node's derivation model — computed once and reused by both the
  // sample-refresh effect below and the controls/context render.
  const detail = useMemo(() => buildNodeDetail(node, nodeSamples), [node, nodeSamples]);

  // Sample edits refresh values without touching positions.
  useEffect(() => {
    const fresh: Record<string, CapabilityNodeData> = {};
    for (const cap of detail.caps) fresh[cap.id] = { ...cap } as CapabilityNodeData;
    setNodes((nds) => nds.map((n) => (fresh[n.id] ? { ...n, data: fresh[n.id] } : n)));
  }, [detail, setNodes]);

  const tidy = () => {
    setNodes((nds) => layoutGraph(nds, edges, "LR"));
    requestAnimationFrame(() => rf.current?.fitView({ padding: 0.15 }));
  };

  return (
    <div>
      <div className="lg-canvas">
        <ReactFlow
          colorMode="dark"
          nodeTypes={nodeTypes}
          nodes={nodes}
          edges={edges}
          onInit={(inst) => { rf.current = inst; }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
        >
          <Background />
          <Controls />
          <Panel position="top-right">
            <button className="lg-tidy" data-testid="tidy-layout-detail" onClick={tidy}>tidy layout</button>
          </Panel>
        </ReactFlow>
      </div>

      {detail.controls.length > 0 && (
        <div className="lg-controls">
          <div className="section">Writable controls</div>
          {detail.controls.map((c, i) => (
            <div key={`${c.capability}-${i}`} className="lg-control">
              <span className="lg-muted">✎</span>
              <span>{c.capability}</span>
              <span className="lg-detail">{c.detail}</span>
            </div>
          ))}
        </div>
      )}

      {detail.context.length > 0 && (
        <div className="lg-ctx">
          {detail.context.map((ctx) => (
            <span key={ctx.label} className="ap">
              <span className="lg-muted">{ctx.label}</span> {ctx.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
