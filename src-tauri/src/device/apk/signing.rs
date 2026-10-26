//! Signer certificates of an APK: the APK Signature Scheme v2 / v3 / v3.1
//! blocks (with v3 key rotation lineage) and the v1 JAR signature
//! (`META-INF/*.RSA`, a PKCS#7 `SignedData`).
//!
//! The signing block sits right before the zip central directory, so only
//! the tail of the APK is needed: [`Tail`] locates the block in a buffer
//! holding the end of the file and tells which range to fetch otherwise.
//! Formats: AOSP `apksig` (`ApkSigningBlockUtils`, `V3SchemeSigner`,
//! `SigningCertificateLineage`).

use serde::Serialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use x509_parser::prelude::{FromDer, X509Certificate};
use x509_parser::public_key::PublicKey;
use x509_parser::x509::X509Name;

use super::Le;

pub const V2: u32 = 0x7109_871a;
pub const V3: u32 = 0xf053_68c0;
pub const V31: u32 = 0x1b93_ad61;
const PROOF_OF_ROTATION: u32 = 0x3ba0_6f8c;
const MAGIC: &[u8; 16] = b"APK Sig Block 42";
const EOCD: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
const EOCD_LEN: usize = 22;
/// Bytes from the end of the file that always contain the EOCD record.
pub const EOCD_SEARCH: u64 = 65_535 + EOCD_LEN as u64;
/// Signing blocks are a few KiB; anything bigger than this is refused.
pub const MAX_BLOCK: u64 = 16 * 1024 * 1024;
/// Footer of the block: `u64 size` + magic, right before the central dir.
pub const FOOTER_LEN: u64 = 24;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    /// `AB:CD:…` as printed by `keytool` / `apksigner`.
    pub sha256: String,
    pub sha1: String,
    pub subject: String,
    pub issuer: String,
    pub subject_cn: Option<String>,
    pub subject_o: Option<String>,
    pub issuer_cn: Option<String>,
    pub issuer_o: Option<String>,
    pub serial: String,
    /// Validity in Unix milliseconds.
    pub not_before: i64,
    pub not_after: i64,
    /// `RSA 2048`, `EC 256`, …
    pub key: Option<String>,
    /// Signed with the SDK's auto-generated debug key (`CN=Android Debug`).
    pub debug: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signer {
    pub certificate: Certificate,
    /// Schemes this certificate signs with: `v1`, `v2`, `v3`, `v3.1`.
    pub schemes: Vec<String>,
    /// SDK range of a v3 / v3.1 signer.
    pub min_sdk: Option<u32>,
    pub max_sdk: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningInfo {
    /// Schemes present in the APK, oldest first.
    pub schemes: Vec<String>,
    /// Distinct signer certificates, newest scheme first.
    pub signers: Vec<Signer>,
    /// v3 proof-of-rotation, oldest certificate first; empty without
    /// key rotation.
    pub lineage: Vec<Certificate>,
}

/// The end of an APK: where the central directory starts and which
/// absolute file offset `data[0]` is.
#[derive(Debug, Clone, Copy)]
pub struct Tail<'a> {
    pub data: &'a [u8],
    pub start: u64,
    pub cd_offset: u64,
}

impl<'a> Tail<'a> {
    /// Finds the EOCD record in the last bytes of a zip file.
    pub fn parse(data: &'a [u8]) -> Option<Self> {
        let last = data.len().checked_sub(EOCD_LEN)?;
        // The EOCD whose comment runs exactly to the end of the file.
        let eocd = (0..=last).rev().find(|&i| {
            data[i..i + 4] == EOCD
                && data
                    .u16_at(i + 20)
                    .is_some_and(|c| i + EOCD_LEN + c as usize == data.len())
        })?;
        let cd_size = u64::from(data.u32_at(eocd + 12)?);
        let cd_offset = u64::from(data.u32_at(eocd + 16)?);
        if cd_offset == u64::from(u32::MAX) {
            return None; // zip64, never produced for APKs
        }
        let eocd_abs = cd_offset.checked_add(cd_size)?;
        let start = eocd_abs.checked_sub(eocd as u64)?;
        Some(Self {
            data,
            start,
            cd_offset,
        })
    }

