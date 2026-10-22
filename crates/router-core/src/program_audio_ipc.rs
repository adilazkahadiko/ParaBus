use std::collections::VecDeque;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::Serialize;

pub const PROGRAM_AUDIO_MAGIC: &[u8; 4] = b"PGM1";
pub const PROGRAM_AUDIO_VERSION: u8 = 1;
pub const PROGRAM_AUDIO_HEADER_BYTES: usize = 32;
pub const PROGRAM_AUDIO_SAMPLE_RATE: u32 = 48_000;
pub const PROGRAM_AUDIO_FRAMES: usize = 480;
pub const PROGRAM_AUDIO_MAX_CHANNELS: usize = 64;
pub const PROGRAM_AUDIO_MAX_PAYLOAD_BYTES: usize =
    PROGRAM_AUDIO_FRAMES * PROGRAM_AUDIO_MAX_CHANNELS * 4;
pub const PROGRAM_AUDIO_MAX_FRAME_BYTES: usize =
    PROGRAM_AUDIO_HEADER_BYTES + PROGRAM_AUDIO_MAX_PAYLOAD_BYTES;

#[derive(Debug, Clone, PartialEq)]
pub struct ProgramAudioFrame {
    pub sequence: u64,
    pub channels: u8,
    pub payload: Vec<u8>,
}
impl ProgramAudioFrame {
    pub fn wire_bytes(&self) -> usize {
        PROGRAM_AUDIO_HEADER_BYTES + self.payload.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgramAudioIpcError {
    IncompleteHeader,
    InvalidMagic,
    UnsupportedVersion(u8),
    UnknownFrameType(u8),
    InvalidShape,
    InvalidLength,
    NonFiniteSample,
    TruncatedAtEof,
}
impl Display for ProgramAudioIpcError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::IncompleteHeader => f.write_str("incomplete Program Audio header"),
            Self::InvalidMagic => f.write_str("invalid Program Audio magic"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported Program Audio version: {v}"),
            Self::UnknownFrameType(t) => write!(f, "unknown Program Audio frame type: {t}"),
            Self::InvalidShape => f.write_str("invalid Program Audio shape"),
            Self::InvalidLength => f.write_str("invalid Program Audio frame length"),
            Self::NonFiniteSample => f.write_str("non-finite Program Audio sample"),
            Self::TruncatedAtEof => f.write_str("truncated Program Audio frame at EOF"),
        }
    }
}
impl Error for ProgramAudioIpcError {}

fn checked_length(header: &[u8]) -> Result<usize, ProgramAudioIpcError> {
    if header.len() < PROGRAM_AUDIO_HEADER_BYTES {
        return Err(ProgramAudioIpcError::IncompleteHeader);
    }
    if &header[..4] != PROGRAM_AUDIO_MAGIC {
        return Err(ProgramAudioIpcError::InvalidMagic);
    }
    if header[4] != PROGRAM_AUDIO_VERSION {
        return Err(ProgramAudioIpcError::UnsupportedVersion(header[4]));
    }
    if header[5] != 1 {
        return Err(ProgramAudioIpcError::UnknownFrameType(header[5]));
    }
    let channels = usize::from(header[6]);
    if !(1..=PROGRAM_AUDIO_MAX_CHANNELS).contains(&channels)
        || header[7] != 0
        || u16::from_be_bytes(header[14..16].try_into().unwrap()) != 0
        || u32::from_be_bytes(header[28..32].try_into().unwrap()) != 0
    {
        return Err(ProgramAudioIpcError::InvalidShape);
    }
    if u32::from_be_bytes(header[8..12].try_into().unwrap()) != PROGRAM_AUDIO_SAMPLE_RATE
        || usize::from(u16::from_be_bytes(header[12..14].try_into().unwrap()))
            != PROGRAM_AUDIO_FRAMES
    {
        return Err(ProgramAudioIpcError::InvalidShape);
    }
    let payload = usize::try_from(u32::from_be_bytes(header[24..28].try_into().unwrap()))
        .map_err(|_| ProgramAudioIpcError::InvalidLength)?;
    let expected = PROGRAM_AUDIO_FRAMES
        .checked_mul(channels)
        .and_then(|v| v.checked_mul(4))
        .ok_or(ProgramAudioIpcError::InvalidLength)?;
    if payload != expected {
        return Err(ProgramAudioIpcError::InvalidLength);
    }
    PROGRAM_AUDIO_HEADER_BYTES
        .checked_add(payload)
        .filter(|v| *v <= PROGRAM_AUDIO_MAX_FRAME_BYTES)
        .ok_or(ProgramAudioIpcError::InvalidLength)
}

