//! Tray bitmaps drawn at runtime: the "device online" badge on the tray
//! icon and the status dots of the device menu items.

use tauri::image::Image;

use super::view::Tone;

/// Opaque black: in a macOS template image only the alpha counts.
pub const TEMPLATE_INK: [u8; 3] = [0, 0, 0];
/// `--ok` of the dark theme; reads on light and dark menus alike.
pub const ONLINE: [u8; 3] = [0x3d, 0xd6, 0x8c];

/// Dark-theme status colors, as in `src/index.css`.
pub fn tone_color(tone: Tone) -> [u8; 3] {
    match tone {
        Tone::Success => ONLINE,
        Tone::Warning => [0xf5, 0xb7, 0x40],
        Tone::Error => [0xf2, 0x55, 0x5a],
        Tone::Info => [0x4a, 0xa3, 0xf0],
        Tone::Neutral => [0x8b, 0x91, 0xa0],
    }
}

/// Fraction of the pixel at (`x`, `y`) inside the circle, by 4×4
/// supersampling; enough to anti-alias edges at 16–36 px.
fn coverage(x: u32, y: u32, cx: f32, cy: f32, r: f32) -> f32 {
    const N: u32 = 4;
    let mut inside = 0;
    for sy in 0..N {
        for sx in 0..N {
            let px = x as f32 + (sx as f32 + 0.5) / N as f32 - cx;
            let py = y as f32 + (sy as f32 + 0.5) / N as f32 - cy;
            if px * px + py * py <= r * r {
                inside += 1;
            }
        }
    }
    inside as f32 / (N * N) as f32
}

/// Paints `color` with `cover` alpha over a straight-alpha RGBA pixel.
fn blend(px: &mut [u8; 4], color: [u8; 3], cover: f32) {
    if cover <= 0.0 {
        return;
    }
    let base_a = px[3] as f32 / 255.0;
    let out_a = cover + base_a * (1.0 - cover);
    for (channel, &c) in px[..3].iter_mut().zip(&color) {
        let mixed = (c as f32 * cover + *channel as f32 * base_a * (1.0 - cover)) / out_a;
        *channel = mixed.round() as u8;
    }
    px[3] = (out_a * 255.0).round() as u8;
}

/// `base` with a dot in the top-right corner and a transparent ring
/// around it, so the dot stays legible where it overlaps the glyph (the
/// board puts it there, 7 px at 18 pt).
pub fn with_badge(base: &Image<'_>, color: [u8; 3]) -> Image<'static> {
    let (w, h) = (base.width(), base.height());
    let size = w.min(h) as f32;
    let r = size * 0.18;
    let gap = size * 0.08;
    let (cx, cy) = (w as f32 - r - size * 0.02, r + size * 0.02);

    let mut rgba = base.rgba().to_vec();
    for (i, px) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let (x, y) = (i as u32 % w, i as u32 / w);
        let ring = coverage(x, y, cx, cy, r + gap);
        if ring > 0.0 {
            px[3] = (px[3] as f32 * (1.0 - ring)).round() as u8;
        }
        blend(px, color, coverage(x, y, cx, cy, r));
    }
    Image::new_owned(rgba, w, h)
}

/// A square bitmap with a centered status dot, for menu item icons.
/// Size and dot are in pixels; the OS scales the bitmap to its menu row.
pub fn dot(size: u32, diameter: f32, color: [u8; 3]) -> Image<'static> {
    let c = size as f32 / 2.0;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for (i, px) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let (x, y) = (i as u32 % size, i as u32 / size);
        blend(px, color, coverage(x, y, c, c, diameter / 2.0));
    }
    Image::new_owned(rgba, size, size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(image: &Image<'_>, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width() + x) * 4) as usize;
        image.rgba()[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn badge_cuts_a_ring_and_paints_the_dot() {
        // Fully opaque white 36×36 square.
        let base = Image::new_owned(vec![255; 36 * 36 * 4], 36, 36);
        let badged = with_badge(&base, ONLINE);

        // Dot center: the badge color, opaque.
        let r = 36.0 * 0.18;
        let (cx, cy) = ((36.0 - r - 0.72) as u32, (r + 0.72) as u32);
        assert_eq!(pixel(&badged, cx, cy), [0x3d, 0xd6, 0x8c, 255]);
        // Just outside the dot, inside the ring: transparent.
        let ring_x = (36.0 - r - 0.72 - r - 1.5) as u32;
        assert_eq!(pixel(&badged, ring_x, cy)[3], 0);
        // Far corner: untouched.
        assert_eq!(pixel(&badged, 0, 35), [255, 255, 255, 255]);
    }

    #[test]
    fn badge_on_transparent_pixels_is_just_the_dot() {
        let base = Image::new_owned(vec![0; 18 * 18 * 4], 18, 18);
        let badged = with_badge(&base, TEMPLATE_INK);
        let opaque = badged
            .rgba()
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|p| p[3] == 255)
            .count();
        // Roughly the dot's area: π·(18·0.18)² ≈ 33 px.
        assert!((20..=40).contains(&opaque), "{opaque}");
    }

    #[test]
    fn dot_is_centered_and_antialiased() {
        let image = dot(16, 8.0, tone_color(Tone::Error));
        assert_eq!(pixel(&image, 8, 8), [0xf2, 0x55, 0x5a, 255]);
        assert_eq!(pixel(&image, 0, 0)[3], 0);
        let edge = pixel(&image, 5, 5)[3];
        assert!(edge > 0 && edge < 255, "{edge}");
    }
}
