//! Signer certificates of an installed app. Only the end of the base APK
//! is read (EOCD, then the signing block before the central directory)
//! plus the v1 `META-INF/*.RSA` through the device's `unzip`, so even a
//! 200 MB APK costs a few KiB of transfer.

use super::{base_apk, check_package, quote};
use crate::adb::server::AdbServer;
use crate::device::apk::signing::{self, EOCD_SEARCH, SigningInfo, Tail};
use crate::error::{AppError, AppResult};

/// The first read: EOCD search area plus room for a typical central
/// directory and signing block, so most APKs need a single round trip.
const TAIL_READ: u64 = 128 * 1024;

pub async fn signing(server: &AdbServer, serial: &str, package: &str) -> AppResult<SigningInfo> {
    let package = check_package(package)?;
    let apk = base_apk(server, serial, package).await?;
    let q = quote(&apk);
    let tail_cmd = format!("tail -c {} {q} 2>/dev/null", TAIL_READ.max(EOCD_SEARCH));
    let v1_cmd =
        format!("unzip -p {q} 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' 2>/dev/null");
    let (tail, v1) = tokio::join!(server.exec(serial, &tail_cmd), server.exec(serial, &v1_cmd));
    let tail = tail?;
    let tail = Tail::parse(&tail)
        .ok_or_else(|| AppError::Device(format!("could not read the end of {apk}")))?;
    let v1 = v1.ok().filter(|d| !d.is_empty());

    let block = match read_block(server, serial, &q, &tail).await {
        Ok(block) => block,
        Err(e) if v1.is_none() => return Err(e),
        Err(_) => None,
    };
    let info = signing::parse(block.as_deref(), v1.as_deref());
    if info.signers.is_empty() {
        return Err(AppError::Device(format!(
            "no signer certificate found in {apk}"
        )));
    }
    Ok(info)
}

/// The signing block, from the tail when it is covered, else read by range.
async fn read_block(
    server: &AdbServer,
    serial: &str,
    quoted: &str,
    tail: &Tail<'_>,
) -> AppResult<Option<Vec<u8>>> {
    let Some((a, b)) = tail.footer_range() else {
        return Ok(None);
    };
    let footer = match tail.slice(a, b) {
        Some(f) => f.to_vec(),
        None => read_range(server, serial, quoted, a, b).await?,
    };
    let Some((from, to)) = tail.block_range(&footer) else {
        return Ok(None);
    };
    Ok(Some(match tail.slice(from, to) {
        Some(block) => block.to_vec(),
        None => read_range(server, serial, quoted, from, to).await?,
    }))
}

/// Bytes `[from, to)` of a device file: `dd` with byte offsets (toybox),
/// falling back to `tail | head` on older shells.
async fn read_range(
    server: &AdbServer,
    serial: &str,
    quoted: &str,
    from: u64,
    to: u64,
) -> AppResult<Vec<u8>> {
    let len = to - from;
    let dd = server
        .exec(
            serial,
            &format!(
                "dd if={quoted} bs=65536 iflag=skip_bytes,count_bytes skip={from} \
                 count={len} status=none 2>/dev/null"
            ),
        )
        .await?;
    if dd.len() as u64 == len {
        return Ok(dd);
    }
    let out = server
        .exec(
            serial,
            &format!("tail -c +{} {quoted} 2>/dev/null | head -c {len}", from + 1),
        )
        .await?;
    if out.len() as u64 == len {
        Ok(out)
    } else {
        Err(AppError::Device(format!(
            "short read of the signing block ({} of {len} bytes)",
            out.len()
        )))
    }
}
