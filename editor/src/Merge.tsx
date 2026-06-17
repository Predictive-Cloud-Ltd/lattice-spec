import { useMemo, useState } from "react";
import { mergeFragments } from "./merge-engine";
import { Graph } from "./Graph";

const FRAG_A = `{
  "topologyVersion": "0.1.0",
  "scope": "fragment",
  "producer": { "name": "Local gateway", "provider": "local-gateway" },
  "nodes": [
    {
      "id": "GW-0001", "kind": "gateway",
      "accessPaths": [{ "id": "gw-local", "provider": "local-gateway", "locality": "local", "transport": "modbus", "preference": 10 }],
      "capabilities": [
        { "capability": "grid_power", "accessPath": "gw-local", "unit": "W",
          "read": { "protocol": "modbus", "op": "read_input", "address": 100 } }
      ]
    },
    {
      "id": "INV-0001", "kind": "inverter",
      "accessPaths": [{ "id": "gw-local", "provider": "local-gateway", "locality": "local", "transport": "modbus", "preference": 10 }],
      "capabilities": [
        { "capability": "soc", "accessPath": "gw-local", "unit": "%",
          "read": { "protocol": "modbus", "op": "read_input", "address": 60 } },
        { "capability": "charge_rate", "accessPath": "gw-local", "unit": "W",
          "control": { "protocol": "modbus", "op": "write_single", "address": 80 } }
      ]
    }
  ],
  "relationships": [{ "from": "GW-0001", "to": "INV-0001", "type": "contains" }]
}`;

const FRAG_B = `{
  "topologyVersion": "0.1.0",
  "scope": "fragment",
  "producer": { "name": "Vendor cloud", "provider": "example-cloud" },
  "nodes": [
    {
      "id": "INV-0001", "kind": "inverter",
      "accessPaths": [{ "id": "vendor-cloud", "provider": "example-cloud", "locality": "cloud", "transport": "cloud-api", "preference": 1 }],
      "capabilities": [
        { "capability": "soc", "accessPath": "vendor-cloud", "unit": "%",
          "read": { "protocol": "cloud-api", "op": "get", "address": "/v1/inverters/{id}/soc" } },
        { "capability": "charge_rate", "accessPath": "vendor-cloud", "unit": "W",
          "control": { "protocol": "cloud-api", "op": "post", "address": "/v1/inverters/{id}/commands/set-charge-rate" } }
      ]
    }
  ]
}`;

function parse(text: string): { obj: any; err: string | null } {
  try {
    return { obj: JSON.parse(text), err: null };
  } catch (e) {
    return { obj: null, err: (e as Error).message };
  }
}

export function Merge() {
  const [a, setA] = useState(FRAG_A);
  const [b, setB] = useState(FRAG_B);

  const pa = useMemo(() => parse(a), [a]);
  const pb = useMemo(() => parse(b), [b]);

  const merged = useMemo(() => {
    const frags = [pa.obj, pb.obj].filter(Boolean);
    return frags.length ? mergeFragments(frags) : null;
  }, [pa.obj, pb.obj]);

  return (
    <div className="merge">
      <div className="merge-inputs">
        <div className="frag">
          <div className="frag-head">Fragment A <span className="muted small">{pa.obj?.producer?.provider ?? (pa.err ? "invalid JSON" : "")}</span></div>
          <textarea value={a} onChange={(e) => setA(e.target.value)} spellCheck={false} />
        </div>
        <div className="frag">
          <div className="frag-head">Fragment B <span className="muted small">{pb.obj?.producer?.provider ?? (pb.err ? "invalid JSON" : "")}</span></div>
          <textarea value={b} onChange={(e) => setB(e.target.value)} spellCheck={false} />
        </div>
      </div>

      <div className="merge-out">
        <div className="section">Merged graph <span className="muted small">— by node identity ({merged?.nodeCount ?? 0} nodes)</span></div>
        <Graph doc={merged?.doc} />

        <div className="section">Merged nodes</div>
        <div className="merges">
          {(merged?.merges ?? []).map((m) => (
            <div className={`mnode ${m.multi ? "multi" : ""}`} key={m.id}>
              <div className="mnode-id">{m.id} <span className="muted">({m.kind})</span>{m.multi ? <span className="badge">merged</span> : null}</div>
              <div className="muted small">from: {m.providers.join(" + ")}</div>
              <div className="mn-aps">
                {m.accessPaths
                  .slice()
                  .sort((x, y) => y.preference - x.preference)
                  .map((ap, i) => (
                    <span key={ap.id} className="ap">
                      {i === 0 ? "★ " : "↳ "}{ap.id}<span className="muted"> · {ap.provider} · p{ap.preference}</span>
                    </span>
                  ))}
              </div>
            </div>
          ))}
          {!merged && <div className="muted small">Both fragments must be valid JSON.</div>}
        </div>
        <p className="muted small merge-note">
          The same <code>id</code> from two producers becomes one node carrying both access paths — ranked, with the
          ★ preferred one and ↳ fallback(s). That's the multi-vendor composition: a device reachable via the local
          gateway <em>and</em> the vendor cloud.
        </p>
      </div>
    </div>
  );
}
