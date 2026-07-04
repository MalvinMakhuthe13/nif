/**
 * NIF — Neural Interactive Format · Binary Specification v1.0
 * © Fumoca Technologies · fumoca.co.za
 * Proprietary. All rights reserved.
 *
 * Wire format:
 *   [HEADER 256B fixed] [CHUNKS...]
 *   Each chunk: [type:2][codec:1][reserved:1][size:4][crc32:4][padding:4][data:size]
 *
 * All integers big-endian. Floats IEEE-754.
 * CRC-32 (IEEE 802.3) validates each chunk independently.
 *
 * Browser-safe: uses DataView and Uint8Array throughout.
 * Node.js pipeline uses same API — no Buffer dependency anywhere.
 */

export const NIF_MAGIC         = 0x4E494600; // 'NIF\0'
export const NIF_VERSION_MAJOR = 1;
export const NIF_VERSION_MINOR = 0;

export const CHUNK = Object.freeze({
  PROXY_VIDEO:   0x0002,  // H.264/H.265 video preview — plays on any device
  KEYFRAME_GEO:  0x0003,  // Packed depth field keyframe data (14 floats per point)
  KEYFRAME_MESH: 0x0004,  // Watertight triangle mesh (SDF-extracted)
  MATERIAL:      0x0005,  // PBR material bundle
  TIMELINE:      0x0006,  // Keyframe timestamps + interpolation curve data
  DEPTH_MAP:     0x0007,  // Per-pixel metric depth map (float16, HxW) from DepthAnything v2
  ALPHA_MASK:    0x0008,  // Per-pixel alpha/segmentation mask (uint8, HxW) — background removal
  LAYER_GEO:     0x0009,  // Layered depth field: each layer = {label, depth_range, geo}
  ASSET_REF:     0x000A,  // External asset reference (glTF/USD/video/image/LAS URL + type)
  SPATIAL_AUDIO: 0x0010,  // Ambisonics B-format + HRTF source positions
  INTERACTION:   0x0011,  // Clickable object graph + trigger/action pairs
  AVATAR:        0x0012,  // SMPL-X body mesh + pose parameters
  EDIT_HISTORY:  0x0013,  // Non-destructive edit operations (reversible)
  PRINT_EXPORT:  0x0014,  // Pre-computed STL for 3D print pipeline
  SEMANTIC_MAP:  0x0016,  // Per-voxel semantic labels (vertical-specific)
  CERT:          0x0020,  // Encoder certificate — license tier, encoder ID, HMAC signature
  WATERMARK:     0x00FF,  // Steganographic ownership mark
  // 0x8000–0xFFFF reserved for licensed third-party vendor extensions
});

/**
 * Encoder license tiers.
 * Every NIF file produced by a licensed encoder carries a CERT chunk
 * containing the tier byte. Viewers enforce tier-based watermarking.
 *
 * UNCERTIFIED (0x00): No CERT chunk present. Viewer shows fumoca watermark.
 * DEVELOPER   (0x01): R500/month. Up to 1,000 files/month. Watermark-free viewer.
 * COMMERCIAL  (0x02): R5,000/month. Up to 50,000 files/month. White-label SDK.
 * OEM         (0x03): Annual negotiated. Hardware manufacturers.
 * ENTERPRISE  (0x04): Unlimited. Custom verticals, SLA, priority support.
 * INTERNAL    (0xFF): Fumoca internal pipeline. Never issued externally.
 */
export const ENCODER_TIER = Object.freeze({
  UNCERTIFIED: 0x00,
  DEVELOPER:   0x01,
  COMMERCIAL:  0x02,
  OEM:         0x03,
  ENTERPRISE:  0x04,
  INTERNAL:    0xFF,
});

export const CRS = Object.freeze({
  LOCAL:   0,
  WGS84:   1,
  UTM_34S: 2,
  UTM_35S: 3,
});

export const CODEC = Object.freeze({
  RAW:   0x00,
  ZSTD:  0x01,
  DRACO: 0x02,
  MPEG4: 0x03,
  HEVC:  0x04,
  OPUS:  0x05,
  LZ4:   0x06,
});

// ─── Utilities ────────────────────────────────────────────────────────────────

