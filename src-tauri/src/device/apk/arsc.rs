//! `resources.arsc` (`RES_TABLE_TYPE`, 0x0002): just enough to resolve a
//! resource id to its per-configuration values (app label, icon paths).

use super::strings::{CHUNK_STRING_POOL, StringPool};
use super::{Chunk, Le, Value, chunks};

const CHUNK_TABLE: u16 = 0x0002;
const CHUNK_PACKAGE: u16 = 0x0200;
const CHUNK_TYPE: u16 = 0x0201;

const FLAG_SPARSE: u8 = 0x01;
const FLAG_OFFSET16: u8 = 0x02;
const ENTRY_FLAG_COMPLEX: u16 = 0x0001;
const ENTRY_FLAG_COMPACT: u16 = 0x0008;

/// Density buckets in `ResTable_config::density`.
pub const DENSITY_DEFAULT: u16 = 0;
pub const DENSITY_ANY: u16 = 0xfffe;
pub const DENSITY_NONE: u16 = 0xffff;

/// The configuration qualifiers we care about.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Config {
    /// ISO 639 language, empty for the default configuration.
    pub language: String,
    /// ISO 3166 region, empty when unspecified.
    pub country: String,
    pub density: u16,
    pub sdk: u16,
}

#[derive(Debug, Clone, Copy)]
struct TypeChunk<'a> {
    id: u8,
    flags: u8,
    entry_count: usize,
    entries_at: usize,
    offsets_at: usize,
    chunk: &'a [u8],
}

#[derive(Debug)]
struct Package<'a> {
    id: u8,
    types: Vec<(TypeChunk<'a>, Config)>,
}

#[derive(Debug)]
pub struct ResourceTable<'a> {
    strings: StringPool<'a>,
    packages: Vec<Package<'a>>,
}

impl<'a> ResourceTable<'a> {
    pub fn parse(data: &'a [u8]) -> Option<Self> {
        let header = Chunk::read(data, 0)?;
        if header.kind != CHUNK_TABLE {
            return None;
        }
        let mut strings = StringPool::empty();
        let mut packages = Vec::new();
        for (at, chunk) in chunks(data, header.header_size, header.size) {
            match chunk.kind {
                CHUNK_STRING_POOL => strings = StringPool::parse(data, at)?,
                CHUNK_PACKAGE => {
                    if let Some(package) = parse_package(data, at, chunk) {
                        packages.push(package);
                    }
                }
                _ => {}
            }
        }
        Some(Self { strings, packages })
    }

    /// Every configuration's value for `id`. Complex (bag) entries are
    /// skipped; they never hold labels or file paths.
    pub fn values(&self, id: u32) -> Vec<(Config, Value)> {
        let package_id = (id >> 24) as u8;
        let type_id = ((id >> 16) & 0xff) as u8;
        let entry = (id & 0xffff) as usize;
        let Some(package) = self
            .packages
            .iter()
            .find(|p| p.id == package_id)
            .or_else(|| {
                self.packages
                    .iter()
                    .find(|p| p.id == 0 && package_id == 0x7f)
            })
        else {
            return Vec::new();
        };
        package
            .types
            .iter()
            .filter(|(t, _)| t.id == type_id)
            .filter_map(|(t, config)| Some((config.clone(), self.entry_value(t, entry)?)))
            .collect()
    }

    /// Follows references until a non-reference value, preferring `locale`
    /// (`en-US`, `ru`) and then the default configuration.
    pub fn resolve_string(&self, id: u32, locale: &str) -> Option<String> {
        let mut id = id;
        for _ in 0..8 {
            let values = self.values(id);
            match pick_locale(&values, locale)? {
                Value::String(s) => return Some(s.clone()),
                Value::Reference(next) => id = *next,
                _ => return None,
            }
        }
        None
    }

