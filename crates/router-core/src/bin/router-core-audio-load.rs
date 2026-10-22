use router_core::realtime_graph::{RealtimeAudioGraph, dense_load_config};
use router_core::{BLOCK_SIZE, SAMPLE_RATE};
use serde::Serialize;
use std::time::Instant;

const SOURCES: usize = 64;
const BUSES: usize = 4;
const OUTPUTS: usize = 64;
const WARMUP_BLOCKS: usize = 100;
const MEASURED_BLOCKS: usize = 2_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadResult {
    sources: usize,
    buses: usize,
    outputs: usize,
    blocks: usize,
    deadline_ms: f64,
    average_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    maximum_ms: f64,
    deadline_misses: usize,
    finite_meters: bool,
}

fn fill_inputs(inputs: &mut [Vec<f32>], phases: &mut [f64]) {
    for (index, (input, phase)) in inputs.iter_mut().zip(phases).enumerate() {
        let frequency = 140.0 + ((index * 37) % 760) as f64;
        let level_db = -24.0 + (index % 5) as f64 * 2.0;
        let gain = 10.0_f64.powf(level_db / 20.0);
        let step = 2.0 * std::f64::consts::PI * frequency / f64::from(SAMPLE_RATE);
        for sample in input {
            *sample = (phase.sin() * gain) as f32;
            *phase += step;
            if *phase >= 2.0 * std::f64::consts::PI {
                *phase -= 2.0 * std::f64::consts::PI;
            }
        }
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut graph = RealtimeAudioGraph::new(dense_load_config(SOURCES, BUSES, OUTPUTS)?)?;
    let mut inputs = vec![vec![0.0_f32; BLOCK_SIZE as usize]; SOURCES];
    let mut phases = vec![0.0_f64; SOURCES];
    for _ in 0..WARMUP_BLOCKS {
        fill_inputs(&mut inputs, &mut phases);
        graph.process_block(&inputs, false)?;
    }

    let deadline_ms = f64::from(BLOCK_SIZE) / f64::from(SAMPLE_RATE) * 1_000.0;
    let mut elapsed = Vec::with_capacity(MEASURED_BLOCKS);
    let mut deadline_misses = 0;
    for _ in 0..MEASURED_BLOCKS {
        let started = Instant::now();
        fill_inputs(&mut inputs, &mut phases);
        graph.process_block(&inputs, false)?;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        if elapsed_ms > deadline_ms {
            deadline_misses += 1;
        }
        elapsed.push(elapsed_ms);
    }
    elapsed.sort_by(f64::total_cmp);
    let result = LoadResult {
        sources: SOURCES,
        buses: BUSES,
        outputs: OUTPUTS,
        blocks: MEASURED_BLOCKS,
        deadline_ms,
        average_ms: elapsed.iter().sum::<f64>() / elapsed.len() as f64,
        p95_ms: percentile(&elapsed, 0.95),
        p99_ms: percentile(&elapsed, 0.99),
        maximum_ms: *elapsed.last().expect("measured blocks are non-empty"),
        deadline_misses,
        finite_meters: graph.meters_are_finite(),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    if result.deadline_misses > 0 || !result.finite_meters {
        std::process::exit(1);
    }
    Ok(())
}
