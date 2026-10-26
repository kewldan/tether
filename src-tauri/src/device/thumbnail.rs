//! Screen images for the multi-device grid: small live thumbnails scaled
//! down from `screencap -p`, and one composed image of several screenshots
//! side by side.

use std::io::Cursor;

use crate::error::{AppError, AppResult};

/// A decoded 8-bit RGB image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgb {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` bytes, row-major.
    pub data: Vec<u8>,
}

fn image_error(e: impl std::fmt::Display) -> AppError {
    AppError::Device(format!("couldn't read the screenshot: {e}"))
}

/// Decodes any PNG `screencap` produces into RGB (alpha is dropped: the
/// screen is opaque).
pub fn decode_png(png: &[u8]) -> AppResult<Rgb> {
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(image_error)?;
    let len = reader
        .output_buffer_size()
        .ok_or_else(|| image_error("image too large"))?;
    let mut buf = vec![0u8; len];
    let frame = reader.next_frame(&mut buf).map_err(image_error)?;
    let channels = match frame.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err(image_error("unexpected palette")),
    };
    let (w, h) = (frame.width as usize, frame.height as usize);
    let mut data = Vec::with_capacity(w * h * 3);
    for row in buf.chunks(frame.line_size).take(h) {
        for px in row[..w * channels].chunks_exact(channels) {
            match channels {
                1 | 2 => data.extend_from_slice(&[px[0], px[0], px[0]]),
                _ => data.extend_from_slice(&px[..3]),
            }
        }
    }
    Ok(Rgb {
        width: frame.width,
        height: frame.height,
        data,
    })
}

pub fn encode_png(image: &Rgb) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(image_error)?;
    writer.write_image_data(&image.data).map_err(image_error)?;
    writer.finish().map_err(image_error)?;
    Ok(out)
}

/// Area-average downscale so the image fits `max_w`×`max_h` (keeps the
/// aspect ratio, never upscales).
pub fn fit(image: &Rgb, max_w: u32, max_h: u32) -> Rgb {
    let scale = f64::min(
        f64::from(max_w.max(1)) / f64::from(image.width.max(1)),
        f64::from(max_h.max(1)) / f64::from(image.height.max(1)),
    );
    if scale >= 1.0 {
        return image.clone();
    }
    let (w, h) = (
        ((f64::from(image.width) * scale).round() as u32).max(1),
        ((f64::from(image.height) * scale).round() as u32).max(1),
    );
    resize_area(image, w, h)
}

