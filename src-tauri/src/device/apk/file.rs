//! Local package files: a single `.apk`, or a bundle (`.apks` from
//! bundletool, `.xapk`, `.apkm` without encryption) that is a zip of APKs.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use zip::ZipArchive;

use super::Value;
use super::arsc::ResourceTable;
use super::icon::{self, AppIcon, IconPlan, Layer, XmlIcon};
use super::manifest::Manifest;
use crate::error::{AppError, AppResult};

/// Upper bound for zip entries we read into memory (manifest, resources).
const MAX_ENTRY: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageFormat {
    Apk,
    /// A zip of APKs (`.apks`, `.xapk`, `.apkm`).
    Bundle,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signing {
    pub v1: bool,
    pub v2: bool,
    pub v3: bool,
    pub v31: bool,
}

/// One APK to write into an install session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApkPart {
    /// Zip entry inside a bundle; `None` for a plain `.apk` file.
    pub entry: Option<String>,
    /// Split name from the manifest; `None` for the base APK.
    pub split: Option<String>,
    pub size: u64,
}

/// An extra file shipped in an `.xapk` (`Android/obb/<pkg>/main.N.pkg.obb`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObbPart {
    pub entry: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFile {
    pub path: String,
    pub file_name: String,
    pub file_size: u64,
    pub format: PackageFormat,
    pub package: String,
    pub label: Option<String>,
    pub icon: Option<AppIcon>,
    pub version_name: Option<String>,
    pub version_code: u64,
    pub min_sdk: Option<u32>,
    pub target_sdk: Option<u32>,
    pub debuggable: bool,
    pub test_only: bool,
    pub signing: Signing,
    pub parts: Vec<ApkPart>,
    pub obbs: Vec<ObbPart>,
}

/// Reads identity, label, icon and signing info of a local package file.
pub fn inspect(path: &Path, locale: &str) -> AppResult<PackageFile> {
    let file = File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut zip = ZipArchive::new(file).map_err(|e| invalid(path, e))?;

    let is_bundle = zip.index_for_name("AndroidManifest.xml").is_none();
    let (format, info, parts, obbs) = if is_bundle {
        let (parts, obbs) = bundle_parts(&mut zip, path)?;
        let base = parts
            .iter()
            .find(|p| p.split.is_none())
            .and_then(|p| p.entry.clone())
            .ok_or_else(|| AppError::InvalidInput("the bundle has no base APK".into()))?;
        let mut inner = open_inner(&mut zip, path, &base)?;
        let mut info = read_apk(&mut inner, locale)?;
        apply_signing_block(&mut info.signing, &mut inner.into_inner());
        (PackageFormat::Bundle, info, parts, obbs)
    } else {
        let mut info = read_apk(&mut zip, locale)?;
        apply_signing_block(&mut info.signing, &mut File::open(path)?);
        let part = ApkPart {
            entry: None,
            split: info.manifest.split.clone(),
            size: file_size,
        };
        (PackageFormat::Apk, info, vec![part], Vec::new())
    };

    let m = info.manifest;
    Ok(PackageFile {
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        file_size,
        format,
        package: m.package,
        label: info.label,
        icon: info.icon,
        version_name: m.version_name,
        version_code: m.version_code,
        min_sdk: m.min_sdk,
        target_sdk: m.target_sdk,
        debuggable: m.debuggable,
        test_only: m.test_only,
        signing: info.signing,
        parts,
        obbs,
    })
}

fn invalid(path: &Path, e: impl std::fmt::Display) -> AppError {
    AppError::InvalidInput(format!(
        "{} is not an APK or APK bundle: {e}",
        path.display()
    ))
}

struct ApkInfo {
    manifest: Manifest,
    label: Option<String>,
    icon: Option<AppIcon>,
    signing: Signing,
}

fn read_apk<R: Read + Seek>(zip: &mut ZipArchive<R>, locale: &str) -> AppResult<ApkInfo> {
    let xml = read_entry(zip, "AndroidManifest.xml")?
        .ok_or_else(|| AppError::InvalidInput("AndroidManifest.xml is missing".into()))?;
    let manifest = Manifest::parse(&xml)
        .ok_or_else(|| AppError::InvalidInput("AndroidManifest.xml is not valid".into()))?;
    let arsc = read_entry(zip, "resources.arsc")?;
    let table = arsc.as_deref().and_then(ResourceTable::parse);

    let label = match (&manifest.label, &table) {
        (Some(Value::String(s)), _) => Some(s.clone()),
        (Some(Value::Reference(id)), Some(t)) => t.resolve_string(*id, locale),
        _ => None,
    };
    let icon = table
        .as_ref()
        .and_then(|t| load_icon(t, &manifest, |name| read_entry(zip, name).ok().flatten()));
    let signing = Signing {
        v1: entry_names(zip).iter().any(|n| is_v1_signature(n)),
        ..Signing::default()
    };
    Ok(ApkInfo {
        manifest,
        label,
        icon,
        signing,
    })
}

