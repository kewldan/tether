//! Photo metadata (EXIF) for the file preview, read from the first bytes of
//! a JPEG, HEIC/AVIF, PNG (`eXIf`), WebP or TIFF/DNG on the device.

use std::io::Cursor;

use exif::{Exif, In, Reader, Tag, Value};
use serde::Serialize;

use super::files::read_head;
use crate::adb::server::AdbServer;
use crate::error::AppResult;

/// Enough for JPEG (APP1 is at most 64 KiB) and most TIFF/DNG headers.
const HEAD_SMALL: usize = 256 * 1024;
/// HEIF keeps EXIF as an item that can sit further into the file.
const HEAD_LARGE: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDetails {
    /// Local wall time as `YYYY-MM-DDTHH:MM:SS`, as the camera wrote it.
    pub taken: Option<String>,
    /// UTC offset of `taken` (`+03:00`), when recorded.
    pub offset: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Seconds.
    pub exposure: Option<f64>,
    pub f_number: Option<f64>,
    pub iso: Option<u32>,
    /// Millimetres.
    pub focal_length: Option<f64>,
    pub focal_length_35mm: Option<u32>,
    /// Decimal degrees, south and west negative.
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// Metres above sea level.
    pub altitude: Option<f64>,
}

impl ImageDetails {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Reads EXIF from the start of `path`. `None` when the file has none (or
/// it lies beyond what is worth downloading for a preview).
pub async fn read(server: &AdbServer, serial: &str, path: &str) -> AppResult<Option<ImageDetails>> {
    let head = read_head(server, serial, path, HEAD_SMALL).await?;
    if let Some(details) = parse(&head) {
        return Ok(Some(details));
    }
    let heif = head.get(4..8) == Some(b"ftyp");
    if heif && head.len() == HEAD_SMALL {
        let head = read_head(server, serial, path, HEAD_LARGE).await?;
        return Ok(parse(&head));
    }
    Ok(None)
}

/// Parses whatever EXIF a (possibly truncated) image file holds.
pub fn parse(data: &[u8]) -> Option<ImageDetails> {
    let exif = Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut Cursor::new(data))
        .or_else(|e| e.distill_partial_result(|_| {}))
        .ok()?;
    let details = details(&exif);
    (!details.is_empty()).then_some(details)
}

fn details(exif: &Exif) -> ImageDetails {
    let field = |tag| exif.get_field(tag, In::PRIMARY).map(|f| &f.value);
    let text = |tag| field(tag).and_then(ascii);
    let uint = |tag| field(tag).and_then(|v| v.get_uint(0)).filter(|&v| v > 0);
    let real = |tag| field(tag).and_then(|v| rational(v, 0)).filter(|v| *v > 0.0);

    let make = text(Tag::Make);
    let model = text(Tag::Model);
    let taken = text(Tag::DateTimeOriginal)
        .or_else(|| text(Tag::DateTimeDigitized))
        .or_else(|| text(Tag::DateTime))
        .and_then(|t| exif_datetime(&t));
    let offset = text(Tag::OffsetTimeOriginal).or_else(|| text(Tag::OffsetTime));
    let width = uint(Tag::PixelXDimension).or_else(|| uint(Tag::ImageWidth));
    let height = uint(Tag::PixelYDimension).or_else(|| uint(Tag::ImageLength));
    let iso = uint(Tag::PhotographicSensitivity);

    let coordinate = |value: Tag, reference: Tag, negative: &str| {
        let v = field(value)?;
        let degrees = rational(v, 0)?
            + rational(v, 1).unwrap_or(0.0) / 60.0
            + rational(v, 2).unwrap_or(0.0) / 3600.0;
        let sign = match text(reference) {
            Some(r) if r.eq_ignore_ascii_case(negative) => -1.0,
            _ => 1.0,
        };
        Some(sign * degrees)
    };
    let mut latitude = coordinate(Tag::GPSLatitude, Tag::GPSLatitudeRef, "S");
    let mut longitude = coordinate(Tag::GPSLongitude, Tag::GPSLongitudeRef, "W");
    // Cameras without a fix often write 0/0 or zeros.
    if latitude
        .zip(longitude)
        .is_none_or(|(a, b)| a == 0.0 && b == 0.0)
        || latitude.is_some_and(|v| !(-90.0..=90.0).contains(&v))
        || longitude.is_some_and(|v| !(-180.0..=180.0).contains(&v))
    {
        latitude = None;
        longitude = None;
    }
    let altitude = latitude.and(field(Tag::GPSAltitude)).and_then(|v| {
        let below = match field(Tag::GPSAltitudeRef) {
            Some(Value::Undefined(v, _)) => v.first() == Some(&1),
            Some(other) => other.get_uint(0) == Some(1),
            None => false,
        };
        rational(v, 0).map(|a| if below { -a } else { a })
    });

    ImageDetails {
        taken,
        offset,
        make,
        model,
        lens: text(Tag::LensModel),
        width,
        height,
        exposure: real(Tag::ExposureTime),
        f_number: real(Tag::FNumber),
        iso,
        focal_length: real(Tag::FocalLength),
        focal_length_35mm: uint(Tag::FocalLengthIn35mmFilm),
        latitude,
        longitude,
        altitude,
    }
}

fn ascii(value: &Value) -> Option<String> {
    let Value::Ascii(parts) = value else {
        return None;
    };
    let raw = parts.first()?;
    let text = String::from_utf8_lossy(raw);
    let text = text.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    (!text.is_empty()).then(|| text.to_owned())
}

fn rational(value: &Value, index: usize) -> Option<f64> {
    let v = match value {
        Value::Rational(v) => v.get(index).filter(|r| r.denom != 0)?.to_f64(),
        Value::SRational(v) => v.get(index).filter(|r| r.denom != 0)?.to_f64(),
        other => f64::from(other.get_uint(index)?),
    };
    v.is_finite().then_some(v)
}

/// `2026:10:25 18:22:11` → `2026-10-25T18:22:11`. Blank dates
/// (`0000:00:00 00:00:00`) give `None`.
fn exif_datetime(text: &str) -> Option<String> {
    let b = text.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<u32> {
        std::str::from_utf8(&b[r]).ok()?.parse().ok()
    };
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
    if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIXEL: &[u8] = include_bytes!("../../tests/fixtures/exif/pixel.jpg");

    #[test]
    fn reads_camera_details_from_jpeg() {
        let d = parse(PIXEL).expect("fixture has EXIF");
        assert_eq!(d.taken.as_deref(), Some("2026-10-25T18:22:11"));
        assert_eq!(d.offset.as_deref(), Some("+03:00"));
        assert_eq!(d.make.as_deref(), Some("Google"));
        assert_eq!(d.model.as_deref(), Some("Pixel 8 Pro"));
        assert_eq!(
            d.lens.as_deref(),
            Some("Pixel 8 Pro back camera 6.9mm f/1.68")
        );
        assert_eq!((d.width, d.height), (Some(4080), Some(3072)));
        assert_eq!(d.exposure, Some(1.0 / 120.0));
        assert_eq!(d.f_number, Some(1.68));
        assert_eq!(d.iso, Some(100));
        assert_eq!(d.focal_length, Some(6.9));
        assert_eq!(d.focal_length_35mm, Some(24));
        let lat = d.latitude.unwrap();
        let lon = d.longitude.unwrap();
        assert!((lat - 55.755_833).abs() < 1e-5, "{lat}");
        assert!((lon - 37.62).abs() < 1e-5, "{lon}");
        assert_eq!(d.altitude, Some(156.0));
    }

    #[test]
    fn survives_a_truncated_head() {
        // The preview only downloads a prefix: EXIF before the cut is
        // enough, anything shorter is simply "no details".
        let app1_end = PIXEL.len() - 300;
        assert!(parse(&PIXEL[..app1_end]).is_some());
        assert_eq!(parse(&PIXEL[..40]), None);
        assert_eq!(parse(b"not an image at all"), None);
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn jpeg_without_exif_has_no_details() {
        // SOI, a JFIF APP0 and EOI.
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        jpeg.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(parse(&jpeg), None);
    }

    #[test]
    fn converts_exif_dates() {
        assert_eq!(
            exif_datetime("2026:10:25 18:22:11").as_deref(),
            Some("2026-10-25T18:22:11")
        );
        assert_eq!(exif_datetime("0000:00:00 00:00:00"), None);
        assert_eq!(exif_datetime("    :  :     :  :  "), None);
        assert_eq!(exif_datetime("2026:10:25"), None);
    }
}