fn resize_area(src: &Rgb, w: u32, h: u32) -> Rgb {
    let (sw, sh) = (src.width as usize, src.height as usize);
    let (dw, dh) = (w as usize, h as usize);
    let mut data = vec![0u8; dw * dh * 3];
    for y in 0..dh {
        let y0 = y * sh / dh;
        let y1 = ((y + 1) * sh / dh).max(y0 + 1).min(sh);
        for x in 0..dw {
            let x0 = x * sw / dw;
            let x1 = ((x + 1) * sw / dw).max(x0 + 1).min(sw);
            let mut sum = [0u64; 3];
            for sy in y0..y1 {
                let row = &src.data[(sy * sw + x0) * 3..(sy * sw + x1) * 3];
                for [r, g, b] in row.as_chunks::<3>().0 {
                    sum[0] += u64::from(*r);
                    sum[1] += u64::from(*g);
                    sum[2] += u64::from(*b);
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u64;
            let out = &mut data[(y * dw + x) * 3..(y * dw + x) * 3 + 3];
            for (o, s) in out.iter_mut().zip(sum) {
                *o = u8::try_from(s / n).unwrap_or(u8::MAX);
            }
        }
    }
    Rgb {
        width: w,
        height: h,
        data,
    }
}

/// Places `images` left to right, each scaled to the same height (the
/// smallest one, capped at `max_height`), with `gap` px of `background`
/// around and between them.
pub fn compose_row(images: &[Rgb], max_height: u32, gap: u32, background: [u8; 3]) -> Rgb {
    let height = images
        .iter()
        .map(|i| i.height)
        .min()
        .unwrap_or(1)
        .min(max_height)
        .max(1);
    let scaled: Vec<Rgb> = images.iter().map(|i| fit(i, u32::MAX, height)).collect();
    let width = scaled.iter().map(|i| i.width).sum::<u32>()
        + gap * (u32::try_from(scaled.len()).unwrap_or(0) + 1);
    let total_h = height + gap * 2;
    let (cw, ch) = (width as usize, total_h as usize);
    let mut data: Vec<u8> = background
        .iter()
        .copied()
        .cycle()
        .take(cw * ch * 3)
        .collect();
    let mut x = gap as usize;
    for image in &scaled {
        let (iw, ih) = (image.width as usize, image.height as usize);
        // Shorter images (other aspect ratios) are centered vertically.
        let top = gap as usize + (height as usize - ih) / 2;
        for row in 0..ih {
            let dst = ((top + row) * cw + x) * 3;
            data[dst..dst + iw * 3].copy_from_slice(&image.data[row * iw * 3..(row + 1) * iw * 3]);
        }
        x += iw + gap as usize;
    }
    Rgb {
        width,
        height: total_h,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, color: [u8; 3]) -> Rgb {
        Rgb {
            width,
            height,
            data: color
                .iter()
                .copied()
                .cycle()
                .take((width * height * 3) as usize)
                .collect(),
        }
    }

    fn rgba_png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().unwrap();
        let data: Vec<u8> = color
            .iter()
            .copied()
            .cycle()
            .take((width * height * 4) as usize)
            .collect();
        w.write_image_data(&data).unwrap();
        w.finish().unwrap();
        out
    }

    #[test]
    fn decodes_rgba_screencap() {
        // screencap -p writes 8-bit RGBA.
        let img = decode_png(&rgba_png(4, 3, [10, 20, 30, 255])).unwrap();
        assert_eq!((img.width, img.height), (4, 3));
        assert_eq!(img.data.len(), 4 * 3 * 3);
        assert_eq!(&img.data[..3], &[10, 20, 30]);
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_png(b"error: no display").is_err());
    }

    #[test]
    fn fit_keeps_aspect_and_averages() {
        let mut img = solid(1344, 2992, [0, 0, 0]);
        // Left half white: the scaled image keeps a sharp-ish edge.
        for y in 0..2992usize {
            for x in 0..672usize {
                let i = (y * 1344 + x) * 3;
                img.data[i..i + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let small = fit(&img, 270, 600);
        assert_eq!(small.width, 270);
        assert_eq!(small.height, 600);
        assert_eq!(&small.data[..3], &[255, 255, 255]);
        let last = small.data.len() - 3;
        assert_eq!(&small.data[last..], &[0, 0, 0]);
    }

    #[test]
    fn fit_never_upscales() {
        let img = solid(100, 200, [1, 2, 3]);
        assert_eq!(fit(&img, 300, 600), img);
    }

    #[test]
    fn png_round_trip() {
        let img = solid(8, 5, [200, 100, 50]);
        let back = decode_png(&encode_png(&img).unwrap()).unwrap();
        assert_eq!(back, img);
    }

    #[test]
    fn composes_side_by_side() {
        let a = solid(100, 200, [255, 0, 0]);
        let b = solid(50, 100, [0, 255, 0]);
        let grid = compose_row(&[a, b], 1000, 10, [9, 9, 9]);
        // Both scaled to height 100: 50 + 50 wide, plus three gaps.
        assert_eq!((grid.width, grid.height), (50 + 50 + 30, 120));
        let px = |x: u32, y: u32| {
            let i = ((y * grid.width + x) * 3) as usize;
            [grid.data[i], grid.data[i + 1], grid.data[i + 2]]
        };
        assert_eq!(px(0, 0), [9, 9, 9]);
        assert_eq!(px(10, 10), [255, 0, 0]);
        assert_eq!(px(70, 50), [0, 255, 0]);
        assert_eq!(px(65, 50), [9, 9, 9]);
    }
}