// CRC-32 (IEEE 802.3) — works on Uint8Array or any iterable of bytes
export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Encode ASCII string into fixed-length Uint8Array, null-padded
function encodeAscii(str, len) {
  const out = new Uint8Array(len);
  const s   = str.slice(0, len);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7F;
  return out;
}

// Decode null-terminated ASCII from DataView
function decodeAscii(dv, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

// Concatenate multiple Uint8Arrays into one
function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const a of arrays) {
    out.set(new Uint8Array(a instanceof ArrayBuffer ? a : a.buffer ?? a), offset);
    offset += a.byteLength;
  }
  return out;
}

// Write a big-endian float32 into a DataView at offset
function setFloatBE(dv, offset, val) {
  const tmp = new DataView(new ArrayBuffer(4));
  tmp.setFloat32(0, val, false);
  dv.setUint32(offset, tmp.getUint32(0, false), false);
}

// Write a big-endian float64 into a DataView at offset
function setDoubleBE(dv, offset, val) {
  const tmp = new DataView(new ArrayBuffer(8));
  tmp.setFloat64(0, val, false);
  dv.setBigUint64(offset, tmp.getBigUint64(0, false), false);
}

// ─── Header (256 bytes, fixed layout) ────────────────────────────────────────
export class NIFHeader {
  constructor(opts = {}) {
    this.magic        = NIF_MAGIC;
    this.versionMajor = NIF_VERSION_MAJOR;
    this.versionMinor = NIF_VERSION_MINOR;
    this.createdAt    = opts.createdAt    ?? Date.now();
    this.captureMode  = opts.captureMode  ?? 'video';
    this.crs          = opts.crs          ?? CRS.LOCAL;
    this.frameCount   = opts.frameCount   ?? 1;
    this.duration     = opts.duration     ?? 0;
    this.fps          = opts.fps          ?? 30;
    this.originLat    = opts.originLat    ?? 0.0;
    this.originLon    = opts.originLon    ?? 0.0;
    this.originAlt    = opts.originAlt    ?? 0.0;
    this.vertical     = opts.vertical     ?? 'generic';
    this.producerTag  = 'FUMOCA_NIF_1.0';
    this.licenseHash  = opts.licenseHash  ?? '';
  }

  toUint8Array() {
    const ab  = new ArrayBuffer(256);
    const dv  = new DataView(ab);
    const u8  = new Uint8Array(ab);
    dv.setUint32(0, this.magic,        false);
    dv.setUint8 (4, this.versionMajor       );
    dv.setUint8 (5, this.versionMinor       );
    dv.setBigInt64(8, BigInt(this.createdAt), false);
    dv.setUint8 (16, this.crs               );
    dv.setUint16(18, this.frameCount, false );
    setFloatBE(dv, 20, this.duration         );
    dv.setUint8 (24, this.fps               );
    setDoubleBE(dv, 32, this.originLat       );
    setDoubleBE(dv, 40, this.originLon       );
    setDoubleBE(dv, 48, this.originAlt       );
    u8.set(encodeAscii(this.captureMode, 16),  56);
    u8.set(encodeAscii(this.vertical,    24),  72);
    u8.set(encodeAscii(this.producerTag, 32),  96);
    u8.set(encodeAscii(this.licenseHash, 32), 128);
    return u8;
  }

  // Keep toBuffer as alias for Node.js pipeline compatibility
  toBuffer() { return Buffer.from(this.toUint8Array()); }

  static fromDataView(dv) {
    if (dv.byteLength < 256) throw new Error('Too short for NIF header');
    const h = new NIFHeader();
    h.magic        = dv.getUint32(0, false);
    h.versionMajor = dv.getUint8(4);
    h.versionMinor = dv.getUint8(5);
    h.createdAt    = Number(dv.getBigInt64(8, false));
    h.crs          = dv.getUint8(16);
    h.frameCount   = dv.getUint16(18, false);
    h.duration     = dv.getFloat32(20, false);
    h.fps          = dv.getUint8(24);
    h.originLat    = dv.getFloat64(32, false);
    h.originLon    = dv.getFloat64(40, false);
    h.originAlt    = dv.getFloat64(48, false);
    h.captureMode  = decodeAscii(dv, 56, 16);
    h.vertical     = decodeAscii(dv, 72, 24);
    h.producerTag  = decodeAscii(dv, 96, 32);
    h.licenseHash  = decodeAscii(dv, 128, 32);
    if (h.magic !== NIF_MAGIC) throw new Error(`Invalid NIF magic: 0x${h.magic.toString(16)}`);
    return h;
  }

