use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use serde::Serialize;

use crate::realtime_graph::RealtimeAudioGraph;

#[cfg(not(target_has_atomic = "32"))]
compile_error!("router-core audio queues require lock-free-capable 32-bit atomics");
#[cfg(not(target_has_atomic = "64"))]
compile_error!("router-core audio queues require lock-free-capable 64-bit atomics");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueError {
    InvalidCapacity,
    BlockSizeMismatch,
}

#[repr(align(64))]
struct CacheAlignedU64(AtomicU64);

pub struct SpscAudioBlockQueue {
    block_size: usize,
    capacity: u64,
    samples: Box<[AtomicU32]>,
    write_sequence: CacheAlignedU64,
    read_sequence: CacheAlignedU64,
    rejected_pushes: AtomicU64,
}

impl SpscAudioBlockQueue {
    pub fn new(block_size: usize, capacity_blocks: usize) -> Result<Self, QueueError> {
        if block_size == 0 || capacity_blocks == 0 {
            return Err(QueueError::InvalidCapacity);
        }
        let sample_count = block_size
            .checked_mul(capacity_blocks)
            .ok_or(QueueError::InvalidCapacity)?;
        let samples = (0..sample_count)
            .map(|_| AtomicU32::new(0))
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Ok(Self {
            block_size,
            capacity: capacity_blocks as u64,
            samples,
            write_sequence: CacheAlignedU64(AtomicU64::new(0)),
            read_sequence: CacheAlignedU64(AtomicU64::new(0)),
            rejected_pushes: AtomicU64::new(0),
        })
    }

    pub fn try_push(&self, block: &[f32]) -> Result<bool, QueueError> {
        if block.len() != self.block_size {
            return Err(QueueError::BlockSizeMismatch);
        }
        let write = self.write_sequence.0.load(Ordering::Relaxed);
        let read = self.read_sequence.0.load(Ordering::Acquire);
        if write.wrapping_sub(read) >= self.capacity {
            self.rejected_pushes.fetch_add(1, Ordering::Relaxed);
            return Ok(false);
        }
        let slot = (write % self.capacity) as usize * self.block_size;
        for (target, sample) in self.samples[slot..slot + self.block_size].iter().zip(block) {
            target.store(sample.to_bits(), Ordering::Relaxed);
        }
        self.write_sequence
            .0
            .store(write.wrapping_add(1), Ordering::Release);
        Ok(true)
    }

    pub fn try_pop(&self, target: &mut [f32]) -> Result<bool, QueueError> {
        if target.len() != self.block_size {
            return Err(QueueError::BlockSizeMismatch);
        }
        let read = self.read_sequence.0.load(Ordering::Relaxed);
        let write = self.write_sequence.0.load(Ordering::Acquire);
        if read == write {
            return Ok(false);
        }
        let slot = (read % self.capacity) as usize * self.block_size;
        for (target, sample) in target.iter_mut().zip(
            self.samples[slot..slot + self.block_size]
                .iter()
                .map(|sample| sample.load(Ordering::Relaxed)),
        ) {
            *target = f32::from_bits(sample);
        }
        self.read_sequence
            .0
            .store(read.wrapping_add(1), Ordering::Release);
        Ok(true)
    }

    pub fn queued_blocks(&self) -> u64 {
        self.write_sequence
            .0
            .load(Ordering::Acquire)
            .wrapping_sub(self.read_sequence.0.load(Ordering::Acquire))
    }

    pub fn rejected_pushes(&self) -> u64 {
        self.rejected_pushes.load(Ordering::Relaxed)
    }
}

pub struct OfflineCallbackIo {
    input: Arc<SpscAudioBlockQueue>,
    output: Arc<SpscAudioBlockQueue>,
    device_connected: Arc<AtomicBool>,
    emergency_muted: Arc<AtomicBool>,
}

pub struct CallbackInputProducer {
    input: Arc<SpscAudioBlockQueue>,
}

impl CallbackInputProducer {
    pub fn try_push(&mut self, block: &[f32]) -> Result<bool, QueueError> {
        self.input.try_push(block)
    }

    pub fn block_size(&self) -> usize {
        self.input.block_size
    }
}

pub struct CallbackOutputConsumer {
    output: Arc<SpscAudioBlockQueue>,
}

impl CallbackOutputConsumer {
    pub fn try_pop(&mut self, target: &mut [f32]) -> Result<bool, QueueError> {
        self.output.try_pop(target)
    }

    pub fn block_size(&self) -> usize {
        self.output.block_size
    }

    pub fn rejected_pushes(&self) -> u64 {
        self.output.rejected_pushes()
    }

    pub fn queued_blocks(&self) -> u64 {
        self.output.queued_blocks()
    }
}

pub struct CallbackControl {
    device_connected: Arc<AtomicBool>,
    emergency_muted: Arc<AtomicBool>,
}

