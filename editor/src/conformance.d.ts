export const SPEC_VERSION: "0.1.0";

export type SemanticOptions = {
  label?: string;
  requireDocVersion?: boolean;
};

export function checkSemanticInvariants(doc: unknown, options?: SemanticOptions): string[];