    /// `[from, to)` of the file if this buffer covers it.
    pub fn slice(&self, from: u64, to: u64) -> Option<&'a [u8]> {
        let a = usize::try_from(from.checked_sub(self.start)?).ok()?;
        let b = usize::try_from(to.checked_sub(self.start)?).ok()?;
        self.data.get(a..b)
    }

    /// Range of the 24-byte footer that ends the signing block.
    pub fn footer_range(&self) -> Option<(u64, u64)> {
        Some((self.cd_offset.checked_sub(FOOTER_LEN)?, self.cd_offset))
    }

    /// Range of the whole signing block given its footer, or `None` when
    /// the APK has no v2+ signature.
    pub fn block_range(&self, footer: &[u8]) -> Option<(u64, u64)> {
        let size = block_size(footer)?;
        Some((self.cd_offset.checked_sub(size + 8)?, self.cd_offset))
    }
}

/// `size` field of a signing block footer.
pub fn block_size(footer: &[u8]) -> Option<u64> {
    if footer.len() != FOOTER_LEN as usize || &footer[8..] != MAGIC {
        return None;
    }
    let size = u64::from_le_bytes(footer[..8].try_into().ok()?);
    (FOOTER_LEN..=MAX_BLOCK).contains(&size).then_some(size)
}

/// ID-value pairs of a signing block (`u64 size`, pairs, `u64 size`, magic).
pub fn pairs(block: &[u8]) -> Vec<(u32, &[u8])> {
    let mut out = Vec::new();
    let Some(body) = block
        .get(8..block.len().saturating_sub(FOOTER_LEN as usize))
        .filter(|_| block.ends_with(MAGIC))
    else {
        return out;
    };
    let mut at = 0usize;
    while at + 12 <= body.len() {
        let Ok(len) = usize::try_from(u64::from_le_bytes(
            body[at..at + 8].try_into().unwrap_or([0; 8]),
        )) else {
            break;
        };
        let Some(end) = (at + 8).checked_add(len).filter(|&e| e <= body.len()) else {
            break;
        };
        if len < 4 {
            break;
        }
        let id = body.u32_at(at + 8).unwrap_or(0);
        out.push((id, &body[at + 12..end]));
        at = end;
    }
    out
}

/// Certificates of an APK from its signing block and/or v1 signature.
pub fn parse(block: Option<&[u8]>, v1: Option<&[u8]>) -> SigningInfo {
    let mut info = SigningInfo::default();
    let pairs = block.map(pairs).unwrap_or_default();
    let has = |id: u32| pairs.iter().any(|(i, _)| *i == id);

    let v1_certs: Vec<&[u8]> = v1.map(pkcs7_certificates).unwrap_or_default();
    if !v1_certs.is_empty() {
        info.schemes.push("v1".into());
    }
    for (id, name) in [(V2, "v2"), (V3, "v3"), (V31, "v3.1")] {
        if has(id) {
            info.schemes.push(name.into());
        }
    }

    let mut add = |der: &[u8], scheme: &str, sdk: Option<(u32, u32)>| {
        let Some(cert) = describe(der) else { return };
        if let Some(s) = info
            .signers
            .iter_mut()
            .find(|s| s.certificate.sha256 == cert.sha256)
        {
            if !s.schemes.iter().any(|x| x == scheme) {
                s.schemes.push(scheme.into());
            }
            return;
        }
        info.signers.push(Signer {
            certificate: cert,
            schemes: vec![scheme.into()],
            min_sdk: sdk.map(|(a, _)| a),
            max_sdk: sdk.map(|(_, b)| b).filter(|&b| b != i32::MAX as u32),
        });
    };

    let mut lineage = None;
    for (id, name) in [(V31, "v3.1"), (V3, "v3")] {
        for (_, value) in pairs.iter().filter(|(i, _)| *i == id) {
            for signer in v3_signers(value) {
                if let Some(der) = signer.certificate {
                    add(der, name, Some((signer.min_sdk, signer.max_sdk)));
                }
                if lineage.is_none() {
                    lineage = signer.lineage;
                }
            }
        }
    }
    for (_, value) in pairs.iter().filter(|(i, _)| *i == V2) {
        for der in v2_certificates(value) {
            add(der, "v2", None);
        }
    }
    for der in v1_certs {
        add(der, "v1", None);
    }
    info.lineage = lineage
        .map(|nodes| nodes.into_iter().filter_map(describe).collect())
        .unwrap_or_default();
    info
}

/// Reads a `u32`-length-prefixed slice off the front of `data`.
fn lp<'a>(data: &mut &'a [u8]) -> Option<&'a [u8]> {
    let len = data.u32_at(0)? as usize;
    let value = data.get(4..4usize.checked_add(len)?)?;
    *data = &data[4 + len..];
    Some(value)
}