    fn entry_value(&self, t: &TypeChunk<'_>, entry: usize) -> Option<Value> {
        if entry >= t.entry_count && t.flags & FLAG_SPARSE == 0 {
            return None;
        }
        let c = t.chunk;
        let offset = if t.flags & FLAG_SPARSE != 0 {
            // ResTable_sparseTypeEntry { idx: u16, offset: u16 (/4) }, sorted.
            let (mut lo, mut hi) = (0usize, t.entry_count);
            let mut found = None;
            while lo < hi {
                let mid = (lo + hi) / 2;
                let idx = c.u16_at(t.offsets_at + mid * 4)? as usize;
                match idx.cmp(&entry) {
                    std::cmp::Ordering::Less => lo = mid + 1,
                    std::cmp::Ordering::Greater => hi = mid,
                    std::cmp::Ordering::Equal => {
                        found = Some(c.u16_at(t.offsets_at + mid * 4 + 2)? as usize * 4);
                        break;
                    }
                }
            }
            found?
        } else if t.flags & FLAG_OFFSET16 != 0 {
            let raw = c.u16_at(t.offsets_at + entry * 2)?;
            if raw == u16::MAX {
                return None;
            }
            raw as usize * 4
        } else {
            let raw = c.u32_at(t.offsets_at + entry * 4)?;
            if raw == u32::MAX {
                return None;
            }
            raw as usize
        };

        let at = t.entries_at.checked_add(offset)?;
        let flags = c.u16_at(at + 2)?;
        let string = |i| self.strings.get(i);
        if flags & ENTRY_FLAG_COMPACT != 0 {
            // Compact entry: { key: u16, flags: u16 (type in high byte), data: u32 }.
            let kind = (flags >> 8) as u8;
            return Some(Value::from_raw(kind, c.u32_at(at + 4)?, string));
        }
        if flags & ENTRY_FLAG_COMPLEX != 0 {
            return None;
        }
        let size = c.u16_at(at)? as usize;
        let value = at + size;
        let kind = c.u8_at(value + 3)?;
        Some(Value::from_raw(kind, c.u32_at(value + 4)?, string))
    }
}

fn parse_package<'a>(data: &'a [u8], at: usize, chunk: Chunk) -> Option<Package<'a>> {
    let id = data.u32_at(at + 8)? as u8;
    let mut types = Vec::new();
    for (t_at, t) in chunks(data, at + chunk.header_size, at + chunk.size) {
        if t.kind != CHUNK_TYPE {
            continue;
        }
        let c = &data[t_at..t_at + t.size];
        let type_chunk = TypeChunk {
            id: c.u8_at(8)?,
            flags: c.u8_at(9)?,
            entry_count: c.u32_at(12)? as usize,
            entries_at: c.u32_at(16)? as usize,
            offsets_at: t.header_size,
            chunk: c,
        };
        types.push((type_chunk, parse_config(c, 20)));
    }
    Some(Package { id, types })
}

fn parse_config(c: &[u8], at: usize) -> Config {
    let size = c.u32_at(at).unwrap_or(0) as usize;
    let field = |off: usize, len: usize| {
        (off + len <= size)
            .then(|| c.get(at + off..at + off + len))
            .flatten()
    };
    let language = field(8, 2).map(unpack_language).unwrap_or_default();
    let country = field(10, 2).map(unpack_language).unwrap_or_default();
    let density = field(14, 2).map_or(0, |b| u16::from_le_bytes([b[0], b[1]]));
    let sdk = field(24, 2).map_or(0, |b| u16::from_le_bytes([b[0], b[1]]));
    Config {
        language,
        country,
        density,
        sdk,
    }
}

/// Two ASCII letters, or three letters packed into 15 bits when the high
/// bit of the first byte is set.
fn unpack_language(b: &[u8]) -> String {
    if b[0] == 0 {
        return String::new();
    }
    if b[0] & 0x80 != 0 {
        let first = b[1] & 0x1f;
        let second = ((b[1] & 0xe0) >> 5) | ((b[0] & 0x03) << 3);
        let third = (b[0] & 0x7c) >> 2;
        return [first, second, third]
            .iter()
            .map(|c| (b'a' + c) as char)
            .collect();
    }
    b.iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as char)
        .collect()
}

/// Locale-aware choice among configuration values, the way Android picks:
/// exact `lang-REGION`, then the language alone, then the default
/// configuration, then the language in another region, then anything.
/// Pseudo-locales (`en-XA`, `ar-XB`) are never picked unless asked for.
pub fn pick_locale<'v>(values: &'v [(Config, Value)], locale: &str) -> Option<&'v Value> {
    let (lang, region) = locale
        .split_once(['-', '_'])
        .map_or((locale, ""), |(l, r)| (l, r.trim_start_matches('r')));
    let pseudo = |c: &Config| {
        let r = c.country.to_ascii_uppercase();
        (r == "XA" || r == "XB") && !r.eq_ignore_ascii_case(region)
    };
    let find = |pred: &dyn Fn(&Config) -> bool| {
        values
            .iter()
            .find(|(c, _)| !pseudo(c) && pred(c))
            .map(|(_, v)| v)
    };
    find(&|c| !lang.is_empty() && c.language == lang && c.country.eq_ignore_ascii_case(region))
        .or_else(|| find(&|c| !lang.is_empty() && c.language == lang && c.country.is_empty()))
        .or_else(|| find(&|c| c.language.is_empty()))
        .or_else(|| find(&|c| !lang.is_empty() && c.language == lang))
        .or_else(|| find(&|_| true))
        .or_else(|| values.first().map(|(_, v)| v))
}