/// Reads the first usable icon from [`icon::plan`], fetching files lazily.
pub fn load_icon(
    table: &ResourceTable<'_>,
    manifest: &Manifest,
    mut read: impl FnMut(&str) -> Option<Vec<u8>>,
) -> Option<AppIcon> {
    for candidate in icon::plan(table, manifest) {
        match candidate {
            IconPlan::Bitmap(path) => {
                if let Some(data) = read(&path).filter(|d| !d.is_empty()) {
                    return Some(AppIcon::Bitmap {
                        src: icon::data_url(&path, &data),
                    });
                }
            }
            IconPlan::Adaptive(path) => {
                let Some(xml) = read(&path) else { continue };
                match icon::xml_icon(table, &xml) {
                    Some(XmlIcon::Adaptive {
                        background,
                        foreground: Some(fg),
                    }) => {
                        let Some(foreground) = icon::render_layer(table, &fg, &mut read) else {
                            continue;
                        };
                        let background =
                            background.and_then(|bg| icon::render_layer(table, &bg, &mut read));
                        return Some(AppIcon::Adaptive {
                            background,
                            foreground: Some(foreground),
                        });
                    }
                    Some(XmlIcon::Drawable) => {
                        let layer = Layer::File(path);
                        if let Some(src) = icon::render_layer(table, &layer, &mut read)
                            .filter(|s| s.starts_with("data:"))
                        {
                            return Some(AppIcon::Bitmap { src });
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    None
}

fn read_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> AppResult<Option<Vec<u8>>> {
    let mut entry = match zip.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(AppError::InvalidInput(format!("{name}: {e}"))),
    };
    if entry.size() > MAX_ENTRY {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut out)?;
    Ok(Some(out))
}

fn entry_names<R: Read + Seek>(zip: &ZipArchive<R>) -> Vec<String> {
    zip.file_names()
        .filter_map(Result::ok)
        .map(std::borrow::Cow::into_owned)
        .collect()
}

fn is_v1_signature(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("META-INF/")
        && [".RSA", ".DSA", ".EC"]
            .iter()
            .any(|ext| upper.ends_with(ext))
}

/// Lists the APKs (and OBBs) of a bundle. bundletool `.apks` keep splits
/// under `splits/` and pre-L fallbacks under `standalones/`; the latter are
/// only used when nothing else exists.
fn bundle_parts<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    path: &Path,
) -> AppResult<(Vec<ApkPart>, Vec<ObbPart>)> {
    let names = entry_names(zip);
    let apks: Vec<&String> = names
        .iter()
        .filter(|n| n.to_ascii_lowercase().ends_with(".apk"))
        .collect();
    let preferred: Vec<&String> = if apks.iter().any(|n| n.starts_with("splits/")) {
        apks.iter()
            .copied()
            .filter(|n| n.starts_with("splits/"))
            .collect()
    } else {
        let regular: Vec<_> = apks
            .iter()
            .copied()
            .filter(|n| !n.starts_with("standalones/"))
            .collect();
        if regular.is_empty() {
            apks.clone()
        } else {
            regular
        }
    };

    let mut parts = Vec::new();
    for name in preferred {
        let size = zip
            .by_name(name)
            .map_err(|e| AppError::InvalidInput(e.to_string()))?
            .size();
        let mut inner = open_inner(zip, path, name)?;
        let xml = read_entry(&mut inner, "AndroidManifest.xml")?.unwrap_or_default();
        let Some(manifest) = Manifest::parse(&xml) else {
            continue;
        };
        parts.push(ApkPart {
            entry: Some(name.clone()),
            split: manifest.split,
            size,
        });
    }
    if parts.is_empty() {
        return Err(AppError::InvalidInput("the bundle contains no APKs".into()));
    }
    // Base first, then splits by name, for a stable install order.
    parts.sort_by(|a, b| (a.split.is_some(), &a.split).cmp(&(b.split.is_some(), &b.split)));

    let mut obbs = Vec::new();
    for name in &names {
        if name.to_ascii_lowercase().ends_with(".obb") && name.starts_with("Android/obb/") {
            let size = zip
                .by_name(name)
                .map_err(|e| AppError::InvalidInput(e.to_string()))?
                .size();
            obbs.push(ObbPart {
                entry: name.clone(),
                size,
            });
        }
    }
    Ok((parts, obbs))
}

pub(crate) trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}

/// A window `[start, start + len)` of a file, e.g. a stored zip entry.
struct SubFile<R> {
    inner: R,
    start: u64,
    len: u64,
    pos: u64,
}

impl<R: Read + Seek> Read for SubFile<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.len.saturating_sub(self.pos);
        if left == 0 {
            return Ok(0);
        }
        let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        self.inner.seek(SeekFrom::Start(self.start + self.pos))?;
        let n = self.inner.read(&mut buf[..want])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl<R: Read + Seek> Seek for SubFile<R> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(p) => Some(p),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        let target = target
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek out of range"))?;
        self.pos = target;
        Ok(target)
    }
}

/// Raw access to one zip entry: stored entries are read in place from a
/// fresh handle of the same file, compressed ones are inflated into memory.
fn entry_reader<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    reopen: impl FnOnce() -> io::Result<File>,
    name: &str,
) -> AppResult<Box<dyn ReadSeek>> {
    let mut entry = zip
        .by_name(name)
        .map_err(|e| AppError::InvalidInput(format!("{name}: {e}")))?;
    if let (zip::CompressionMethod::Stored, Some(start)) = (entry.compression(), entry.data_start())
    {
        let len = entry.size();
        return Ok(Box::new(SubFile {
            inner: reopen()?,
            start,
            len,
            pos: 0,
        }));
    }
    if entry.size() > 4 * MAX_ENTRY {
        return Err(AppError::InvalidInput(format!(
            "{name} is too large to unpack"
        )));
    }
    let mut data = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut data)?;
    Ok(Box::new(io::Cursor::new(data)))
}

