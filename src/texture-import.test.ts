import { describe, expect, it } from "vitest";
import { mergeVanillaTextures } from "./texture-import";

type TestTexture = { id: string; path: string; value: string };

describe("mergeVanillaTextures", () => {
  it("replaces an edited texture on explicit reload while keeping edits outside the source paths", () => {
    const editedBlock: TestTexture = { id: "block/stone.png", path: "block/stone.png", value: "edited" };
    const custom: TestTexture = { id: "custom/extra.png", path: "custom/extra.png", value: "custom" };
    const vanillaStone: TestTexture = { id: "block/stone.png", path: "block/stone.png", value: "vanilla" };
    const { textures, editedIds } = mergeVanillaTextures(
      [vanillaStone],
      [editedBlock, custom],
      new Set([editedBlock.id, custom.id]),
      undefined,
      true,
    );

    expect(textures).toEqual([vanillaStone, custom]);
    expect(editedIds).toEqual(new Set([custom.id]));
  });

  it("preserves matching edits on startup or version changes", () => {
    const edited: TestTexture = { id: "block/stone.png", path: "block/stone.png", value: "edited" };
    const vanilla: TestTexture = { id: "block/stone.png", path: "block/stone.png", value: "vanilla" };

    const { textures, editedIds } = mergeVanillaTextures([vanilla], [edited], new Set([edited.id]));

    expect(textures).toEqual([edited]);
    expect(editedIds).toEqual(new Set([edited.id]));
  });

  it("matches source paths without regard to case", () => {
    const edited: TestTexture = { id: "block/stone.png", path: "Block/Stone.png", value: "edited" };
    const vanilla: TestTexture = { id: "block/stone.png", path: "block/stone.png", value: "vanilla" };

    const { textures, editedIds } = mergeVanillaTextures([vanilla], [edited], new Set([edited.id]), undefined, true);

    expect(textures).toEqual([vanilla]);
    expect(editedIds.size).toBe(0);
  });
});
