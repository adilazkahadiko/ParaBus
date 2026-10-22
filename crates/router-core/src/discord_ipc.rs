use std::collections::VecDeque;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::Serialize;

pub const DISCORD_IPC_MAGIC: &[u8; 4] = b"DBR1";
pub const DISCORD_IPC_VERSION: u8 = 1;
pub const DISCORD_IPC_HEADER_BYTES: usize = 56;
pub const DISCORD_IPC_MAX_FRAME_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordFrame {
    pub frame_type: u8,
    pub flags: u16,
    pub sequence: u32,
    pub rtp_timestamp: u32,
    /// DBR1 v1 header offset 20; zero is the legacy/no-generation value.
    pub source_generation: u32,
    pub bot_id: u64,
    pub guild_id: u64,
    pub voice_channel_id: u64,
    pub user_id: u64,
    pub payload: Vec<u8>,
}

impl DiscordFrame {
    pub fn wire_bytes(&self) -> usize {
        DISCORD_IPC_HEADER_BYTES + self.payload.len()
    }

    pub fn is_metadata(&self) -> bool {
        self.frame_type != 1 && self.frame_type != 8
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordFrameProjection {
    #[serde(rename = "type")]
    pub frame_type: u8,
    pub flags: u16,
    pub sequence: u32,
    pub rtp_timestamp: u32,
    pub source_generation: u32,
    pub bot_id: String,
    pub guild_id: String,
    pub voice_channel_id: String,
    pub user_id: String,
    pub payload_bytes: usize,
    pub payload_hash: String,
}

pub fn project_discord_frame(frame: &DiscordFrame) -> DiscordFrameProjection {
    DiscordFrameProjection {
        frame_type: frame.frame_type,
        flags: frame.flags,
        sequence: frame.sequence,
        rtp_timestamp: frame.rtp_timestamp,
        source_generation: frame.source_generation,
        bot_id: frame.bot_id.to_string(),
        guild_id: frame.guild_id.to_string(),
        voice_channel_id: frame.voice_channel_id.to_string(),
        user_id: frame.user_id.to_string(),
        payload_bytes: frame.payload.len(),
        payload_hash: format!("{:016x}", fnv1a64(&frame.payload)),
    }
}

pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscordIpcError {
    IncompleteHeader,
    InvalidMagic,
    UnsupportedVersion(u8),
    InvalidFrameLength(u32),
    UnknownFrameType(u8),
}

impl Display for DiscordIpcError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::IncompleteHeader => formatter.write_str("incomplete Discord IPC header"),
            Self::InvalidMagic => formatter.write_str("invalid Discord IPC magic"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported Discord IPC version: {version}")
            }
            Self::InvalidFrameLength(length) => {
                write!(formatter, "invalid Discord IPC frame length: {length}")
            }
            Self::UnknownFrameType(frame_type) => {
                write!(formatter, "unknown Discord IPC frame type: {frame_type}")
            }
        }
    }
}

impl Error for DiscordIpcError {}

fn checked_frame_length(header: &[u8]) -> Result<usize, DiscordIpcError> {
    if header.len() < DISCORD_IPC_HEADER_BYTES {
        return Err(DiscordIpcError::IncompleteHeader);
    }
    if &header[..4] != DISCORD_IPC_MAGIC {
        return Err(DiscordIpcError::InvalidMagic);
    }
    if header[4] != DISCORD_IPC_VERSION {
        return Err(DiscordIpcError::UnsupportedVersion(header[4]));
    }
    if !(1..=10).contains(&header[5]) {
        return Err(DiscordIpcError::UnknownFrameType(header[5]));
    }
    let length = u32::from_be_bytes(header[8..12].try_into().expect("fixed header slice"));
    if length < DISCORD_IPC_HEADER_BYTES as u32 || length as usize > DISCORD_IPC_MAX_FRAME_BYTES {
        return Err(DiscordIpcError::InvalidFrameLength(length));
    }
    Ok(length as usize)
}

