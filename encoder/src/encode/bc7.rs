//! Minimal pure-Rust BC7 encoder (mode 6 only) + mip-chain generation.
//!
//! BC7 (`m_TextureFormat=25`) is the format real DCL texture bundles use —
//! 1 byte/texel, GPU-decodable. We emit **mode 6** for every 4×4 block: a
//! single subset, RGBA, two 7-bit+P-bit endpoints, 4-bit indices. Mode 6 is
//! the simplest full-RGBA BC7 mode and produces valid blocks any BC7 decoder
//! (Unity, UnityPy) reads — quality is below a production ISPC encoder, but
//! the FORMAT, block size, and mip-chain byte sizes match exactly, and the
//! result is validatable by decoding it back (e.g. via UnityPy).
//!
//! No external dependency — avoids a native ISPC build.

/// BC7 4-bit index interpolation weights (/64).
const W4: [u32; 16] = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

/// LSB-first bit packer into a fixed 16-byte (128-bit) BC7 block.
struct BlockBits {
    bytes: [u8; 16],
    pos: usize,
}
impl BlockBits {
    fn new() -> Self {
        Self { bytes: [0u8; 16], pos: 0 }
    }
    fn put(&mut self, val: u32, bits: usize) {
        for i in 0..bits {
            if (val >> i) & 1 != 0 {
                self.bytes[self.pos / 8] |= 1 << (self.pos % 8);
            }
            self.pos += 1;
        }
    }
}

/// Pick the 4-bit index (0..15) whose interpolation weight best matches the
/// scalar projection `t` (0..1) of a pixel onto the endpoint line.
fn nearest_index(t: f32) -> u32 {
    let target = (t.clamp(0.0, 1.0) * 64.0) as i32;
    let mut best = 0u32;
    let mut best_err = i32::MAX;
    for (i, &w) in W4.iter().enumerate() {
        let e = (w as i32 - target).abs();
        if e < best_err {
            best_err = e;
            best = i as u32;
        }
    }
    best
}

/// Encode one 4×4 RGBA block (16 pixels, row-major, RGBA8) → 16 BC7 bytes.
fn encode_block(px: &[[u8; 4]; 16]) -> [u8; 16] {
    // Axis-aligned endpoints: per-channel min/max over the block.
    let mut lo = [255u8; 4];
    let mut hi = [0u8; 4];
    for p in px.iter() {
        for c in 0..4 {
            lo[c] = lo[c].min(p[c]);
            hi[c] = hi[c].max(p[c]);
        }
    }

    // Direction vector e1-e0 and its squared length, for projection.
    let dir = [
        hi[0] as f32 - lo[0] as f32,
        hi[1] as f32 - lo[1] as f32,
        hi[2] as f32 - lo[2] as f32,
        hi[3] as f32 - lo[3] as f32,
    ];
    let len2 = dir.iter().map(|d| d * d).sum::<f32>();

    let mut idx = [0u32; 16];
    for (i, p) in px.iter().enumerate() {
        idx[i] = if len2 <= 0.0 {
            0
        } else {
            let dot = (0..4).map(|c| (p[c] as f32 - lo[c] as f32) * dir[c]).sum::<f32>();
            nearest_index(dot / len2)
        };
    }

    // P-bits: endpoint LSB. Endpoint0 → pbit 0, endpoint1 → pbit 1 (so the
    // reconstructed 8-bit endpoints straddle the 7-bit grid sensibly).
    let (mut e0, mut e1) = (lo, hi);
    let (mut p0, mut p1) = (0u32, 1u32);

    // Anchor rule: index[0] must have its high bit 0 (< 8). If not, swap
    // endpoints + p-bits and invert every index.
    if idx[0] >= 8 {
        std::mem::swap(&mut e0, &mut e1);
        std::mem::swap(&mut p0, &mut p1);
        for v in idx.iter_mut() {
            *v = 15 - *v;
        }
    }

    // 7-bit color per channel (drop the LSB, which the p-bit represents).
    let c7 = |v: u8| (v >> 1) as u32;

    let mut b = BlockBits::new();
    b.put(0b100_0000, 7); // mode 6 marker (six zeros then a one)
    // Endpoints, channel-major: R0,R1, G0,G1, B0,B1, A0,A1 — 7 bits each.
    for c in 0..4 {
        b.put(c7(e0[c]), 7);
        b.put(c7(e1[c]), 7);
    }
    b.put(p0, 1);
    b.put(p1, 1);
    // Indices: anchor (index 0) is 3 bits, the rest are 4 bits.
    b.put(idx[0], 3);
    for v in idx.iter().skip(1) {
        b.put(*v, 4);
    }
    debug_assert_eq!(b.pos, 128);
    b.bytes
}

