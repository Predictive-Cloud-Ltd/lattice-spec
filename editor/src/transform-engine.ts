// Pure, bidirectional value-transform evaluator: raw <-> engineering units.
// Mirrors the spec's transform vocabulary (spec/2026-06-19-transform-binding-vocabulary-design.md)
// and the gateway's transform.cpp, so the editor, the gateway, and any other language compute the
// SAME values — pinned across languages by conformance/transform/.

type Transform = any;
type Ctx = Record<string, number>; // node parameters available to refs: capacity, rated_power, nominal_voltage

// Sign-aware integer division with the requested rounding (mirrors the gateway's div_round).
// b === 0 yields 0; callers detect the unavailable/zero-divisor case first for fail-open.
function divRound(a: number, b: number, round: string): number {
  if (b === 0) return 0;
  const sign = (a < 0) !== (b < 0) ? -1 : 1;
  const aa = Math.abs(a);
  const bb = Math.abs(b);
  if (round === "half_up") return sign * Math.floor((aa + Math.floor(bb / 2)) / bb);
  if (round === "half_even") {
    const q = Math.floor(aa / bb);
    const rem = aa % bb;
    const up = rem * 2 > bb || (rem * 2 === bb && q % 2 === 1);
    return sign * (up ? q + 1 : q);
  }
  return Math.trunc(a / b); // trunc (default): toward zero
}

// Resolve a value-or-ref param to a number, or null if it references an unavailable ctx key.
function resolveParam(p: unknown, ctx: Ctx): number | null {
  if (typeof p === "number") return p;
  if (p && typeof p === "object" && typeof (p as any).ref === "string") {
    const r = p as { ref: string; factor?: number };
    if (!(r.ref in ctx)) return null;
    return typeof r.factor === "number" ? ctx[r.ref] * r.factor : ctx[r.ref];
  }
  return null;
}

// The value when a fromEng ref can't resolve (or the inverse divisor is 0): fail-open max, else null.
function unresolvedWrite(t: Transform, ctx: Ctx): number | null {
  if (t.onRefUnavailable === "max" && t.max !== undefined) return resolveParam(t.max, ctx);
  return null; // fail-closed (default "zero" = no value)
}

function clampValue(t: Transform, v: number, ctx: Ctx): number | null {
  const min = t.min === undefined ? null : resolveParam(t.min, ctx);
  const max = t.max === undefined ? null : resolveParam(t.max, ctx);
  if ((t.min !== undefined && min === null) || (t.max !== undefined && max === null)) return null;
  let out = v;
  if (min !== null) out = Math.max(out, min);
  if (max !== null) out = Math.min(out, max);
  return out;
}

// raw -> engineering (read direction).
export function toEng(t: Transform, raw: number, ctx: Ctx = {}): number | null {
  if (!t || typeof t !== "object" || typeof t.kind !== "string") return raw;
  switch (t.kind) {
    case "identity":
    case "hhmm":
      return raw;
    case "negate":
      return -raw;
    case "affine": {
      const scale = resolveParam(t.scale ?? 1, ctx);
      const offset = resolveParam(t.offset ?? 0, ctx);
      if (scale === null || offset === null) return null; // read: fail-closed
      return raw * scale + offset;
    }
    case "ratio": {
      const num = resolveParam(t.num, ctx);
      const den = resolveParam(t.den, ctx);
      if (num === null || den === null || den === 0) return null; // read: fail-closed
      return divRound(raw * num, den, t.round ?? "trunc");
    }
    case "clamp":
      return clampValue(t, raw, ctx);
    case "pipeline": {
      let v: number | null = raw;
      for (const step of Array.isArray(t.steps) ? t.steps : []) {
        if (v === null) return null;
        v = toEng(step, v, ctx);
      }
      return v;
    }
    default:
      return null; // x-<vendor>: extension — not generically evaluable
  }
}

// engineering -> raw (write direction; the algebraic inverse).
export function fromEng(t: Transform, eng: number, ctx: Ctx = {}): number | null {
  if (!t || typeof t !== "object" || typeof t.kind !== "string") return eng;
  switch (t.kind) {
    case "identity":
    case "hhmm":
      return eng;
    case "negate":
      return -eng;
    case "affine": {
      const scale = resolveParam(t.scale ?? 1, ctx);
      const offset = resolveParam(t.offset ?? 0, ctx);
      if (scale === null || offset === null || scale === 0) return unresolvedWrite(t, ctx);
      return divRound(eng - offset, scale, t.round ?? "trunc");
    }
    case "ratio": {
      const num = resolveParam(t.num, ctx);
      const den = resolveParam(t.den, ctx);
      if (num === null || den === null || num === 0) return unresolvedWrite(t, ctx); // inverse divisor is num
      return divRound(eng * den, num, t.round ?? "trunc");
    }
    case "clamp":
      return clampValue(t, eng, ctx); // idempotent; its own inverse
    case "pipeline": {
      let v: number | null = eng;
      const steps = Array.isArray(t.steps) ? [...t.steps].reverse() : [];
      for (const step of steps) {
        if (v === null) return null;
        v = fromEng(step, v, ctx);
      }
      return v;
    }
    default:
      return null;
  }
}
