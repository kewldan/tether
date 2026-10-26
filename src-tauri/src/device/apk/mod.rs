//! Reading APKs without aapt: Android binary XML (`AndroidManifest.xml`,
//! compiled `res/*.xml`), the resource table (`resources.arsc`), launcher
//! icon selection and local `.apk` / `.apks` / `.xapk` inspection.
//!
//! Formats follow AOSP `frameworks/base/libs/androidfw/include/androidfw/
//! ResourceTypes.h`. Every parser works on untrusted bytes: all reads are
//! bounds-checked and malformed input yields `None` / an error, never a
//! panic.

pub mod arsc;
pub mod axml;
pub mod file;
pub mod icon;
pub mod manifest;
pub mod signing;
pub mod vector;

mod strings;

/// Little-endian bounds-checked reads over a byte slice.
pub(crate) trait Le {
    fn u8_at(&self, at: usize) -> Option<u8>;
    fn u16_at(&self, at: usize) -> Option<u16>;
    fn u32_at(&self, at: usize) -> Option<u32>;
}

impl Le for [u8] {
    fn u8_at(&self, at: usize) -> Option<u8> {
        self.get(at).copied()
    }

    fn u16_at(&self, at: usize) -> Option<u16> {
        let b = self.get(at..at.checked_add(2)?)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32_at(&self, at: usize) -> Option<u32> {
        let b = self.get(at..at.checked_add(4)?)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// A `ResChunk_header`: type, header size and total size.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Chunk {
    pub kind: u16,
    pub header_size: usize,
    pub size: usize,
}

impl Chunk {
    pub fn read(data: &[u8], at: usize) -> Option<Self> {
        let kind = data.u16_at(at)?;
        let header_size = data.u16_at(at + 2)? as usize;
        let size = data.u32_at(at + 4)? as usize;
        if size < 8 || header_size < 8 || header_size > size || at.checked_add(size)? > data.len() {
            return None;
        }
        Some(Self {
            kind,
            header_size,
            size,
        })
    }
}

/// Iterates the chunks laid out back to back in `data[start..end]`.
pub(crate) fn chunks(
    data: &[u8],
    start: usize,
    end: usize,
) -> impl Iterator<Item = (usize, Chunk)> {
    let end = end.min(data.len());
    let mut at = start;
    std::iter::from_fn(move || {
        if at + 8 > end {
            return None;
        }
        let chunk = Chunk::read(data, at)?;
        let here = at;
        at += chunk.size;
        Some((here, chunk))
    })
}

/// `Res_value` data types used by manifests and resource tables.
pub mod value_type {
    pub const NULL: u8 = 0x00;
    pub const REFERENCE: u8 = 0x01;
    pub const ATTRIBUTE: u8 = 0x02;
    pub const STRING: u8 = 0x03;
    pub const FLOAT: u8 = 0x04;
    pub const DYNAMIC_REFERENCE: u8 = 0x07;
    pub const INT_DEC: u8 = 0x10;
    pub const INT_HEX: u8 = 0x11;
    pub const INT_BOOLEAN: u8 = 0x12;
    pub const INT_COLOR_ARGB8: u8 = 0x1c;
    pub const INT_COLOR_RGB8: u8 = 0x1d;
    pub const INT_COLOR_ARGB4: u8 = 0x1e;
    pub const INT_COLOR_RGB4: u8 = 0x1f;
}

/// A typed value from a manifest attribute or a resource entry.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    String(String),
    /// `@pkg:type/name` as a resource id.
    Reference(u32),
    /// `?attr` theme attribute reference.
    Attribute(u32),
    Int(u32),
    Bool(bool),
    Float(f32),
    /// Color as `0xAARRGGBB`.
    Color(u32),
    Other {
        kind: u8,
        data: u32,
    },
}

impl Value {
    /// Builds a value from a `Res_value`; `string` resolves pool indices.
    pub(crate) fn from_raw(
        kind: u8,
        data: u32,
        string: impl FnOnce(u32) -> Option<String>,
    ) -> Self {
        use value_type as t;
        match kind {
            t::STRING => string(data).map_or(Self::Other { kind, data }, Self::String),
            t::REFERENCE | t::DYNAMIC_REFERENCE => Self::Reference(data),
            t::ATTRIBUTE => Self::Attribute(data),
            t::INT_DEC | t::INT_HEX => Self::Int(data),
            t::INT_BOOLEAN => Self::Bool(data != 0),
            t::FLOAT => Self::Float(f32::from_bits(data)),
            t::INT_COLOR_ARGB8 => Self::Color(data),
            t::INT_COLOR_RGB8 => Self::Color(0xff00_0000 | data),
            t::INT_COLOR_ARGB4 | t::INT_COLOR_RGB4 => Self::Color(expand_color4(data, kind)),
            _ => Self::Other { kind, data },
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<u32> {
        match self {
            Self::Int(v) => Some(*v),
            Self::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(v) => Some(*v),
            Self::Int(v) => Some(*v != 0),
            Self::String(s) => s.parse().ok(),
            _ => None,
        }
    }
}

/// `#ARGB` / `#RGB` stored as 4-bit channels in the low bits.
fn expand_color4(data: u32, kind: u8) -> u32 {
    let nib = |shift: u32| ((data >> shift) & 0xf) * 0x11;
    let a = if kind == value_type::INT_COLOR_RGB4 {
        0xff
    } else {
        nib(12)
    };
    (a << 24) | (nib(8) << 16) | (nib(4) << 8) | nib(0)
}

#[cfg(test)]
pub(crate) mod fixtures {
    /// `aapt2 compile --dir src/res` + `aapt2 link -I android.jar` of the
    /// sources in `tests/fixtures/apps/src` (`dev.tether.fixture`).
    pub const PLAIN_APK: &[u8] = include_bytes!("../../../tests/fixtures/apps/fixture-plain.apk");
    /// Same sources linked with `--enable-sparse-encoding --enable-compact-entries`.
    pub const SPARSE_APK: &[u8] = include_bytes!("../../../tests/fixtures/apps/fixture-sparse.apk");
    /// `aapt2 compile` + `link` of `tests/fixtures/apps/vector-src`: vector
    /// drawable launcher icons (gradient, clip path, inset, shape).
    pub const VECTOR_APK: &[u8] = include_bytes!("../../../tests/fixtures/apps/fixture-vector.apk");
    /// A compiled `ic_launcher_background.xml` (Android Studio template)
    /// from an app installed on an Android 16 emulator.
    pub const LAUNCHER_BACKGROUND: &[u8] =
        include_bytes!("../../../tests/fixtures/apps/ic-launcher-background.axml");
    /// AndroidManifest.xml of AOSP Camera2 pulled from an Android 16 emulator.
    pub const CAMERA2_MANIFEST: &[u8] =
        include_bytes!("../../../tests/fixtures/apps/camera2-manifest.axml");

    pub fn zip_entry(apk: &[u8], name: &str) -> Vec<u8> {
        use std::io::Read;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(apk)).unwrap();
        let mut entry = zip.by_name(name).unwrap();
        let mut out = Vec::new();
        entry.read_to_end(&mut out).unwrap();
        out
    }
}