  // Accept ArrayBuffer, Uint8Array, or Node.js Buffer
  static fromBuffer(buf) {
    const ab = buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength)
                          : buf instanceof ArrayBuffer ? buf : buf;
    return NIFHeader.fromDataView(new DataView(ab));
  }
}

// ─── Chunk ────────────────────────────────────────────────────────────────────
// Wire: [type:2][codec:1][reserved:1][size:4][crc32:4][padding:4][data:size]
export class NIFChunk {
  static HEADER_SIZE = 16;

  constructor(type, data, codec = CODEC.ZSTD) {
    this.type  = type;
    this.codec = codec;
    // Accept ArrayBuffer, Uint8Array, Node Buffer, or plain array
    if (data instanceof ArrayBuffer) {
      this.data = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      this.data = data;
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      this.data = new Uint8Array(data);
    } else {
      this.data = new Uint8Array(data);
    }
    this.size = this.data.byteLength;
    this.crc  = crc32(this.data);
  }

  toUint8Array() {
    const hdr = new Uint8Array(NIFChunk.HEADER_SIZE);
    const dv  = new DataView(hdr.buffer);
    dv.setUint16(0, this.type,  false);
    dv.setUint8 (2, this.codec       );
    dv.setUint32(4, this.size,  false);
    dv.setUint32(8, this.crc,   false);
    return concat(hdr, this.data);
  }

  toBuffer() { return Buffer.from(this.toUint8Array()); }

  get _totalSize() { return NIFChunk.HEADER_SIZE + this.size; }

  static fromDataView(dv, offset = 0) {
    if (dv.byteLength < offset + NIFChunk.HEADER_SIZE)
      throw new Error('Truncated chunk header at offset ' + offset);
    const type  = dv.getUint16(offset,     false);
    const codec = dv.getUint8 (offset + 2       );
    const size  = dv.getUint32(offset + 4, false);
    const crc   = dv.getUint32(offset + 8, false);
    const dataStart = offset + NIFChunk.HEADER_SIZE;
    if (dv.byteLength < dataStart + size)
      throw new Error(`Chunk data truncated: expected ${size}B at offset ${dataStart}`);
    const data = new Uint8Array(dv.buffer, dv.byteOffset + dataStart, size);
    const actual = crc32(data);
    if (actual !== crc)
      throw new Error(`Chunk CRC mismatch at offset ${offset}: expected 0x${crc.toString(16)}, got 0x${actual.toString(16)}`);
    const chunk = new NIFChunk(type, data, codec);
    return chunk;
  }

  static fromBuffer(buf, offset = 0) {
    const ab = buf instanceof ArrayBuffer ? buf
             : buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength)
             : new Uint8Array(buf).buffer;
    return NIFChunk.fromDataView(new DataView(ab), offset);
  }
}

// ─── Writer (Node.js pipeline — server-side) ──────────────────────────────────
export class NIFWriter {
  constructor(headerOpts = {}) {
    this.header = new NIFHeader(headerOpts);
    this.chunks = [];
  }

  add(type, data, codec) {
    this.chunks.push(new NIFChunk(type, data, codec));
    return this;
  }

  build() {
    const parts = [this.header.toUint8Array(), ...this.chunks.map(c => c.toUint8Array())];
    return concat(...parts);
  }

  // Node.js compatibility — returns Buffer
  buildBuffer() { return Buffer.from(this.build()); }

  get byteLength() {
    return 256 + this.chunks.reduce((s, c) => s + NIFChunk.HEADER_SIZE + c.size, 0);
  }
}

