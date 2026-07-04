# NIF — Neural Interactive Format
## Public Specification · Version 1.0
### © Fumoca Technologies · fumoca.co.za
#### Effective date: 2025

---

## 1. Overview

NIF (Neural Interactive Format) is a container format for 4D spatial captures.
A NIF file encodes a volumetric depth field reconstructed from real-world video,
along with a proxy video for social sharing, depth maps, alpha masks, and layered
geometry — all in a single portable binary.

**Reading a NIF file is free.**
Any application may implement a NIF reader using this specification at no cost.

**Writing a NIF file requires an encoder license.**
Applications that produce NIF files — by capturing, converting, or transforming
spatial data into NIF format — must hold a valid encoder license from Fumoca
Technologies. Unlicensed encoders produce files that are watermarked by certified
NIF viewers.

**The Fumoca viewer SDK is separately licensed.**
The reference viewer implementation (cinematic transition, layer system, EWA
splatting renderer, parallax, depth-of-field) is proprietary and available under
the viewer SDK license.

---

## 2. File format

### 2.1 Magic bytes and extension

- File extension: `.nif`
- MIME type: `model/x-nif`
- Magic bytes (first 4 bytes): `0x4E 0x49 0x46 0x00` (ASCII `NIF\0`)

### 2.2 Wire format

```
[HEADER: 256 bytes fixed]
[CHUNK_0: 16-byte header + data]
[CHUNK_1: 16-byte header + data]
...
[CHUNK_N: 16-byte header + data]
```

All integers are **big-endian** (network byte order).
All floats are **IEEE 754**.
All strings are **ASCII**, null-padded to their fixed field length.

### 2.3 Header (256 bytes)

| Offset | Size | Type    | Field         | Notes |
|--------|------|---------|---------------|-------|
| 0      | 4    | uint32  | magic         | `0x4E494600` = `NIF\0` |
| 4      | 1    | uint8   | versionMajor  | Currently `1` |
| 5      | 1    | uint8   | versionMinor  | Currently `0` |
| 6      | 2    | padding | —             | Reserved, zero |
| 8      | 8    | int64   | createdAt     | Unix timestamp, milliseconds |
| 16     | 1    | uint8   | crs           | Coordinate reference system (see §3.1) |
| 17     | 1    | padding | —             | Reserved, zero |
| 18     | 2    | uint16  | frameCount    | Number of keyframes |
| 20     | 4    | float32 | duration      | Duration in seconds |
| 24     | 1    | uint8   | fps           | Frames per second |
| 25     | 7    | padding | —             | Reserved, zero |
| 32     | 8    | float64 | originLat     | WGS84 latitude (0 if CRS = LOCAL) |
| 40     | 8    | float64 | originLon     | WGS84 longitude |
| 48     | 8    | float64 | originAlt     | Altitude metres above WGS84 ellipsoid |
| 56     | 16   | ascii   | captureMode   | `video`, `photo`, `lidar`, `pointcloud` |
| 72     | 24   | ascii   | vertical      | `generic`, `automotive`, `property`, `fashion`, etc. |
| 96     | 32   | ascii   | producerTag   | Encoder identifier string |
| 128    | 32   | ascii   | licenseHash   | Deprecated — use CERT chunk instead |
| 160    | 96   | padding | —             | Reserved for future header fields |

### 2.4 Chunk format (each chunk)

```
[type:2][codec:1][reserved:1][size:4][crc32:4][padding:4][data:size]
```

| Offset | Size | Type   | Field    | Notes |
|--------|------|--------|----------|-------|
| 0      | 2    | uint16 | type     | Chunk type (see §4) |
| 2      | 1    | uint8  | codec    | Compression codec (see §5) |
| 3      | 1    | —      | reserved | Zero |
| 4      | 4    | uint32 | size     | Byte length of `data` field (uncompressed if codec = RAW) |
| 8      | 4    | uint32 | crc32    | CRC-32 (IEEE 802.3) of the `data` field |
| 12     | 4    | —      | padding  | Zero |
| 16     | size | bytes  | data     | Chunk payload (may be compressed) |

**Chunk total size = 16 + `size`.**

A reader that encounters an unknown chunk type MUST skip it by advancing `size` bytes
and continue reading. This ensures forward compatibility.

---

## 3. Coordinate systems

### 3.1 CRS values

| Value | Name   | Description |
|-------|--------|-------------|
| 0x00  | LOCAL  | Local scene coordinate system. Origin arbitrary. Units: metres. |
| 0x01  | WGS84  | Global GPS coordinates. Use `originLat`/`originLon`/`originAlt` as scene origin. |
| 0x02  | UTM_34S| UTM Zone 34 South (South Africa east) |
| 0x03  | UTM_35S| UTM Zone 35 South (South Africa west) |

### 3.2 Scene coordinate conventions (LOCAL CRS)

- **+X**: right
- **+Y**: up
- **+Z**: toward viewer (right-handed, Y-up)
- Units: metres
- Depth field origin: centre of the captured subject's bounding box
- Camera looks in the **-Z** direction at the origin

