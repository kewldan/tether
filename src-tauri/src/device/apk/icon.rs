//! Launcher icon selection. Works in two steps so the same logic serves
//! local files and APKs on a device: [`plan`] names the files to read,
//! [`xml_icon`] turns an `<adaptive-icon>` into layer files/colors and
//! [`render_layer`] draws a layer (bitmaps as-is, vector drawables as SVG).

use serde::{Deserialize, Serialize};

use super::Value;
use super::arsc::{Config, DENSITY_ANY, DENSITY_DEFAULT, DENSITY_NONE, ResourceTable};
use super::axml::{self, Element};
use super::manifest::Manifest;
use super::vector::{self, Files, Rendered};

const ATTR_DRAWABLE: u32 = 0x0101_0199;
/// A drawable rarely nests deeper than inset → vector → gradient.
pub const MAX_RENDER_ROUNDS: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IconPlan {
    /// A PNG / WebP / JPEG inside the APK.
    Bitmap(String),
    /// A compiled XML inside the APK: `<adaptive-icon>` or a drawable.
    Adaptive(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Layer {
    Color(u32),
    /// A bitmap or a drawable XML (vector, inset, shape) in the APK.
    File(String),
    /// A drawable written inside `<foreground>` / `<background>`.
    Inline(Box<Element>),
}

/// What an icon XML holds: an `<adaptive-icon>`'s layers, or a drawable
/// (usually a `<vector>`) that is the whole icon.
#[derive(Debug, Clone, PartialEq)]
pub enum XmlIcon {
    Adaptive {
        background: Option<Layer>,
        foreground: Option<Layer>,
    },
    Drawable,
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
        if let Some(path) = best_xml(&files) {
            out.push(IconPlan::Adaptive(path));
        }
    }
    out.dedup();
    out
}

/// Classifies an icon XML and resolves an adaptive icon's layers.
pub fn xml_icon(table: &ResourceTable<'_>, xml: &[u8]) -> Option<XmlIcon> {
    let root = axml::parse(xml)?;
    if root.name != "adaptive-icon" {
        return Some(XmlIcon::Drawable);
    }
    let layer = |tag: &str| -> Option<Layer> {
        let el = root.child(tag)?;
        let Some(value) = el.attr(ATTR_DRAWABLE, "drawable") else {
            return Some(Layer::Inline(Box::new(el.children.first()?.clone())));
        };
        match value {
            Value::Color(c) => Some(Layer::Color(*c)),
            Value::Reference(id) if vector::framework_color(*id).is_some() => {
                vector::framework_color(*id).map(Layer::Color)
            }
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
                best_file(&files).map(Layer::File)
            }
            _ => None,
        }
    };
    Some(XmlIcon::Adaptive {
        background: layer("background"),
        foreground: layer("foreground"),
    })
}

/// A layer as the frontend draws it (CSS color or data URL), reading the
/// files it needs through `read`.
pub fn render_layer(
    table: &ResourceTable<'_>,
    layer: &Layer,
    mut read: impl FnMut(&str) -> Option<Vec<u8>>,
) -> Option<String> {
    let mut files = Files::new();
    for _ in 0..MAX_RENDER_ROUNDS {
        match render_step(table, layer, &files) {
            Rendered::Done(out) => return Some(out),
            Rendered::Unsupported => return None,
            Rendered::Need(paths) => {
                for p in paths {
                    let data = read(&p).filter(|d| !d.is_empty());
                    files.insert(p, data);
                }
            }
        }
    }
    None
}

/// One rendering pass over the files fetched so far.
pub fn render_step(table: &ResourceTable<'_>, layer: &Layer, files: &Files) -> Rendered {
    match layer {
        Layer::Color(c) => Rendered::Done(css_color(*c)),
        Layer::File(path) => vector::render(table, path, files),
        Layer::Inline(el) => vector::render_element(table, el, files),
    }
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

/// Anything that is not compiled XML. Shrunk APKs (R8 resource
/// obfuscation) drop extensions (`res/Qt`), so the bytes decide later.
fn is_bitmap(path: &str) -> bool {
    !path.to_ascii_lowercase().ends_with(".xml")
}

/// The sharpest bitmap, else the newest drawable XML.
pub(crate) fn best_file(files: &[(Config, String)]) -> Option<String> {
    best_bitmap(files).or_else(|| best_xml(files))
}

fn density_rank(density: u16) -> u16 {
    match density {
        DENSITY_DEFAULT | DENSITY_NONE | DENSITY_ANY => 160,
        d => d,
    }
}

/// The drawable XML for the newest platform version (`drawable-v24` over
/// `drawable`).
fn best_xml(files: &[(Config, String)]) -> Option<String> {
    files
        .iter()
        .filter(|(_, p)| p.ends_with(".xml"))
        .max_by_key(|(c, _)| c.sdk)
        .map(|(_, p)| p.clone())
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
        assert_eq!(
            xml_icon(&table, &xml),
            Some(XmlIcon::Adaptive {
                background: Some(Layer::Color(0xffe8_603c)),
                foreground: Some(Layer::File(
                    "res/mipmap-xxxhdpi-v4/ic_launcher_foreground.png".into()
                )),
            })
        );
        assert_eq!(css_color(0xffe8_603c), "#e8603cff");
    }

    #[test]
    fn renders_vector_adaptive_layers() {
        let apk = fixtures::VECTOR_APK;
        let arsc = fixtures::zip_entry(apk, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        let manifest = Manifest::parse(&fixtures::zip_entry(apk, "AndroidManifest.xml")).unwrap();
        assert_eq!(
            plan(&table, &manifest),
            [
                IconPlan::Adaptive("res/mipmap-anydpi-v26/ic_launcher.xml".into()),
                IconPlan::Adaptive("res/mipmap-anydpi-v26/ic_inset.xml".into()),
            ]
        );
        let xml = fixtures::zip_entry(apk, "res/mipmap-anydpi-v26/ic_launcher.xml");
        let Some(XmlIcon::Adaptive {
            background: Some(bg),
            foreground: Some(fg),
        }) = xml_icon(&table, &xml)
        else {
            panic!("no layers");
        };
        assert_eq!(
            fg,
            Layer::File("res/drawable/ic_launcher_foreground.xml".into())
        );
        let mut reads = Vec::new();
        let svg = render_layer(&table, &fg, |p| {
            reads.push(p.to_owned());
            Some(fixtures::zip_entry(apk, p))
        })
        .unwrap();
        assert!(svg.starts_with("data:image/svg+xml;base64,"));
        assert_eq!(
            reads,
            [
                "res/drawable/ic_launcher_foreground.xml",
                "res/drawable/$ic_launcher_foreground__0.xml",
            ]
        );
        let bg = render_layer(&table, &bg, |p| Some(fixtures::zip_entry(apk, p)));
        assert_eq!(bg.as_deref(), Some("#ffffffff"));
        // A vector used directly as the icon is a drawable, not adaptive.
        let glyph = fixtures::zip_entry(apk, "res/drawable/ic_glyph.xml");
        assert_eq!(xml_icon(&table, &glyph), Some(XmlIcon::Drawable));
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