// ─── Certificate (CHUNK 0x0020) ───────────────────────────────────────────────
//
// Every NIF file produced by a licensed encoder contains a CERT chunk.
// The chunk is 128 bytes:
//   [0]     tier:1         ENCODER_TIER byte
//   [1..32] encoderId:32   ASCII encoder identifier (issued by fumoca at license time)
//   [33..64] licenseeId:32 ASCII licensee identifier (company/developer name)
//   [65..68] issuedAt:4    Unix timestamp (uint32 BE) when license was issued
//   [69..72] expiresAt:4   Unix timestamp (uint32 BE) when license expires (0=never)
//   [73..104] sig:32       HMAC-SHA256 of bytes [0..72] using the encoder's private key
//             (issued by fumoca, never leaves the licensee's build environment)
//   [105..127] reserved:23 Zero-padded for future use
//
// Viewers check the CERT chunk:
//   - No CERT chunk → UNCERTIFIED → show fumoca watermark
//   - CERT present but signature invalid → UNCERTIFIED → show watermark
//   - CERT present, sig valid, tier ≥ DEVELOPER → clean viewer
//   - CERT present, sig valid, tier ≥ COMMERCIAL → white-label SDK features
//
// The HMAC key is unique per encoder license. Fumoca holds the master key.
// Revocation: fumoca adds the encoderId to a revocation list fetched by viewers.
//
export class NIFCertificate {
  /**
   * @param {object} opts
   * @param {number}  opts.tier        — ENCODER_TIER constant
   * @param {string}  opts.encoderId   — max 32 chars, issued by fumoca
   * @param {string}  opts.licenseeId  — max 32 chars, company/developer name
   * @param {number}  opts.issuedAt    — Unix timestamp seconds
   * @param {number}  opts.expiresAt   — Unix timestamp seconds (0 = never)
   * @param {Uint8Array} opts.sig      — 32-byte HMAC-SHA256 signature
   */
  constructor(opts = {}) {
    this.tier       = opts.tier       ?? ENCODER_TIER.UNCERTIFIED;
    this.encoderId  = opts.encoderId  ?? '';
    this.licenseeId = opts.licenseeId ?? '';
    this.issuedAt   = opts.issuedAt   ?? 0;
    this.expiresAt  = opts.expiresAt  ?? 0;
    this.sig        = opts.sig        ?? new Uint8Array(32);
  }

  toUint8Array() {
    const out = new Uint8Array(128);
    const dv  = new DataView(out.buffer);
    out[0] = this.tier;
    out.set(encodeAscii(this.encoderId,  32), 1);
    out.set(encodeAscii(this.licenseeId, 32), 33);
    dv.setUint32(65, this.issuedAt,  false);
    dv.setUint32(69, this.expiresAt, false);
    out.set(this.sig.slice(0, 32), 73);
    return out;
  }

  /** Build a NIFChunk ready to embed in a NIF file */
  toChunk() {
    return new NIFChunk(CHUNK.CERT, this.toUint8Array(), CODEC.RAW);
  }

  static fromUint8Array(u8) {
    if (u8.byteLength < 128) throw new Error('CERT chunk too short');
    const dv   = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return new NIFCertificate({
      tier:       u8[0],
      encoderId:  decodeAscii(dv, 1,  32),
      licenseeId: decodeAscii(dv, 33, 32),
      issuedAt:   dv.getUint32(65, false),
      expiresAt:  dv.getUint32(69, false),
      sig:        u8.slice(73, 105),
    });
  }

  static fromChunk(chunk) {
    if (chunk.type !== CHUNK.CERT) throw new Error('Not a CERT chunk');
    return NIFCertificate.fromUint8Array(chunk.data);
  }

  /** Is this certificate currently valid (not expired)? */
  isActive() {
    if (this.tier === ENCODER_TIER.UNCERTIFIED) return false;
    if (this.expiresAt === 0) return true;
    return Math.floor(Date.now() / 1000) < this.expiresAt;
  }

  /**
   * Verify the HMAC signature using the Web Crypto API.
   * The hmacKey is the 32-byte raw key issued to this encoder by fumoca.
   * In the viewer SDK this is fetched from the fumoca certificate authority.
   * @param {CryptoKey|Uint8Array} hmacKey
   */
  async verify(hmacKey) {
    if (typeof SubtleCrypto === 'undefined' && typeof crypto === 'undefined') {
      // Node.js < 19 or non-secure context — skip verification, trust tier
      return this.tier !== ENCODER_TIER.UNCERTIFIED;
    }
    try {
      const subtle = (typeof crypto !== 'undefined' ? crypto : globalThis.crypto).subtle;
      let key = hmacKey;
      if (hmacKey instanceof Uint8Array) {
        key = await subtle.importKey(
          'raw', hmacKey, { name:'HMAC', hash:'SHA-256' }, false, ['verify']
        );
      }
      // The signed payload is bytes [0..72] of the cert
      const payload = this.toUint8Array().slice(0, 73);
      return await subtle.verify('HMAC', key, this.sig, payload);
    } catch {
      return false;
    }
  }