/// Opens an APK stored inside a bundle as its own zip.
fn open_inner<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    path: &Path,
    name: &str,
) -> AppResult<ZipArchive<Box<dyn ReadSeek>>> {
    let reader = entry_reader(zip, || File::open(path), name)?;
    ZipArchive::new(reader).map_err(|e| AppError::InvalidInput(format!("{name}: {e}")))
}

/// Detects APK Signature Scheme v2/v3/v3.1 blocks: the "APK Sig Block 42"
/// block sits right before the zip central directory.
fn apply_signing_block<R: Read + Seek>(signing: &mut Signing, apk: &mut R) {
    if let Some(ids) = signing_block_ids(apk) {
        signing.v2 = ids.contains(&0x7109_871a);
        signing.v3 = ids.contains(&0xf053_68c0);
        signing.v31 = ids.contains(&0x1b93_ad61);
    }
}

fn signing_block_ids<R: Read + Seek>(file: &mut R) -> Option<Vec<u32>> {
    let len = file.seek(SeekFrom::End(0)).ok()?;
    let tail_len = len.min(65_557 + 22);
    file.seek(SeekFrom::Start(len - tail_len)).ok()?;
    let mut tail = vec![0u8; tail_len as usize];
    file.read_exact(&mut tail).ok()?;
    let eocd = (0..=tail.len().checked_sub(22)?)
        .rev()
        .find(|&i| tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])?;
    let cd_offset = u64::from(u32::from_le_bytes(
        tail[eocd + 16..eocd + 20].try_into().ok()?,
    ));
    if cd_offset < 32 {
        return None;
    }
    let mut footer = [0u8; 24];
    file.seek(SeekFrom::Start(cd_offset - 24)).ok()?;
    file.read_exact(&mut footer).ok()?;
    if &footer[8..] != b"APK Sig Block 42" {
        return None;
    }
    let size = u64::from_le_bytes(footer[..8].try_into().ok()?);
    let start = cd_offset.checked_sub(size + 8)?;
    if size > 64 * 1024 * 1024 {
        return None;
    }
    let mut block = vec![0u8; size as usize];
    file.seek(SeekFrom::Start(start + 8)).ok()?;
    file.read_exact(&mut block).ok()?;
    // Pairs: u64 length, u32 id, value; the last 24 bytes are the footer.
    let mut ids = Vec::new();
    let mut at = 0usize;
    let end = block.len().saturating_sub(24);
    while at + 12 <= end {
        let pair_len = u64::from_le_bytes(block[at..at + 8].try_into().ok()?) as usize;
        if pair_len < 4 || at + 8 + pair_len > end {
            break;
        }
        ids.push(u32::from_le_bytes(block[at + 8..at + 12].try_into().ok()?));
        at += 8 + pair_len;
    }
    Some(ids)
}

