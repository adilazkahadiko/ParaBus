use router_core::audio_callback::OfflineAudioCallback;
use router_core::core_audio_adapter::{
    CoreAudioDevice, CoreAudioRenderAdapter, CoreAudioSampleFormat, CoreAudioStreamFormat,
};
use router_core::realtime_graph::{RealtimeAudioGraph, dense_load_config};
use router_core::{BLOCK_SIZE, SAMPLE_RATE};
use serde::Serialize;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

const SOURCES: usize = 64;
const BUSES: usize = 4;
const OUTPUTS: usize = 64;
const WARMUP_BLOCKS: usize = 100;
const MEASURED_BLOCKS: usize = 2_000;
const DEVICE_ID: &str = "wasapi:offline-callback-load";

static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);

struct CountingAllocator;

// SAFETY: Every operation is delegated unchanged to the process-wide System allocator. The only
// added behavior is a relaxed atomic counter, which does not alter pointer or Layout semantics.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: The caller supplies the Layout under GlobalAlloc's contract.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: The pointer and Layout came from this allocator's System delegation.
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: The caller supplies the Layout under GlobalAlloc's contract.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: The caller supplies the original allocation and requested size under the contract.
        unsafe { System.realloc(pointer, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL_ALLOCATOR: CountingAllocator = CountingAllocator;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CallbackLoadResult {
    sources: usize,
    buses: usize,
    outputs: usize,
    device_sample_rate: u32,
    device_frames_per_buffer: usize,
    blocks: usize,
    deadline_ms: f64,
    average_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    maximum_ms: f64,
    deadline_misses: usize,
    hot_path_allocations: u64,
    input_underruns: u64,
    output_drops: u64,
    device_faults: u64,
    processing_faults: u64,
    adapter_output_underruns: u64,
    adapter_device_faults: u64,
    adapter_callback_faults: u64,
    underrun_silence: bool,
    device_loss_silence: bool,
    fault_latched_after_reconnect: bool,
}

fn fill_input(input: &mut [f32], phases: &mut [f64], gains: &[f64], steps: &[f64]) {
    for (source, frames) in input.chunks_mut(BLOCK_SIZE as usize).enumerate() {
        for sample in frames {
            *sample = (phases[source].sin() * gains[source]) as f32;
            phases[source] += steps[source];
            if phases[source] >= 2.0 * std::f64::consts::PI {
                phases[source] -= 2.0 * std::f64::consts::PI;
            }
        }
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let graph = RealtimeAudioGraph::new(dense_load_config(SOURCES, BUSES, OUTPUTS)?)?;
    let (mut callback, io) = OfflineAudioCallback::new(graph, 4)
        .map_err(|error| format!("callback queue setup failed: {error:?}"))?;
    let (mut input_producer, output_consumer, callback_control) = io.into_parts();
    let device_format = CoreAudioStreamFormat {
        sample_rate: 96_000,
        frames_per_buffer: 960,
        channels: OUTPUTS,
        sample_format: CoreAudioSampleFormat::Float32,
    };
    let mut adapter = CoreAudioRenderAdapter::new(
        CoreAudioDevice {
            id: DEVICE_ID.to_owned(),
            name: "Offline Core Audio Device".to_owned(),
        },
        device_format,
        OUTPUTS,
        output_consumer,
        callback_control,
    )?;
    assert!(adapter.start());
    let mut input = vec![0.0_f32; SOURCES * BLOCK_SIZE as usize];
    let mut output = vec![0.0_f32; OUTPUTS * device_format.frames_per_buffer];
    let mut phases = vec![0.0_f64; SOURCES];
    let gains: Vec<f64> = (0..SOURCES)
        .map(|index| 10.0_f64.powf((-24.0 + (index % 5) as f64 * 2.0) / 20.0))
        .collect();
    let steps: Vec<f64> = (0..SOURCES)
        .map(|index| {
            let frequency = 140.0 + ((index * 37) % 760) as f64;
            2.0 * std::f64::consts::PI * frequency / f64::from(SAMPLE_RATE)
        })
        .collect();

    for _ in 0..WARMUP_BLOCKS {
        fill_input(&mut input, &mut phases, &gains, &steps);
        assert!(
            input_producer
                .try_push(&input)
                .expect("input block size is fixed")
        );
        callback.process_once();
        adapter.render(&mut output);
    }

    let deadline_ms = f64::from(BLOCK_SIZE) / f64::from(SAMPLE_RATE) * 1_000.0;
    let mut elapsed = Vec::with_capacity(MEASURED_BLOCKS);
    let allocations_before = ALLOCATIONS.load(Ordering::Relaxed);
    let mut deadline_misses = 0;
    for _ in 0..MEASURED_BLOCKS {
        let started = Instant::now();
        fill_input(&mut input, &mut phases, &gains, &steps);
        assert!(
            input_producer
                .try_push(&input)
                .expect("input block size is fixed")
        );
        callback.process_once();
        adapter.render(&mut output);
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        if elapsed_ms > deadline_ms {
            deadline_misses += 1;
        }
        elapsed.push(elapsed_ms);
    }
    let hot_path_allocations = ALLOCATIONS
        .load(Ordering::Relaxed)
        .saturating_sub(allocations_before);
    let steady_state = callback.stats();
    let steady_adapter = adapter.snapshot();

    callback.process_once();
    adapter.render(&mut output);
    let underrun_silence = output.iter().all(|sample| *sample == 0.0);

    adapter.notify_device_lost(DEVICE_ID);
    assert!(
        input_producer
            .try_push(&input)
            .expect("input block size is fixed")
    );
    callback.process_once();
    adapter.render(&mut output);
    let device_loss_silence = output.iter().all(|sample| *sample == 0.0);
    adapter.notify_device_available(DEVICE_ID);
    let reconnect_rejected = !adapter.start();
    assert!(
        input_producer
            .try_push(&input)
            .expect("input block size is fixed")
    );
    callback.process_once();
    adapter.render(&mut output);
    let final_stats = callback.stats();
    let final_adapter = adapter.snapshot();
    let fault_latched_after_reconnect = reconnect_rejected
        && final_stats.fault_latched
        && final_adapter.fault_latched
        && output.iter().all(|sample| *sample == 0.0);

    elapsed.sort_by(f64::total_cmp);
    let result = CallbackLoadResult {
        sources: SOURCES,
        buses: BUSES,
        outputs: OUTPUTS,
        device_sample_rate: device_format.sample_rate,
        device_frames_per_buffer: device_format.frames_per_buffer,
        blocks: MEASURED_BLOCKS,
        deadline_ms,
        average_ms: elapsed.iter().sum::<f64>() / elapsed.len() as f64,
        p95_ms: percentile(&elapsed, 0.95),
        p99_ms: percentile(&elapsed, 0.99),
        maximum_ms: *elapsed.last().expect("measured blocks are non-empty"),
        deadline_misses,
        hot_path_allocations,
        input_underruns: steady_state.input_underruns,
        output_drops: steady_state.output_drops,
        device_faults: final_stats.device_faults,
        processing_faults: steady_state.processing_faults,
        adapter_output_underruns: steady_adapter.output_underruns,
        adapter_device_faults: final_adapter.device_faults,
        adapter_callback_faults: steady_adapter.callback_faults,
        underrun_silence,
        device_loss_silence,
        fault_latched_after_reconnect,
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    if result.deadline_misses > 0
        || result.hot_path_allocations > 0
        || result.input_underruns > 0
        || result.output_drops > 0
        || result.processing_faults > 0
        || result.adapter_output_underruns > 0
        || result.adapter_device_faults != 1
        || result.adapter_callback_faults > 0
        || !result.underrun_silence
        || !result.device_loss_silence
        || !result.fault_latched_after_reconnect
    {
        std::process::exit(1);
    }
    Ok(())
}
