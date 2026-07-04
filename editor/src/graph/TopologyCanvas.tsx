import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow, Background, Controls, Panel,
  useNodesState, useEdgesState,
  type Node, type Edge, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildTopologyModel } from "./inspector-model";
import { layoutGraph } from "./layout";
import { DeviceNode, type DeviceNodeData } from "./DeviceNode";

const nodeTypes = { device: DeviceNode };

const edgeDefaults = {
  labelStyle: { fill: "#9fb0cf", fontSize: 10 },
  labelBgStyle: { fill: "#0a0f24" },
  style: { stroke: "#475569" },
};

interface TopologyCanvasProps {
  doc: any;
  samples: Record<string, Record<string, number>> | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TopologyCanvas({ doc, samples, selectedId, onSelect }: TopologyCanvasProps) {
  const rf = useRef<ReactFlowInstance | null>(null);

  // Structure (nodes/edges/layout) recomputes only when the doc changes,
  // so user drags survive samples/selection updates.
  const { initialNodes, initialEdges } = useMemo(() => {
    const model = buildTopologyModel(doc, null);
    const rawNodes: Node<DeviceNodeData>[] = model.nodes.map((n) => ({
      id: n.id, type: "device" as const, position: { x: 0, y: 0 },
      data: { ...n, selected: false },
    }));
    const edges: Edge[] = model.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: e.label,
      animated: e.label === "measures",
      ...edgeDefaults,
      ...(e.label === "measures" ? { style: { stroke: "#6ea8fe" } } : {}),
    }));
    return { initialNodes: layoutGraph(rawNodes, edges, "TB"), initialEdges: edges };
  }, [doc]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Samples/selection change node data only — positions untouched.
  useEffect(() => {
    const model = buildTopologyModel(doc, samples);
    const fresh: Record<string, DeviceNodeData> = {};
    for (const n of model.nodes) fresh[n.id] = { ...n, selected: n.id === selectedId };
    setNodes((nds) => nds.map((n) => (fresh[n.id] ? { ...n, data: fresh[n.id] } : n)));
  }, [doc, samples, selectedId, setNodes]);

  const tidy = () => {
    setNodes((nds) => layoutGraph(nds, edges, "TB"));
    requestAnimationFrame(() => rf.current?.fitView({ padding: 0.15 }));
  };

  return (
    <div className="lg-canvas">
      <ReactFlow
        colorMode="dark"
        nodeTypes={nodeTypes}
        nodes={nodes}
        edges={edges}
        onInit={(inst) => { rf.current = inst; }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelect(node.id)}
        fitView
      >
        <Background />
        <Controls />
        <Panel position="top-right">
          <button className="lg-tidy" data-testid="tidy-layout" onClick={tidy}>tidy layout</button>
        </Panel>
      </ReactFlow>
    </div>
  );
}