/// Streams one part of a package file (the file itself or a bundle entry).
pub fn open_part(path: &Path, entry: Option<&str>) -> AppResult<Box<dyn Read + Send>> {
    let file = File::open(path)?;
    match entry {
        None => Ok(Box::new(file)),
        Some(name) => {
            let mut zip =
                ZipArchive::new(file).map_err(|e| AppError::InvalidInput(e.to_string()))?;
            Ok(Box::new(entry_reader(&mut zip, || File::open(path), name)?))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::super::fixtures;
    use super::*;

    fn write_temp(dir: &tempfile::TempDir, name: &str, data: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, data).unwrap();
        path
    }

    #[test]
    fn inspects_a_single_apk() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "shop.apk", fixtures::PLAIN_APK);
        let info = inspect(&path, "en-US").unwrap();
        assert_eq!(info.format, PackageFormat::Apk);
        assert_eq!(info.package, "dev.tether.fixture");
        assert_eq!(info.label.as_deref(), Some("Example Shop"));
        assert_eq!(info.version_code, 2150);
        assert!(info.test_only);
        // aapt2 output is unsigned.
        assert_eq!(info.signing, Signing::default());
        assert!(
            matches!(&info.icon, Some(AppIcon::Bitmap { src }) if src.starts_with("data:image/png;base64,"))
        );
        assert_eq!(info.parts.len(), 1);
        assert_eq!(info.file_name, "shop.apk");

        let ru = inspect(&path, "ru").unwrap();
        assert_eq!(ru.label.as_deref(), Some("Пример магазина"));
    }

    #[test]
    fn inspects_a_bundle_and_streams_its_parts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shop.apks");
        {
            let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
            let stored = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("toc.pb", stored).unwrap();
            zip.write_all(b"\x0a\x00").unwrap();
            zip.start_file("splits/base-master.apk", stored).unwrap();
            zip.write_all(fixtures::PLAIN_APK).unwrap();
            zip.start_file("standalones/standalone-x86.apk", stored)
                .unwrap();
            zip.write_all(fixtures::PLAIN_APK).unwrap();
            zip.start_file("Android/obb/dev.tether.fixture/main.1.obb", stored)
                .unwrap();
            zip.write_all(b"obb").unwrap();
            zip.finish().unwrap();
        }
        let info = inspect(&path, "en").unwrap();
        assert_eq!(info.format, PackageFormat::Bundle);
        assert_eq!(info.package, "dev.tether.fixture");
        assert_eq!(info.label.as_deref(), Some("Example Shop"));
        assert_eq!(
            info.parts,
            [ApkPart {
                entry: Some("splits/base-master.apk".into()),
                split: None,
                size: fixtures::PLAIN_APK.len() as u64,
            }]
        );
        assert_eq!(info.obbs.len(), 1);

        let mut streamed = Vec::new();
        open_part(&path, Some("splits/base-master.apk"))
            .unwrap()
            .read_to_end(&mut streamed)
            .unwrap();
        assert_eq!(streamed, fixtures::PLAIN_APK);
    }

    #[test]
    fn detects_signing_block_ids() {
        // Minimal zip: [signing block][central directory = EOCD only].
        let mut block = Vec::new();
        let pairs: [(u32, &[u8]); 2] = [(0x7109_871a, b"v2"), (0xf053_68c0, b"v3")];
        let mut body = Vec::new();
        for (id, value) in pairs {
            body.extend_from_slice(&((4 + value.len()) as u64).to_le_bytes());
            body.extend_from_slice(&id.to_le_bytes());
            body.extend_from_slice(value);
        }
        let size = (body.len() + 24) as u64;
        block.extend_from_slice(&size.to_le_bytes());
        block.extend_from_slice(&body);
        block.extend_from_slice(&size.to_le_bytes());
        block.extend_from_slice(b"APK Sig Block 42");
        let cd_offset = block.len() as u32;
        let mut file = block;
        file.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        file.extend_from_slice(&cd_offset.to_le_bytes());
        file.extend_from_slice(&[0, 0]);
        let ids = signing_block_ids(&mut io::Cursor::new(file)).unwrap();
        assert_eq!(ids, [0x7109_871a, 0xf053_68c0]);
    }

    #[test]
    fn rejects_non_zip_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "notes.apk", b"hello");
        assert!(matches!(
            inspect(&path, "en"),
            Err(AppError::InvalidInput(_))
        ));
    }
}
