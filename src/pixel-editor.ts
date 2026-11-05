export type PixelPoint = { x: number; y: number };
export type PixelColor = [number, number, number, number];

export function traceLinePixels(from: PixelPoint, to: PixelPoint) {
  const points: PixelPoint[] = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const sx = from.x < to.x ? 1 : -1;
  const dy = -Math.abs(to.y - from.y);
  const sy = from.y < to.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    points.push({ x, y });
    if (x === to.x && y === to.y) break;
    const doubledError = 2 * error;
    if (doubledError >= dy) { error += dy; x += sx; }
    if (doubledError <= dx) { error += dx; y += sy; }
  }
  return points;
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
  if (target.every((channel, index) => channel === fillColor[index])) return false;

  const queue = new Int32Array(width * height);
  const visited = new Uint8Array(width * height);
  const matchesTarget = (pixel: number) => {
    const offset = pixel * 4;
    return target.every((channel, index) => pixels[offset + index] === channel);
  };
  let head = 0;
  let tail = 0;
  const startPixel = startY * width + startX;
  queue[tail++] = startPixel;
  visited[startPixel] = 1;

  while (head < tail) {
    const pixel = queue[head++];
    const offset = pixel * 4;
    pixels.set(fillColor, offset);
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const left = pixel - 1;
    if (x > 0 && !visited[left] && matchesTarget(left)) { visited[left] = 1; queue[tail++] = left; }
    const right = pixel + 1;
    if (x < width - 1 && !visited[right] && matchesTarget(right)) { visited[right] = 1; queue[tail++] = right; }
    const above = pixel - width;
    if (y > 0 && !visited[above] && matchesTarget(above)) { visited[above] = 1; queue[tail++] = above; }
    const below = pixel + width;
    if (y < height - 1 && !visited[below] && matchesTarget(below)) { visited[below] = 1; queue[tail++] = below; }
  }
  return true;
}
