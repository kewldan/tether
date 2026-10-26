//! OTA package checks before a sideload: is it a zip, is it an OTA, which
//! device and build it targets, and does it carry a signature block.
//!
//! The text metadata lives at `META-INF/com/android/metadata`
//! (`key=value` lines written by `ota_from_target_files`). The signature
//! check is the same footer test recovery runs before verifying the RSA
//! signature (`bootable/recovery/install/verifier.cpp`); the signature
//! itself is verified by recovery against its own keys.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};

const METADATA: &str = "META-INF/com/android/metadata";
const METADATA_PB: &str = "META-INF/com/android/metadata.pb";
const UPDATE_BINARY: &str = "META-INF/com/google/android/update-binary";
const PAYLOAD: &str = "payload.bin";
const EOCD_LEN: u64 = 22;
const MAX_METADATA: u64 = 256 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtaPackage {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    /// Has OTA metadata or an updater; false for an arbitrary zip.
    pub is_ota: bool,
    /// A/B (`payload.bin`) rather than a block-based updater.
    pub ab: bool,
    /// `ota-type`: `AB`, `BLOCK`, `BRICK`…
    pub ota_type: Option<String>,
    /// Device codenames the package installs on (`pre-device`).
    pub devices: Vec<String>,
    /// Fingerprint the package installs (`post-build`).
    pub post_build: Option<String>,
    /// Android release of `post-build`, e.g. `15`.
    pub post_release: Option<String>,
    /// Build id of `post-build`, e.g. `AP4A.261005.002`.
    pub post_build_id: Option<String>,
    pub post_sdk: Option<u32>,
    pub post_security_patch: Option<String>,
    /// Incremental packages only apply on top of this fingerprint.
    pub pre_build: Option<String>,
    /// `ota-wipe=yes`: the update erases user data.
    pub wipe: bool,
    /// `ota-downgrade=yes`.
    pub downgrade: bool,
    /// The zip comment ends with the signature footer recovery expects.
    pub signed: bool,
}

/// Inspects a local file. Blocking: run it on a blocking thread.
pub fn inspect(path: &Path) -> AppResult<OtaPackage> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut out = OtaPackage {
        path: path.display().to_string(),
        name,
        size_bytes: size,
        ..OtaPackage::default()
    };
    if size == 0 {
        return Err(AppError::InvalidInput("the file is empty".into()));
    }
    out.signed = has_signature_footer(&mut file, size)?;
    file.seek(SeekFrom::Start(0))?;

    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| AppError::InvalidInput("the file is not a zip archive".into()))?;
    out.ab = zip.index_for_name(PAYLOAD).is_some();
    let has_updater = zip.index_for_name(UPDATE_BINARY).is_some();
    let has_pb = zip.index_for_name(METADATA_PB).is_some();

    let text = match zip.by_name(METADATA) {
        Ok(entry) => {
            let mut text = String::new();
            entry.take(MAX_METADATA).read_to_string(&mut text)?;
            Some(text)
        }
        Err(_) => None,
    };
    out.is_ota = text.is_some() || has_pb || has_updater || out.ab;
    if let Some(text) = text {
        apply_metadata(&mut out, &parse_metadata(&text));
    }
    Ok(out)
}

