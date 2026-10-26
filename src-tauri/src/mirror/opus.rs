//! Opus helpers for recording: the `OpusHead` from the server (RFC 7845
//! §5.1) becomes the `dOps` box of the Opus-in-ISOBMFF binding, and packet
//! durations come from the TOC byte (RFC 6716 §3.1).

/// Opus always decodes at 48 kHz; MP4 timestamps use that clock.
pub const SAMPLE_RATE: u32 = 48_000;

/// What the sample entry needs from an `OpusHead`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpusConfig {
    pub channels: u8,
    /// Samples (at 48 kHz) to discard at the start of the stream.
    pub pre_skip: u16,
    /// Body of the `dOps` box (`OpusSpecificBox`).
    pub dops: Vec<u8>,
}

/// Parses an `OpusHead`: magic, version, channels, pre-skip, input rate,
/// gain, mapping family (+ mapping table). Little-endian on the wire;
/// `dOps` stores the same fields big-endian with version 0.
pub fn parse_opus_head(head: &[u8]) -> Option<OpusConfig> {
    if head.len() < 19 || &head[..8] != b"OpusHead" || head[8] >> 4 != 0 {
        return None;
    }
    let channels = head[9];
    let pre_skip = u16::from_le_bytes([head[10], head[11]]);
    let rate = u32::from_le_bytes([head[12], head[13], head[14], head[15]]);
    let gain = i16::from_le_bytes([head[16], head[17]]);
    let family = head[18];
    if channels == 0 {
        return None;
    }
    let mut dops = Vec::with_capacity(11 + 2 + channels as usize);
    dops.push(0); // Version
    dops.push(channels);
    dops.extend_from_slice(&pre_skip.to_be_bytes());
    dops.extend_from_slice(&rate.to_be_bytes());
    dops.extend_from_slice(&gain.to_be_bytes());
    dops.push(family);
    if family != 0 {
        // StreamCount, CoupledCount, ChannelMapping[channels].
        let table = head.get(19..21 + channels as usize)?;
        dops.extend_from_slice(table);
    }
    Some(OpusConfig {
        channels,
        pre_skip,
        dops,
    })
}

/// Duration of one Opus packet in 48 kHz samples, from its TOC byte.
pub fn packet_samples(packet: &[u8]) -> Option<u32> {
    let toc = *packet.first()?;
    let config = toc >> 3;
    // Frame size in 1/400 s units (2.5 ms = 120 samples).
    let frame = match config {
        0..=11 => [480, 960, 1920, 2880][usize::from(config % 4)],
        12..=15 => [480, 960][usize::from(config % 2)],
        _ => [120, 240, 480, 960][usize::from(config % 4)],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => u32::from(*packet.get(1)? & 0x3F),
    };
    Some(frame * frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 19-byte head scrcpy-server sends for Android's Opus encoder.
    const HEAD: [u8; 19] = [
        b'O', b'p', b'u', b's', b'H', b'e', b'a', b'd', 1, 2, 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn opus_head_becomes_dops() {
        let config = parse_opus_head(&HEAD).unwrap();
        assert_eq!(config.channels, 2);
        assert_eq!(config.pre_skip, 312);
        assert_eq!(config.dops, [0, 2, 0x01, 0x38, 0, 0, 0xBB, 0x80, 0, 0, 0]);
    }

    #[test]
    fn mapping_table_is_kept() {
        let mut head = HEAD.to_vec();
        head[18] = 1;
        head.extend_from_slice(&[1, 1, 0, 1]);
        let config = parse_opus_head(&head).unwrap();
        assert_eq!(&config.dops[11..], [1, 1, 0, 1]);
        // Family 1 without its table is invalid.
        assert!(parse_opus_head(&head[..20]).is_none());
    }

    #[test]
    fn rejects_other_data() {
        assert!(parse_opus_head(b"AOPUSHDR\x13\0\0\0\0\0\0\0OpusHead").is_none());
        assert!(parse_opus_head(&HEAD[..18]).is_none());
        let mut v2 = HEAD;
        v2[8] = 0x10;
        assert!(parse_opus_head(&v2).is_none());
    }

    #[test]
    fn packet_durations() {
        // CELT fullband 20 ms, one frame (Android's default).
        assert_eq!(packet_samples(&[0xFC, 0xAA]), Some(960));
        // CELT 10 ms, two frames.
        assert_eq!(packet_samples(&[0xF1, 0]), Some(960));
        // SILK 60 ms, one frame.
        assert_eq!(packet_samples(&[0x18]), Some(2880));
        // Hybrid 10 ms, code 3 with 3 frames.
        assert_eq!(packet_samples(&[0x63, 0x03]), Some(1440));
        // CELT 2.5 ms.
        assert_eq!(packet_samples(&[0x80]), Some(120));
        assert_eq!(packet_samples(&[]), None);
        assert_eq!(packet_samples(&[0x03]), None);
    }
}