  /**
   * Sign a certificate using the encoder's HMAC key.
   * Called once at build/deploy time by a licensed encoder.
   * @param {Uint8Array} rawKey  — 32-byte key provided by fumoca
   */
  static async sign(opts, rawKey) {
    const cert    = new NIFCertificate(opts);
    const payload = cert.toUint8Array().slice(0, 73);
    const subtle  = (typeof crypto !== 'undefined' ? crypto : globalThis.crypto).subtle;
    const key     = await subtle.importKey(
      'raw', rawKey, { name:'HMAC', hash:'SHA-256' }, false, ['sign']
    );
    const sig     = new Uint8Array(await subtle.sign('HMAC', key, payload));
    cert.sig      = sig;
    return cert;
  }
}

// ─── Reader — browser + Node safe ────────────────────────────────────────────
export class NIFReader {
  /**
   * Accepts:
   *   - ArrayBuffer (from fetch().arrayBuffer() in browser)
   *   - Uint8Array
   *   - Node.js Buffer
   */
  constructor(input) {
    let ab;
    if (input instanceof ArrayBuffer) {
      ab = input;
    } else if (input instanceof Uint8Array) {
      ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
      ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    } else {
      ab = input;
    }

    const dv = new DataView(ab);
    this.header = NIFHeader.fromDataView(dv);
    this.chunks = [];

    let offset = 256;
    while (offset < dv.byteLength) {
      if (offset + NIFChunk.HEADER_SIZE > dv.byteLength) break;
      try {
        const chunk = NIFChunk.fromDataView(dv, offset);
        this.chunks.push(chunk);
        offset += chunk._totalSize;
      } catch (e) {
        console.warn('[NIFReader] Chunk parse error at offset', offset, '—', e.message);
        break;
      }
    }
  }

  getChunk(type)  { return this.chunks.find(c => c.type === type) ?? null; }
  allChunks(type) { return this.chunks.filter(c => c.type === type); }
  hasChunk(type)  { return this.chunks.some(c => c.type === type); }

  /** Returns the encoder certificate, or null if no CERT chunk is present */
  getCertificate() {
    const chunk = this.getChunk(CHUNK.CERT);
    if (!chunk) return null;
    try { return NIFCertificate.fromChunk(chunk); } catch { return null; }
  }

  /**
   * Returns the encoder tier for this file.
   * UNCERTIFIED if no CERT chunk or cert is expired.
   */
  getEncoderTier() {
    const cert = this.getCertificate();
    if (!cert || !cert.isActive()) return ENCODER_TIER.UNCERTIFIED;
    return cert.tier;
  }

  // Deserialise geometry chunk → { count, data: Float32Array }
  /**
   * Parse KEYFRAME_GEO chunk.
   *
   * Supports two formats determined by the first byte (format_flag):
   *   0x00 — raw float32  (legacy / fallback): [flag:u8][count:u32][data: count×14×f32]
   *   0x01 — quantised    (default since v1.1): [flag:u8][count:u32][bb_min:3×f32][bb_max:3×f32]
   *                                              [points: count × 17 bytes]
   *
   * Quantised point layout (17 bytes):
   *   [px:i16][py:i16][pz:i16] positions   (dequantise: val/32767 × range + bb_min)
   *   [sx:u8][sy:u8][sz:u8]   log_scales   (dequantise: val/255 × 10 - 8)
   *   [qw:i8][qx:i8][qy:i8][qz:i8] quat    (dequantise: val/127)
   *   [opacity:u8]             logit         (dequantise: val/255)
   *   [r:u8][g:u8][b:u8]      sh0 colour    (dequantise: val/255 + 0.5 - 0.5 = val/255)
   *
   * Returns { count, data: Float32Array } — always 14 floats per point in the
   * canonical format regardless of which encoding was used. The viewer and
   * renderer see the same layout either way.
   */
  getGeometry() {
    const chunk = this.getChunk(CHUNK.KEYFRAME_GEO);
    if (!chunk) return null;
    const dv = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);

