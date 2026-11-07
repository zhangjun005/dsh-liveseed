import zlib from 'node:zlib';

/** Minimal dependency-free PNG reader used by the real-model acceptance checks. */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8, width = 0, height = 0, color = 0, interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); if (data[8] !== 8) throw new Error('unsupported bit depth'); color = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !height) throw new Error('missing IHDR');
  if (interlace !== 0) throw new Error('interlaced PNG is unsupported');
  const channels = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (!channels) throw new Error('unsupported PNG color type');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride), cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const line = raw.subarray(cursor, cursor + stride); cursor += stride;
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      current[x] = value & 0xff;
    }
    current.copy(pixels, y * stride); previous = current;
  }
  return { width, height, channels, pixels };
}

const saturatedBlue = (pixels, index) => pixels[index + 2] > 150 && pixels[index + 2] - pixels[index] > 50;

/**
 * Counts saturated blue pixels that appear in the top band of `after` but not in `before`.
 * A displacement Morph (MMD symbol such as a sweat drop) moves a hidden quad out of the hair,
 * so it must introduce saturated blue pixels the idle animation never produces there.
 */
export function newBluePixels(before, after, bandFraction = 0.15) {
  const a = decodePng(before), b = decodePng(after);
  if (a.width !== b.width || a.height !== b.height) throw new Error('screenshot size changed');
  const band = Math.min(a.height, Math.max(1, Math.round(a.height * bandFraction)));
  let count = 0;
  for (let y = 0; y < band; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * a.channels, j = (y * b.width + x) * b.channels;
      if (saturatedBlue(b.pixels, j) && !saturatedBlue(a.pixels, i)) count++;
    }
  }
  return count;
}
