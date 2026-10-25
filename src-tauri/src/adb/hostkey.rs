//! The computer's adb RSA key, as the phone shows it in the
//! "Allow USB debugging?" prompt.

use std::path::{Path, PathBuf};

use base64::Engine;
use md5::{Digest, Md5};

/// `~/.android` (or `$ANDROID_USER_HOME`), where adb keeps `adbkey.pub`.
pub fn android_user_home() -> Option<PathBuf> {
    std::env::var_os("ANDROID_USER_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|h| h.join(".android")))
}

/// Fingerprint of `<dir>/adbkey.pub`, or `None` before adb created a key.
pub fn fingerprint_in(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("adbkey.pub")).ok()?;
    fingerprint(&text)
}

/// Android's fingerprint of an adb public key: MD5 of the decoded key blob
/// as colon-separated upper-case hex (`UsbDebuggingManager#getFingerprints`).
/// The file holds `<base64 key> <user@host>`.
pub fn fingerprint(public_key: &str) -> Option<String> {
    let blob = public_key.split_whitespace().next()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(blob)
        .ok()?;
    let digest = Md5::digest(&bytes);
    Some(
        digest
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_md5_of_decoded_key() {
        // "hello" in base64; md5("hello") = 5d41402abc4b2a76b9719d911017c592.
        assert_eq!(
            fingerprint("aGVsbG8= user@host\n").as_deref(),
            Some("5D:41:40:2A:BC:4B:2A:76:B9:71:9D:91:10:17:C5:92")
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(fingerprint(""), None);
        assert_eq!(fingerprint("!!!not base64"), None);
    }

    #[test]
    fn reads_key_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(fingerprint_in(dir.path()), None);
        std::fs::write(dir.path().join("adbkey.pub"), "aGVsbG8= me@mac").unwrap();
        assert!(fingerprint_in(dir.path()).is_some());
    }
}
