// Discovery demo engine — mirrors the gateway's C++ flow as data:
// probe -> fingerprint-match against the descriptor catalog -> instantiate nodes
// from the descriptor's capabilities/bindings -> emit a fragment.
// The catalog here is vendor-neutral and illustrative.

export type Probe = { serial?: string; dtc?: string; fw?: number; aioCount?: number; [k: string]: unknown };

type Descriptor = {
  key: string;
  kind: string;
  dtcHi?: number;        // match (parseInt(dtc,16) >> 8)
  serialPrefix?: string; // match serial.startsWith(...)
  probe?: string;        // a probe field that must be > 0 (e.g. aioCount)
  aggregate?: any;
  contains?: string;     // child descriptor key
  capabilities: any[];
};

// The discovery schema as DATA. In the real gateway this catalog is flash/OTA-distributable.
const CATALOG: Descriptor[] = [
  {
    key: "example-gateway", kind: "gateway",
    dtcHi: 0x70, serialPrefix: "GW", probe: "aioCount",
    aggregate: { serves: true, minChildren: 2, priority: 10, over: "contains" },
    contains: "example-hybrid-inverter",
    capabilities: [
      { capability: "meter.grid_power", accessPath: "gw-local", unit: "W", read: { protocol: "modbus", op: "read_input", address: 100 } },
    ],
  },
  {
    key: "example-hybrid-inverter", kind: "inverter",
    dtcHi: 0x80, serialPrefix: "INV",
    capabilities: [
      { capability: "battery.soc", accessPath: "gw-local", unit: "%", read: { protocol: "modbus", op: "read_input", address: 60 } },
      { capability: "battery.charge_power_limit", accessPath: "gw-local", unit: "W", constraints: { min: 0, max: "rated" },
        read: { protocol: "modbus", op: "read_holding", address: 80 }, control: { protocol: "modbus", op: "write_single", address: 80 } },
    ],
  },
  {
    key: "example-evse", kind: "ev_charger", serialPrefix: "EVSE",
    capabilities: [
      { capability: "ev_charger.charge_current_limit", accessPath: "gw-local", unit: "A", constraints: { min: 0, max: 32 },
        control: { protocol: "modbus", op: "write_single", address: 300 } },
    ],
  },
  {
    key: "example-meter", kind: "meter", serialPrefix: "MTR",
    capabilities: [
      { capability: "meter.grid_voltage", accessPath: "gw-local", unit: "V", reducer: "representative", groupBy: "phase",
        read: { protocol: "modbus", op: "read_input", address: 200, count: 3 } },
    ],
  },
];

export type Match = { probe: Probe; descriptor?: Descriptor; rule?: string };

function dtcHi(dtc?: string): number | undefined {
  if (!dtc) return undefined;
  const v = parseInt(dtc, 16);
  return Number.isNaN(v) ? undefined : (v >> 8) & 0xff;
}

export function matchProbe(p: Probe): Match {
  const hi = dtcHi(p.dtc);
  for (const d of CATALOG) {
    if (d.dtcHi != null && hi === d.dtcHi) return { probe: p, descriptor: d, rule: `DTC hi-byte 0x${d.dtcHi.toString(16)}` };
    if (d.serialPrefix && p.serial && p.serial.startsWith(d.serialPrefix)) return { probe: p, descriptor: d, rule: `serial prefix "${d.serialPrefix}"` };
    if (d.probe && Number(p[d.probe]) > 0) return { probe: p, descriptor: d, rule: `probe ${d.probe} > 0` };
  }
  return { probe: p };
}

export function discover(probes: Probe[]): { matches: Match[]; fragment: any } {
  const matches = probes.map(matchProbe);
  const nodes: any[] = [];
  for (const m of matches) {
    if (!m.descriptor || !m.probe.serial) continue;
    nodes.push({
      id: m.probe.serial,
      kind: m.descriptor.kind,
      deviceType: m.descriptor.key,
      accessPaths: [{ id: "gw-local", provider: "local-gateway", locality: "local", transport: "modbus", preference: 10 }],
      ...(m.descriptor.aggregate ? { aggregate: m.descriptor.aggregate } : {}),
      capabilities: m.descriptor.capabilities,
    });
  }
  // a gateway descriptor implies `contains` edges to the inverters discovered
  const rels: any[] = [];
  for (const g of matches) {
    if (!g.descriptor?.contains || !g.probe.serial) continue;
    for (const m of matches) {
      if (m.descriptor?.key === g.descriptor.contains && m.probe.serial) {
        rels.push({ from: g.probe.serial, to: m.probe.serial, type: "contains" });
      }
    }
  }
  const fragment = {
    topologyVersion: "0.2.0",
    scope: "fragment",
    producer: { name: "Local gateway (discovered)", provider: "local-gateway" },
    nodes,
    relationships: rels,
  };
  return { matches, fragment };
}
