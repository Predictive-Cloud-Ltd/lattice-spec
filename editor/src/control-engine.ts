export type ScheduleSlot = {
  start_hhmm: number;
  end_hhmm: number;
  mode: string;
  target_soc?: number;
  reserve_soc?: number;
  charge_power_limit?: number;
  discharge_power_limit?: number;
  enable?: boolean;
};

export type ScheduleIntent = {
  slots: ScheduleSlot[];
  default_mode?: string;
};

export type ControlMessage = {
  command_id?: string;
  doc_version?: number;
  cap_ref?: number;
  scalar?: unknown;
  schedule?: unknown;
  schedule_intent?: ScheduleIntent;
};

export type ControlValidation = {
  ok: boolean;
  errors: string[];
  plan?: ScheduleIntent;
};

const SLOT_FIELDS = [
  "target_soc",
  "reserve_soc",
  "charge_power_limit",
  "discharge_power_limit",
  "enable",
] as const;

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

function hhmmToMinutes(value: unknown): number | null {
  if (!Number.isInteger(value)) return null;
  const hhmm = Number(value);
  const hours = Math.trunc(hhmm / 100);
  const minutes = hhmm % 100;
  if (hhmm < 0 || hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function scheduleOffersForRef(doc: any, capRef: number): { node: any; offer: any }[] {
  const matches: { node: any; offer: any }[] = [];
  for (const node of doc?.nodes ?? []) {
    for (const offer of node?.capabilities ?? []) {
      if (offer?.ref === capRef && offer?.control && offer?.shape === "schedule") {
        matches.push({ node, offer });
      }
    }
  }
  return matches;
}

function numericBounds(node: any, field: string): { min?: number; max?: number } {
  const capability = `battery.${field}`;
  const sibling = (node?.capabilities ?? []).find((offer: any) => offer?.capability === capability);
  const min = typeof sibling?.constraints?.min === "number" ? sibling.constraints.min : undefined;
  const max = typeof sibling?.constraints?.max === "number" ? sibling.constraints.max : undefined;
  return { min, max };
}

export function validateScheduleIntent(node: any, offer: any, intent: unknown): ControlValidation {
  const errors: string[] = [];
  if (!intent || typeof intent !== "object") {
    return { ok: false, errors: ["schedule_intent must be an object"] };
  }

  const schedule = intent as ScheduleIntent;
  if (!Array.isArray(schedule.slots)) errors.push("schedule_intent.slots must be an array");
  const slots = Array.isArray(schedule.slots) ? schedule.slots : [];
  const spec = offer?.scheduleSpec ?? {};

  if (Number.isInteger(spec.maxSlots) && slots.length > spec.maxSlots) {
    errors.push(`schedule has ${slots.length} slots; maximum is ${spec.maxSlots}`);
  }
  if (spec.requiresDefaultMode && !schedule.default_mode) {
    errors.push("schedule requires default_mode");
  }
  if (slots.length === 0 && !schedule.default_mode) {
    errors.push("empty schedule requires default_mode");
  }

  const allowedFields = new Set(spec.slotFields ?? []);
  let previousEnd = -1;
  for (const [index, slot] of slots.entries()) {
    const label = `slot ${index}`;
    if (!slot || typeof slot !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }

    const start = hhmmToMinutes(slot.start_hhmm);
    const end = hhmmToMinutes(slot.end_hhmm);
    if (start == null) errors.push(`${label} has invalid start_hhmm`);
    if (end == null) errors.push(`${label} has invalid end_hhmm`);
    if (start != null && end != null) {
      if (start >= end) errors.push(`${label} must end after it starts; split midnight-spanning windows`);
      if (start < previousEnd) errors.push(`${label} overlaps or is not ordered`);
      previousEnd = Math.max(previousEnd, end);
    }
    if (typeof slot.mode !== "string" || slot.mode.length === 0) {
      errors.push(`${label} requires mode`);
    }

    for (const field of SLOT_FIELDS) {
      if (!hasOwn(slot, field)) continue;
      if (!allowedFields.has(field)) errors.push(`${label} field ${field} is not offered by scheduleSpec`);

      const value = slot[field];
      if (field === "enable") {
        if (typeof value !== "boolean") errors.push(`${label} field enable must be boolean`);
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${label} field ${field} must be a finite number`);
        continue;
      }
      const bounds = numericBounds(node, field);
      if (bounds.min != null && value < bounds.min) errors.push(`${label} field ${field} is below ${bounds.min}`);
      if (bounds.max != null && value > bounds.max) errors.push(`${label} field ${field} is above ${bounds.max}`);
    }
  }

  if (errors.length) return { ok: false, errors };
  // A plan is returned only after every slot validates: callers cannot execute
  // a valid prefix of an invalid schedule.
  return { ok: true, errors: [], plan: structuredClone(schedule) };
}

export function validateControl(doc: any, control: ControlMessage): ControlValidation {
  const errors: string[] = [];
  if (!control || typeof control !== "object") return { ok: false, errors: ["control must be an object"] };
  if (!control.command_id) errors.push("command_id is required");
  if (!Number.isInteger(control.doc_version) || control.doc_version !== doc?.docVersion) {
    errors.push("stale doc_version");
  }
  if (!Number.isInteger(control.cap_ref)) errors.push("cap_ref is required");

  const payloads = ["scalar", "schedule", "schedule_intent"].filter((field) =>
    hasOwn(control, field),
  );
  if (payloads.length !== 1) errors.push("control must contain exactly one payload");
  if (hasOwn(control, "schedule")) {
    errors.push("legacy schedule payload is ambiguous and unsupported");
  }
  if (!hasOwn(control, "schedule_intent")) {
    if (errors.length) return { ok: false, errors };
    return { ok: true, errors: [] };
  }

  const matches = Number.isInteger(control.cap_ref) ? scheduleOffersForRef(doc, control.cap_ref!) : [];
  if (matches.length === 0) errors.push("cap_ref does not identify a schedule control offer");
  if (errors.length) return { ok: false, errors };
  return validateScheduleIntent(matches[0].node, matches[0].offer, control.schedule_intent);
}