pub fn decode_discord_frame(bytes: &[u8]) -> Result<DiscordFrame, DiscordIpcError> {
    let length = checked_frame_length(bytes)?;
    if length != bytes.len() {
        return Err(DiscordIpcError::InvalidFrameLength(length as u32));
    }
    Ok(DiscordFrame {
        frame_type: bytes[5],
        flags: u16::from_be_bytes(bytes[6..8].try_into().expect("fixed header slice")),
        sequence: u32::from_be_bytes(bytes[12..16].try_into().expect("fixed header slice")),
        rtp_timestamp: u32::from_be_bytes(bytes[16..20].try_into().expect("fixed header slice")),
        source_generation: u32::from_be_bytes(
            bytes[20..24].try_into().expect("fixed header slice"),
        ),
        bot_id: u64::from_be_bytes(bytes[24..32].try_into().expect("fixed header slice")),
        guild_id: u64::from_be_bytes(bytes[32..40].try_into().expect("fixed header slice")),
        voice_channel_id: u64::from_be_bytes(bytes[40..48].try_into().expect("fixed header slice")),
        user_id: u64::from_be_bytes(bytes[48..56].try_into().expect("fixed header slice")),
        payload: bytes[DISCORD_IPC_HEADER_BYTES..].to_vec(),
    })
}

#[derive(Debug, Default)]
pub struct DiscordStreamDecoder {
    buffer: Vec<u8>,
}

impl DiscordStreamDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<DiscordFrame>, DiscordIpcError> {
        match self.push_inner(chunk) {
            Ok(frames) => Ok(frames),
            Err(error) => {
                self.buffer.clear();
                Err(error)
            }
        }
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }

    fn push_inner(&mut self, mut chunk: &[u8]) -> Result<Vec<DiscordFrame>, DiscordIpcError> {
        let mut decoded = Vec::new();
        while !chunk.is_empty() {
            if self.buffer.is_empty() && chunk.len() >= DISCORD_IPC_HEADER_BYTES {
                let frame_length = checked_frame_length(chunk)?;
                if chunk.len() >= frame_length {
                    decoded.push(decode_discord_frame(&chunk[..frame_length])?);
                    chunk = &chunk[frame_length..];
                    continue;
                }
            }

            let target = if self.buffer.len() < DISCORD_IPC_HEADER_BYTES {
                DISCORD_IPC_HEADER_BYTES
            } else {
                checked_frame_length(&self.buffer)?
            };
            let take = (target - self.buffer.len()).min(chunk.len());
            self.buffer.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];

            let frame_length = if self.buffer.len() >= DISCORD_IPC_HEADER_BYTES {
                checked_frame_length(&self.buffer)?
            } else {
                continue;
            };
            if self.buffer.len() == frame_length {
                decoded.push(decode_discord_frame(&self.buffer)?);
                self.buffer.clear();
            }
        }
        Ok(decoded)
    }
}

#[derive(Debug)]
pub struct BoundedDiscordQueue {
    frames: VecDeque<DiscordFrame>,
    max_frames: usize,
    max_bytes: usize,
    queued_bytes: usize,
    dropped_frames: u64,
}

impl BoundedDiscordQueue {
    pub fn new(max_frames: usize, max_bytes: usize) -> Self {
        assert!(
            max_frames > 0,
            "Discord queue must accept at least one frame"
        );
        assert!(
            max_bytes >= DISCORD_IPC_HEADER_BYTES,
            "Discord queue byte bound must fit one header"
        );
        Self {
            frames: VecDeque::with_capacity(max_frames),
            max_frames,
            max_bytes,
            queued_bytes: 0,
            dropped_frames: 0,
        }
    }

    pub fn push(&mut self, frame: DiscordFrame) -> bool {
        let frame_bytes = frame.wire_bytes();
        if frame_bytes > self.max_bytes {
            self.dropped_frames += 1;
            return false;
        }
        while self.frames.len() >= self.max_frames
            || self.queued_bytes + frame_bytes > self.max_bytes
        {
            let dropped = self
                .frames
                .pop_front()
                .expect("queue limit requires an old frame");
            self.queued_bytes -= dropped.wire_bytes();
            self.dropped_frames += 1;
        }
        self.queued_bytes += frame_bytes;
        self.frames.push_back(frame);
        true
    }

