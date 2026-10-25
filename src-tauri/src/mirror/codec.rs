//! Bitstream helpers that turn MediaCodec output into what WebCodecs'
//! `VideoDecoder` accepts on every engine (Chromium, WebKit, WebKitGTK).
//!
//! - H.264: the config packet holds SPS/PPS in Annex-B. We build an `avcC`
//!   record from it and send frames length-prefixed (AVCC), which WebKit
//!   requires and Chromium accepts.
//! - H.265: Annex-B with parameter sets prepended to key frames, plus an
//!   RFC 6381 codec string parsed from the SPS.
//! - AV1: the config packet is an `av1C` record (`AV1CodecConfigurationRecord`),
//!   used as is for the description and the codec string.

/// What the frontend needs to configure a `VideoDecoder`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecoderConfig {
    /// RFC 6381 codec string, e.g. `avc1.42C028`.
    pub codec: String,
    /// `VideoDecoderConfig.description`; empty means Annex-B / none.
    pub description: Vec<u8>,
    /// Frames must be converted to 4-byte length-prefixed NAL units.
    pub length_prefixed: bool,
    /// Prepend the config packet to key frames (Annex-B in-band params).
    pub inband_config: bool,
}

/// NAL units of an Annex-B byte stream, without start codes.
pub fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut units = Vec::new();
    let mut start = None;
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if let Some(s) = start {
                units.push(trim_trailing_zeros(&data[s..i]));
            }
            i += 3;
            start = Some(i);
        } else {
            i += 1;
        }
    }
    if let Some(s) = start {
        units.push(trim_trailing_zeros(&data[s..]));
    }
    units.retain(|u| !u.is_empty());
    units
}

/// Zero bytes before a start code belong to it (4-byte start codes or
/// `trailing_zero_8bits`), never to the NAL unit: a NAL never ends in 0x00.
fn trim_trailing_zeros(unit: &[u8]) -> &[u8] {
    let end = unit.iter().rposition(|&b| b != 0).map_or(0, |p| p + 1);
    &unit[..end]
}

/// Annex-B → AVCC/HVCC (`u32` big-endian length before each NAL unit).
pub fn to_length_prefixed(data: &[u8]) -> Vec<u8> {
    let units = nal_units(data);
    let mut out = Vec::with_capacity(data.len() + units.len());
    for unit in units {
        out.extend_from_slice(&(unit.len() as u32).to_be_bytes());
        out.extend_from_slice(unit);
    }
    out
}

/// Builds the decoder config from an H.264 config packet (SPS + PPS).
pub fn h264_config(config: &[u8]) -> Option<DecoderConfig> {
    let units = nal_units(config);
    let sps: Vec<&[u8]> = units.iter().copied().filter(|u| u[0] & 0x1F == 7).collect();
    let pps: Vec<&[u8]> = units.iter().copied().filter(|u| u[0] & 0x1F == 8).collect();
    let first = sps.first()?;
    if first.len() < 4 || pps.is_empty() {
        return None;
    }

    let mut avcc = vec![
        1,        // configurationVersion
        first[1], // AVCProfileIndication
        first[2], // profile_compatibility
        first[3], // AVCLevelIndication
        0xFF,     // reserved | lengthSizeMinusOne = 3
        0xE0 | (sps.len() as u8 & 0x1F),
    ];
    for unit in &sps {
        avcc.extend_from_slice(&(unit.len() as u16).to_be_bytes());
        avcc.extend_from_slice(unit);
    }
    avcc.push(pps.len() as u8);
    for unit in &pps {
        avcc.extend_from_slice(&(unit.len() as u16).to_be_bytes());
        avcc.extend_from_slice(unit);
    }

    Some(DecoderConfig {
        codec: format!("avc1.{:02X}{:02X}{:02X}", first[1], first[2], first[3]),
        description: avcc,
        length_prefixed: true,
        inband_config: false,
    })
}

/// Decoder config for an H.265 config packet (VPS + SPS + PPS, Annex-B).
pub fn h265_config(config: &[u8]) -> Option<DecoderConfig> {
    let sps = nal_units(config)
        .into_iter()
        .find(|u| u.len() > 2 && (u[0] >> 1) & 0x3F == 33)?;
    let rbsp = remove_emulation_prevention(&sps[2..]);
    // rbsp[0]: vps id, max_sub_layers_minus1, temporal_id_nesting; then
    // profile_tier_level: space/tier/profile, 32 compat bits, 48 constraint
    // bits, level.
    if rbsp.len() < 13 {
        return None;
    }
    let space = rbsp[1] >> 6;
    let tier = if rbsp[1] & 0x20 != 0 { 'H' } else { 'L' };
    let profile = rbsp[1] & 0x1F;
    let compat = u32::from_be_bytes([rbsp[2], rbsp[3], rbsp[4], rbsp[5]]).reverse_bits();
    let level = rbsp[12];

    let mut codec = format!(
        "hvc1.{}{profile}.{compat:X}.{tier}{level}",
        ["", "A", "B", "C"][space as usize]
    );
    let constraints = &rbsp[6..12];
    let used = constraints
        .iter()
        .rposition(|&b| b != 0)
        .map_or(0, |p| p + 1);
    for byte in &constraints[..used] {
        codec.push_str(&format!(".{byte:X}"));
    }

    Some(DecoderConfig {
        codec,
        description: Vec::new(),
        length_prefixed: false,
        inband_config: true,
    })
}

