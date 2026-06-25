export const SPEC_VERSION = "0.1.0";

function add(errors, label, message) {
  errors.push(label ? `${label}: ${message}` : message);
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
    for (const capability of node.capabilities ?? []) {
      if (!capability?.capability) continue;
      const capName = String(capability.capability);
      const offerKey = `${capName}|${capability.accessPath ?? ""}`;
      const nodeCapKey = `${nodeId}|${capName}`;

      if (offerKeys.has(offerKey)) {
        add(errors, label, `node "${nodeId}" repeats capability/accessPath "${offerKey}"`);
      }
      offerKeys.add(offerKey);

      if (!capability.accessPath) {
        if (requireDataPlane) {
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