    pub fn pop(&mut self) -> Option<DiscordFrame> {
        let frame = self.frames.pop_front()?;
        self.queued_bytes -= frame.wire_bytes();
        Some(frame)
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped_frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        version: u8,
        frames: Vec<FixtureFrame>,
        stream_chunks: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    struct FixtureFrame {
        name: String,
        hex: String,
        expected: ExpectedFrame,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedFrame {
        #[serde(rename = "type")]
        frame_type: u8,
        flags: u16,
        sequence: u32,
        rtp_timestamp: u32,
        #[serde(default)]
        source_generation: u32,
        bot_id: String,
        guild_id: String,
        voice_channel_id: String,
        user_id: String,
        payload_hex: String,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(
            "../../../tests/core-ipc/fixtures/discord-ipc-v1.json"
        ))
        .unwrap()
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        assert!(value.len().is_multiple_of(2));
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }

    fn assert_fixture_frame(frame: &DiscordFrame, expected: &ExpectedFrame) {
        assert_eq!(frame.frame_type, expected.frame_type);
        assert_eq!(frame.flags, expected.flags);
        assert_eq!(frame.sequence, expected.sequence);
        assert_eq!(frame.rtp_timestamp, expected.rtp_timestamp);
        assert_eq!(frame.source_generation, expected.source_generation);
        assert_eq!(frame.bot_id.to_string(), expected.bot_id);
        assert_eq!(frame.guild_id.to_string(), expected.guild_id);
        assert_eq!(
            frame.voice_channel_id.to_string(),
            expected.voice_channel_id
        );
        assert_eq!(frame.user_id.to_string(), expected.user_id);
        assert_eq!(frame.payload, decode_hex(&expected.payload_hex));
    }

    #[test]
    fn shared_typescript_fixture_has_rust_frame_parity() {
        let fixture = fixture();
        assert_eq!(fixture.version, DISCORD_IPC_VERSION);
        for case in fixture.frames {
            let decoded = decode_discord_frame(&decode_hex(&case.hex))
                .unwrap_or_else(|error| panic!("{} failed: {error}", case.name));
            assert_fixture_frame(&decoded, &case.expected);
        }
    }

    #[test]
    fn stream_decoder_handles_shared_split_and_coalesced_chunks() {
        let fixture = fixture();
        let mut frames = fixture.frames;
        let generation = frames.remove(3);
        let expected: Vec<ExpectedFrame> = frames
            .into_iter()
            .map(|frame| frame.expected)
            .chain(std::iter::once(generation.expected))
            .collect();
        let mut decoder = DiscordStreamDecoder::default();
        let mut decoded = Vec::new();
        for chunk in fixture.stream_chunks {
            decoded.extend(decoder.push(&decode_hex(&chunk)).unwrap());
            assert!(decoder.buffered_bytes() <= DISCORD_IPC_MAX_FRAME_BYTES);
        }
        assert_eq!(decoded.len(), expected.len());
        for (frame, expected) in decoded.iter().zip(&expected) {
            assert_fixture_frame(frame, expected);
        }
        assert_eq!(decoder.buffered_bytes(), 0);
    }

    #[test]
    fn invalid_or_oversized_headers_are_rejected_and_buffer_is_cleared() {
        let mut decoder = DiscordStreamDecoder::default();
        let mut oversized = vec![0_u8; DISCORD_IPC_HEADER_BYTES];
        oversized[..4].copy_from_slice(DISCORD_IPC_MAGIC);
        oversized[4] = DISCORD_IPC_VERSION;
        oversized[5] = 7;
        oversized[8..12].copy_from_slice(&((DISCORD_IPC_MAX_FRAME_BYTES as u32) + 1).to_be_bytes());
        assert!(matches!(
            decoder.push(&oversized),
            Err(DiscordIpcError::InvalidFrameLength(_))
        ));
        assert_eq!(decoder.buffered_bytes(), 0);

        let mut unknown = oversized;
        unknown[5] = 99;
        unknown[8..12].copy_from_slice(&(DISCORD_IPC_HEADER_BYTES as u32).to_be_bytes());
        assert_eq!(
            decoder.push(&unknown),
            Err(DiscordIpcError::UnknownFrameType(99))
        );
        assert_eq!(decoder.buffered_bytes(), 0);
    }

    #[test]
    fn queue_evicts_oldest_frames_with_bounded_drop_accounting() {
        let fixture = fixture();
        let frames: Vec<DiscordFrame> = fixture
            .frames
            .iter()
            .map(|case| decode_discord_frame(&decode_hex(&case.hex)).unwrap())
            .collect();
        let max_bytes = frames[3].wire_bytes() + frames[4].wire_bytes();
        let mut queue = BoundedDiscordQueue::new(2, max_bytes);
        for frame in frames {
            assert!(queue.push(frame));
            assert!(queue.len() <= 2);
            assert!(queue.queued_bytes() <= max_bytes);
        }
        assert_eq!(queue.dropped_frames(), 3);
        assert_eq!(queue.pop().unwrap().frame_type, 3);
        assert_eq!(queue.pop().unwrap().frame_type, 10);
        assert!(queue.is_empty());
        assert_eq!(queue.queued_bytes(), 0);
    }

    #[test]
    fn projection_hash_uses_standard_fnv1a64() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"hello"), 0xa430_d846_80aa_bd0b);
    }
}
