/**
 * SPAX — Spatial Progressive Adaptive eXchange Format
 * © Fumoca Technologies / FUMOCA Labs · fumoca.co.za
 * Proprietary — Open Core licensed
 *
 * SPAX is the "MP4 of spatial content" — a universal container for any
 * 3D/4D scene that:
 *   - Streams progressively (lowest-quality splats first, refine over time)
 *   - Plays everywhere without a special viewer (proxy video fallback)
 *   - Is natively social (contains all metadata for OG/Twitter cards)
 *   - Is hardware-adaptive (LOD tiers for mobile → desktop → XR)
 *   - Is editable non-destructively (edit history chunk like Photoshop PSB)
 *
 * Relationship to NIF:
 *   NIF (.nif) is the internal reconstruction format.
 *   SPAX (.spax) is the distribution format — consumers receive .spax files.
 *   NIFToSPAX converts a processed .nif into a .spax for distribution.
 *
 * Binary layout:
 *   [0–3]   Magic:   0x53504158 ("SPAX")
 *   [4]     Major version
 *   [5]     Minor version
 *   [6–7]   Flags:   bit 0=has proxy, bit 1=has audio, bit 2=is looping,
 *                    bit 3=has edit history, bit 4=is progressive
 *   [8–11]  Frame count (uint32 big-endian)
 *   [12–15] Duration ms (uint32 big-endian)
 *   [16–19] Total chunks (uint32 big-endian)
 *   [20–23] CRC32 of header
 *   [24–87] Title (null-padded UTF-8, 64 bytes)
 *   [88–151] Creator (null-padded UTF-8, 64 bytes)
 *   [152–215] Description (null-padded UTF-8, 64 bytes)
 *   [216–255] Reserved
 *   [256+]  Chunks (same format as NIF: type/codec/size/crc/data)
 *
 * Chunk types:
 *   0x0100  PROXY_VIDEO_H264   — H.264 proxy, plays on any device
 *   0x0101  PROXY_VIDEO_HEVC   — H.265 proxy (smaller)
 *   0x0200  LOD_0              — Lowest quality splats (fast load, mobile)
 *   0x0201  LOD_1              — Medium quality
 *   0x0202  LOD_2              — Full quality
 *   0x0300  SPATIAL_AUDIO      — Ambisonics + HRTF source map
 *   0x0400  METADATA           — JSON: title, tags, vertical, preview frames
 *   0x0500  EDIT_HISTORY       — Non-destructive edit stack
 *   0x0600  INTERACTION_GRAPH  — Hotspots, triggers, actions
 *   0x0700  THUMBNAIL          — WEBP thumbnail 512×512
 *   0x0800  SOCIAL_CARD        — OG/Twitter card assets (WEBP 1200×630)
 *
 * LOD strategy:
 *   LOD_0: top 5% of Gaussians by opacity/size — ~50KB, instant
 *   LOD_1: top 25%                             — ~250KB, 1s on 4G
 *   LOD_2: full scene                          — 2–20MB, streams in
 *
 * Open Core licensing:
 *   Core format spec + parser: MIT licensed (everyone can read .spax)
 *   SPAX writer / encoder:     Proprietary (requires FUMOCA Labs license)
 *   Progressive streaming:     Proprietary
 *   XR extensions:             Proprietary
 */

export const SPAX_MAGIC   = 0x53504158;
export const SPAX_VERSION = { major: 1, minor: 0 };

export const SPAX_FLAGS = {
  HAS_PROXY:        0x0001,
  HAS_AUDIO:        0x0002,
  IS_LOOPING:       0x0004,
  HAS_EDIT_HISTORY: 0x0008,
  IS_PROGRESSIVE:   0x0010,
  IS_SPATIAL:       0x0020,  // has 6DOF camera
  HAS_INTERACTION:  0x0040,
};

export const SPAX_CHUNK = {
  PROXY_H264:       0x0100,
  PROXY_HEVC:       0x0101,
  LOD_0:            0x0200,
  LOD_1:            0x0201,
  LOD_2:            0x0202,
  SPATIAL_AUDIO:    0x0300,
  METADATA:         0x0400,
  EDIT_HISTORY:     0x0500,
  INTERACTION:      0x0600,
  THUMBNAIL:        0x0700,
  SOCIAL_CARD:      0x0800,
};

/**
 * Parse a .spax file from an ArrayBuffer.
 * Returns structured object with all chunks decoded.
 *
 * @param {ArrayBuffer} buffer
 * @returns {SPAXFile}
 */