#[cfg(test)]
mod tests {
    use super::super::{axml, fixtures};
    use super::*;

    fn label_id(apk: &[u8]) -> u32 {
        let xml = fixtures::zip_entry(apk, "AndroidManifest.xml");
        let root = axml::parse(&xml).unwrap();
        match root
            .child("application")
            .unwrap()
            .attr(0x0101_0001, "label")
        {
            Some(Value::Reference(id)) => *id,
            other => panic!("unexpected label {other:?}"),
        }
    }

    #[test]
    fn resolves_localized_label_from_plain_and_sparse_tables() {
        for apk in [fixtures::PLAIN_APK, fixtures::SPARSE_APK] {
            let arsc = fixtures::zip_entry(apk, "resources.arsc");
            let table = ResourceTable::parse(&arsc).unwrap();
            let id = label_id(apk);
            assert_eq!(
                table.resolve_string(id, "en-US").as_deref(),
                Some("Example Shop")
            );
            assert_eq!(
                table.resolve_string(id, "ru-RU").as_deref(),
                Some("Пример магазина")
            );
            assert_eq!(
                table.resolve_string(id, "").as_deref(),
                Some("Example Shop")
            );
        }
    }

    #[test]
    fn lists_icon_files_per_density() {
        let arsc = fixtures::zip_entry(fixtures::PLAIN_APK, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        let xml = fixtures::zip_entry(fixtures::PLAIN_APK, "AndroidManifest.xml");
        let root = axml::parse(&xml).unwrap();
        let Some(Value::Reference(icon)) =
            root.child("application").unwrap().attr(0x0101_0002, "icon")
        else {
            panic!("no icon");
        };
        let mut values = table.values(*icon);
        values.sort_by_key(|(c, _)| c.density);
        let paths: Vec<_> = values
            .iter()
            .map(|(c, v)| (c.density, v.as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(
            paths,
            vec![
                (160, "res/mipmap-mdpi-v4/ic_launcher.png".to_owned()),
                (640, "res/mipmap-xxxhdpi-v4/ic_launcher.png".to_owned()),
            ]
        );
    }

    #[test]
    fn unknown_ids_and_garbage_are_harmless() {
        let arsc = fixtures::zip_entry(fixtures::PLAIN_APK, "resources.arsc");
        let table = ResourceTable::parse(&arsc).unwrap();
        assert!(table.values(0x7f7f_7f7f).is_empty());
        assert!(table.values(0x0101_0001).is_empty());
        assert!(ResourceTable::parse(b"not a table").is_none());
    }

    #[test]
    fn skips_pseudo_locales_and_prefers_default() {
        let cfg = |language: &str, country: &str| Config {
            language: language.into(),
            country: country.into(),
            ..Config::default()
        };
        let s = |v: &str| Value::String(v.into());
        let values = vec![
            (cfg("en", "XA"), s("[Ŝéţţîñĝš one two]")),
            (cfg("ar", "XB"), s("sgnitteS")),
            (cfg("", ""), s("Settings")),
            (cfg("en", "GB"), s("Settings (UK)")),
            (cfg("ru", ""), s("Настройки")),
        ];
        let pick = |l: &str| match pick_locale(&values, l) {
            Some(Value::String(v)) => v.clone(),
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(pick("en-US"), "Settings");
        assert_eq!(pick("en-GB"), "Settings (UK)");
        assert_eq!(pick("ru-RU"), "Настройки");
        assert_eq!(pick("en-XA"), "[Ŝéţţîñĝš one two]");
    }

    #[test]
    fn unpacks_three_letter_languages() {
        // "fil" packed per ResTable_config::packLanguage.
        let (f, i, l) = (b'f' - b'a', b'i' - b'a', b'l' - b'a');
        let b0 = 0x80 | (l << 2) | (i >> 3);
        let b1 = ((i & 0x07) << 5) | f;
        assert_eq!(unpack_language(&[b0, b1]), "fil");
        assert_eq!(unpack_language(b"en"), "en");
    }
}