pub fn decode_program_audio_frame(bytes: &[u8]) -> Result<ProgramAudioFrame, ProgramAudioIpcError> {
    let length = checked_length(bytes)?;
    if length != bytes.len() {
        return Err(ProgramAudioIpcError::InvalidLength);
    }
    for sample in bytes[PROGRAM_AUDIO_HEADER_BYTES..].chunks_exact(4) {
        if !f32::from_le_bytes(sample.try_into().unwrap()).is_finite() {
            return Err(ProgramAudioIpcError::NonFiniteSample);
        }
    }
    Ok(ProgramAudioFrame {
        sequence: u64::from_be_bytes(bytes[16..24].try_into().unwrap()),
        channels: bytes[6],
        payload: bytes[PROGRAM_AUDIO_HEADER_BYTES..].to_vec(),
    })
}

#[derive(Debug, Default)]
pub struct ProgramAudioStreamDecoder {
    buffer: Vec<u8>,
}
impl ProgramAudioStreamDecoder {
    pub fn push(
        &mut self,
        mut chunk: &[u8],
    ) -> Result<Vec<ProgramAudioFrame>, ProgramAudioIpcError> {
        let outcome = self.push_inner(&mut chunk);
        if outcome.is_err() {
            self.buffer.clear();
        }
        outcome
    }
    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }
    pub fn finish(&mut self) -> Result<(), ProgramAudioIpcError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            self.buffer.clear();
            Err(ProgramAudioIpcError::TruncatedAtEof)
        }
    }
    fn push_inner(
        &mut self,
        chunk: &mut &[u8],
    ) -> Result<Vec<ProgramAudioFrame>, ProgramAudioIpcError> {
        let mut result = Vec::new();
        while !chunk.is_empty() {
            if self.buffer.is_empty() && chunk.len() >= PROGRAM_AUDIO_HEADER_BYTES {
                let length = checked_length(chunk)?;
                if chunk.len() >= length {
                    result.push(decode_program_audio_frame(&chunk[..length])?);
                    *chunk = &chunk[length..];
                    continue;
                }
            }
            let target = if self.buffer.len() < PROGRAM_AUDIO_HEADER_BYTES {
                PROGRAM_AUDIO_HEADER_BYTES
            } else {
                checked_length(&self.buffer)?
            };
            let take = (target - self.buffer.len()).min(chunk.len());
            self.buffer.extend_from_slice(&chunk[..take]);
            *chunk = &chunk[take..];
            let completed_length = if self.buffer.len() >= PROGRAM_AUDIO_HEADER_BYTES {
                Some(checked_length(&self.buffer)?)
            } else {
                None
            };
            if completed_length == Some(self.buffer.len()) {
                result.push(decode_program_audio_frame(&self.buffer)?);
                self.buffer.clear();
            }
        }
        Ok(result)
    }
}

