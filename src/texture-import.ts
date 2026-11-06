type TextureAsset = { id: string; path: string };

export function mergeVanillaTextures<T extends TextureAsset>(
  additions: readonly T[],
  imported: readonly T[],
  editedIds: ReadonlySet<string>,
  preservedEdits?: readonly T[],
  overwriteMatchingEdits = false,
) {
  const replacementPaths = new Set(additions.map((asset) => asset.path.toLowerCase()));
  const preserved = preservedEdits ?? imported.filter((asset) =>
    editedIds.has(asset.id) && (!overwriteMatchingEdits || !replacementPaths.has(asset.path.toLowerCase()))
  );
  const byPath = new Map(additions.map((asset) => [asset.path.toLowerCase(), asset]));
  for (const asset of preserved) byPath.set(asset.path.toLowerCase(), asset);
  const textures = [...byPath.values()];
  const nextEditedIds = new Set([
    ...[...editedIds].filter((id) => !overwriteMatchingEdits || !replacementPaths.has(id)),
    ...preserved.map((asset) => asset.id),
  ].filter((id) => textures.some((asset) => asset.id === id)));
  return { textures, editedIds: nextEditedIds };
}
