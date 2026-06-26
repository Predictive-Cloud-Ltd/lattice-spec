import { useMemo, useState } from "react";
import { resolve, listCapabilities, listAccessPaths, type ResolveResult, type Altitude } from "./resolve-engine";

export function Resolver({ doc }: { doc: unknown }) {
  const caps = useMemo(() => listCapabilities(doc), [doc]);
  const aps = useMemo(() => listAccessPaths(doc), [doc]);

  const [cap, setCap] = useState<string>("");
  const [side, setSide] = useState<"read" | "control">("control");
  const [value, setValue] = useState<string>("6000");
  const [altitude, setAltitude] = useState<Altitude>("auto");
  const [offline, setOffline] = useState<Set<string>>(new Set());

  const effCap = cap && caps.includes(cap) ? cap : caps[0] ?? "";
  const res = useMemo<ResolveResult | null>(
    () => (effCap ? resolve(doc, effCap, side, side === "control" ? Number(value) : undefined, offline, altitude) : null),
    [doc, effCap, side, value, offline, altitude],
  );

  if (!caps.length) return <div className="muted small">Load a valid document to resolve capabilities.</div>;

  const toggle = (id: string) =>
    setOffline((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div className="resolver">
      <div className="rrow">
        <select value={effCap} onChange={(e) => setCap(e.target.value)}>
          {caps.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <div className="seg">
          <button className={side === "read" ? "on" : ""} onClick={() => setSide("read")}>read</button>
          <button className={side === "control" ? "on" : ""} onClick={() => setSide("control")}>control</button>
        </div>
        {side === "control" && (
          <input className="val" value={value} onChange={(e) => setValue(e.target.value)} aria-label="intent value" />
        )}
        {side === "control" && (
          <div className="seg" role="group" aria-label="control altitude">
            {(["auto", "aggregate", "leaves"] as Altitude[]).map((a) => (
              <button key={a} className={altitude === a ? "on" : ""} onClick={() => setAltitude(a)}>{a}</button>
            ))}
          </div>
        )}
      </div>

      {aps.length > 0 && (
        <div className="aps-toggle">
          <span className="muted small">simulate offline:</span>
          {aps.map((id) => (
            <label key={id} className={offline.has(id) ? "off" : ""}>
              <input type="checkbox" checked={offline.has(id)} onChange={() => toggle(id)} /> {id}
            </label>
          ))}
        </div>
      )}

      {res && <ResultView res={res} />}
    </div>
  );
}

function ResultView({ res }: { res: ResolveResult }) {
  if (!res.ok && res.message && !res.node) {
    return <div className="rresult bad">✗ {res.message}</div>;
  }
  return (
    <div className={`rresult ${res.ok ? "ok" : "bad"}`}>
      <div className="rline">
        <span className="rk">{res.side === "read" ? "read route" : "control route"}</span>
        <span>→ <strong>{res.node}</strong> <span className="muted">({res.nodeKind})</span>
          {res.routeNodeCount && res.routeNodeCount > 1 ? <span className="muted"> +{res.routeNodeCount - 1} more, reduce: <code>{res.reducer}</code></span> : null}
          {res.reducer && res.routeNodeCount === 1 ? <span className="muted"> · reduce: <code>{res.reducer}</code></span> : null}
        </span>
      </div>

      <div className="rline">
        <span className="rk">access path</span>
        <span className="aps">
          {res.accessPaths.map((a) => (
            <span key={a.id} className={`ap ${a.chosen ? "chosen" : ""} ${!a.available ? "offline" : ""}`}>
              {a.id}<span className="muted"> · {a.provider} · p{a.preference}</span>
              {a.chosen ? " ✓" : !a.available ? " ✗offline" : ""}
            </span>
          ))}
        </span>
      </div>
      {res.fellBack && res.ok && <div className="rnote">↳ preferred path offline — <strong>fell back</strong> to <code>{res.chosenAccessPath}</code></div>}
      {!res.ok && res.message && <div className="rnote bad">{res.message}</div>}

      {res.side === "control" && res.strategy && (
        <div className="rline">
          <span className="rk">altitude</span>
          <span>
            <strong>{res.strategy}</strong>
            <span className="muted">
              {res.strategy === "delegated" ? " — one command, the coordinator fans out" : res.strategy === "expanded" ? " — hub fans out to each leaf" : " — single device"}
            </span>
            {res.distribution ? <span className="muted"> · distribute: <code>{res.distribution}</code></span> : null}
            {res.planNodes && res.planNodes.length ? <span className="muted"> · command: <strong>{res.planNodes.join(", ")}</strong></span> : null}
          </span>
        </div>
      )}
      {res.side === "control" && (res.shape || res.tier != null || res.controlGroup) && (
        <div className="rline">
          <span className="rk">control</span>
          <span>
            {res.shape ? <strong>{res.shape}</strong> : null}
            {res.tier != null ? <span className="muted"> · tier {res.tier}</span> : null}
            {res.controlGroup ? <span className="muted"> · group <code>{res.controlGroup}</code></span> : null}
            {res.binding?.readModifyWrite ? <span className="muted"> · read-modify-write</span> : null}
          </span>
        </div>
      )}
      {res.strategy === "expanded" && res.planNodes && res.planNodes.length > 1 && (
        <div className="rnote">↳ illustrative: the access path + binding below are shown for <code>{res.node}</code> only — each of the {res.planNodes.length} plan nodes resolves its own path/binding.</div>
      )}
      {res.side === "control" && res.ownedNodes && res.ownedNodes.length > 0 && (
        <div className="rline">
          <span className="rk">owns</span>
          <span className="muted">{res.ownedNodes.join(", ")} <span className="small">— claimed subtree, not separately controllable while held (§6)</span></span>
        </div>
      )}
      {res.ownershipNote && <div className="rnote">⚠ {res.ownershipNote}</div>}

      {res.side === "control" && res.clamped != null && (
        <div className="rline">
          <span className="rk">clamp</span>
          <span>
            {res.intent}{res.unit ? ` ${res.unit}` : ""} → <strong>{res.clamped}{res.unit ? ` ${res.unit}` : ""}</strong>
            <span className="muted"> (min {res.clampMin}, max {res.clampMaxLabel})</span>
            {res.intent !== res.clamped ? <span className="clamped-tag"> clamped</span> : null}
          </span>
        </div>
      )}

      {res.binding && (
        <div className="rline">
          <span className="rk">binding</span>
          <code className="bind">
            {res.binding.protocol} {res.binding.op} {String(res.binding.address)}
            {res.binding.transform ? `  ·  transform ${res.binding.transform}` : ""}
          </code>
        </div>
      )}
    </div>
  );
}