#[derive(Debug)]
pub struct BoundedProgramAudioQueue {
    frames: VecDeque<ProgramAudioFrame>,
    max_frames: usize,
    max_bytes: usize,
    queued_bytes: usize,
    dropped_frames: u64,
}
impl BoundedProgramAudioQueue {
    pub fn new(max_frames: usize, max_bytes: usize) -> Self {
        assert!(max_frames > 0);
        assert!(max_bytes >= PROGRAM_AUDIO_HEADER_BYTES);
        Self {
            frames: VecDeque::with_capacity(max_frames),
            max_frames,
            max_bytes,
            queued_bytes: 0,
            dropped_frames: 0,
        }
    }
    /// Never blocks production: evict oldest queued shadow frames, so stale audio cannot be replayed later.
    pub fn push(&mut self, frame: ProgramAudioFrame) -> bool {
        let size = frame.wire_bytes();
        if size > self.max_bytes {
            self.dropped_frames = self.dropped_frames.saturating_add(1);
            return false;
        }
        while self.frames.len() >= self.max_frames
            || self
                .queued_bytes
                .checked_add(size)
                .is_none_or(|v| v > self.max_bytes)
        {
            let dropped = self.frames.pop_front().expect("queue limit has a frame");
            self.queued_bytes -= dropped.wire_bytes();
            self.dropped_frames = self.dropped_frames.saturating_add(1);
        }
        self.queued_bytes += size;
        self.frames.push_back(frame);
        true
    }
    pub fn pop(&mut self) -> Option<ProgramAudioFrame> {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramAudioProjection {
    pub sequence: String,
    pub channels: u8,
    pub frames: usize,
    pub payload_bytes: usize,
    pub payload_hash: String,
    pub peak: f64,
}
pub fn project_program_audio_frame(frame: &ProgramAudioFrame) -> ProgramAudioProjection {
    let peak = frame
        .payload
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()).abs())
        .fold(0.0_f32, f32::max);
    ProgramAudioProjection {
        sequence: frame.sequence.to_string(),
        channels: frame.channels,
        frames: PROGRAM_AUDIO_FRAMES,
        payload_bytes: frame.payload.len(),
        payload_hash: format!("{:016x}", fnv1a64(&frame.payload)),
        peak: f64::from(peak),
    }
}
fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encoded(sequence: u64, channels: u8) -> Vec<u8> {
        let payload = PROGRAM_AUDIO_FRAMES * usize::from(channels) * 4;
        let mut b = vec![0; PROGRAM_AUDIO_HEADER_BYTES + payload];
        b[..4].copy_from_slice(PROGRAM_AUDIO_MAGIC);
        b[4] = 1;
        b[5] = 1;
        b[6] = channels;
        b[8..12].copy_from_slice(&PROGRAM_AUDIO_SAMPLE_RATE.to_be_bytes());
        b[12..14].copy_from_slice(&(PROGRAM_AUDIO_FRAMES as u16).to_be_bytes());
        b[16..24].copy_from_slice(&sequence.to_be_bytes());
        b[24..28].copy_from_slice(&(payload as u32).to_be_bytes());
        b[32..36].copy_from_slice(&0.5f32.to_le_bytes());
        b
    }
    #[test]
    fn decodes_split_and_coalesced_frames() {
        let a = encoded(1, 1);
        let b = encoded(2, 2);
        let mut d = ProgramAudioStreamDecoder::default();
        assert!(d.push(&a[..7]).unwrap().is_empty());
        let mut tail = a[7..].to_vec();
        tail.extend_from_slice(&b);
        let frames = d.push(&tail).unwrap();
        assert_eq!(
            frames.iter().map(|f| f.sequence).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(d.buffered_bytes(), 0);
        assert!(d.finish().is_ok());
    }
    #[test]
    fn invalid_headers_and_nonfinite_samples_fail_closed() {
        let mut d = ProgramAudioStreamDecoder::default();
        let mut x = encoded(1, 1);
        x[4] = 9;
        assert!(d.push(&x).is_err());
        assert_eq!(d.buffered_bytes(), 0);
        let mut unknown = encoded(1, 1);
        unknown[5] = 99;
        assert_eq!(
            d.push(&unknown),
            Err(ProgramAudioIpcError::UnknownFrameType(99))
        );
        let mut oversized = encoded(1, 1);
        oversized[6] = 65;
        assert_eq!(d.push(&oversized), Err(ProgramAudioIpcError::InvalidShape));
        let mut y = encoded(1, 1);
        y[32..36].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(
            decode_program_audio_frame(&y),
            Err(ProgramAudioIpcError::NonFiniteSample)
        );
        assert!(d.push(&encoded(1, 1)[..11]).unwrap().is_empty());
        assert_eq!(d.finish(), Err(ProgramAudioIpcError::TruncatedAtEof));
        assert_eq!(d.buffered_bytes(), 0);
    }
    #[test]
    fn queue_evicts_oldest_and_bounds_bytes() {
        let a = decode_program_audio_frame(&encoded(1, 1)).unwrap();
        let b = decode_program_audio_frame(&encoded(2, 1)).unwrap();
        let bytes = a.wire_bytes();
        let mut q = BoundedProgramAudioQueue::new(1, bytes);
        assert!(q.push(a));
        assert!(q.push(b));
        assert_eq!(q.dropped_frames(), 1);
        assert_eq!(q.pop().unwrap().sequence, 2);
        assert_eq!(q.queued_bytes(), 0);
    }
    #[test]
    fn queue_evicts_for_byte_bound_and_rejects_oversized_single_frame() {
        let a = decode_program_audio_frame(&encoded(1, 1)).unwrap();
        let b = decode_program_audio_frame(&encoded(2, 1)).unwrap();
        let bytes = a.wire_bytes();
        let mut q = BoundedProgramAudioQueue::new(3, bytes + 1);
        assert!(q.push(a));
        assert!(q.push(b));
        assert_eq!(q.len(), 1, "byte limit, not frame limit, evicts oldest");
        assert_eq!(q.pop().unwrap().sequence, 2);
        let too_large = decode_program_audio_frame(&encoded(3, 2)).unwrap();
        assert!(!q.push(too_large));
        assert!(q.is_empty());
        assert_eq!(q.dropped_frames(), 2);
    }
}