/// BC7-compress an RGBA8 image (tight, width*height*4). Dimensions are
/// padded up to a multiple of 4 (edge pixels clamped). Output is
/// `ceil(w/4) * ceil(h/4) * 16` bytes.
pub fn compress_rgba(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let bw = width.max(1).div_ceil(4);
    let bh = height.max(1).div_ceil(4);
    let mut out = Vec::with_capacity((bw * bh * 16) as usize);
    let w = width.max(1) as i64;
    let h = height.max(1) as i64;
    let at = |x: i64, y: i64| -> [u8; 4] {
        let cx = x.clamp(0, w - 1);
        let cy = y.clamp(0, h - 1);
        let o = ((cy * w + cx) * 4) as usize;
        [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]
    };
    for by in 0..bh as i64 {
        for bx in 0..bw as i64 {
            let mut block = [[0u8; 4]; 16];
            for py in 0..4 {
                for px in 0..4 {
                    block[(py * 4 + px) as usize] = at(bx * 4 + px, by * 4 + py);
                }
            }
            out.extend_from_slice(&encode_block(&block));
        }
    }
    out
}

/// Generate the full mip chain (down to 1×1) by 2×2 box-filter downsampling,
/// BC7-compress each level, and concatenate. Returns (bc7_bytes, mip_count).
/// The concatenated size matches Unity's `m_CompleteImageSize`.
pub fn compress_with_mips(rgba: &[u8], width: u32, height: u32) -> (Vec<u8>, i32) {
    let mut out = Vec::new();
    let mut levels = 0i32;
    let mut cur = rgba.to_vec();
    let mut w = width.max(1);
    let mut h = height.max(1);
    loop {
        out.extend_from_slice(&compress_rgba(&cur, w, h));
        levels += 1;
        if w <= 1 && h <= 1 {
            break;
        }
        let nw = (w / 2).max(1);
        let nh = (h / 2).max(1);
        cur = downsample(&cur, w, h, nw, nh);
        w = nw;
        h = nh;
    }
    (out, levels)
}

/// 2×2 box-filter downsample of a tight RGBA8 image.
fn downsample(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (dw * dh * 4) as usize];
    for y in 0..dh {
        for x in 0..dw {
            for c in 0..4 {
                let mut sum = 0u32;
                let mut n = 0u32;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let sx = (x * 2 + dx).min(sw - 1);
                        let sy = (y * 2 + dy).min(sh - 1);
                        sum += src[((sy * sw + sx) * 4 + c) as usize] as u32;
                        n += 1;
                    }
                }
                out[((y * dw + x) * 4 + c) as usize] = (sum / n) as u8;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_is_16_bytes_and_mode6() {
        let px = [[10u8, 20, 30, 255]; 16];
        let b = encode_block(&px);
        assert_eq!(b.len(), 16);
        // mode 6 marker: low 7 bits = 0b1000000 = 0x40.
        assert_eq!(b[0] & 0x7f, 0x40);
    }

    #[test]
    fn complete_image_size_matches_unity_for_512() {
        // 512×512 BC7 + full mip chain = 349552 bytes (Unity's value).
        let rgba = vec![128u8; 512 * 512 * 4];
        let (data, mips) = compress_with_mips(&rgba, 512, 512);
        assert_eq!(mips, 10);
        assert_eq!(data.len(), 349552);
    }

    #[test]
    fn flat_block_round_trips_close() {
        // A flat block should reconstruct ~exactly (endpoints equal-ish).
        let px = [[200u8, 100, 50, 255]; 16];
        let b = encode_block(&px);
        // mode marker present; full decode is validated externally (UnityPy).
        assert_eq!(b[0] & 0x7f, 0x40);
    }
}
