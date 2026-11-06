// Runtime validation coverage for pixel drawing and bucket-fill behavior.
import { describe, expect, it } from "vitest";
import { floodFillPixels, traceLinePixels, trimImageHistory } from "./pixel-editor";

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

  it("does not fill when the requested color clamps to the existing color", () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255]);

    expect(floodFillPixels(pixels, 1, 1, 0, 0, [300, 0, 0, 255])).toBe(false);
    expect([...pixels]).toEqual([255, 0, 0, 255]);
  });

  it("rejects a fill origin outside the texture", () => {
    expect(() => floodFillPixels(new Uint8ClampedArray(4), 1, 1, 1, 0, [0, 0, 0, 255])).toThrow(RangeError);
  });

  it("keeps recent undo frames within the frame and memory limits", () => {
    const history = [
      { data: { byteLength: 8 } },
      { data: { byteLength: 8 } },
      { data: { byteLength: 8 } },
    ];

    trimImageHistory(history, 2, 16);

    expect(history).toEqual([{ data: { byteLength: 8 } }, { data: { byteLength: 8 } }]);
  });

  it("drops older frames when a single frame exceeds the memory limit", () => {
    const history = [{ data: { byteLength: 8 } }, { data: { byteLength: 24 } }];

    trimImageHistory(history, 30, 16);

    expect(history).toEqual([]);
  });
});