---

## 4. Chunk types

### Defined chunk types

| Hex    | Name          | Description |
|--------|---------------|-------------|
| 0x0002 | PROXY_VIDEO   | H.264 or H.265 proxy video. Codec byte is 0x03 (MPEG4) or 0x04 (HEVC). Plays on any platform without NIF support. |
| 0x0003 | KEYFRAME_GEO  | Depth field geometry. See §6. |
| 0x0004 | KEYFRAME_MESH | Watertight triangle mesh (marching cubes output). |
| 0x0005 | MATERIAL      | PBR material bundle. |
| 0x0006 | TIMELINE      | Keyframe timestamps and interpolation curves. |
| 0x0007 | DEPTH_MAP     | Per-pixel metric depth map. See §7. |
| 0x0008 | ALPHA_MASK    | Per-pixel alpha/segmentation mask. See §8. |
| 0x0009 | LAYER_GEO     | Layered depth field (foreground/midground/background/segments). See §9. |
| 0x000A | ASSET_REF     | External asset reference (URL + type string). |
| 0x0010 | SPATIAL_AUDIO | Ambisonics B-format audio + HRTF source positions. |
| 0x0011 | INTERACTION   | Clickable object graph + trigger/action pairs. |
| 0x0012 | AVATAR        | SMPL-X body mesh + pose parameters. |
| 0x0013 | EDIT_HISTORY  | Non-destructive edit operations (reversible). |
| 0x0014 | PRINT_EXPORT  | Pre-computed STL mesh for 3D print pipeline. |
| 0x0016 | SEMANTIC_MAP  | Per-voxel semantic labels (vertical-specific schema). |
| 0x0020 | CERT          | Encoder certificate. See §10. |
| 0x00FF | WATERMARK     | Steganographic ownership mark. Format not published. |
| 0x8000–0xFFFF | VENDOR | Reserved for licensed third-party vendor extensions. |

A reader MUST skip unrecognised chunk types without error.

---

## 5. Compression codecs

| Value | Name  | Standard | Notes |
|-------|-------|----------|-------|
| 0x00  | RAW   | —        | Uncompressed. `size` is the exact byte length. |
| 0x01  | ZSTD  | RFC 8878  | Zstandard. `size` is compressed length. |
| 0x02  | GZIP  | RFC 1952  | Gzip. wbits=31. Browser-native: `DecompressionStream('gzip')`. |
| 0x03  | MPEG4 | ISO 14496 | H.264. Used for PROXY_VIDEO only. |
| 0x04  | HEVC  | ISO 23008 | H.265. Used for PROXY_VIDEO only. |
| 0x05  | OPUS  | RFC 6716  | Used for SPATIAL_AUDIO only. |
| 0x06  | LZ4   | LZ4 frame | High-speed, lower ratio than GZIP. |

**GZIP (0x02) is the recommended codec for geometry chunks.**
It is natively supported in all modern browsers via `DecompressionStream` and in
Python via `zlib.compress(data, level=6, wbits=31)` / `zlib.decompress(data, wbits=31)`.

---

## 6. KEYFRAME_GEO chunk data layout

The geometry payload is a packed array of depth field points.

```
[count: uint32 big-endian]
[point_0: 14 × float32 big-endian]
[point_1: 14 × float32 big-endian]
...
[point_{count-1}: 14 × float32 big-endian]
```

Each point contains 14 float32 values in this order:

| Index | Field      | Description |
|-------|------------|-------------|
| 0     | px         | X position (metres, LOCAL CRS) |
| 1     | py         | Y position |
| 2     | pz         | Z position |
| 3     | sx         | Log-space scale X |
| 4     | sy         | Log-space scale Y |
| 5     | sz         | Log-space scale Z |
| 6     | qw         | Rotation quaternion W |
| 7     | qx         | Rotation quaternion X |
| 8     | qy         | Rotation quaternion Y |
| 9     | qz         | Rotation quaternion Z |
| 10    | opacity    | Opacity in logit space: `logit(α)` where `α ∈ (0,1)` |
| 11    | sh_r       | Spherical Harmonic DC red channel (logit-space, degree 0) |
| 12    | sh_g       | SH DC green channel |
| 13    | sh_b       | SH DC blue channel |

**Scale decoding:** `scale = exp(sx, sy, sz)` — exponential of stored values.

**Opacity decoding:** `α = sigmoid(opacity) = 1 / (1 + exp(-opacity))`

**Colour decoding:** `colour = sigmoid(sh_r, sh_g, sh_b) + 0.5` — maps logit to `[0.5, 1.5]`,
then clamp to `[0, 1]` for display.

**Covariance reconstruction (for EWA splatting):**
```
R = quaternion_to_matrix(qw, qx, qy, qz)
S = diag(exp(sx), exp(sy), exp(sz))
M = R · S
Σ = M · Mᵀ   (3×3 covariance matrix)
```

---

## 7. DEPTH_MAP chunk data layout

