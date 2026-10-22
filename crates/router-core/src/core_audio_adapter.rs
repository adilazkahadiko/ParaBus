use std::error::Error;
use std::fmt::{Display, Formatter};

use serde::Serialize;

use crate::audio_callback::{CallbackControl, CallbackOutputConsumer};
use crate::{BLOCK_SIZE, SAMPLE_RATE};

const MAX_OUTPUT_CHANNELS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoreAudioSampleFormat {
    Float32,
    Signed16,
    Signed24,
    Signed32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAudioStreamFormat {
    pub sample_rate: u32,
    pub frames_per_buffer: usize,
    pub channels: usize,
    pub sample_format: CoreAudioSampleFormat,
}

impl CoreAudioStreamFormat {
    pub fn production(channels: usize) -> Self {
        Self {
            sample_rate: SAMPLE_RATE,
            frames_per_buffer: BLOCK_SIZE as usize,
            channels,
            sample_format: CoreAudioSampleFormat::Float32,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAudioDevice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreAudioAdapterError {
    DeviceIdRequired,
    UnsupportedSampleRate,
    UnsupportedBlockSize,
    UnsupportedChannelCount,
    UnsupportedSampleFormat,
    GraphOutputMismatch,
    QueueBlockMismatch,
}

impl Display for CoreAudioAdapterError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::DeviceIdRequired => "an explicit Core Audio device ID is required",
            Self::UnsupportedSampleRate => "Core Audio sample rate must be 48 or 96 kHz",
            Self::UnsupportedBlockSize => {
                "Core Audio buffer must span exactly 10 ms at the device sample rate"
            }
            Self::UnsupportedChannelCount => "Core Audio channel count must be within 1..64",
            Self::UnsupportedSampleFormat => "Core Audio sample format must be Float32",
            Self::GraphOutputMismatch => "Core Audio channels exceed the graph output count",
            Self::QueueBlockMismatch => "callback output queue does not match the graph format",
        };
        formatter.write_str(message)
    }
}

impl Error for CoreAudioAdapterError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoreAudioAdapterState {
    Stopped,
    Ready,
    Fault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoreAudioFaultReason {
    DeviceLost,
    FormatChanged,
    CallbackBufferSizeChanged,
    QueueSizeMismatch,
    NonFiniteAudio,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreAudioAdapterSnapshot {
    pub state: CoreAudioAdapterState,
    pub selected_device_id: String,
    pub format: CoreAudioStreamFormat,
    pub render_callbacks: u64,
    pub rendered_frames: u64,
    pub output_underruns: u64,
    pub stale_blocks_discarded: u64,
    pub device_faults: u64,
    pub format_faults: u64,
    pub callback_faults: u64,
    pub fault_latched: bool,
    pub fault_reason: Option<CoreAudioFaultReason>,
}

pub struct CoreAudioRenderAdapter {
    device: CoreAudioDevice,
    format: CoreAudioStreamFormat,
    output: CallbackOutputConsumer,
    control: CallbackControl,
    planar_scratch: Vec<f32>,
    resample_previous: Vec<f32>,
    device_rate_ratio: usize,
    snapshot: CoreAudioAdapterSnapshot,
}

impl CoreAudioRenderAdapter {
    pub fn new(
        device: CoreAudioDevice,
        format: CoreAudioStreamFormat,
        graph_output_channels: usize,
        output: CallbackOutputConsumer,
        control: CallbackControl,
    ) -> Result<Self, CoreAudioAdapterError> {
        if device.id.trim().is_empty() {
            return Err(CoreAudioAdapterError::DeviceIdRequired);
        }
        if !format.sample_rate.is_multiple_of(SAMPLE_RATE)
            || format.sample_rate / SAMPLE_RATE == 0
            || format.sample_rate / SAMPLE_RATE > 2
        {
            return Err(CoreAudioAdapterError::UnsupportedSampleRate);
        }
        let device_rate_ratio = (format.sample_rate / SAMPLE_RATE) as usize;
        if format.frames_per_buffer != BLOCK_SIZE as usize * device_rate_ratio {
            return Err(CoreAudioAdapterError::UnsupportedBlockSize);
        }
        if format.channels == 0 || format.channels > MAX_OUTPUT_CHANNELS {
            return Err(CoreAudioAdapterError::UnsupportedChannelCount);
        }
        if format.sample_format != CoreAudioSampleFormat::Float32 {
            return Err(CoreAudioAdapterError::UnsupportedSampleFormat);
        }
        if format.channels > graph_output_channels || graph_output_channels > MAX_OUTPUT_CHANNELS {
            return Err(CoreAudioAdapterError::GraphOutputMismatch);
        }
        let queue_block_size = (BLOCK_SIZE as usize)
            .checked_mul(graph_output_channels)
            .ok_or(CoreAudioAdapterError::QueueBlockMismatch)?;
        if output.block_size() != queue_block_size {
            return Err(CoreAudioAdapterError::QueueBlockMismatch);
        }
        let selected_device_id = device.id.clone();
        Ok(Self {
            device,
            format,
            output,
            control,
            planar_scratch: vec![0.0; queue_block_size],
            resample_previous: vec![0.0; format.channels],
            device_rate_ratio,
            snapshot: CoreAudioAdapterSnapshot {
                state: CoreAudioAdapterState::Stopped,
                selected_device_id,
                format,
                render_callbacks: 0,
                rendered_frames: 0,
                output_underruns: 0,
                stale_blocks_discarded: 0,
                device_faults: 0,
                format_faults: 0,
                callback_faults: 0,
                fault_latched: false,
                fault_reason: None,
            },
        })
    }

    pub fn start(&mut self) -> bool {
        if self.snapshot.fault_latched {
            self.snapshot.state = CoreAudioAdapterState::Fault;
            return false;
        }
        let queued_at_start = self.output.queued_blocks();
        for _ in 0..queued_at_start {
            match self.output.try_pop(&mut self.planar_scratch) {
                Ok(true) => {
                    self.snapshot.stale_blocks_discarded =
                        self.snapshot.stale_blocks_discarded.saturating_add(1);
                }
                Ok(false) => break,
                Err(_) => {
                    self.latch_callback_fault(CoreAudioFaultReason::QueueSizeMismatch);
                    return false;
                }
            }
        }
        self.resample_previous.fill(0.0);
        self.control.set_device_connected(true);
        self.snapshot.state = CoreAudioAdapterState::Ready;
        true
    }

    pub fn stop(&mut self) {
        if !self.snapshot.fault_latched {
            self.snapshot.state = CoreAudioAdapterState::Stopped;
        }
    }

    pub fn render(&mut self, interleaved_output: &mut [f32]) {
        self.snapshot.render_callbacks = self.snapshot.render_callbacks.saturating_add(1);
        interleaved_output.fill(0.0);
        let expected_samples = self.format.frames_per_buffer * self.format.channels;
        if interleaved_output.len() != expected_samples {
            self.latch_callback_fault(CoreAudioFaultReason::CallbackBufferSizeChanged);
            return;
        }
        if self.snapshot.state != CoreAudioAdapterState::Ready || self.snapshot.fault_latched {
            return;
        }
        let received = match self.output.try_pop(&mut self.planar_scratch) {
            Ok(received) => received,
            Err(_) => {
                self.latch_callback_fault(CoreAudioFaultReason::QueueSizeMismatch);
                return;
            }
        };
        if !received {
            self.snapshot.output_underruns = self.snapshot.output_underruns.saturating_add(1);
            self.resample_previous.fill(0.0);
            return;
        }
        if self.planar_scratch.iter().any(|sample| !sample.is_finite()) {
            self.latch_callback_fault(CoreAudioFaultReason::NonFiniteAudio);
            return;
        }
        if self.planar_scratch.iter().all(|sample| *sample == 0.0) {
            self.resample_previous.fill(0.0);
        }
        let graph_frames = BLOCK_SIZE as usize;
        for channel in 0..self.format.channels {
            let channel_offset = channel * graph_frames;
            let mut previous = self.resample_previous[channel];
            for source_frame in 0..graph_frames {
                let current = self.planar_scratch[channel_offset + source_frame];
                let device_frame = source_frame * self.device_rate_ratio;
                if self.device_rate_ratio == 1 {
                    interleaved_output[device_frame * self.format.channels + channel] = current;
                } else {
                    interleaved_output[device_frame * self.format.channels + channel] =
                        (previous + current) * 0.5;
                    interleaved_output[(device_frame + 1) * self.format.channels + channel] =
                        current;
                }
                previous = current;
            }
            self.resample_previous[channel] = previous;
        }
        self.snapshot.rendered_frames = self
            .snapshot
            .rendered_frames
            .saturating_add(self.format.frames_per_buffer as u64);
    }

    /// Scalar values avoid cloning the diagnostic snapshot in the render hot path.
    pub fn render_counters(&self) -> (u64, u64) {
        (
            self.snapshot.render_callbacks,
            self.snapshot.output_underruns,
        )
    }

    pub fn notify_device_lost(&mut self, device_id: &str) {
        if device_id != self.device.id || self.snapshot.fault_latched {
            return;
        }
        self.snapshot.device_faults = self.snapshot.device_faults.saturating_add(1);
        self.latch_fault(CoreAudioFaultReason::DeviceLost);
    }

    pub fn notify_format_changed(&mut self, device_id: &str, format: CoreAudioStreamFormat) {
        if device_id != self.device.id || format == self.format || self.snapshot.fault_latched {
            return;
        }
        self.snapshot.format_faults = self.snapshot.format_faults.saturating_add(1);
        self.latch_fault(CoreAudioFaultReason::FormatChanged);
    }

    pub fn notify_device_available(&mut self, _device_id: &str) {
        // Availability alone never clears a latched fault or changes the explicit selection.
    }

    pub fn snapshot(&self) -> CoreAudioAdapterSnapshot {
        self.snapshot.clone()
    }

    pub fn selected_device_id(&self) -> &str {
        &self.device.id
    }

    pub fn format(&self) -> CoreAudioStreamFormat {
        self.format
    }

    pub fn is_fault_latched(&self) -> bool {
        self.snapshot.fault_latched
    }

    pub fn notify_callback_buffer_size_changed(&mut self) {
        self.latch_callback_fault(CoreAudioFaultReason::CallbackBufferSizeChanged);
    }

    fn latch_callback_fault(&mut self, reason: CoreAudioFaultReason) {
        if self.snapshot.fault_latched {
            return;
        }
        self.snapshot.callback_faults = self.snapshot.callback_faults.saturating_add(1);
        self.latch_fault(reason);
    }

    fn latch_fault(&mut self, reason: CoreAudioFaultReason) {
        self.snapshot.fault_latched = true;
        self.snapshot.state = CoreAudioAdapterState::Fault;
        self.snapshot.fault_reason = Some(reason);
        self.control.set_device_connected(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_callback::OfflineAudioCallback;
    use crate::audio_parity::{CompressorSettings, TapPoint};
    use crate::realtime_graph::{
        BusConfig, DirectRouteConfig, RealtimeAudioGraph, RealtimeGraphConfig, SourceConfig,
    };

    fn graph(output_count: usize) -> RealtimeAudioGraph {
        let compressor = CompressorSettings {
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 8.0,
            release_ms: 100.0,
            makeup_db: 0.0,
        };
        RealtimeAudioGraph::new(RealtimeGraphConfig {
            block_size: BLOCK_SIZE as usize,
            output_count,
            sources: vec![SourceConfig {
                trim_db: 0.0,
                fader_db: 0.0,
                mute: false,
                hpf_enabled: false,
                compressor_enabled: false,
                compressor: compressor.clone(),
                direct: Some(DirectRouteConfig {
                    output: 0,
                    tap: TapPoint::Pre,
                    gain_db: 0.0,
                    mute: false,
                }),
                sends: Vec::new(),
            }],
            buses: vec![BusConfig {
                master_db: 0.0,
                mute: false,
                compressor_enabled: false,
                compressor,
                limiter_enabled: false,
            }],
            matrix_routes: Vec::new(),
        })
        .unwrap()
    }

    fn setup(
        output_count: usize,
        device_channels: usize,
    ) -> (
        OfflineAudioCallback,
        crate::audio_callback::CallbackInputProducer,
        CoreAudioRenderAdapter,
    ) {
        setup_with_format(
            output_count,
            CoreAudioStreamFormat::production(device_channels),
        )
    }

    fn setup_with_format(
        output_count: usize,
        format: CoreAudioStreamFormat,
    ) -> (
        OfflineAudioCallback,
        crate::audio_callback::CallbackInputProducer,
        CoreAudioRenderAdapter,
    ) {
        let (callback, io) = OfflineAudioCallback::new(graph(output_count), 2).unwrap();
        let (input, output, control) = io.into_parts();
        let adapter = CoreAudioRenderAdapter::new(
            CoreAudioDevice {
                id: "wasapi:test-device".to_owned(),
                name: "Test Device".to_owned(),
            },
            format,
            output_count,
            output,
            control,
        )
        .unwrap();
        (callback, input, adapter)
    }

    #[test]
    fn requires_explicit_supported_device_format() {
        let (_callback, _input, adapter) = setup(2, 2);
        assert_eq!(adapter.snapshot().state, CoreAudioAdapterState::Stopped);

        let (_callback, io) = OfflineAudioCallback::new(graph(2), 1).unwrap();
        let (_input, output, control) = io.into_parts();
        let error = CoreAudioRenderAdapter::new(
            CoreAudioDevice {
                id: String::new(),
                name: "Default".to_owned(),
            },
            CoreAudioStreamFormat::production(2),
            2,
            output,
            control,
        )
        .err()
        .unwrap();
        assert_eq!(error, CoreAudioAdapterError::DeviceIdRequired);
    }

    #[test]
    fn rejects_rate_block_channel_and_sample_format_mismatch() {
        let invalid_formats = [
            (
                CoreAudioStreamFormat {
                    sample_rate: 44_100,
                    ..CoreAudioStreamFormat::production(2)
                },
                CoreAudioAdapterError::UnsupportedSampleRate,
            ),
            (
                CoreAudioStreamFormat {
                    frames_per_buffer: 256,
                    ..CoreAudioStreamFormat::production(2)
                },
                CoreAudioAdapterError::UnsupportedBlockSize,
            ),
            (
                CoreAudioStreamFormat::production(0),
                CoreAudioAdapterError::UnsupportedChannelCount,
            ),
            (
                CoreAudioStreamFormat {
                    sample_format: CoreAudioSampleFormat::Signed16,
                    ..CoreAudioStreamFormat::production(2)
                },
                CoreAudioAdapterError::UnsupportedSampleFormat,
            ),
        ];
        for (format, expected) in invalid_formats {
            let (_callback, io) = OfflineAudioCallback::new(graph(2), 1).unwrap();
            let (_input, output, control) = io.into_parts();
            let error = CoreAudioRenderAdapter::new(
                CoreAudioDevice {
                    id: "wasapi:test-device".to_owned(),
                    name: "Test Device".to_owned(),
                },
                format,
                2,
                output,
                control,
            )
            .err()
            .unwrap();
            assert_eq!(error, expected);
        }
    }

    #[test]
    fn renders_planar_graph_output_as_interleaved_core_audio() {
        let (mut callback, mut input, mut adapter) = setup(2, 2);
        assert!(adapter.start());
        assert!(input.try_push(&vec![0.25; BLOCK_SIZE as usize]).unwrap());
        callback.process_once();
        let mut output = vec![1.0; BLOCK_SIZE as usize * 2];
        adapter.render(&mut output);
        for frame in output.chunks_exact(2) {
            assert_eq!(frame, [0.25, 0.0]);
        }
        assert_eq!(adapter.snapshot().rendered_frames, BLOCK_SIZE as u64);
        assert_eq!(adapter.snapshot().output_underruns, 0);
    }

    #[test]
    fn converts_48_khz_graph_blocks_to_96_khz_device_frames_without_allocating() {
        let format = CoreAudioStreamFormat {
            sample_rate: 96_000,
            frames_per_buffer: 960,
            channels: 2,
            sample_format: CoreAudioSampleFormat::Float32,
        };
        let (mut callback, mut input, mut adapter) = setup_with_format(2, format);
        assert!(adapter.start());
        let source = (0..BLOCK_SIZE as usize)
            .map(|frame| frame as f32 / 1_000.0)
            .collect::<Vec<_>>();
        assert!(input.try_push(&source).unwrap());
        callback.process_once();

        let mut output = vec![1.0; format.frames_per_buffer * format.channels];
        adapter.render(&mut output);

        assert_eq!(output[0], 0.0);
        assert_eq!(output[2], 0.0);
        assert_eq!(output[4], 0.0005);
        assert_eq!(output[format.frames_per_buffer * 2 - 2], 0.479);
        assert!(output.chunks_exact(2).all(|frame| frame[1] == 0.0));
        assert_eq!(adapter.snapshot().rendered_frames, 960);
        assert_eq!(adapter.snapshot().output_underruns, 0);

        assert!(input.try_push(&vec![0.5; BLOCK_SIZE as usize]).unwrap());
        callback.process_once();
        adapter.render(&mut output);
        assert!((output[0] - 0.4895).abs() < 1.0e-6);
        assert_eq!(output[2], 0.5);
        assert_eq!(adapter.snapshot().rendered_frames, 1_920);

        callback.process_once();
        adapter.render(&mut output);
        assert!(output.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn output_underrun_is_exact_silence_without_faulting() {
        let (_callback, _input, mut adapter) = setup(2, 2);
        assert!(adapter.start());
        let mut output = vec![1.0; BLOCK_SIZE as usize * 2];
        adapter.render(&mut output);
        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_eq!(adapter.snapshot().output_underruns, 1);
        assert_eq!(adapter.snapshot().state, CoreAudioAdapterState::Ready);
    }

    #[test]
    fn operator_stop_silences_render_without_latching_device_fault() {
        let (mut callback, mut input, mut adapter) = setup(2, 2);
        assert!(adapter.start());
        adapter.stop();
        assert!(input.try_push(&vec![0.5; BLOCK_SIZE as usize]).unwrap());
        callback.process_once();
        let mut output = vec![1.0; BLOCK_SIZE as usize * 2];
        adapter.render(&mut output);
        assert!(output.iter().all(|sample| *sample == 0.0));
        assert!(!callback.stats().fault_latched);
        assert_eq!(adapter.snapshot().state, CoreAudioAdapterState::Stopped);
    }

    #[test]
    fn restart_discards_blocks_created_while_the_device_was_stopped() {
        let (mut callback, mut input, mut adapter) = setup(2, 2);
        assert!(input.try_push(&vec![0.5; BLOCK_SIZE as usize]).unwrap());
        callback.process_once();
        assert!(adapter.start());
        let mut output = vec![1.0; BLOCK_SIZE as usize * 2];
        adapter.render(&mut output);
        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_eq!(adapter.snapshot().stale_blocks_discarded, 1);
        assert_eq!(adapter.snapshot().output_underruns, 1);
    }

    #[test]
    fn selected_device_loss_latches_fault_and_reconnect_does_not_clear_it() {
        let (mut callback, mut input, mut adapter) = setup(2, 2);
        assert!(adapter.start());
        adapter.notify_device_lost("wasapi:unrelated");
        assert_eq!(adapter.snapshot().state, CoreAudioAdapterState::Ready);
        adapter.notify_device_lost("wasapi:test-device");
        adapter.notify_device_available("wasapi:test-device");
        assert!(!adapter.start());

        assert!(input.try_push(&vec![0.5; BLOCK_SIZE as usize]).unwrap());
        callback.process_once();
        let mut output = vec![1.0; BLOCK_SIZE as usize * 2];
        adapter.render(&mut output);
        assert!(output.iter().all(|sample| *sample == 0.0));
        let snapshot = adapter.snapshot();
        assert_eq!(snapshot.device_faults, 1);
        assert_eq!(snapshot.state, CoreAudioAdapterState::Fault);
        assert_eq!(
            snapshot.fault_reason,
            Some(CoreAudioFaultReason::DeviceLost)
        );
        assert!(snapshot.fault_latched);
    }

    #[test]
    fn format_or_callback_buffer_change_fails_closed() {
        let (_callback, _input, mut adapter) = setup(2, 2);
        assert!(adapter.start());
        adapter.notify_format_changed(
            "wasapi:test-device",
            CoreAudioStreamFormat {
                sample_rate: 44_100,
                ..CoreAudioStreamFormat::production(2)
            },
        );
        let mut output = vec![1.0; BLOCK_SIZE as usize * 2];
        adapter.render(&mut output);
        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_eq!(adapter.snapshot().format_faults, 1);
        assert_eq!(
            adapter.snapshot().fault_reason,
            Some(CoreAudioFaultReason::FormatChanged)
        );

        let (_callback, _input, mut adapter) = setup(2, 2);
        assert!(adapter.start());
        let mut wrong_size = vec![1.0; 12];
        adapter.render(&mut wrong_size);
        assert!(wrong_size.iter().all(|sample| *sample == 0.0));
        assert_eq!(adapter.snapshot().callback_faults, 1);
        assert_eq!(adapter.snapshot().state, CoreAudioAdapterState::Fault);
        assert_eq!(
            adapter.snapshot().fault_reason,
            Some(CoreAudioFaultReason::CallbackBufferSizeChanged)
        );
    }
}
