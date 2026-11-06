export type PixelPoint = { x: number; y: number };
export type PixelColor = [number, number, number, number];

export function trimImageHistory<T extends { data: { byteLength: number } }>(
  history: T[],
  maxFrames: number,
  maxBytes: number,
) {
  let retainedBytes = history.reduce((total, frame) => total + frame.data.byteLength, 0);
  while (history.length > maxFrames || retainedBytes > maxBytes) {
    const removed = history.shift();
    if (!removed) break;
    retainedBytes -= removed.data.byteLength;
  }
}

export function traceLinePixels(from: PixelPoint, to: PixelPoint) {
  const points: PixelPoint[] = [];
  forEachLinePixel(from, to, (x, y) => points.push({ x, y }));
  return points;
}

export function forEachLinePixel(from: PixelPoint, to: PixelPoint, visit: (x: number, y: number) => void) {
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const sx = from.x < to.x ? 1 : -1;
  const dy = -Math.abs(to.y - from.y);
  const sy = from.y < to.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    visit(x, y);
    if (x === to.x && y === to.y) break;
    const doubledError = 2 * error;
    if (doubledError >= dy) { error += dy; x += sx; }
    if (doubledError <= dx) { error += dx; y += sy; }
  }
}

export function floodFillPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  fillColor: PixelColor,
) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4) {
    throw new RangeError("Pixel buffer dimensions do not match its data.");
  }
  if (!Number.isInteger(startX) || !Number.isInteger(startY) || startX < 0 || startY < 0 || startX >= width || startY >= height) {
    throw new RangeError("Fill origin is outside the pixel buffer.");
  }

  const start = (startY * width + startX) * 4;
  const target: PixelColor = [pixels[start], pixels[start + 1], pixels[start + 2], pixels[start + 3]];
  const normalizedFill = new Uint8ClampedArray(fillColor);
  if (target.every((channel, index) => channel === normalizedFill[index])) return false;

  const queue = new Int32Array(width * height);
  const matchesTarget = (pixel: number) => {
    const offset = pixel * 4;
    return target.every((channel, index) => pixels[offset + index] === channel);
  };
  const enqueueIfTarget = (pixel: number, tail: number) => {
    if (!matchesTarget(pixel)) return tail;
    pixels.set(normalizedFill, pixel * 4);
    queue[tail] = pixel;
    return tail + 1;
  };
  let head = 0;
  let tail = 1;
  const startPixel = startY * width + startX;
  queue[0] = startPixel;
  pixels.set(normalizedFill, start);

  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const left = pixel - 1;
    if (x > 0) tail = enqueueIfTarget(left, tail);
    const right = pixel + 1;
    if (x < width - 1) tail = enqueueIfTarget(right, tail);
    const above = pixel - width;
    if (y > 0) tail = enqueueIfTarget(above, tail);
    const below = pixel + width;
    if (y < height - 1) tail = enqueueIfTarget(below, tail);
  }
  return true;
}