export function parseSPAX(buffer) {
  const dv = new DataView(buffer);

  const magic = dv.getUint32(0, false);
  if (magic !== SPAX_MAGIC) {
    throw new Error(`Not a .spax file — expected 0x${SPAX_MAGIC.toString(16)}, got 0x${magic.toString(16)}`);
  }

  const major      = dv.getUint8(4);
  const minor      = dv.getUint8(5);
  const flags      = dv.getUint16(6, false);
  const frameCount = dv.getUint32(8,  false);
  const durationMs = dv.getUint32(12, false);
  const chunkCount = dv.getUint32(16, false);
  const title      = _readUtf8(dv, 24, 64);
  const creator    = _readUtf8(dv, 88, 64);
  const description= _readUtf8(dv, 152, 64);

  const header = {
    version:     `${major}.${minor}`,
    flags,
    frameCount,
    duration:    durationMs / 1000,
    chunkCount,
    title,
    creator,
    description,
    hasProxy:        !!(flags & SPAX_FLAGS.HAS_PROXY),
    hasAudio:        !!(flags & SPAX_FLAGS.HAS_AUDIO),
    isLooping:       !!(flags & SPAX_FLAGS.IS_LOOPING),
    hasEditHistory:  !!(flags & SPAX_FLAGS.HAS_EDIT_HISTORY),
    isProgressive:   !!(flags & SPAX_FLAGS.IS_PROGRESSIVE),
    hasInteraction:  !!(flags & SPAX_FLAGS.HAS_INTERACTION),
  };

  // Parse chunks
  const chunks = new Map();
  let offset = 256;
  while (offset + 12 < buffer.byteLength) {
    const type  = dv.getUint16(offset,     false);
    const codec = dv.getUint8 (offset + 2);
    const _rsv  = dv.getUint8 (offset + 3);
    const size  = dv.getUint32(offset + 4, false);
    const crc   = dv.getUint32(offset + 8, false);
    if (size === 0 || offset + 12 + size > buffer.byteLength) break;
    const rawData = buffer.slice(offset + 12, offset + 12 + size);
    chunks.set(type, { type, codec, size, crc, rawData,
      // Lazy decompression — call chunk.decompress() to get uncompressed data
      decompress: async () => {
        if (codec === 0x00) return rawData;  // raw
        if (codec === 0x02) {                // gzip
          if (typeof DecompressionStream !== 'undefined') {
            const ds     = new DecompressionStream('gzip');
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();
            writer.write(new Uint8Array(rawData));
            writer.close();
            const parts = []; let total = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parts.push(value); total += value.length;
            }
            const out = new Uint8Array(total); let off = 0;
            for (const p of parts) { out.set(p, off); off += p.length; }
            return out.buffer;
          }
        }
        return rawData; // unknown codec — return raw
      }
    });
    offset += 12 + size;
  }

  // Decode METADATA chunk if present
  let metadata = null;
  const metaChunk = chunks.get(SPAX_CHUNK.METADATA);
  if (metaChunk) {
    try {
      metadata = JSON.parse(new TextDecoder().decode(metaChunk.data));
    } catch {}
  }

  return {
    header,
    chunks,
    metadata,
    getChunk: (type) => chunks.get(type) ?? null,
    getLOD:   (level = 2) => chunks.get(SPAX_CHUNK.LOD_0 + level) ?? null,
  };
}

/**
 * Compress data using the browser/Node CompressionStream API (gzip).
 * Used for SPAX chunk compression — gzip chosen over ZSTD because it is
 * natively supported in all modern browsers via DecompressionStream without
 * any WASM dependency.
 *
 * SPAX codec byte: 0x00 = raw, 0x02 = gzip
 */
const SPAX_CODEC_RAW  = 0x00;
const SPAX_CODEC_GZIP = 0x02;
const MIN_COMPRESS    = 1024; // don't compress chunks smaller than 1 KB

async function _compressGzip(data) {
  if (typeof CompressionStream !== 'undefined') {
    const cs     = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
    writer.close();
    const chunks = [];
    let   total  = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let   off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
  }
  // Node.js fallback
  if (typeof require !== 'undefined') {
    const zlib = require('zlib');
    return new Promise((res, rej) => {
      zlib.gzip(Buffer.from(data), (err, buf) => err ? rej(err) : res(buf.buffer));
    });
  }
  return data; // no compression available
}

/**
 * Convert a NIF file to SPAX format.
 * All chunks larger than 1KB are gzip-compressed (codec 0x02).
 */