```
[height: uint16 big-endian]
[width:  uint16 big-endian]
[data:   height × width × float16 big-endian]
```

Values are metric depth in metres. The float16 encoding uses IEEE 754 half-precision.
Rows are top-to-bottom, columns are left-to-right.

---

## 8. ALPHA_MASK chunk data layout

```
[height: uint16 big-endian]
[width:  uint16 big-endian]
[data:   height × width × uint8]
```

Values: `0` = background, `255` = foreground. Intermediate values indicate
soft segmentation edges. Rows are top-to-bottom, columns are left-to-right.

---

## 9. LAYER_GEO chunk data layout

A sequence of named depth field layers:

```
For each layer:
  [labelLen: uint8]
  [label: labelLen × uint8 ASCII]
  [depthMin: float32 big-endian]
  [depthMax: float32 big-endian]
  [nPoints:  uint32 big-endian]
  [points:   nPoints × 14 × float32 big-endian]   (same layout as KEYFRAME_GEO)
```

Reserved label names: `foreground`, `midground`, `background`, `segment_N` where N
is a zero-based integer. Applications may define their own label names.

---

## 10. CERT chunk data layout (encoder certificate)

The CERT chunk identifies the encoder that produced the NIF file and its license tier.
Viewers use the tier byte to decide whether to display the fumoca watermark.

```
[0]       tier:1          ENCODER_TIER byte (see below)
[1..32]   encoderId:32    ASCII encoder identifier (issued by fumoca)
[33..64]  licenseeId:32   ASCII licensee name (company or developer)
[65..68]  issuedAt:4      Unix timestamp seconds, uint32 big-endian
[69..72]  expiresAt:4     Unix timestamp seconds, uint32 big-endian (0 = never)
[73..104] sig:32          HMAC-SHA256 of bytes [0..72] using encoder private key
[105..127] reserved:23    Zero-padded
```

### Encoder tier values

| Value | Name        | Notes |
|-------|-------------|-------|
| 0x00  | UNCERTIFIED | No CERT chunk, or cert invalid/expired. Viewers show watermark. |
| 0x01  | DEVELOPER   | R500/month. Up to 1,000 files/month. |
| 0x02  | COMMERCIAL  | R5,000/month. Up to 50,000 files/month. |
| 0x03  | OEM         | Annual license. Hardware manufacturers. |
| 0x04  | ENTERPRISE  | Unlimited. Custom verticals, SLA. |
| 0xFF  | INTERNAL    | Fumoca Technologies internal pipeline. |

### Viewer behaviour

A NIF-compliant viewer SHOULD:
- Display the fumoca watermark when tier = UNCERTIFIED
- Display the fumoca watermark when the CERT chunk is absent
- Display the fumoca watermark when the certificate is expired
- Show a clean viewer for tier ≥ DEVELOPER with a valid signature

Signature verification uses HMAC-SHA256. The HMAC key for each encoderId is
managed by the fumoca certificate authority and is not published.

---

## 11. Third-party vendor extensions

Chunk types in the range `0x8000`–`0xFFFF` are reserved for licensed third-party
vendor extensions. To register a vendor chunk type range:

1. Contact Fumoca Technologies at hello@fumoca.co.za
2. Describe your use case and the chunk data layout
3. Receive a registered type range and a vendor ID

Vendor chunks MUST be skippable — a reader that does not recognise a vendor chunk
type MUST skip it by advancing `chunk.size` bytes.

---

## 12. Versioning and compatibility

**Minor version increments (1.0 → 1.1):** New chunk types added. Readers ignoring
unknown chunks remain compatible.

**Major version increments (1.x → 2.0):** Breaking changes to header layout or
existing chunk semantics. Readers SHOULD check `versionMajor`.

A reader that encounters `versionMajor > 1` SHOULD warn the user but MAY attempt
to parse the file using the last known major version spec.

---

## 13. Reference implementation

A reference reader/writer (`NIFSpec.js`) is available for browser and Node.js
environments. The reader half is released under the MIT licence.
The writer half requires an encoder license.

```javascript
// Browser — reading a NIF file
import { NIFReader, CHUNK } from 'https://fumoca.co.za/sdk/nif-spec.js';

const res    = await fetch('https://example.com/scene.nif');
const buf    = await res.arrayBuffer();
const reader = new NIFReader(buf);

const tier     = reader.getEncoderTier();   // ENCODER_TIER constant
const geometry = reader.getGeometry();      // { count, data: Float32Array }
const cert     = reader.getCertificate();   // NIFCertificate | null
```

---

## 14. Contact and licensing

**Encoder licenses:** hello@fumoca.co.za
**Viewer SDK licenses:** hello@fumoca.co.za
**Vendor chunk registration:** hello@fumoca.co.za
**Spec feedback:** hello@fumoca.co.za

Fumoca Technologies · fumoca.co.za
© 2025 Fumoca Technologies. All rights reserved.
This specification may be reproduced freely for the purpose of implementing
a NIF reader. Encoder and viewer SDK implementations require a commercial license.