fn u32_le(data: &mut &[u8]) -> Option<u32> {
    let v = data.u32_at(0)?;
    *data = &data[4..];
    Some(v)
}

/// Iterates a sequence of length-prefixed elements.
fn sequence(mut data: &[u8]) -> impl Iterator<Item = &[u8]> {
    std::iter::from_fn(move || lp(&mut data))
}

/// First certificate of each v2 signer.
fn v2_certificates(value: &[u8]) -> Vec<&[u8]> {
    let mut value = value;
    let Some(signers) = lp(&mut value) else {
        return Vec::new();
    };
    sequence(signers)
        .filter_map(|mut signer| {
            let mut signed = lp(&mut signer)?;
            let _digests = lp(&mut signed)?;
            let certs = lp(&mut signed)?;
            sequence(certs).next()
        })
        .collect()
}

struct V3Signer<'a> {
    certificate: Option<&'a [u8]>,
    min_sdk: u32,
    max_sdk: u32,
    lineage: Option<Vec<&'a [u8]>>,
}

fn v3_signers(value: &[u8]) -> Vec<V3Signer<'_>> {
    let mut value = value;
    let Some(signers) = lp(&mut value) else {
        return Vec::new();
    };
    sequence(signers)
        .filter_map(|mut signer| {
            let mut signed = lp(&mut signer)?;
            let min_sdk = u32_le(&mut signer)?;
            let max_sdk = u32_le(&mut signer)?;
            let _digests = lp(&mut signed)?;
            let certs = lp(&mut signed)?;
            let _min = u32_le(&mut signed)?;
            let _max = u32_le(&mut signed)?;
            let attrs = lp(&mut signed).unwrap_or_default();
            let lineage = sequence(attrs).find_map(|attr| {
                (attr.u32_at(0)? == PROOF_OF_ROTATION).then(|| lineage_certificates(&attr[4..]))
            });
            Some(V3Signer {
                certificate: sequence(certs).next(),
                min_sdk,
                max_sdk,
                lineage,
            })
        })
        .collect()
}

/// Certificates of a proof-of-rotation attribute: `u32 version`, then
/// nodes of `lp(signed data = lp(cert), u32 alg), u32 flags, u32 alg,
/// lp(signature)`.
fn lineage_certificates(mut data: &[u8]) -> Vec<&[u8]> {
    if u32_le(&mut data).is_none() {
        return Vec::new();
    }
    sequence(data)
        .filter_map(|mut node| {
            let mut signed = lp(&mut node)?;
            lp(&mut signed)
        })
        .collect()
}

/// One DER element: (tag, content, whole element, rest).
type Der<'a> = (u8, &'a [u8], &'a [u8], &'a [u8]);

fn der(data: &[u8]) -> Option<Der<'_>> {
    let tag = *data.first()?;
    let first = *data.get(1)?;
    let (len, header) = if first < 0x80 {
        (first as usize, 2)
    } else {
        let n = (first & 0x7f) as usize;
        if n == 0 || n > 4 {
            return None;
        }
        let bytes = data.get(2..2 + n)?;
        let len = bytes.iter().fold(0usize, |acc, &b| (acc << 8) | b as usize);
        (len, 2 + n)
    };
    let end = header.checked_add(len)?;
    let content = data.get(header..end)?;
    Some((tag, content, &data[..end], &data[end..]))
}

/// Certificates of a PKCS#7 `ContentInfo { signedData }` (a v1 `.RSA`,
/// `.DSA` or `.EC` file).
pub fn pkcs7_certificates(data: &[u8]) -> Vec<&[u8]> {
    let inner = || -> Option<Vec<&[u8]>> {
        let (_, content_info, _, _) = der(data).filter(|(t, ..)| *t == 0x30)?;
        let (_, _, _, rest) = der(content_info)?; // contentType OID
        let (_, explicit, _, _) = der(rest).filter(|(t, ..)| *t == 0xa0)?;
        let (_, signed_data, _, _) = der(explicit).filter(|(t, ..)| *t == 0x30)?;
        let mut rest = signed_data;
        for _ in 0..3 {
            // version, digestAlgorithms, encapContentInfo
            rest = der(rest)?.3;
        }
        let (tag, certs, _, _) = der(rest)?;
        if tag != 0xa0 {
            return None;
        }
        let mut out = Vec::new();
        let mut at = certs;
        while let Some((tag, _, whole, next)) = der(at) {
            if tag == 0x30 {
                out.push(whole);
            }
            at = next;
        }
        Some(out)
    };
    inner().unwrap_or_default()
}