/// Decoder config for an AV1 config packet (`av1C`).
pub fn av1_config(config: &[u8]) -> DecoderConfig {
    if config.len() >= 4 && config[0] == 0x81 {
        let profile = config[1] >> 5;
        let level = config[1] & 0x1F;
        let tier = if config[2] & 0x80 != 0 { 'H' } else { 'M' };
        let high_bitdepth = config[2] & 0x40 != 0;
        let twelve_bit = config[2] & 0x20 != 0;
        let depth = match (high_bitdepth, twelve_bit) {
            (true, true) => 12,
            (true, false) => 10,
            _ => 8,
        };
        DecoderConfig {
            codec: format!("av01.{profile}.{level:02}{tier}.{depth:02}"),
            description: config.to_vec(),
            length_prefixed: false,
            inband_config: false,
        }
    } else {
        // Not an av1C record (raw sequence header OBU): send it in-band.
        DecoderConfig {
            codec: "av01.0.08M.08".into(),
            description: Vec::new(),
            length_prefixed: false,
            inband_config: true,
        }
    }
}

/// Drops the `0x03` of every `00 00 03` sequence (H.264/H.265 RBSP).
fn remove_emulation_prevention(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut zeros = 0;
    for &b in data {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real H.264 config packet from the Android 16 emulator
    // (scrcpy 5.0.1, max_size=1280 → 572x1280).
    const H264_SPS: &[u8] = &[
        0x67, 0x42, 0xC0, 0x29, 0x8D, 0x68, 0x09, 0x00, 0xA1, 0xEF, 0x90, 0x80, 0x80, 0x80, 0x83,
        0xC2, 0x21, 0x1A, 0x80,
    ];
    const H264_PPS: &[u8] = &[0x68, 0xCE, 0x01, 0xA8, 0x35, 0xC8];

    fn annexb(units: &[&[u8]]) -> Vec<u8> {
        units
            .iter()
            .flat_map(|u| [&[0, 0, 0, 1][..], u].concat())
            .collect()
    }

    #[test]
    fn splits_three_and_four_byte_start_codes() {
        let data = [
            0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 0,
        ];
        assert_eq!(
            nal_units(&data),
            vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4][..]]
        );
        assert!(nal_units(&[1, 2, 3]).is_empty());
        assert!(nal_units(&[]).is_empty());
    }

    #[test]
    fn length_prefixes_each_unit() {
        let data = [0, 0, 0, 1, 0x65, 0xAA, 0xBB, 0, 0, 1, 0x41, 0xCC];
        assert_eq!(
            to_length_prefixed(&data),
            [0, 0, 0, 3, 0x65, 0xAA, 0xBB, 0, 0, 0, 2, 0x41, 0xCC]
        );
    }

    #[test]
    fn avcc_from_real_config() {
        let config = h264_config(&annexb(&[H264_SPS, H264_PPS])).unwrap();
        assert_eq!(config.codec, "avc1.42C029");
        assert!(config.length_prefixed);
        let mut expected = vec![1, 0x42, 0xC0, 0x29, 0xFF, 0xE1, 0, 19];
        expected.extend_from_slice(H264_SPS);
        expected.extend_from_slice(&[1, 0, 6]);
        expected.extend_from_slice(H264_PPS);
        assert_eq!(config.description, expected);
    }

    #[test]
    fn h264_config_needs_sps_and_pps() {
        assert!(h264_config(&[0, 0, 1, 0x68, 0xCE]).is_none());
        assert!(h264_config(&[0, 0, 1, 0x67, 0x42, 0xC0, 0x29]).is_none());
    }

    #[test]
    fn hevc_codec_string() {
        // Main profile, level 4.1 (123), progressive/non-packed/frame-only.
        let config = [
            0, 0, 0, 1, 0x40, 0x01, 0x0C, // VPS (truncated)
            0, 0, 0, 1, 0x42, 0x01, // SPS NAL header
            0x01, // vps id 0, max_sub_layers_minus1 0, nesting 1
            0x01, // space 0, tier main, profile 1
            0x60, 0x00, 0x00, 0x00, // compat: profiles 1 and 2
            // Constraints 90 00 00 00 00 00, with emulation prevention.
            0x90, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x7B, // level 123
            0xA0, // rest of the SPS
        ];
        let config = h265_config(&config).unwrap();
        assert_eq!(config.codec, "hvc1.1.6.L123.90");
        assert!(config.inband_config);
        assert!(config.description.is_empty());
    }

    #[test]
    fn av1_codec_string() {
        // Real av1C from the emulator: main profile, level 4.0, 8-bit 4:2:0.
        let c = av1_config(&[0x81, 0x08, 0x0C, 0x00]);
        assert_eq!(c.codec, "av01.0.08M.08");
        assert_eq!(c.description, [0x81, 0x08, 0x0C, 0x00]);
        assert!(!c.inband_config);
        let c = av1_config(&[0x81, 0x2D, 0xC0, 0x00]);
        assert_eq!(c.codec, "av01.1.13H.10");
        let c = av1_config(&[0x0A, 0x0B]);
        assert!(c.inband_config && c.description.is_empty());
    }

    #[test]
    fn emulation_prevention_is_removed() {
        assert_eq!(
            remove_emulation_prevention(&[0, 0, 3, 1, 0, 0, 3, 0, 3]),
            [0, 0, 1, 0, 0, 0, 3]
        );
    }
}