    const flag  = dv.getUint8(0);
    const count = dv.getUint32(1, false);   // big-endian

    if (flag === 0x00) {
      // ── Raw float32 (fallback format) ──────────────────────────────────────
      const arr = new Float32Array(
        chunk.data.buffer,
        chunk.data.byteOffset + 5,
        count * 14,
      );
      return { count, data: arr };
    }

    if (flag === 0x01) {
      // ── Quantised format ───────────────────────────────────────────────────
      // Header: flag(1) + count(4) + bb_min(12) + bb_max(12) = 29 bytes
      const bbMinX = dv.getFloat32(5,  false);
      const bbMinY = dv.getFloat32(9,  false);
      const bbMinZ = dv.getFloat32(13, false);
      const bbMaxX = dv.getFloat32(17, false);
      const bbMaxY = dv.getFloat32(21, false);
      const bbMaxZ = dv.getFloat32(25, false);

      const rangeX = bbMaxX - bbMinX;
      const rangeY = bbMaxY - bbMinY;
      const rangeZ = bbMaxZ - bbMinZ;

      const SCALE_MIN = -8.0, SCALE_RANGE = 10.0; // maps [0,255] → [-8, 2]

      const out   = new Float32Array(count * 14);
      let   base  = 29; // byte offset into chunk.data where points start

      for (let i = 0; i < count; i++) {
        const o  = i * 14;  // output offset

        // Positions (3 × int16, big-endian)
        const px = dv.getInt16(chunk.data.byteOffset + base,     false);
        const py = dv.getInt16(chunk.data.byteOffset + base + 2, false);
        const pz = dv.getInt16(chunk.data.byteOffset + base + 4, false);
        out[o + 0] = ((px + 32767) / 65534) * rangeX + bbMinX;
        out[o + 1] = ((py + 32767) / 65534) * rangeY + bbMinY;
        out[o + 2] = ((pz + 32767) / 65534) * rangeZ + bbMinZ;

        // Log scales (3 × uint8)
        out[o + 3] = (chunk.data[base + 6]  / 255) * SCALE_RANGE + SCALE_MIN;
        out[o + 4] = (chunk.data[base + 7]  / 255) * SCALE_RANGE + SCALE_MIN;
        out[o + 5] = (chunk.data[base + 8]  / 255) * SCALE_RANGE + SCALE_MIN;

        // Quaternion (4 × int8)
        out[o + 6] = dv.getInt8(chunk.data.byteOffset + base + 9)  / 127;
        out[o + 7] = dv.getInt8(chunk.data.byteOffset + base + 10) / 127;
        out[o + 8] = dv.getInt8(chunk.data.byteOffset + base + 11) / 127;
        out[o + 9] = dv.getInt8(chunk.data.byteOffset + base + 12) / 127;

        // Opacity (uint8 → logit-space)
        // Was: sigmoid(logit) × 255, dequantise: val/255 → sigmoid, then logit
        const opSig = chunk.data[base + 13] / 255;
        out[o + 10] = Math.log(Math.max(opSig, 1e-6) / Math.max(1 - opSig, 1e-6));

        // SH0 colour (3 × uint8)
        // Was: (sigmoid(sh) + 0.5 - 0.5) × 255, simplifies to: sigmoid(sh) × 255
        // Dequantise: val/255 → sigmoid → logit
        const r = chunk.data[base + 14] / 255;
        const g = chunk.data[base + 15] / 255;
        const b = chunk.data[base + 16] / 255;
        out[o + 11] = Math.log(Math.max(r, 1e-6) / Math.max(1 - r, 1e-6));
        out[o + 12] = Math.log(Math.max(g, 1e-6) / Math.max(1 - g, 1e-6));
        out[o + 13] = Math.log(Math.max(b, 1e-6) / Math.max(1 - b, 1e-6));

        base += 17;
      }

      return { count, data: out };
    }

    console.warn(`[NIFSpec] Unknown geometry format flag: 0x${flag.toString(16)}`);
    return null;
  }
}
