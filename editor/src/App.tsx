import { useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import example from "./generated/example.json";
import { validateDoc } from "./validate";
import { TopologyCanvas } from "./graph/TopologyCanvas";
import { NodeDetailGraph } from "./graph/NodeDetailGraph";
import { DEFAULT_SAMPLES_TEXT } from "./graph/example-samples";
import { Resolver } from "./Resolver";
import { Merge } from "./Merge";
import { Discover } from "./Discover";

export default function App() {
  const [mode, setMode] = useState<"editor" | "merge" | "discover">("editor");
  const [text, setText] = useState<string>(JSON.stringify(example, null, 2));

  const [samplesText, setSamplesText] = useState<string>(DEFAULT_SAMPLES_TEXT);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Parse samples, retaining the last good value on JSON errors so the
  // graph never blanks mid-edit.
  const lastGoodSamples = useRef<Record<string, Record<string, number>> | null>(null);
  const samplesParse = useMemo(() => {
    try {
      const obj = JSON.parse(samplesText) as Record<string, Record<string, number>>;
      lastGoodSamples.current = obj;
      return { samples: obj, err: null as string | null };
    } catch (e) {
      return { samples: lastGoodSamples.current, err: (e as Error).message };
    }
  }, [samplesText]);

  const parsed = useMemo(() => {
    try {
      return { obj: JSON.parse(text) as unknown, err: null as string | null };
    } catch (e) {
      return { obj: null as unknown, err: (e as Error).message };
    }
  }, [text]);

  const result = useMemo(
    () => (parsed.obj != null ? validateDoc(parsed.obj) : null),
    [parsed.obj],
  );

  const status = parsed.err
    ? { cls: "bad", msg: `Invalid JSON — ${parsed.err}` }
    : result?.ok
      ? { cls: "ok", msg: "✓ Valid Lattice document" }
      : result?.schemaErrors.length
        ? { cls: "bad", msg: `✗ ${result.schemaErrors.length} schema error(s)` }
        : { cls: "bad", msg: `✗ ${result?.conformanceErrors.length ?? 0} conformance error(s)` };

  const doc = parsed.obj as { nodes?: any[] } | null;
  const nodes = Array.isArray(doc?.nodes) ? doc!.nodes : [];

  // Selection survives only while the node still exists in the doc.
  const selectedNode = useMemo(
    () => nodes.find((n: any) => n?.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  return (
    <div className="app">
      <header>
        <span className="brand">Lattice</span>
        <div className="seg headseg">
          <button className={mode === "editor" ? "on" : ""} onClick={() => setMode("editor")}>Editor</button>
          <button className={mode === "merge" ? "on" : ""} onClick={() => setMode("merge")}>Merge</button>
          <button className={mode === "discover" ? "on" : ""} onClick={() => setMode("discover")}>Discover</button>
        </div>
        <a className="right" href="https://lattice-spec.org" target="_blank" rel="noreferrer">lattice-spec.org →</a>
      </header>

      {mode === "merge" ? (
        <Merge />
      ) : mode === "discover" ? (
        <Discover />
      ) : (
      <div className="panes">
        <div className="left">
          <Editor
            height="100%"
            defaultLanguage="json"
            value={text}
            onChange={(v) => setText(v ?? "")}
            theme="vs-dark"
            options={{ minimap: { enabled: false }, fontSize: 13, tabSize: 2, scrollBeyondLastLine: false }}
          />
        </div>

        <div className="right">
          <div className={`status ${status.cls}`}>{status.msg}</div>

          {result && !result.ok && (
            <ul className="errors">
              {result.errors.slice(0, 14).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {result.errors.length > 14 && <li className="muted">… and {result.errors.length - 14} more</li>}
            </ul>
          )}

          <div className="section">Resolve <span className="muted small">— route, access-path fallback &amp; clamp</span></div>
          <Resolver doc={doc} />

          <div className="section">Topology</div>
          <TopologyCanvas
            doc={doc}
            samples={samplesParse.samples}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
          />

          <div className="section">Samples <span className="muted small">— paste {"{ nodeId: { capability: value } }"} and watch derived capabilities evaluate</span></div>
          <div className="samples">
            <textarea
              data-testid="samples-input"
              value={samplesText}
              onChange={(e) => setSamplesText(e.target.value)}
              spellCheck={false}
            />
            {samplesParse.err && <div className="err">Invalid JSON — {samplesParse.err} (showing last valid samples)</div>}
          </div>

          {selectedNode && (
            <>
              <div className="section">Node detail <span className="muted small">— {String(selectedNode.id)}</span></div>
              <NodeDetailGraph node={selectedNode} nodeSamples={samplesParse.samples?.[selectedNode.id] ?? {}} />
            </>
          )}

          <div className="section">Capabilities</div>
          <div className="caps">
            {nodes.length === 0 && <div className="muted small">No nodes.</div>}
            {nodes.flatMap((n: any) =>
              (Array.isArray(n?.capabilities) ? n.capabilities : []).map((c: any, i: number) => (
                <div className="cap" key={`${n.id}-${c.capability}-${i}`}>
                  <span className="cap-node">{String(n.id)}</span>
                  <span className="cap-name">{String(c.capability)}</span>
                  <span className="cap-rw">{c.read ? "R" : ""}{c.control ? "W" : ""}</span>
                  <span className="cap-unit muted">{c.unit ?? ""}</span>
                </div>
              )),
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
