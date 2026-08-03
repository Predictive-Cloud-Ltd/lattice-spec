export const SPEC_VERSION: "0.3.0";

export type SemanticOptions = {
  label?: string;
  requireDataPlane?: boolean;
};

export function checkSemanticInvariants(doc: unknown, options?: SemanticOptions): string[];
