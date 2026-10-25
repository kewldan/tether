//! Launcher icon selection. Works in two steps so the same logic serves
//! local files and APKs on a device: [`plan`] names the files to read,
//! [`adaptive_layers`] turns an `<adaptive-icon>` into layer files/colors.

use serde::{Deserialize, Serialize};

use super::Value;
use super::arsc::{Config, DENSITY_ANY, DENSITY_DEFAULT, DENSITY_NONE, ResourceTable};
use super::axml;
use super::manifest::Manifest;

const ATTR_DRAWABLE: u32 = 0x0101_0199;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IconPlan {
    /// A PNG / WebP / JPEG inside the APK.
    Bitmap(String),
    /// A compiled `<adaptive-icon>` XML inside the APK.
    Adaptive(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Layer {
    Color(u32),
    Bitmap(String),
}

/// Icon as the frontend draws it: a single image, or an adaptive icon's
/// background (CSS color or image) and foreground image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AppIcon {
    Bitmap {
        src: String,
    },
    Adaptive {
        background: Option<String>,
        foreground: Option<String>,
    },
}

/// Candidate icon files, best first: the regular icon's largest bitmap, its
/// adaptive XML, then the same for `roundIcon`.
pub fn plan(table: &ResourceTable<'_>, manifest: &Manifest) -> Vec<IconPlan> {
    let mut out = Vec::new();
    for id in [manifest.icon, manifest.round_icon].into_iter().flatten() {
        let files = files(table, id, 0);
        if let Some(path) = best_bitmap(&files) {
            out.push(IconPlan::Bitmap(path));
        }
        if let Some((_, path)) = files.iter().find(|(_, p)| p.ends_with(".xml")) {
            out.push(IconPlan::Adaptive(path.clone()));
        }
    }
    out.dedup();
    out
}

/// Background and foreground of a compiled `<adaptive-icon>`; vector
/// drawables are not rendered and come back as `None`.
pub fn adaptive_layers(
    table: &ResourceTable<'_>,
    xml: &[u8],
) -> Option<(Option<Layer>, Option<Layer>)> {
    let root = axml::parse(xml)?;
    if root.name != "adaptive-icon" {
        return None;
    }
    let layer = |tag: &str| -> Option<Layer> {
        let value = root.child(tag)?.attr(ATTR_DRAWABLE, "drawable")?;
        match value {
            Value::Color(c) => Some(Layer::Color(*c)),
            Value::Reference(id) => {
                let resolved = resolve_all(table, *id, 0);
                if let Some(Value::Color(c)) = resolved
                    .iter()
                    .map(|(_, v)| v)
                    .find(|v| matches!(v, Value::Color(_)))
                {
                    return Some(Layer::Color(*c));
                }
                let files: Vec<_> = resolved
                    .into_iter()
                    .filter_map(|(c, v)| Some((c, v.as_str()?.to_owned())))
                    .collect();
                best_bitmap(&files).map(Layer::Bitmap)
            }
            _ => None,
        }
    };
    Some((layer("background"), layer("foreground")))
}

fn resolve_all(table: &ResourceTable<'_>, id: u32, depth: u8) -> Vec<(Config, Value)> {
    if depth > 4 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (config, value) in table.values(id) {
        match value {
            Value::Reference(next) if next != id => out.extend(resolve_all(table, next, depth + 1)),
            other => out.push((config, other)),
        }
    }
    out
}

fn files(table: &ResourceTable<'_>, id: u32, depth: u8) -> Vec<(Config, String)> {
    resolve_all(table, id, depth)
        .into_iter()
        .filter_map(|(c, v)| Some((c, v.as_str()?.to_owned())))
        .collect()
}

fn is_bitmap(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".png", ".webp", ".jpg", ".jpeg"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn density_rank(density: u16) -> u16 {
    match density {
        DENSITY_DEFAULT | DENSITY_NONE | DENSITY_ANY => 160,
        d => d,
    }
}

fn best_bitmap(files: &[(Config, String)]) -> Option<String> {
    files
        .iter()
        .filter(|(_, p)| is_bitmap(p))
        .max_by_key(|(c, _)| density_rank(c.density))
        .map(|(_, p)| p.clone())
}

pub fn mime_for(path: &str, data: &[u8]) -> &'static str {
    if data.starts_with(b"\x89PNG") {
        "image/png"
    } else if data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else if data.starts_with(&[0xff, 0xd8]) {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    }
}

pub fn data_url(path: &str, data: &[u8]) -> String {
    format!("data:{};base64,{}", mime_for(path, data), base64(data))
}

/// `#RRGGBBAA` for CSS from Android's `0xAARRGGBB`.
pub fn css_color(argb: u32) -> String {
    format!("#{:06x}{:02x}", argb & 0x00ff_ffff, argb >> 24)
}

pub fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::*;

    #[test]
    fn plans_bitmap_then_adaptive_round_icon() {
        let arsc = fixtures::zip_entry(fixtures::PLAIN_APK, "resources.arsc");
        let xml = fixtures::zip_entry(fixtures::PLAIN_APK, "AndroidManifest.xml");
        let table = ResourceTable::parse(&arsc).unwrap();
        let manifest = Manifest::parse(&xml).unwrap();
        assert_eq!(
            plan(&table, &manifest),
            [
                IconPlan::Bitmap("res/mipmap-xxxhdpi-v4/ic_launcher.png".into()),
                IconPlan::Adaptive("res/mipmap-anydpi-v26/ic_round.xml".into()),
            ]
        );
    }

    #[test]
    fn resolves_adaptive_icon_layers() {
        let arsc = fixtures::zip_entry(fixtures::PLAIN_APK, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        let xml = fixtures::zip_entry(fixtures::PLAIN_APK, "res/mipmap-anydpi-v26/ic_round.xml");
        let (bg, fg) = adaptive_layers(&table, &xml).unwrap();
        assert_eq!(bg, Some(Layer::Color(0xffe8_603c)));
        assert_eq!(
            fg,
            Some(Layer::Bitmap(
                "res/mipmap-xxxhdpi-v4/ic_launcher_foreground.png".into()
            ))
        );
        assert_eq!(css_color(0xffe8_603c), "#e8603cff");
    }

    #[test]
    fn encodes_base64_with_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn sniffs_image_types() {
        assert_eq!(mime_for("a.png", b"\x89PNG...."), "image/png");
        assert_eq!(mime_for("a", b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
    }
}
