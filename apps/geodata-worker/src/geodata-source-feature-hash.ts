const sourceFeatureHashOverrides = new WeakMap<object, string>();

export function setSourceFeatureHashOverride(
  feature: object,
  hash: string,
): void {
  sourceFeatureHashOverrides.set(feature, hash);
}

export function sourceFeatureHashOverride(feature: object): string | undefined {
  return sourceFeatureHashOverrides.get(feature);
}
