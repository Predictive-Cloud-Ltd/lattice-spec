export const SPEC_VERSION = "0.1.0";

function add(errors, label, message) {
  errors.push(label ? `${label}: ${message}` : message);
}

export function checkSemanticInvariants(doc, options = {}) {
  const label = options.label ?? "";
  const requireDocVersion = options.requireDocVersion ?? true;
  const errors = [];

  if (!doc || typeof doc !== "object") {
    add(errors, label, "document must be an object");
    return errors;
  }

  if (doc.topologyVersion !== SPEC_VERSION) {
    add(errors, label, `topologyVersion must be ${SPEC_VERSION}`);
  }
  if (requireDocVersion && !Number.isInteger(doc.docVersion)) {
    add(errors, label, "docVersion must be an integer for data-plane conformance");
  }

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const nodeIds = new Set();
  const capRefToKey = new Map();

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const nodeId = String(node.id ?? "");
    if (!nodeId) continue;

    if (nodeIds.has(nodeId)) {
      add(errors, label, `duplicate node id "${nodeId}"`);
    }
    nodeIds.add(nodeId);

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
        add(errors, label, `node "${nodeId}" capability "${capName}" is missing accessPath`);
      } else if (!accessPathIds.has(capability.accessPath)) {
        add(
          errors,
          label,
          `node "${nodeId}" capability "${capName}" references unknown accessPath "${capability.accessPath}"`,
        );
      }

      if (!Number.isInteger(capability.ref)) {
        add(errors, label, `node "${nodeId}" capability "${capName}" must define integer ref`);
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

  const relKeys = new Set();
  for (const relationship of doc.relationships ?? []) {
    if (!relationship || typeof relationship !== "object") continue;
    const key = `${relationship.from}|${relationship.type}|${relationship.to}`;
    if (relKeys.has(key)) {
      add(errors, label, `duplicate relationship "${key}"`);
    }
    relKeys.add(key);

    if (!nodeIds.has(relationship.from)) {
      add(errors, label, `relationship "${key}" references unknown from node "${relationship.from}"`);
    }
    if (!nodeIds.has(relationship.to)) {
      add(errors, label, `relationship "${key}" references unknown to node "${relationship.to}"`);
    }
  }

  const deviceTypes = Array.isArray(doc.deviceTypes) ? doc.deviceTypes : [];
  if (deviceTypes.length) {
    const keys = new Set();
    for (const deviceType of deviceTypes) {
      if (!deviceType?.key) continue;
      if (keys.has(deviceType.key)) {
        add(errors, label, `duplicate deviceTypes key "${deviceType.key}"`);
      }
      keys.add(deviceType.key);
    }
    for (const node of nodes) {
      if (node?.deviceType && !keys.has(node.deviceType)) {
        add(errors, label, `node "${node.id}" references unknown deviceType "${node.deviceType}"`);
      }
    }
  }

  return errors;
}
