import type { ExternalWorkProviderDescription } from "./api";

export interface ExternalWriteSet {
  supportedMutations: string[];
  localOnlyMutations: string[];
}

export function externalWriteSetFor(
  providers: ExternalWorkProviderDescription[],
  source: string,
): ExternalWriteSet | null {
  const provider = providers.find((candidate) => candidate.id === source);
  if (!provider) return null;
  return {
    supportedMutations: provider.supportedMutations ?? [],
    localOnlyMutations: provider.localOnlyMutations ?? [],
  };
}

export function canMutateTaskField(
  source: string,
  field: string,
  writeSet: ExternalWriteSet | null,
): boolean {
  if (source === "local") return true;
  // The write set is unknown until the provider description arrives; keep the
  // server as the enforcement point rather than locking the whole issue.
  if (!writeSet) return true;
  return writeSet.supportedMutations.includes(field)
    || writeSet.localOnlyMutations.includes(field);
}
