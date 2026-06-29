export const SPEC_VERSION = "0.1.0";

function add(errors, label, message) {
  errors.push(label ? `${label}: ${message}` : message);
}

// Capability identity MUST be `class.function` (qualified by device class) or a namespaced
// `x-<vendor>:` extension; a bare name reintroduces cross-class ambiguity. Shared by node
// capabilities and device-type template capabilities.
function isValidCapabilityName(name) {
  const s = String(name);
  return /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(s) || /^x-[^:]+:.+$/.test(s);
}

// A capability may appear several times on one offerer (one per access path); the
// same capability + access path twice is a duplicate. Shared by node and
// device-type-template capability lists.
function checkOfferUniqueness(errors, label, owner, capabilities) {
  if (!Array.isArray(capabilities)) return;
  const offerKeys = new Set();
  for (const capability of capabilities) {
    if (!capability?.capability) continue;
    const offerKey = `${String(capability.capability)}|${capability.accessPath ?? ""}`;
    if (offerKeys.has(offerKey)) {
      add(errors, label, `${owner} repeats capability/accessPath "${offerKey}"`);
    }
    offerKeys.add(offerKey);
  }
}

export function checkSemanticInvariants(doc, options = {}) {
  const label = options.label ?? "";
  const errors = [];

  if (!doc || typeof doc !== "object") {
    add(errors, label, "document must be an object");
    return errors;
  }

  // Data-plane readiness — a docVersion plus a per-capability `ref`/`accessPath` —
  // is only required of a merged `site` doc. A description-only `fragment` (the
  // schema default) may omit them and still be conformant; cross-reference
  // integrity (unknown refs/endpoints, duplicate ids, etc.) is checked in both
  // modes. Callers can force either mode with the `requireDataPlane` option.
  const requireDataPlane = options.requireDataPlane ?? doc.scope === "site";

  if (doc.topologyVersion !== SPEC_VERSION) {
    add(errors, label, `topologyVersion must be ${SPEC_VERSION}`);
  }
  if (requireDataPlane && !Number.isInteger(doc.docVersion)) {
    add(errors, label, "docVersion must be an integer for data-plane conformance");
  }

  // A merged `site` doc is post-merge: tombstones must already be applied, so `removed:true`
  // anywhere in a site doc is a contradiction. (Fragments/overlays may carry tombstones.)
  if (doc.scope === "site") {
    const flagTombstones = (items, what) => {
      for (const it of Array.isArray(items) ? items : []) {
        if (it && it.removed === true) add(errors, label, `${what} "${String(it.id ?? it.capability ?? it.type ?? "")}" carries a tombstone (removed) in a merged site doc`);
      }
    };
    for (const node of Array.isArray(doc.nodes) ? doc.nodes : []) {
      if (!node || typeof node !== "object") continue;
      if (node.removed === true) add(errors, label, `node "${String(node.id ?? "")}" carries a tombstone (removed) in a merged site doc`);
      flagTombstones(node.accessPaths, "access path");
      flagTombstones(node.capabilities, "capability");
    }
    flagTombstones(doc.relationships, "relationship");
  }

  // Device-type descriptors first (nodes reference them by key). Validate key
  // uniqueness and the descriptor's capability templates. A template has no access
  // paths/attributes of its own, so only the structure-independent invariant — no
  // duplicate capability/accessPath offer — applies to its capabilities.
  const deviceTypes = Array.isArray(doc.deviceTypes) ? doc.deviceTypes : [];
  const deviceTypeKeys = new Set();
  for (const deviceType of deviceTypes) {
    if (!deviceType?.key) continue;
    if (deviceTypeKeys.has(deviceType.key)) {
      add(errors, label, `duplicate deviceTypes key "${deviceType.key}"`);
    }
    deviceTypeKeys.add(deviceType.key);
    checkOfferUniqueness(errors, label, `deviceType "${deviceType.key}"`, deviceType.capabilities);
    for (const capability of deviceType.capabilities ?? []) {
      if (!capability?.capability) continue;
      if (!isValidCapabilityName(capability.capability)) {
        add(errors, label, `deviceType "${deviceType.key}" capability "${capability.capability}" is not class.function or a namespaced x-* extension`);
      }
    }
  }

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const nodeIds = new Set();
  const capRefToKey = new Map();

  for (const [nodeIndex, node] of nodes.entries()) {
    if (!node || typeof node !== "object") continue;
    const nodeId = String(node.id ?? "");
    if (!nodeId) {
      // The id is the cross-producer merge key; a node without one can't be
      // checked or referenced. Report it rather than skipping silently.
      add(errors, label, `node #${nodeIndex} is missing an id`);
      continue;
    }

    if (nodeIds.has(nodeId)) {
      add(errors, label, `duplicate node id "${nodeId}"`);
    }
    nodeIds.add(nodeId);

    // node.deviceType must resolve to a declared descriptor once the doc carries a
    // descriptor table, or — for a merged `site` doc — always (a site has no other
    // fragment left to supply it). A `fragment` may reference a descriptor defined
    // in another fragment, so a missing table there is tolerated.
    if (
      node.deviceType &&
      (deviceTypeKeys.size > 0 || requireDataPlane) &&
      !deviceTypeKeys.has(node.deviceType)
    ) {
      add(errors, label, `node "${nodeId}" references unknown deviceType "${node.deviceType}"`);
    }

    const accessPathIds = new Set();
    for (const accessPath of node.accessPaths ?? []) {
      if (!accessPath?.id) continue;
      if (accessPathIds.has(accessPath.id)) {
        add(errors, label, `node "${nodeId}" has duplicate accessPath "${accessPath.id}"`);
      }
      accessPathIds.add(accessPath.id);
    }

    const offerKeys = new Set();
    const refsByNodeCapability = new Map();
    const groupBindings = new Map(); // controlGroup -> Set(binding signature): members must share ONE op
    const groupMembers = new Map();  // controlGroup -> [{ capName, slot }]: how each value enters the one op
    const nodeCapNames = new Set((node.capabilities ?? []).map((c) => c?.capability).filter(Boolean).map(String));
    const nodeParamNames = node.parameters && typeof node.parameters === "object" ? Object.keys(node.parameters) : [];
    const derivedDeps = new Map();   // derived capName -> [input capability refs], for cycle detection
    for (const capability of node.capabilities ?? []) {
      if (!capability?.capability) continue;
      const capName = String(capability.capability);
      const offerKey = `${capName}|${capability.accessPath ?? ""}`;
      const nodeCapKey = `${nodeId}|${capName}`;

      // Capability identity is the merge/resolve key: it MUST be `class.function` (qualified by device
      // class) or a namespaced `x-<vendor>:` extension. A bare name reintroduces the cross-class
      // collision the model exists to prevent (e.g. a battery's W vs an EV's A).
      if (!isValidCapabilityName(capName)) {
        add(errors, label, `node "${nodeId}" capability "${capName}" is not class.function or a namespaced x-* extension`);
      }

      if (offerKeys.has(offerKey)) {
        add(errors, label, `node "${nodeId}" repeats capability/accessPath "${offerKey}"`);
      }
      offerKeys.add(offerKey);

      if (!capability.accessPath) {
        // A derived read is computed from sibling capabilities — it has no transport, so no accessPath.
        if (requireDataPlane && !capability.derived) {
          add(errors, label, `node "${nodeId}" capability "${capName}" is missing accessPath`);
        }
      } else if (!accessPathIds.has(capability.accessPath)) {
        add(
          errors,
          label,
          `node "${nodeId}" capability "${capName}" references unknown accessPath "${capability.accessPath}"`,
        );
      }

      if (!Number.isInteger(capability.ref)) {
        if (requireDataPlane) {
          add(errors, label, `node "${nodeId}" capability "${capName}" must define integer ref`);
        }
      } else {
        const previous = refsByNodeCapability.get(nodeCapKey);
        if (previous != null && previous !== capability.ref) {
          add(errors, label, `node "${nodeId}" capability "${capName}" uses inconsistent refs`);
        }
        refsByNodeCapability.set(nodeCapKey, capability.ref);

        const existingKey = capRefToKey.get(capability.ref);
        if (existingKey && existingKey !== nodeCapKey) {
          add(errors, label, `ref ${capability.ref} is shared by "${existingKey}" and "${nodeCapKey}"`);
        }
        capRefToKey.set(capability.ref, nodeCapKey);
      }

      if (capability.constraints?.max === "rated" && typeof node.attributes?.ratedW !== "number") {
        add(errors, label, `node "${nodeId}" capability "${capName}" uses max "rated" without attributes.ratedW`);
      }
      // A runtime-sourced constraint bound ({ source }) must resolve to a sibling capability or node parameter.
      for (const which of ["min", "max"]) {
        const bound = capability.constraints?.[which];
        if (bound && typeof bound === "object" && typeof bound.source === "string") {
          if (!nodeCapNames.has(bound.source) && !nodeParamNames.includes(bound.source)) {
            add(errors, label, `node "${nodeId}" capability "${capName}" constraint ${which} source "${bound.source}" is not a capability or parameter on this node`);
          }
        }
      }

      // Transform parameter references must resolve to a declared node parameter.
      const nodeParams = node.parameters && typeof node.parameters === "object" ? node.parameters : {};
      const collectRefs = (transform, out) => {
        if (!transform || typeof transform !== "object") return out;
        for (const key of ["num", "den", "scale", "offset", "min", "max"]) {
          const value = transform[key];
          if (value && typeof value === "object" && typeof value.ref === "string") out.push(value.ref);
        }
        for (const step of Array.isArray(transform.steps) ? transform.steps : []) collectRefs(step, out);
        return out;
      };
      for (const binding of [capability.read, capability.control]) {
        for (const refName of collectRefs(binding?.transform, [])) {
          if (!(refName in nodeParams)) {
            add(errors, label, `node "${nodeId}" capability "${capName}" transform ref "${refName}" has no matching node parameter`);
          }
        }
      }

      // Control offers must declare how the intent is shaped and at what tier.
      if (capability.control) {
        if (!capability.shape) {
          add(errors, label, `node "${nodeId}" capability "${capName}" has a control binding but no shape`);
        }
        if (capability.tier == null) {
          add(errors, label, `node "${nodeId}" capability "${capName}" has a control binding but no tier`);
        }
      }
      // A schedule-shape offer must declare its schedule surface so a consumer can build a valid plan.
      if (capability.shape === "schedule" && !capability.scheduleSpec) {
        add(errors, label, `node "${nodeId}" capability "${capName}" has shape "schedule" but no scheduleSpec`);
      }
      // scheduleSpec is only meaningful on a schedule-shape offer.
      if (capability.scheduleSpec && capability.shape !== "schedule") {
        add(errors, label, `node "${nodeId}" capability "${capName}" has a scheduleSpec but shape is not "schedule"`);
      }
      // A control group is a coupled WRITE; a member without a control binding is meaningless.
      if (capability.controlGroup && !capability.control) {
        add(errors, label, `node "${nodeId}" capability "${capName}" has controlGroup "${capability.controlGroup}" but no control binding`);
      }
      // Derived reads: a computed value isn't writable; collect inputs for ref-resolution + cycle check.
      if (capability.derived) {
        if (capability.control) {
          add(errors, label, `node "${nodeId}" capability "${capName}" is derived (computed) and cannot also have a control binding`);
        }
        const d = capability.derived, refs = [];
        if (d.op === "sum") for (const i of Array.isArray(d.inputs) ? d.inputs : []) { if (i?.ref) refs.push(String(i.ref)); }
        if (d.op === "ratio") { if (d.num?.ref) refs.push(String(d.num.ref)); if (d.den?.ref) refs.push(String(d.den.ref)); }
        derivedDeps.set(capName, refs);
      }
      // Members of a control group execute as ONE operation, so they must share one control binding
      // (same protocol/op/address) — the resolver gathers all member values and invokes it once.
      if (capability.controlGroup && capability.control) {
        const b = capability.control;
        const sig = `${b.protocol ?? ""}|${b.op ?? ""}|${JSON.stringify(b.address ?? null)}`;
        const sigs = groupBindings.get(capability.controlGroup) ?? new Set();
        sigs.add(sig);
        groupBindings.set(capability.controlGroup, sigs);
        const members = groupMembers.get(capability.controlGroup) ?? [];
        members.push({ capName, slot: capability.groupSlot });
        groupMembers.set(capability.controlGroup, members);
      }
    }
    for (const [group, sigs] of groupBindings) {
      if (sigs.size > 1) {
        add(errors, label, `node "${nodeId}" controlGroup "${group}" members must share one control binding (one atomic operation) — found ${sigs.size} distinct bindings`);
      }
    }
    // For a coupled op the executor must know where each member's value goes: with ≥2 members,
    // every member declares a `groupSlot`, and no two may collide (same field / overlapping bits).
    for (const [group, members] of groupMembers) {
      if (members.length < 2) continue;
      const fields = new Set();
      const bitRanges = [];
      for (const { capName, slot } of members) {
        if (!slot || (slot.field == null && slot.bits == null)) {
          add(errors, label, `node "${nodeId}" controlGroup "${group}" member "${capName}" needs a groupSlot (field or bits) to place its value in the one operation`);
          continue;
        }
        if (slot.field != null) {
          if (fields.has(slot.field)) {
            add(errors, label, `node "${nodeId}" controlGroup "${group}" has two members on field "${slot.field}"`);
          }
          fields.add(slot.field);
        }
        if (slot.bits && Number.isInteger(slot.bits.lsb) && Number.isInteger(slot.bits.width)) {
          const lo = slot.bits.lsb;
          const hi = slot.bits.lsb + slot.bits.width - 1;
          for (const r of bitRanges) {
            if (lo <= r.hi && r.lo <= hi) {
              add(errors, label, `node "${nodeId}" controlGroup "${group}" member "${capName}" bit range [${lo}..${hi}] overlaps "${r.capName}" [${r.lo}..${r.hi}]`);
            }
          }
          bitRanges.push({ capName, lo, hi });
        }
      }
    }
    // Derived read inputs must resolve to a sibling capability or a node parameter; no reference cycles.
    for (const [dCap, refs] of derivedDeps) {
      for (const r of refs) {
        if (!nodeCapNames.has(r) && !nodeParamNames.includes(r)) {
          add(errors, label, `node "${nodeId}" derived capability "${dCap}" input "${r}" is not a capability or parameter on this node`);
        }
      }
    }
    {
      const color = new Map(); // cap -> 'gray' (on stack) | 'black' (done)
      const dfs = (cap) => {
        color.set(cap, "gray");
        let cyc = false;
        for (const r of derivedDeps.get(cap) ?? []) {
          if (!derivedDeps.has(r)) continue; // non-derived input is a leaf
          const c = color.get(r);
          if (c === "gray") cyc = true;
          else if (c !== "black" && dfs(r)) cyc = true;
        }
        color.set(cap, "black");
        return cyc;
      };
      for (const dCap of derivedDeps.keys()) {
        if (color.get(dCap) !== "black" && dfs(dCap)) {
          add(errors, label, `node "${nodeId}" derived capability "${dCap}" has a reference cycle`);
        }
      }
    }
  }

  // Relationships: endpoints are matched against node ids, which are stored
  // String()-coerced, so coerce the endpoints the same way (a numeric id would
  // otherwise never resolve). Also tally child counts per (parent, relationType)
  // for the aggregate qualification check below.
  const relKeys = new Set();
  const childCounts = new Map();
  for (const relationship of doc.relationships ?? []) {
    if (!relationship || typeof relationship !== "object") continue;
    const from = String(relationship.from ?? "");
    const to = String(relationship.to ?? "");
    const type = String(relationship.type ?? "");
    const key = `${from}|${type}|${to}`;
    if (relKeys.has(key)) {
      add(errors, label, `duplicate relationship "${key}"`);
    }
    relKeys.add(key);

    if (!nodeIds.has(from)) {
      add(errors, label, `relationship "${key}" references unknown from node "${from}"`);
    }
    if (!nodeIds.has(to)) {
      add(errors, label, `relationship "${key}" references unknown to node "${to}"`);
    }

    const childKey = `${from}|${type}`;
    childCounts.set(childKey, (childCounts.get(childKey) ?? 0) + 1);
  }

  // Aggregate-as-data: a node with `aggregate.serves` is a candidate primary
  // read/control point for its children over a relationType. Selection is "the
  // highest-priority *qualifying* aggregator wins", where a node qualifies only if
  // its child count over that relation is >= minChildren. Two qualifying
  // aggregators over the same relation with equal priority make that selection
  // nondeterministic. Only meaningful for a merged `site` doc (a fragment doesn't
  // yet hold the full relationship graph).
  if (requireDataPlane) {
    const aggregatorsByRelation = new Map();
    for (const node of nodes) {
      const aggregate = node?.aggregate;
      if (!aggregate || aggregate.serves !== true) continue;
      const nodeId = String(node.id ?? "");
      if (!nodeId) continue;
      if (!aggregate.over) {
        add(errors, label, `node "${nodeId}" aggregate serves but defines no "over" relation`);
        continue;
      }
      const minChildren = Number.isInteger(aggregate.minChildren) ? aggregate.minChildren : 0;
      const childCount = childCounts.get(`${nodeId}|${aggregate.over}`) ?? 0;
      if (childCount < minChildren) continue; // does not qualify — not an error
      const priority = Number.isInteger(aggregate.priority) ? aggregate.priority : 0;
      const byPriority = aggregatorsByRelation.get(aggregate.over) ?? new Map();
      byPriority.set(priority, [...(byPriority.get(priority) ?? []), nodeId]);
      aggregatorsByRelation.set(aggregate.over, byPriority);
    }
    for (const [over, byPriority] of aggregatorsByRelation) {
      for (const [priority, ids] of byPriority) {
        if (ids.length > 1) {
          add(
            errors,
            label,
            `nodes ${ids.map((id) => `"${id}"`).join(", ")} all qualify as aggregate over "${over}" with equal priority ${priority} (nondeterministic primary)`,
          );
        }
      }
    }
  }

  return errors;
}

// Reports (does not reject) use of namespaced `x-*` extension transform kinds —
// a conformance note so consumers know provider-specific kinds are in play.
export function collectExtensionTransformKinds(doc) {
  const notes = [];
  const scan = (transform, nodeId, capName) => {
    if (!transform || typeof transform !== "object") return;
    if (typeof transform.kind === "string" && transform.kind.startsWith("x-")) {
      notes.push(`node "${nodeId}" capability "${capName}" uses extension transform kind "${transform.kind}"`);
    }
    for (const step of Array.isArray(transform.steps) ? transform.steps : []) scan(step, nodeId, capName);
  };
  for (const node of Array.isArray(doc?.nodes) ? doc.nodes : []) {
    const nodeId = String(node?.id ?? "");
    for (const capability of Array.isArray(node?.capabilities) ? node.capabilities : []) {
      const capName = String(capability?.capability ?? "");
      scan(capability?.read?.transform, nodeId, capName);
      scan(capability?.control?.transform, nodeId, capName);
    }
  }
  return notes;
}
