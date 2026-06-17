import { useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import example from "./generated/example.json";
import { validateDoc } from "./validate";
import { Graph } from "./Graph";

export default function App() {
  const [text, setText] = useState<string>(JSON.stringify(example, null, 2));

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
      : { cls: "bad", msg: `✗ ${result?.errors.length ?? 0} schema error(s)` };

  const doc = parsed.obj as { nodes?: any[] } | null;
  const nodes = Array.isArray(doc?.nodes) ? doc!.nodes : [];

  return (
    <div className="app">
      <header>
        <span className="brand">Lattice</span>
        <span className="muted">Editor — paste / edit a document, validate &amp; visualise</span>
        <a className="right" href="https://lattice-spec.org" target="_blank" rel="noreferrer">lattice-spec.org →</a>
      </header>

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

          <div className="section">Topology</div>
          <Graph doc={doc} />

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
    </div>
  );
}