fn hex_colons(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn first(name: &X509Name<'_>, cn: bool) -> Option<String> {
    let mut it: Box<dyn Iterator<Item = _>> = if cn {
        Box::new(name.iter_common_name())
    } else {
        Box::new(name.iter_organization())
    };
    it.next().and_then(|a| a.as_str().ok()).map(str::to_owned)
}

/// Fingerprints, names, validity and key of one DER certificate.
pub fn describe(der: &[u8]) -> Option<Certificate> {
    let (_, cert) = X509Certificate::from_der(der).ok()?;
    let subject_cn = first(cert.subject(), true);
    let key = cert.public_key().parsed().ok().and_then(|k| match k {
        PublicKey::RSA(_) => Some(format!("RSA {}", k.key_size())),
        PublicKey::EC(_) => Some(format!("EC {}", k.key_size())),
        PublicKey::DSA(_) => Some(format!("DSA {}", k.key_size())),
        _ => None,
    });
    Some(Certificate {
        sha256: hex_colons(&Sha256::digest(der)),
        sha1: hex_colons(&Sha1::digest(der)),
        subject: cert.subject().to_string(),
        issuer: cert.issuer().to_string(),
        debug: subject_cn.as_deref() == Some("Android Debug"),
        subject_cn,
        subject_o: first(cert.subject(), false),
        issuer_cn: first(cert.issuer(), true),
        issuer_o: first(cert.issuer(), false),
        serial: cert.raw_serial_as_string().to_ascii_uppercase(),
        not_before: cert.validity().not_before.timestamp() * 1000,
        not_after: cert.validity().not_after.timestamp() * 1000,
        key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAMERA2: &[u8] =
        include_bytes!("../../../tests/fixtures/apps/signing/com.android.camera2.bin");
    const SAFETYHUB: &[u8] = include_bytes!(
        "../../../tests/fixtures/apps/signing/com.google.android.apps.safetyhub.bin"
    );
    const RESTORE: &[u8] =
        include_bytes!("../../../tests/fixtures/apps/signing/com.google.android.apps.restore.bin");
    const V2_ONLY: &[u8] =
        include_bytes!("../../../tests/fixtures/apps/signing/dev.silent27.appinstaller.bin");
    const DEBUG: &[u8] = include_bytes!("../../../tests/fixtures/apps/signing/debug.bin");
    const V1_DEBUG: &[u8] = include_bytes!("../../../tests/fixtures/apps/signing/v1-debug.rsa");

    fn sha(hex: &str) -> String {
        hex_colons(
            &(0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn reads_platform_signed_v2_v3_block() {
        let info = parse(Some(CAMERA2), None);
        assert_eq!(info.schemes, ["v2", "v3"]);
        assert_eq!(info.signers.len(), 1);
        let s = &info.signers[0];
        assert_eq!(s.schemes, ["v3", "v2"]);
        assert_eq!(
            s.certificate.sha256,
            sha("6cecc50e34ae31bfb5678986d6d6d3736c571ded2f2459527793e1f054eb0c9b")
        );
        assert_eq!(s.certificate.subject_cn.as_deref(), Some("Android"));
        assert_eq!(s.certificate.issuer_o.as_deref(), Some("Android"));
        assert_eq!(s.certificate.key.as_deref(), Some("RSA 2048"));
        assert!(!s.certificate.debug);
        assert!(s.certificate.not_before < s.certificate.not_after);
        assert!(info.lineage.is_empty());
    }

    #[test]
    fn reads_v3_rotation_lineage() {
        let info = parse(Some(SAFETYHUB), None);
        assert_eq!(info.schemes, ["v2", "v3"]);
        // v3 signs with the rotated key, v2 with the original one.
        let shas: Vec<_> = info.signers.iter().map(|s| &s.certificate.sha256).collect();
        assert_eq!(
            shas,
            [
                &sha("a929dbb24dd2a23162aadfd3be6dc3de4f80c6905d5cb6bf326bdcace3ddec14"),
                &sha("d78e17cf8be776c5723ba85fdc66c72f334843d9b8afee35dce04de8c96eeef6"),
            ]
        );
        assert_eq!(info.signers[0].certificate.key.as_deref(), Some("RSA 4096"));
        let lineage: Vec<_> = info.lineage.iter().map(|c| c.subject_cn.clone()).collect();
        assert_eq!(
            lineage,
            [
                Some("android-safetyhub".to_owned()),
                Some("com_google_android_apps_safetyhub-rotation-2021".to_owned()),
            ]
        );
    }

    #[test]
    fn reads_v31_signer_with_sdk_range() {
        let info = parse(Some(RESTORE), None);
        assert_eq!(info.schemes, ["v2", "v3", "v3.1"]);
        let first = &info.signers[0];
        assert_eq!(first.schemes, ["v3.1"]);
        assert_eq!(
            first.certificate.sha256,
            sha("8a922b36357d2ae2d585d715297db6144620267503c6064052baab3962b9115a")
        );
        assert_eq!((first.min_sdk, first.max_sdk), (Some(33), None));
        let old = &info.signers[1];
        assert_eq!(old.schemes, ["v3", "v2"]);
        assert_eq!((old.min_sdk, old.max_sdk), (Some(24), Some(32)));
        assert_eq!(
            old.certificate.subject_cn.as_deref(),
            Some("restore-android")
        );
        assert_eq!(info.lineage.len(), 2);
    }

    #[test]
    fn reads_v2_only_block() {
        let info = parse(Some(V2_ONLY), None);
        assert_eq!(info.schemes, ["v2"]);
        assert_eq!(
            info.signers[0].certificate.sha256,
            sha("f30d8f446afbc761559d30ec476bfa9c88c6e1ee729285264e98886ede21d4f1")
        );
        assert_eq!(
            info.signers[0].certificate.subject_o.as_deref(),
            Some("sIleNt27")
        );
    }

    #[test]
    fn flags_debug_certificates_in_block_and_v1() {
        let debug_sha = sha("afafcb42dfd87da55dc447cc64bb6a5da523bcd12c2515412f482859c2ab42e8");
        let info = parse(Some(DEBUG), Some(V1_DEBUG));
        assert_eq!(info.schemes, ["v1", "v2", "v3"]);
        assert_eq!(info.signers.len(), 1);
        let s = &info.signers[0];
        assert_eq!(s.schemes, ["v3", "v2", "v1"]);
        assert!(s.certificate.debug);
        assert_eq!(s.certificate.sha256, debug_sha);
        assert_eq!(s.certificate.issuer_cn.as_deref(), Some("Android Debug"));

        let v1 = parse(None, Some(V1_DEBUG));
        assert_eq!(v1.schemes, ["v1"]);
        assert_eq!(v1.signers[0].certificate.sha256, debug_sha);
    }

    #[test]
    fn locates_block_in_apk_tail() {
        // [padding][signing block][central directory][EOCD]
        let mut file = vec![0u8; 100];
        file.extend_from_slice(DEBUG);
        let cd_offset = file.len() as u32;
        let cd = b"central directory";
        file.extend_from_slice(cd);
        file.extend_from_slice(&EOCD);
        file.extend_from_slice(&[0; 8]);
        file.extend_from_slice(&(cd.len() as u32).to_le_bytes());
        file.extend_from_slice(&cd_offset.to_le_bytes());
        file.extend_from_slice(&[0, 0]);

        let full = Tail::parse(&file).unwrap();
        assert_eq!(full.start, 0);
        let (a, b) = full.footer_range().unwrap();
        let footer = full.slice(a, b).unwrap();
        let (from, to) = full.block_range(footer).unwrap();
        assert_eq!(full.slice(from, to).unwrap(), DEBUG);

        // A short tail knows the offsets but not the block bytes.
        let short = Tail::parse(&file[file.len() - 60..]).unwrap();
        assert_eq!(short.start, file.len() as u64 - 60);
        assert_eq!(short.cd_offset, u64::from(cd_offset));
        assert!(short.slice(from, to).is_none());
    }

    #[test]
    fn tolerates_garbage() {
        assert!(Tail::parse(b"tail: /x: No such file or directory\n").is_none());
        assert!(block_size(&[0; 24]).is_none());
        assert!(pairs(b"nonsense").is_empty());
        assert!(pkcs7_certificates(b"\x30\x80").is_empty());
        let info = parse(
            Some(&DEBUG[..DEBUG.len() / 2]),
            Some(b"\x30\x03\x02\x01\x00"),
        );
        assert!(info.signers.is_empty());
        assert!(describe(b"\x30\x00").is_none());
    }
}
