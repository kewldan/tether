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

/// Builds an `HEVCDecoderConfigurationRecord` (`hvcC`, ISO/IEC 14496-15
/// §8.3.3) from an H.265 config packet (VPS + SPS + PPS, Annex-B), for
/// muxing into MP4. Samples then carry 4-byte NAL lengths.
pub fn hevc_record(config: &[u8]) -> Option<Vec<u8>> {
    let units = nal_units(config);
    let of_type = |t: u8| -> Vec<&[u8]> {
        units
            .iter()
            .copied()
            .filter(|u| u.len() > 2 && (u[0] >> 1) & 0x3F == t)
            .collect()
    };
    let (vps, sps, pps) = (of_type(32), of_type(33), of_type(34));
    let first = sps.first()?;
    let rbsp = remove_emulation_prevention(&first[2..]);
    if rbsp.len() < 13 {
        return None;
    }
    let mut r = BitReader::new(&rbsp);
    r.skip(4)?; // sps_video_parameter_set_id
    let sub_layers = r.bits(3)? as usize; // sps_max_sub_layers_minus1
    let nested = r.bits(1)? as u8;
    r.skip(96)?; // general profile_tier_level, copied byte-wise below
    let mut present = [(false, false); 8];
    for p in present.iter_mut().take(sub_layers) {
        *p = (r.bits(1)? == 1, r.bits(1)? == 1);
    }
    if sub_layers > 0 {
        r.skip(2 * (8 - sub_layers))?;
    }
    for &(profile, level) in present.iter().take(sub_layers) {
        if profile {
            r.skip(88)?;
        }
        if level {
            r.skip(8)?;
        }
    }
    r.ue()?; // sps_seq_parameter_set_id
    let chroma = r.ue()?;
    if chroma == 3 {
        r.skip(1)?; // separate_colour_plane_flag
    }
    r.ue()?; // pic_width_in_luma_samples
    r.ue()?; // pic_height_in_luma_samples
    if r.bits(1)? == 1 {
        for _ in 0..4 {
            r.ue()?; // conformance window offsets
        }
    }
    let luma = r.ue()?;
    let chroma_depth = r.ue()?;
    if chroma > 3 || luma > 7 || chroma_depth > 7 {
        return None;
    }

    let mut out = vec![1];
    out.extend_from_slice(&rbsp[1..13]); // profile, compat, constraints, level
    out.extend_from_slice(&[
        0xF0, // min_spatial_segmentation_idc = 0
        0x00,
        0xFC,                      // parallelismType = 0
        0xFC | chroma as u8,       // chromaFormat
        0xF8 | luma as u8,         // bitDepthLumaMinus8
        0xF8 | chroma_depth as u8, // bitDepthChromaMinus8
        0x00,                      // avgFrameRate = unknown
        0x00,
        // constantFrameRate 0, numTemporalLayers, temporalIdNested,
        // lengthSizeMinusOne = 3.
        ((sub_layers as u8 + 1) << 3) | (nested << 2) | 3,
    ]);
    let arrays: Vec<(u8, &Vec<&[u8]>)> = [(32, &vps), (33, &sps), (34, &pps)]
        .into_iter()
        .filter(|(_, units)| !units.is_empty())
        .collect();
    out.push(arrays.len() as u8);
    for (kind, units) in arrays {
        out.push(0x80 | kind); // array_completeness = 1
        out.extend_from_slice(&(units.len() as u16).to_be_bytes());
        for unit in units {
            out.extend_from_slice(&(unit.len() as u16).to_be_bytes());
            out.extend_from_slice(unit);
        }
    }
    Some(out)
}

/// Drops temporal delimiter OBUs from an AV1 temporal unit: the AV1
/// ISOBMFF binding (§2.4) keeps them out of samples. Data whose OBUs carry
/// no size field is returned unchanged.
pub fn av1_sample(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut at = 0;
    while at < data.len() {
        let header = data[at];
        let kind = (header >> 3) & 0x0F;
        let extension = header & 0x04 != 0;
        if header & 0x02 == 0 {
            return data.to_vec();
        }
        let mut p = at + 1 + usize::from(extension);
        let mut size = 0usize;
        let mut shift = 0;
        loop {
            let Some(&byte) = data.get(p) else {
                return data.to_vec();
            };
            p += 1;
            size |= usize::from(byte & 0x7F) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                break;
            }
            if shift > 56 {
                return data.to_vec();
            }
        }
        let end = p.saturating_add(size);
        if end > data.len() {
            return data.to_vec();
        }
        if kind != 2 {
            out.extend_from_slice(&data[at..end]);
        }
        at = end;
    }
    out
}