export async function nifToSPAX(opts = {}) {
  const {
    title       = '',
    creator     = '',
    description = '',
    duration    = 0,
    frameCount  = 1,
    isLooping   = false,
    proxyVideoBuffer = null,
    gaussianData     = null,
    audioBuffer      = null,
    thumbnail        = null,
    socialCard       = null,
    metadata         = null,
  } = opts;

  let flags = 0;
  if (proxyVideoBuffer) flags |= SPAX_FLAGS.HAS_PROXY;
  if (audioBuffer)      flags |= SPAX_FLAGS.HAS_AUDIO;
  if (isLooping)        flags |= SPAX_FLAGS.IS_LOOPING;
  if (gaussianData)     flags |= SPAX_FLAGS.IS_PROGRESSIVE;

  const chunkList = [];

  // Proxy video chunk
  if (proxyVideoBuffer) {
    chunkList.push({ type: SPAX_CHUNK.PROXY_H264, data: proxyVideoBuffer });
  }

  // LOD tiers from Gaussian data
  if (gaussianData) {
    const count = gaussianData.length / 14; // 14 floats per Gaussian
    const lod0Count = Math.ceil(count * 0.05);
    const lod1Count = Math.ceil(count * 0.25);

    // Sort by size (index 6 = scale x) — largest first = most visible
    const indices = Array.from({ length: count }, (_, i) => i)
      .sort((a, b) => gaussianData[b*14+6] - gaussianData[a*14+6]);

    const makeLOD = (n) => {
      const buf = new Float32Array(n * 14);
      for (let i = 0; i < n; i++) {
        const src = indices[i] * 14;
        buf.set(gaussianData.subarray(src, src + 14), i * 14);
      }
      const out = new ArrayBuffer(4 + buf.byteLength);
      new DataView(out).setUint32(0, n, false);
      new Float32Array(out, 4).set(buf);
      return out;
    };

    chunkList.push({ type: SPAX_CHUNK.LOD_0, data: makeLOD(lod0Count) });
    chunkList.push({ type: SPAX_CHUNK.LOD_1, data: makeLOD(lod1Count) });
    chunkList.push({ type: SPAX_CHUNK.LOD_2, data: makeLOD(count) });
  }

  // Spatial audio
  if (audioBuffer) {
    chunkList.push({ type: SPAX_CHUNK.SPATIAL_AUDIO, data: audioBuffer });
  }

  // Metadata
  if (metadata) {
    const enc = new TextEncoder().encode(JSON.stringify(metadata));
    chunkList.push({ type: SPAX_CHUNK.METADATA, data: enc.buffer });
  }

  // Thumbnail
  if (thumbnail) {
    chunkList.push({ type: SPAX_CHUNK.THUMBNAIL, data: thumbnail });
  }

  // Social card
  if (socialCard) {
    chunkList.push({ type: SPAX_CHUNK.SOCIAL_CARD, data: socialCard });
  }

  // Compress all chunks above the minimum size threshold
  const compressedChunks = await Promise.all(chunkList.map(async (chunk) => {
    const rawData = chunk.data instanceof ArrayBuffer ? chunk.data : chunk.data.buffer ?? chunk.data;
    const rawSize = rawData.byteLength;

    // Never compress video/audio — already compressed formats, would grow
    const noCompress = [SPAX_CHUNK.PROXY_H264, SPAX_CHUNK.PROXY_HEVC, SPAX_CHUNK.SPATIAL_AUDIO,
                        SPAX_CHUNK.THUMBNAIL, SPAX_CHUNK.SOCIAL_CARD];
    if (noCompress.includes(chunk.type) || rawSize < MIN_COMPRESS) {
      return { type: chunk.type, data: rawData, codec: SPAX_CODEC_RAW };
    }

    const compressed = await _compressGzip(rawData);
    // Only use compressed version if it's actually smaller
    if (compressed.byteLength < rawSize * 0.95) {
      return { type: chunk.type, data: compressed, codec: SPAX_CODEC_GZIP };
    }
    return { type: chunk.type, data: rawData, codec: SPAX_CODEC_RAW };
  }));

  // Calculate total size after compression
  const headerSize = 256;
  const chunksSize = compressedChunks.reduce((s, c) => s + 12 + c.data.byteLength, 0);
  const total      = headerSize + chunksSize;

  const out = new ArrayBuffer(total);
  const dv  = new DataView(out);
  const enc = new TextEncoder();

  // Header
  dv.setUint32(0,  SPAX_MAGIC,                false);
  dv.setUint8 (4,  SPAX_VERSION.major);
  dv.setUint8 (5,  SPAX_VERSION.minor);
  dv.setUint16(6,  flags,                     false);
  dv.setUint32(8,  frameCount,                false);
  dv.setUint32(12, Math.round(duration*1000), false);
  dv.setUint32(16, compressedChunks.length,   false);
  _writeUtf8(dv, 24,  64, title);
  _writeUtf8(dv, 88,  64, creator);
  _writeUtf8(dv, 152, 64, description);

  // Chunks
  let offset = headerSize;
  for (const chunk of compressedChunks) {
    const data = chunk.data;
    const size = data.byteLength;
    dv.setUint16(offset,     chunk.type,  false);
    dv.setUint8 (offset + 2, chunk.codec);     // 0x00=raw, 0x02=gzip
    dv.setUint8 (offset + 3, 0);               // reserved
    dv.setUint32(offset + 4, size,        false);
    dv.setUint32(offset + 8, _crc32(new Uint8Array(data)), false);
    new Uint8Array(out, offset + 12, size).set(new Uint8Array(data));
    offset += 12 + size;
  }

  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _readUtf8(dv, offset, maxLen) {
  const bytes = [];
  for (let i = 0; i < maxLen; i++) {
    const b = dv.getUint8(offset + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).trim();
}

function _writeUtf8(dv, offset, maxLen, str) {
  const bytes = new TextEncoder().encode(str);
  const len   = Math.min(bytes.length, maxLen - 1);
  for (let i = 0; i < len; i++) dv.setUint8(offset + i, bytes[i]);
  dv.setUint8(offset + len, 0); // null terminator
}

// IEEE 802.3 CRC32
const _crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function _crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) crc = _crc32Table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