impl CallbackControl {
    pub fn set_device_connected(&self, connected: bool) {
        self.device_connected.store(connected, Ordering::Release);
    }

    pub fn set_emergency_muted(&self, muted: bool) {
        self.emergency_muted.store(muted, Ordering::Release);
    }
}

impl OfflineCallbackIo {
    pub fn try_push_input(&mut self, block: &[f32]) -> Result<bool, QueueError> {
        self.input.try_push(block)
    }

    pub fn try_pop_output(&mut self, target: &mut [f32]) -> Result<bool, QueueError> {
        self.output.try_pop(target)
    }

    pub fn output_rejected_pushes(&self) -> u64 {
        self.output.rejected_pushes()
    }

    pub fn set_device_connected(&self, connected: bool) {
        self.device_connected.store(connected, Ordering::Release);
    }

    pub fn set_emergency_muted(&self, muted: bool) {
        self.emergency_muted.store(muted, Ordering::Release);
    }

    pub fn into_parts(
        self,
    ) -> (
        CallbackInputProducer,
        CallbackOutputConsumer,
        CallbackControl,
    ) {
        (
            CallbackInputProducer { input: self.input },
            CallbackOutputConsumer {
                output: self.output,
            },
            CallbackControl {
                device_connected: self.device_connected,
                emergency_muted: self.emergency_muted,
            },
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackStats {
    pub callbacks: u64,
    pub input_underruns: u64,
    pub output_drops: u64,
    pub device_faults: u64,
    pub processing_faults: u64,
    pub fault_latched: bool,
}

pub struct OfflineAudioCallback {
    graph: RealtimeAudioGraph,
    input: Arc<SpscAudioBlockQueue>,
    output: Arc<SpscAudioBlockQueue>,
    device_connected: Arc<AtomicBool>,
    emergency_muted: Arc<AtomicBool>,
    flat_input: Vec<f32>,
    source_inputs: Vec<Vec<f32>>,
    flat_output: Vec<f32>,
    stats: CallbackStats,
}

impl OfflineAudioCallback {
    pub fn new(
        graph: RealtimeAudioGraph,
        queue_capacity_blocks: usize,
    ) -> Result<(Self, OfflineCallbackIo), QueueError> {
        let block_size = graph.block_size();
        let source_count = graph.source_count();
        let output_count = graph.output_count();
        let input = Arc::new(SpscAudioBlockQueue::new(
            block_size * source_count,
            queue_capacity_blocks,
        )?);
        let output = Arc::new(SpscAudioBlockQueue::new(
            block_size * output_count,
            queue_capacity_blocks,
        )?);
        let device_connected = Arc::new(AtomicBool::new(true));
        let emergency_muted = Arc::new(AtomicBool::new(false));
        let io = OfflineCallbackIo {
            input: Arc::clone(&input),
            output: Arc::clone(&output),
            device_connected: Arc::clone(&device_connected),
            emergency_muted: Arc::clone(&emergency_muted),
        };
        Ok((
            Self {
                graph,
                input,
                output,
                device_connected,
                emergency_muted,
                flat_input: vec![0.0; block_size * source_count],
                source_inputs: vec![vec![0.0; block_size]; source_count],
                flat_output: vec![0.0; block_size * output_count],
                stats: CallbackStats {
                    callbacks: 0,
                    input_underruns: 0,
                    output_drops: 0,
                    device_faults: 0,
                    processing_faults: 0,
                    fault_latched: false,
                },
            },
            io,
        ))
    }

    pub fn process_once(&mut self) {
        let received = self
            .input
            .try_pop(&mut self.flat_input)
            .expect("callback input scratch size is fixed");
        if !received {
            self.flat_input.fill(0.0);
            self.stats.input_underruns += 1;
        }
        let block_size = self.graph.block_size();
        for (source, input) in self.source_inputs.iter_mut().enumerate() {
            let start = source * block_size;
            input.copy_from_slice(&self.flat_input[start..start + block_size]);
        }

        if !self.device_connected.load(Ordering::Acquire) && !self.stats.fault_latched {
            self.stats.fault_latched = true;
            self.stats.device_faults += 1;
        }
        let emergency_muted =
            self.stats.fault_latched || self.emergency_muted.load(Ordering::Acquire);
        let graph_ok = self
            .graph
            .process_block(&self.source_inputs, emergency_muted)
            .is_ok();
        if !graph_ok {
            self.stats.processing_faults += 1;
            self.stats.fault_latched = true;
        }
        if !received || emergency_muted || !graph_ok {
            self.flat_output.fill(0.0);
        } else {
            for (output, source) in self
                .flat_output
                .chunks_mut(block_size)
                .zip(self.graph.outputs())
            {
                output.copy_from_slice(source);
            }
        }
        let queued = self
            .output
            .try_push(&self.flat_output)
            .expect("callback output scratch size is fixed");
        if !queued {
            self.stats.output_drops += 1;
        }
        self.stats.callbacks += 1;
    }

    pub fn stats(&self) -> CallbackStats {
        self.stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_parity::{CompressorSettings, TapPoint};
    use crate::realtime_graph::{BusConfig, DirectRouteConfig, RealtimeGraphConfig, SourceConfig};

    fn test_graph() -> RealtimeAudioGraph {
        let compressor = CompressorSettings {
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 8.0,
            release_ms: 100.0,
            makeup_db: 0.0,
        };
        RealtimeAudioGraph::new(RealtimeGraphConfig {
            block_size: 48,
            output_count: 1,
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

    #[test]
    fn queue_is_bounded_and_preserves_block_order() {
        let queue = SpscAudioBlockQueue::new(2, 2).unwrap();
        assert!(queue.try_push(&[1.0, 2.0]).unwrap());
        assert!(queue.try_push(&[3.0, 4.0]).unwrap());
        assert!(!queue.try_push(&[5.0, 6.0]).unwrap());
        assert_eq!(queue.queued_blocks(), 2);
        assert_eq!(queue.rejected_pushes(), 1);
        let mut output = [0.0; 2];
        assert!(queue.try_pop(&mut output).unwrap());
        assert_eq!(output, [1.0, 2.0]);
        assert!(queue.try_pop(&mut output).unwrap());
        assert_eq!(output, [3.0, 4.0]);
        assert!(!queue.try_pop(&mut output).unwrap());
    }

    #[test]
    fn callback_routes_input_and_turns_underrun_into_silence() {
        let (mut callback, mut io) = OfflineAudioCallback::new(test_graph(), 2).unwrap();
        assert!(io.try_push_input(&[0.25; 48]).unwrap());
        callback.process_once();
        let mut output = vec![0.0; 48];
        assert!(io.try_pop_output(&mut output).unwrap());
        assert!(output.iter().all(|sample| *sample == 0.25));

        callback.process_once();
        assert!(io.try_pop_output(&mut output).unwrap());
        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_eq!(callback.stats().input_underruns, 1);
    }

    #[test]
    fn device_loss_latches_fail_closed_after_reconnect() {
        let (mut callback, mut io) = OfflineAudioCallback::new(test_graph(), 2).unwrap();
        io.set_device_connected(false);
        assert!(io.try_push_input(&[0.5; 48]).unwrap());
        callback.process_once();
        io.set_device_connected(true);
        assert!(io.try_push_input(&[0.5; 48]).unwrap());
        callback.process_once();

        let mut output = vec![1.0; 48];
        assert!(io.try_pop_output(&mut output).unwrap());
        assert!(output.iter().all(|sample| *sample == 0.0));
        assert!(io.try_pop_output(&mut output).unwrap());
        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_eq!(callback.stats().device_faults, 1);
        assert!(callback.stats().fault_latched);
    }

    #[test]
    fn full_output_queue_drops_without_blocking_the_callback() {
        let (mut callback, mut io) = OfflineAudioCallback::new(test_graph(), 1).unwrap();
        assert!(io.try_push_input(&[0.25; 48]).unwrap());
        callback.process_once();
        assert!(io.try_push_input(&[0.5; 48]).unwrap());
        callback.process_once();
        assert_eq!(callback.stats().callbacks, 2);
        assert_eq!(callback.stats().output_drops, 1);
        assert_eq!(io.output_rejected_pushes(), 1);
    }

    #[test]
    fn non_finite_input_fails_closed_without_panicking() {
        let (mut callback, mut io) = OfflineAudioCallback::new(test_graph(), 1).unwrap();
        let mut input = [0.25; 48];
        input[12] = f32::NAN;
        assert!(io.try_push_input(&input).unwrap());
        callback.process_once();
        let mut output = [1.0; 48];
        assert!(io.try_pop_output(&mut output).unwrap());
        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_eq!(callback.stats().processing_faults, 1);
        assert!(callback.stats().fault_latched);
    }

    #[test]
    fn queue_transfers_blocks_between_one_producer_and_one_consumer() {
        let queue = Arc::new(SpscAudioBlockQueue::new(1, 8).unwrap());
        let producer = Arc::clone(&queue);
        let thread = std::thread::spawn(move || {
            for value in 0..1_000_u32 {
                while !producer.try_push(&[value as f32]).unwrap() {
                    std::hint::spin_loop();
                }
            }
        });
        let mut block = [0.0];
        for expected in 0..1_000_u32 {
            while !queue.try_pop(&mut block).unwrap() {
                std::hint::spin_loop();
            }
            assert_eq!(block[0], expected as f32);
        }
        thread.join().unwrap();
    }
}
