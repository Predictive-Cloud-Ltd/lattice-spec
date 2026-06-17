import { useMemo, useState } from "react";
import { discover } from "./discover-engine";
import { Graph } from "./Graph";

const PROBES = `[
  { "serial": "GW-0001",   "dtc": "0x7001", "aioCount": 2 },
  { "serial": "INV-0001",  "dtc": "0x8001" },
  { "serial": "EVSE-0001" },
  { "serial": "MTR-0001" }
]`;

export function Discover() {
  const [text, setText] = useState(PROBES);
  const parsed = useMemo(() => {
    try {
      return { obj: JSON.parse(text), err: null as string | null };
    } catch (e) {
      return { obj: null as any, err: (e as Error).message };
    }
  }, [text]);
  const out = useMemo(() => (Array.isArray(parsed.obj) ? discover(parsed.obj) : null), [parsed.obj]);

  return (
    <div className="discover">
      <div className="disc-left">
        <div className="frag-head">Raw probes <span className="muted small">— what the gateway reads off the bus</span></div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </div>

      <div className="disc-right">
        <div className="section">Fingerprint matches</div>
        <div className="matches">
          {parsed.err && <div className="muted small">Invalid JSON — {parsed.err}</div>}
          {(out?.matches ?? []).map((m, i) => (
            <div className={`mnode ${m.descriptor ? "multi" : "nomatch"}`} key={i}>
              <div className="mnode-id">
                {m.probe.serial ?? "(no serial)"}
                {m.descriptor ? <span className="badge">{m.descriptor.key}</span> : <span className="badge bad">no match</span>}
              </div>
              {m.descriptor ? (
                <div className="muted small">matched by {m.rule} → kind <code>{m.descriptor.kind}</code></div>
              ) : (
                <div className="muted small">no fingerprint matched</div>
              )}
            </div>
          ))}
        </div>

        <div className="section">Generated fragment</div>
        <Graph doc={out?.fragment} />
        <pre className="fragjson">{out ? JSON.stringify(out.fragment, null, 2) : ""}</pre>

        <p className="muted small merge-note">
          probe → <strong>fingerprint match</strong> (DTC hi-byte / serial prefix / probe register) → instantiate nodes
          from the descriptor's capabilities + bindings → emit this <strong>fragment</strong>. The gateway publishes it
          up; the cloud merges it (see the <em>Merge</em> tab). The catalog is data — new device families ship as a
          descriptor, no firmware rebuild.
        </p>
      </div>
    </div>
  );
}
