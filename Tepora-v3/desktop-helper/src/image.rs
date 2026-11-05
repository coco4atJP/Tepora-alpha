//! Screenshot pixels to JPEG, scaled to logical points like the macOS helper's `sips --resampleWidth`.
use crate::protocol::{HelperError, Result, Shot};

/// A BGRA/BGRX image with a row stride in bytes.
pub struct Pixels<'a> {
    pub data: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

/// Box-filter downscale to `out_w` x `out_h` (never upscales) into packed RGB.
pub fn to_rgb(p: &Pixels, out_w: u32, out_h: u32) -> Result<Vec<u8>> {
    if p.width == 0 || p.height == 0 {
        return Err(HelperError::new("The window has no frame."));
    }
    if p.stride < p.width as usize * 4 || p.data.len() < p.stride * (p.height as usize - 1) + p.width as usize * 4 {
        return Err(HelperError::new("The screenshot data is incomplete."));
    }
    let (ow, oh) = (out_w.clamp(1, p.width), out_h.clamp(1, p.height));
    let mut out = Vec::with_capacity(ow as usize * oh as usize * 3);
    for oy in 0..oh {
        let y0 = (oy as u64 * p.height as u64 / oh as u64) as usize;
        let y1 = (((oy + 1) as u64 * p.height as u64 / oh as u64) as usize).max(y0 + 1);
        for ox in 0..ow {
            let x0 = (ox as u64 * p.width as u64 / ow as u64) as usize;
            let x1 = (((ox + 1) as u64 * p.width as u64 / ow as u64) as usize).max(x0 + 1);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row = &p.data[y * p.stride..];
                for x in x0..x1 {
                    b += row[x * 4] as u32;
                    g += row[x * 4 + 1] as u32;
                    r += row[x * 4 + 2] as u32;
                    n += 1;
                }
            }
            out.extend_from_slice(&[(r / n) as u8, (g / n) as u8, (b / n) as u8]);
        }
    }
    Ok(out)
}

pub fn jpeg(p: &Pixels, scale: f64) -> Result<Shot> {
    let scale = if scale.is_finite() && scale >= 1.0 { scale } else { 1.0 };
    let w = ((p.width as f64 / scale).round() as u32).clamp(1, u16::MAX as u32);
    let h = ((p.height as f64 / scale).round() as u32).clamp(1, u16::MAX as u32);
    let rgb = to_rgb(p, w, h)?;
    let (w, h) = (w.min(p.width), h.min(p.height));
    let mut buf = Vec::new();
    jpeg_encoder::Encoder::new(&mut buf, 75).encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)?;
    Ok(Shot { jpeg: buf, width: w, height: h })
}