/// MSB-first bit reader for RBSP fields.
struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn bits(&mut self, n: usize) -> Option<u64> {
        let mut v = 0;
        for _ in 0..n {
            let byte = *self.data.get(self.pos / 8)?;
            v = (v << 1) | u64::from((byte >> (7 - self.pos % 8)) & 1);
            self.pos += 1;
        }
        Some(v)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        if self.pos + n > self.data.len() * 8 {
            return None;
        }
        self.pos += n;
        Some(())
    }

    /// Exp-Golomb `ue(v)`.
    fn ue(&mut self) -> Option<u64> {
        let mut zeros = 0;
        while self.bits(1)? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1 << zeros) - 1 + self.bits(zeros)?)
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
    fn hvcc_from_real_config() {
        // H.265 config packet from the Android 16 emulator
        // (c2.android.hevc.encoder, Main profile, level 3.1, 228x512).
        let vps: &[u8] = &[
            0x40, 0x01, 0x0C, 0x01, 0xFF, 0xFF, 0x01, 0x40, 0x00, 0x00, 0x03, 0x00, 0xA0, 0x00,
            0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x5D, 0x1B, 0x02, 0x40,
        ];
        let sps: &[u8] = &[
            0x42, 0x01, 0x01, 0x01, 0x40, 0x00, 0x00, 0x03, 0x00, 0xA0, 0x00, 0x00, 0x03, 0x00,
            0x00, 0x03, 0x00, 0x5D, 0xA0, 0x1D, 0x20, 0x08, 0x07, 0x7E, 0x71, 0xB9, 0x24, 0x22,
            0x4B, 0x9A, 0x82, 0x80, 0x83, 0x08, 0x40,
        ];
        let pps: &[u8] = &[0x44, 0x01, 0xC0, 0x18, 0xC3, 0x09, 0x30, 0x33, 0x24];
        let record = hevc_record(&annexb(&[vps, sps, pps])).unwrap();

        let mut expected = vec![
            1,    // configurationVersion
            0x01, // space 0, main tier, Main profile
            0x40, 0x00, 0x00, 0x00, // compatibility: Main
            0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, // progressive, frame only
            0x5D, // level 3.1
            0xF0, 0x00, 0xFC, //
            0xFD, // 4:2:0
            0xF8, 0xF8, // 8-bit
            0x00, 0x00, //
            0x0F, // 1 temporal layer, nested, 4-byte lengths
            3,    // arrays
        ];
        for (kind, unit) in [(32u8, vps), (33, sps), (34, pps)] {
            expected.push(0x80 | kind);
            expected.extend_from_slice(&1u16.to_be_bytes());
            expected.extend_from_slice(&(unit.len() as u16).to_be_bytes());
            expected.extend_from_slice(unit);
        }
        assert_eq!(record, expected);
        // Same SPS fields as the WebCodecs string.
        assert_eq!(
            h265_config(&annexb(&[vps, sps, pps])).unwrap().codec,
            "hvc1.1.2.L93.A0"
        );
        assert!(hevc_record(&annexb(&[vps, pps])).is_none());
    }

    #[test]
    fn av1_samples_lose_temporal_delimiters() {
        // TD (type 2, size 0), sequence header (type 1, 2 bytes), frame
        // (type 6, 3 bytes) with an extension byte.
        let tu = [
            0x12, 0x00, 0x0A, 0x02, 0xAA, 0xBB, 0x36, 0x00, 0x03, 1, 2, 3,
        ];
        assert_eq!(
            av1_sample(&tu),
            [0x0A, 0x02, 0xAA, 0xBB, 0x36, 0x00, 0x03, 1, 2, 3]
        );
        // No size field: left alone.
        assert_eq!(av1_sample(&[0x30, 1, 2]), [0x30, 1, 2]);
        // Truncated: left alone.
        assert_eq!(av1_sample(&[0x0A, 0x05, 1]), [0x0A, 0x05, 1]);
    }

    #[test]
    fn exp_golomb() {
        // 1 → 0, 010 → 1, 011 → 2, 00100 → 3, 00111 → 6.
        let data = [0b1010_0110, 0b0100_0011, 0b1000_0000];
        let mut r = BitReader::new(&data);
        let values: Vec<_> = (0..5).map(|_| r.ue().unwrap()).collect();
        assert_eq!(values, [0, 1, 2, 3, 6]);
        assert!(BitReader::new(&[0, 0]).ue().is_none());
    }

    #[test]
    fn emulation_prevention_is_removed() {
        assert_eq!(
            remove_emulation_prevention(&[0, 0, 3, 1, 0, 0, 3, 0, 3]),
            [0, 0, 1, 0, 0, 0, 3]
        );
    }
}
