// Runtime validation coverage for pixel drawing and bucket-fill behavior.
import { describe, expect, it } from "vitest";
import { floodFillPixels, traceLinePixels } from "./pixel-editor";

describe("pixel editor drawing", () => {
  it("traces a continuous diagonal line between pixel coordinates", () => {
    expect(traceLinePixels({ x: 1, y: 1 }, { x: 4, y: 3 })).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 3 },
    ]);
  });

  it("fills only pixels connected to the selected pixel", () => {
    const black = [0, 0, 0, 255];
    const red = [255, 0, 0, 255];
    const pixels = new Uint8ClampedArray([...black, ...black, ...red, ...black, ...red, ...red]);

    expect(floodFillPixels(pixels, 3, 2, 0, 0, [0, 0, 255, 255])).toBe(true);
    expect([...pixels]).toEqual([
      0, 0, 255, 255, 0, 0, 255, 255, ...red,
      0, 0, 255, 255, ...red, ...red,
    ]);
  });

  it("does not change pixels when the fill color already matches", () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 255]);

    expect(floodFillPixels(pixels, 1, 1, 0, 0, [10, 20, 30, 255])).toBe(false);
    expect([...pixels]).toEqual([10, 20, 30, 255]);
  });

  it("rejects a fill origin outside the texture", () => {
    expect(() => floodFillPixels(new Uint8ClampedArray(4), 1, 1, 1, 0, [0, 0, 0, 255])).toThrow(RangeError);
  });
});