pub fn parse_metadata(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

fn apply_metadata(out: &mut OtaPackage, meta: &BTreeMap<String, String>) {
    let get = |k: &str| meta.get(k).filter(|v| !v.is_empty()).cloned();
    out.ota_type = get("ota-type");
    out.devices = get("pre-device")
        .map(|v| {
            v.split(',')
                .map(|d| d.trim().to_owned())
                .filter(|d| !d.is_empty())
                .collect()
        })
        .unwrap_or_default();
    out.post_build = get("post-build");
    if let Some(fp) = &out.post_build {
        let (release, build_id) = fingerprint_parts(fp);
        out.post_release = release;
        out.post_build_id = build_id;
    }
    out.post_sdk = get("post-sdk-level").and_then(|v| v.parse().ok());
    out.post_security_patch = get("post-security-patch-level");
    out.pre_build = get("pre-build");
    out.wipe = get("ota-wipe").is_some_and(|v| v == "yes");
    out.downgrade = get("ota-downgrade").is_some_and(|v| v == "yes");
}

/// `brand/product/device:release/build_id/incremental:type/tags` →
/// (release, build id). Multiple fingerprints are `|`-separated; the
/// first one wins.
fn fingerprint_parts(fp: &str) -> (Option<String>, Option<String>) {
    let first = fp.split('|').next().unwrap_or(fp);
    let parts: Vec<&str> = first.split('/').collect();
    let release = parts
        .get(2)
        .and_then(|p| p.split_once(':'))
        .map(|(_, r)| r.to_owned())
        .filter(|r| !r.is_empty());
    let build_id = parts
        .get(3)
        .map(|s| (*s).to_owned())
        .filter(|s| !s.is_empty());
    (release, build_id)
}

/// The last 6 bytes of a signed OTA are `[sig_start u16][0xffff]
/// [comment_len u16]`, and the zip's end-of-central-directory record sits
/// right before the comment.
fn has_signature_footer<R: Read + Seek>(file: &mut R, size: u64) -> AppResult<bool> {
    if size < EOCD_LEN + 6 {
        return Ok(false);
    }
    let mut footer = [0u8; 6];
    file.seek(SeekFrom::Start(size - 6))?;
    file.read_exact(&mut footer)?;
    if footer[2] != 0xff || footer[3] != 0xff {
        return Ok(false);
    }
    let sig_start = u64::from(u16::from_le_bytes([footer[0], footer[1]]));
    let comment_len = u64::from(u16::from_le_bytes([footer[4], footer[5]]));
    if sig_start > comment_len || comment_len + EOCD_LEN > size {
        return Ok(false);
    }
    let mut eocd = [0u8; EOCD_LEN as usize];
    file.seek(SeekFrom::Start(size - comment_len - EOCD_LEN))?;
    file.read_exact(&mut eocd)?;
    let stored_len = u64::from(u16::from_le_bytes([eocd[20], eocd[21]]));
    Ok(&eocd[..4] == b"PK\x05\x06" && stored_len == comment_len)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use zip::write::SimpleFileOptions;

    use super::*;

    // Shape of a real Pixel full OTA's `META-INF/com/android/metadata`.
    const PIXEL_METADATA: &str = "ota-property-files=payload_metadata.bin:2667:113935,payload.bin:2667:2482151424\n\
        ota-required-cache=0\n\
        ota-streaming-property-files=payload.bin:2667:2482151424\n\
        ota-type=AB\n\
        post-build=google/husky/husky:15/AP4A.261005.002/12493156:user/release-keys\n\
        post-build-incremental=12493156\n\
        post-sdk-level=35\n\
        post-security-patch-level=2026-10-05\n\
        post-timestamp=1759700000\n\
        pre-device=husky\n";

    fn ota_zip(metadata: Option<&str>, payload: bool, comment: &[u8]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        if let Some(text) = metadata {
            zip.start_file(METADATA, opts).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        if payload {
            zip.start_file(PAYLOAD, opts).unwrap();
            zip.write_all(&[0u8; 64]).unwrap();
        }
        zip.set_raw_comment(comment.to_vec().into_boxed_slice())
            .unwrap();
        zip.finish().unwrap().into_inner()
    }

    /// A comment shaped like the signapk whole-file signature footer.
    fn signed_comment() -> Vec<u8> {
        let mut comment = b"signed by SignApk".to_vec();
        comment.extend_from_slice(&[0u8; 40]); // stands in for the PKCS#7 blob
        let len = u16::try_from(comment.len() + 6).unwrap();
        comment.extend_from_slice(&(len - 17).to_le_bytes()); // signature start
        comment.extend_from_slice(&[0xff, 0xff]);
        comment.extend_from_slice(&len.to_le_bytes());
        comment
    }

    fn inspect_bytes(bytes: &[u8]) -> AppResult<OtaPackage> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("husky-ota-ap4a.261005.002-3b1f.zip");
        std::fs::write(&path, bytes).unwrap();
        inspect(&path)
    }

    #[test]
    fn reads_full_ab_ota() {
        let bytes = ota_zip(Some(PIXEL_METADATA), true, &signed_comment());
        let ota = inspect_bytes(&bytes).unwrap();
        assert!(ota.is_ota);
        assert!(ota.ab);
        assert!(ota.signed);
        assert_eq!(ota.name, "husky-ota-ap4a.261005.002-3b1f.zip");
        assert_eq!(ota.size_bytes, bytes.len() as u64);
        assert_eq!(ota.ota_type.as_deref(), Some("AB"));
        assert_eq!(ota.devices, ["husky"]);
        assert_eq!(ota.post_release.as_deref(), Some("15"));
        assert_eq!(ota.post_build_id.as_deref(), Some("AP4A.261005.002"));
        assert_eq!(ota.post_sdk, Some(35));
        assert_eq!(ota.post_security_patch.as_deref(), Some("2026-10-05"));
        assert_eq!(ota.pre_build, None);
        assert!(!ota.wipe && !ota.downgrade);
    }

    #[test]
    fn unsigned_and_flags() {
        let meta = "ota-type=BLOCK\npre-device=bluejay,oriole\nota-wipe=yes\nota-downgrade=yes\n\
            pre-build=google/oriole/oriole:14/UP1A.231005.007/1:user/release-keys\n";
        let ota = inspect_bytes(&ota_zip(Some(meta), false, b"")).unwrap();
        assert!(ota.is_ota && !ota.ab && !ota.signed);
        assert_eq!(ota.devices, ["bluejay", "oriole"]);
        assert!(ota.wipe && ota.downgrade);
        assert!(ota.pre_build.is_some());
        assert_eq!(ota.post_release, None);
    }

    #[test]
    fn plain_zip_is_not_an_ota() {
        let ota = inspect_bytes(&ota_zip(None, false, b"hello")).unwrap();
        assert!(!ota.is_ota);
        assert!(!ota.signed);
    }

    #[test]
    fn rejects_non_zip_and_empty() {
        assert!(matches!(
            inspect_bytes(b"definitely not a zip file at all, just text"),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(inspect_bytes(b""), Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn footer_needs_matching_eocd() {
        // Footer bytes without a zip in front.
        let mut bytes = vec![0u8; 64];
        bytes.extend_from_slice(&[10, 0, 0xff, 0xff, 20, 0]);
        let len = bytes.len() as u64;
        assert!(!has_signature_footer(&mut Cursor::new(bytes), len).unwrap());
    }

    #[test]
    fn fingerprint_split() {
        assert_eq!(
            fingerprint_parts("samsung/dm1qxeea/dm1q:14/UP1A.231005.007/S911B:user/release-keys"),
            (Some("14".into()), Some("UP1A.231005.007".into()))
        );
        assert_eq!(fingerprint_parts("garbage"), (None, None));
    }
}
