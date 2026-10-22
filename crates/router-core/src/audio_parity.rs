use serde::{Deserialize, Serialize};

use crate::{BLOCK_SIZE, SAMPLE_RATE};

const MIN_DB: f64 = -120.0;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TapPoint {
    Pre,
    Post,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressorSettings {
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
}

impl Default for CompressorSettings {
    fn default() -> Self {
        Self {
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 8.0,
            release_ms: 100.0,
            makeup_db: 0.0,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdditionalSourceRequest {
    pub id: String,
    pub samples: Vec<f32>,
    pub trim_db: f64,
    pub fader_db: f64,
    pub channel_muted: bool,
    pub send_gain_db: f64,
    pub send_muted: bool,
    #[serde(default)]
    pub hpf_enabled: bool,
    #[serde(default)]
    pub compressor_enabled: bool,
    #[serde(default)]
    pub compressor: CompressorSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBlockRequest {
    pub samples: Vec<f32>,
    pub trim_db: f64,
    pub fader_db: f64,
    pub channel_muted: bool,
    pub direct_tap: TapPoint,
    pub direct_gain_db: f64,
    pub direct_muted: bool,
    pub send_gain_db: f64,
    pub send_muted: bool,
    pub bus_master_db: f64,
    pub bus_muted: bool,
    pub limiter_enabled: bool,
    pub emergency_muted: bool,
    #[serde(default)]
    pub hpf_enabled: bool,
    #[serde(default)]
    pub compressor_enabled: bool,
    #[serde(default)]
    pub compressor: CompressorSettings,
    #[serde(default)]
    pub bus_compressor_enabled: bool,
    #[serde(default)]
    pub bus_compressor: CompressorSettings,
    #[serde(default)]
    pub additional_sources: Vec<AdditionalSourceRequest>,
    #[serde(default)]
    pub summary_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterSnapshot {
    pub peak: f64,
    pub rms: f64,
    pub hold: f64,
    pub clip: bool,
    pub voice_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessSnapshot {
    pub momentary: f64,
    pub short_term: f64,
    pub integrated: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdditionalSourceResult {
    pub id: String,
    pub processed: Vec<f32>,
    pub post: Vec<f32>,
    pub input_meter: MeterSnapshot,
    pub output_meter: MeterSnapshot,
    pub loudness: LoudnessSnapshot,
    pub compressor_gain_reduction_db: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBlockResult {
    pub processed: Vec<f32>,
    pub post: Vec<f32>,
    pub direct_output: Vec<f32>,
    pub bus_output: Vec<f32>,
    pub input_meter: MeterSnapshot,
    pub output_meter: MeterSnapshot,
    pub bus_input_meter: MeterSnapshot,
    pub bus_meter: MeterSnapshot,
    pub loudness: LoudnessSnapshot,
    pub bus_loudness: LoudnessSnapshot,
    pub compressor_gain_reduction_db: f64,
    pub bus_compressor_gain_reduction_db: f64,
    pub limiter_gain_reduction_db: f64,
    pub emergency_muted: bool,
    pub additional_sources: Vec<AdditionalSourceResult>,
}

#[derive(Debug, Default)]
pub(crate) struct PeakRmsMeter {
    peak: f64,
    rms: f64,
    hold: f64,
    clip: bool,
    voice_active: bool,
    hold_samples: i64,
}

impl PeakRmsMeter {
    pub(crate) fn process(&mut self, buffer: &[f32]) {
        let mut peak = 0.0_f64;
        let mut sum_squares = 0.0_f64;
        for &sample in buffer {
            let sample = f64::from(sample);
            peak = peak.max(sample.abs());
            sum_squares += sample * sample;
        }
        self.peak = peak;
        self.rms = (sum_squares / buffer.len().max(1) as f64).sqrt();
        self.clip = peak >= 1.0;
        self.voice_active = self.rms >= db_to_gain(-45.0);
        if peak >= self.hold {
            self.hold = peak;
            self.hold_samples = i64::from(SAMPLE_RATE) * 3 / 2;
        } else if self.hold_samples > 0 {
            self.hold_samples -= buffer.len() as i64;
        } else {
            self.hold *= 0.94;
        }
    }

    pub(crate) fn is_finite(&self) -> bool {
        self.peak.is_finite() && self.rms.is_finite() && self.hold.is_finite()
    }

    fn snapshot(&self) -> MeterSnapshot {
        MeterSnapshot {
            peak: self.peak,
            rms: self.rms,
            hold: self.hold,
            clip: self.clip,
            voice_active: self.voice_active,
        }
    }
}

#[derive(Debug)]
pub(crate) struct HighPassFilter {
    alpha: f64,
    previous_input: f64,
    previous_output: f64,
}

impl Default for HighPassFilter {
    fn default() -> Self {
        let time_constant = 1.0 / (2.0 * std::f64::consts::PI * 80.0);
        let interval = 1.0 / f64::from(SAMPLE_RATE);
        Self {
            alpha: time_constant / (time_constant + interval),
            previous_input: 0.0,
            previous_output: 0.0,
        }
    }
}

impl HighPassFilter {
    pub(crate) fn process(&mut self, buffer: &mut [f32]) {
        for sample in buffer {
            let input = f64::from(*sample);
            let output = self.alpha * (self.previous_output + input - self.previous_input);
            *sample = output as f32;
            self.previous_input = input;
            self.previous_output = output;
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct Compressor {
    envelope: f64,
    gain_reduction_db: f64,
}

impl Compressor {
    pub(crate) fn process(&mut self, buffer: &mut [f32], settings: &CompressorSettings) {
        let attack = (-1.0 / (f64::from(SAMPLE_RATE) * settings.attack_ms / 1_000.0)).exp();
        let release = (-1.0 / (f64::from(SAMPLE_RATE) * settings.release_ms / 1_000.0)).exp();
        let makeup = db_to_gain(settings.makeup_db);
        let mut last_reduction = 0.0;
        for sample in buffer {
            let level = f64::from(*sample).abs();
            let coefficient = if level > self.envelope {
                attack
            } else {
                release
            };
            self.envelope = coefficient * self.envelope + (1.0 - coefficient) * level;
            let envelope_db = gain_to_db(self.envelope);
            let above = 0.0_f64.max(envelope_db - settings.threshold_db);
            last_reduction = above - above / 1.0_f64.max(settings.ratio);
            *sample = (f64::from(*sample) * db_to_gain(-last_reduction) * makeup) as f32;
        }
        self.gain_reduction_db = last_reduction;
    }

    pub(crate) fn bypass(&mut self) {
        self.gain_reduction_db = 0.0;
    }
}

#[derive(Debug)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    fn new(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0,
            b1,
            b2,
            a1,
            a2,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, input: f64) -> f64 {
        let output = self.b0 * input + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }
}

#[derive(Debug)]
struct KWeightingFilter {
    pre_filter: Biquad,
    rlb_filter: Biquad,
}

impl Default for KWeightingFilter {
    fn default() -> Self {
        Self {
            pre_filter: Biquad::new(
                1.535_124_859_586_97,
                -2.691_696_189_406_38,
                1.198_392_810_852_85,
                -1.690_659_293_182_41,
                0.732_480_774_215_85,
            ),
            rlb_filter: Biquad::new(1.0, -2.0, 1.0, -1.990_047_454_833_98, 0.990_072_250_366_21),
        }
    }
}

impl KWeightingFilter {
    fn process(&mut self, input: f64) -> f64 {
        self.rlb_filter.process(self.pre_filter.process(input))
    }
}

#[derive(Debug)]
pub(crate) struct LoudnessMeter {
    filter: KWeightingFilter,
    energy_ring: Vec<f64>,
    integrated_blocks: Vec<f64>,
    momentary_chunks: usize,
    short_term_chunks: usize,
    gate_stride_chunks: usize,
    ring_index: usize,
    ring_count: usize,
    chunks_since_gate: usize,
    integrated_count: usize,
    integrated_index: usize,
    cached_integrated: f64,
    value: LoudnessSnapshot,
}

impl LoudnessMeter {
    pub(crate) fn new(block_size: usize, integrated: bool) -> Result<Self, String> {
        if block_size == 0 || !(SAMPLE_RATE as usize).is_multiple_of(block_size) {
            return Err("loudness requires an integral number of blocks per second".to_owned());
        }
        let chunks_per_second = SAMPLE_RATE as usize / block_size;
        let momentary_chunks = (chunks_per_second as f64 * 0.4).round() as usize;
        let short_term_chunks = chunks_per_second * 3;
        let gate_stride_chunks = (chunks_per_second as f64 * 0.1).round() as usize;
        Ok(Self {
            filter: KWeightingFilter::default(),
            energy_ring: vec![0.0; short_term_chunks],
            integrated_blocks: if integrated {
                vec![0.0; 6 * 60 * 60 * 10]
            } else {
                Vec::new()
            },
            momentary_chunks,
            short_term_chunks,
            gate_stride_chunks,
            ring_index: 0,
            ring_count: 0,
            chunks_since_gate: 0,
            integrated_count: 0,
            integrated_index: 0,
            cached_integrated: f64::NEG_INFINITY,
            value: LoudnessSnapshot {
                momentary: f64::NEG_INFINITY,
                short_term: f64::NEG_INFINITY,
                integrated: f64::NEG_INFINITY,
            },
        })
    }

    pub(crate) fn process(&mut self, buffer: &[f32]) {
        let mut energy = 0.0;
        for &sample in buffer {
            let weighted = self.filter.process(f64::from(sample));
            energy += weighted * weighted;
        }
        self.energy_ring[self.ring_index] = energy / buffer.len().max(1) as f64;
        self.ring_index = (self.ring_index + 1) % self.energy_ring.len();
        self.ring_count = self.energy_ring.len().min(self.ring_count + 1);

        if !self.integrated_blocks.is_empty() && self.ring_count >= self.momentary_chunks {
            self.chunks_since_gate += 1;
            if self.chunks_since_gate >= self.gate_stride_chunks {
                self.chunks_since_gate = 0;
                self.integrated_blocks[self.integrated_index] =
                    self.window_energy(self.momentary_chunks);
                self.integrated_index = (self.integrated_index + 1) % self.integrated_blocks.len();
                self.integrated_count = self.integrated_blocks.len().min(self.integrated_count + 1);
                if self.integrated_count.is_multiple_of(10) {
                    self.cached_integrated = self.calculate_integrated();
                }
            }
        }

        self.value.momentary = if self.ring_count >= self.momentary_chunks {
            energy_to_lufs(self.window_energy(self.momentary_chunks))
        } else {
            f64::NEG_INFINITY
        };
        self.value.short_term = if self.ring_count >= self.short_term_chunks {
            energy_to_lufs(self.window_energy(self.short_term_chunks))
        } else {
            f64::NEG_INFINITY
        };
        self.value.integrated = self.cached_integrated;
    }

    fn snapshot(&self) -> LoudnessSnapshot {
        LoudnessSnapshot {
            momentary: finite_or_floor(self.value.momentary),
            short_term: finite_or_floor(self.value.short_term),
            integrated: finite_or_floor(self.value.integrated),
        }
    }

    fn window_energy(&self, chunks: usize) -> f64 {
        let mut sum = 0.0;
        for offset in 0..chunks {
            let index =
                (self.ring_index + self.energy_ring.len() - 1 - offset) % self.energy_ring.len();
            sum += self.energy_ring[index];
        }
        sum / chunks as f64
    }

    fn calculate_integrated(&self) -> f64 {
        let mut absolute_energy = 0.0;
        let mut absolute_count = 0;
        for &energy in &self.integrated_blocks[..self.integrated_count] {
            if energy_to_lufs(energy) >= -70.0 {
                absolute_energy += energy;
                absolute_count += 1;
            }
        }
        if absolute_count == 0 {
            return f64::NEG_INFINITY;
        }
        let relative_threshold = energy_to_lufs(absolute_energy / absolute_count as f64) - 10.0;
        let threshold = (-70.0_f64).max(relative_threshold);
        let mut gated_energy = 0.0;
        let mut gated_count = 0;
        for &energy in &self.integrated_blocks[..self.integrated_count] {
            if energy_to_lufs(energy) >= threshold {
                gated_energy += energy;
                gated_count += 1;
            }
        }
        if gated_count == 0 {
            f64::NEG_INFINITY
        } else {
            energy_to_lufs(gated_energy / gated_count as f64)
        }
    }
}

fn energy_to_lufs(energy: f64) -> f64 {
    if energy > 0.0 {
        -0.691 + 10.0 * energy.log10()
    } else {
        f64::NEG_INFINITY
    }
}

fn finite_or_floor(value: f64) -> f64 {
    if value.is_finite() { value } else { MIN_DB }
}

#[derive(Debug)]
pub(crate) struct SafetyLimiter {
    gain: f64,
    gain_reduction_db: f64,
}

impl Default for SafetyLimiter {
    fn default() -> Self {
        Self {
            gain: 1.0,
            gain_reduction_db: 0.0,
        }
    }
}

impl SafetyLimiter {
    pub(crate) fn process(&mut self, buffer: &mut [f32], enabled: bool) {
        if !enabled {
            self.gain_reduction_db = 0.0;
            return;
        }
        let ceiling = db_to_gain(-1.0);
        let release = (-1.0 / (f64::from(SAMPLE_RATE) * 80.0 / 1_000.0)).exp();
        let mut minimum_gain = 1.0_f64;
        for sample in buffer {
            let absolute = f64::from(*sample).abs();
            let wanted = if absolute > ceiling {
                ceiling / absolute
            } else {
                1.0
            };
            self.gain = if wanted < self.gain {
                wanted
            } else {
                release * self.gain + (1.0 - release)
            };
            minimum_gain = minimum_gain.min(self.gain);
            *sample = (f64::from(*sample) * self.gain) as f32;
        }
        self.gain_reduction_db = 0.0_f64.max(-gain_to_db(minimum_gain));
    }
}

#[derive(Debug)]
struct ChannelDspState {
    id: String,
    hpf: HighPassFilter,
    compressor: Compressor,
    input_meter: PeakRmsMeter,
    output_meter: PeakRmsMeter,
    loudness: LoudnessMeter,
}

impl ChannelDspState {
    fn new(id: String, block_size: usize) -> Result<Self, String> {
        Ok(Self {
            id,
            hpf: HighPassFilter::default(),
            compressor: Compressor::default(),
            input_meter: PeakRmsMeter::default(),
            output_meter: PeakRmsMeter::default(),
            loudness: LoudnessMeter::new(block_size, false)?,
        })
    }
}

#[derive(Debug, Default)]
pub struct AudioParityCore {
    block_size: Option<usize>,
    primary: Option<ChannelDspState>,
    additional: Vec<ChannelDspState>,
    bus_input_meter: PeakRmsMeter,
    bus_meter: PeakRmsMeter,
    bus_compressor: Compressor,
    bus_loudness: Option<LoudnessMeter>,
    limiter: SafetyLimiter,
}

impl AudioParityCore {
    pub fn process_block(
        &mut self,
        request: AudioBlockRequest,
    ) -> Result<AudioBlockResult, String> {
        validate_request(&request)?;
        self.ensure_state(&request)?;

        let primary = process_channel(
            self.primary
                .as_mut()
                .expect("primary state was initialized"),
            &request.samples,
            request.trim_db,
            request.fader_db,
            request.channel_muted,
            request.emergency_muted,
            request.hpf_enabled,
            request.compressor_enabled,
            &request.compressor,
        );

        let direct_source = match request.direct_tap {
            TapPoint::Pre => &primary.processed,
            TapPoint::Post => &primary.post,
        };
        let direct_gain = if request.direct_muted || request.emergency_muted {
            0.0
        } else {
            db_to_gain(request.direct_gain_db)
        };
        let direct_output: Vec<f32> = direct_source
            .iter()
            .map(|sample| (f64::from(*sample) * direct_gain) as f32)
            .collect();

        let mut bus_output = vec![0.0_f32; request.samples.len()];
        mix_send(
            &mut bus_output,
            &primary.processed,
            request.send_gain_db,
            request.send_muted,
        );

        let mut additional_results = Vec::with_capacity(request.additional_sources.len());
        for (source, state) in request.additional_sources.iter().zip(&mut self.additional) {
            let result = process_channel(
                state,
                &source.samples,
                source.trim_db,
                source.fader_db,
                source.channel_muted,
                request.emergency_muted,
                source.hpf_enabled,
                source.compressor_enabled,
                &source.compressor,
            );
            mix_send(
                &mut bus_output,
                &result.processed,
                source.send_gain_db,
                source.send_muted,
            );
            additional_results.push(AdditionalSourceResult {
                id: source.id.clone(),
                processed: if request.summary_only {
                    Vec::new()
                } else {
                    result.processed
                },
                post: if request.summary_only {
                    Vec::new()
                } else {
                    result.post
                },
                input_meter: result.input_meter,
                output_meter: result.output_meter,
                loudness: result.loudness,
                compressor_gain_reduction_db: result.compressor_gain_reduction_db,
            });
        }
        self.bus_input_meter.process(&bus_output);

        if request.bus_compressor_enabled {
            self.bus_compressor
                .process(&mut bus_output, &request.bus_compressor);
        } else {
            self.bus_compressor.gain_reduction_db = 0.0;
        }

        let bus_gain = if request.bus_muted || request.emergency_muted {
            0.0
        } else {
            db_to_gain(request.bus_master_db)
        };
        for sample in &mut bus_output {
            *sample = (f64::from(*sample) * bus_gain) as f32;
        }
        self.limiter
            .process(&mut bus_output, request.limiter_enabled);
        self.bus_meter.process(&bus_output);
        let bus_loudness = self
            .bus_loudness
            .as_mut()
            .expect("bus loudness was initialized");
        bus_loudness.process(&bus_output);

        Ok(AudioBlockResult {
            processed: if request.summary_only {
                Vec::new()
            } else {
                primary.processed
            },
            post: if request.summary_only {
                Vec::new()
            } else {
                primary.post
            },
            direct_output: if request.summary_only {
                Vec::new()
            } else {
                direct_output
            },
            bus_output: if request.summary_only {
                Vec::new()
            } else {
                bus_output
            },
            input_meter: primary.input_meter,
            output_meter: primary.output_meter,
            bus_input_meter: self.bus_input_meter.snapshot(),
            bus_meter: self.bus_meter.snapshot(),
            loudness: primary.loudness,
            bus_loudness: bus_loudness.snapshot(),
            compressor_gain_reduction_db: primary.compressor_gain_reduction_db,
            bus_compressor_gain_reduction_db: self.bus_compressor.gain_reduction_db,
            limiter_gain_reduction_db: self.limiter.gain_reduction_db,
            emergency_muted: request.emergency_muted,
            additional_sources: additional_results,
        })
    }

    fn ensure_state(&mut self, request: &AudioBlockRequest) -> Result<(), String> {
        let block_size = request.samples.len();
        match self.block_size {
            None => {
                self.block_size = Some(block_size);
                self.primary = Some(ChannelDspState::new("primary".to_owned(), block_size)?);
                self.additional = request
                    .additional_sources
                    .iter()
                    .map(|source| ChannelDspState::new(source.id.clone(), block_size))
                    .collect::<Result<Vec<_>, _>>()?;
                self.bus_loudness = Some(LoudnessMeter::new(block_size, true)?);
            }
            Some(existing) if existing != block_size => {
                return Err("block size cannot change within a parity process".to_owned());
            }
            Some(_) => {
                if self.additional.len() != request.additional_sources.len()
                    || self
                        .additional
                        .iter()
                        .zip(&request.additional_sources)
                        .any(|(state, source)| state.id != source.id)
                {
                    return Err(
                        "additional source order and IDs cannot change within a parity process"
                            .to_owned(),
                    );
                }
            }
        }
        Ok(())
    }
}

struct ProcessedChannel {
    processed: Vec<f32>,
    post: Vec<f32>,
    input_meter: MeterSnapshot,
    output_meter: MeterSnapshot,
    loudness: LoudnessSnapshot,
    compressor_gain_reduction_db: f64,
}

#[allow(clippy::too_many_arguments)]
fn process_channel(
    state: &mut ChannelDspState,
    samples: &[f32],
    trim_db: f64,
    fader_db: f64,
    muted: bool,
    emergency_muted: bool,
    hpf_enabled: bool,
    compressor_enabled: bool,
    compressor_settings: &CompressorSettings,
) -> ProcessedChannel {
    state.input_meter.process(samples);
    let trim = db_to_gain(trim_db);
    let mut processed: Vec<f32> = samples
        .iter()
        .map(|sample| (f64::from(*sample) * trim) as f32)
        .collect();
    if hpf_enabled {
        state.hpf.process(&mut processed);
    }
    if compressor_enabled {
        state
            .compressor
            .process(&mut processed, compressor_settings);
    } else {
        state.compressor.gain_reduction_db = 0.0;
    }

    let post_gain = if muted || emergency_muted {
        0.0
    } else {
        db_to_gain(fader_db)
    };
    let post: Vec<f32> = processed
        .iter()
        .map(|sample| (f64::from(*sample) * post_gain) as f32)
        .collect();
    state.output_meter.process(&post);
    state.loudness.process(&post);
    ProcessedChannel {
        processed,
        post,
        input_meter: state.input_meter.snapshot(),
        output_meter: state.output_meter.snapshot(),
        loudness: state.loudness.snapshot(),
        compressor_gain_reduction_db: state.compressor.gain_reduction_db,
    }
}

fn mix_send(target: &mut [f32], source: &[f32], gain_db: f64, muted: bool) {
    if muted {
        return;
    }
    let gain = db_to_gain(gain_db);
    for (target, source) in target.iter_mut().zip(source) {
        *target = (f64::from(*target) + f64::from(*source) * gain) as f32;
    }
}

fn validate_request(request: &AudioBlockRequest) -> Result<(), String> {
    if request.samples.is_empty() || request.samples.len() > BLOCK_SIZE as usize {
        return Err(format!("samples must contain 1..={BLOCK_SIZE} mono frames"));
    }
    if request.samples.iter().any(|sample| !sample.is_finite()) {
        return Err("samples must be finite".to_owned());
    }
    if !(SAMPLE_RATE as usize).is_multiple_of(request.samples.len()) {
        return Err("sample count must divide the fixed 48 kHz project rate".to_owned());
    }
    if request.additional_sources.len() >= 64 {
        return Err("the parity graph supports at most 64 total sources".to_owned());
    }
    let mut source_ids = std::collections::HashSet::new();
    for source in &request.additional_sources {
        if source.id.is_empty() || !source_ids.insert(&source.id) {
            return Err("additional source IDs must be non-empty and unique".to_owned());
        }
        if source.samples.len() != request.samples.len()
            || source.samples.iter().any(|sample| !sample.is_finite())
        {
            return Err("additional source samples must match the finite primary block".to_owned());
        }
        validate_gain("additional.trimDb", source.trim_db)?;
        validate_gain("additional.faderDb", source.fader_db)?;
        validate_gain("additional.sendGainDb", source.send_gain_db)?;
        validate_compressor(&source.compressor)?;
    }
    for (name, value) in [
        ("trimDb", request.trim_db),
        ("faderDb", request.fader_db),
        ("directGainDb", request.direct_gain_db),
        ("sendGainDb", request.send_gain_db),
        ("busMasterDb", request.bus_master_db),
    ] {
        validate_gain(name, value)?;
    }
    validate_compressor(&request.compressor)?;
    validate_compressor(&request.bus_compressor)?;
    Ok(())
}

fn validate_gain(name: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() || !(-120.0..=24.0).contains(&value) {
        Err(format!("{name} must be finite and within -120..24 dB"))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_compressor(settings: &CompressorSettings) -> Result<(), String> {
    validate_gain("compressor.thresholdDb", settings.threshold_db)?;
    validate_gain("compressor.makeupDb", settings.makeup_db)?;
    if !settings.ratio.is_finite() || !(1.0..=20.0).contains(&settings.ratio) {
        return Err("compressor.ratio must be within 1..20".to_owned());
    }
    if !settings.attack_ms.is_finite() || !(0.1..=200.0).contains(&settings.attack_ms) {
        return Err("compressor.attackMs must be within 0.1..200 ms".to_owned());
    }
    if !settings.release_ms.is_finite() || !(10.0..=2_000.0).contains(&settings.release_ms) {
        return Err("compressor.releaseMs must be within 10..2000 ms".to_owned());
    }
    Ok(())
}

pub(crate) fn db_to_gain(db: f64) -> f64 {
    if db <= MIN_DB {
        0.0
    } else {
        10.0_f64.powf(db / 20.0)
    }
}

fn gain_to_db(gain: f64) -> f64 {
    if gain <= 0.000_001 {
        MIN_DB
    } else {
        20.0 * gain.log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(samples: Vec<f32>) -> AudioBlockRequest {
        AudioBlockRequest {
            samples,
            trim_db: 0.0,
            fader_db: 0.0,
            channel_muted: false,
            direct_tap: TapPoint::Pre,
            direct_gain_db: 0.0,
            direct_muted: false,
            send_gain_db: 0.0,
            send_muted: false,
            bus_master_db: 0.0,
            bus_muted: false,
            limiter_enabled: true,
            emergency_muted: false,
            hpf_enabled: false,
            compressor_enabled: false,
            compressor: CompressorSettings::default(),
            bus_compressor_enabled: false,
            bus_compressor: CompressorSettings {
                threshold_db: -12.0,
                ratio: 2.0,
                ..CompressorSettings::default()
            },
            additional_sources: Vec::new(),
            summary_only: false,
        }
    }

    #[test]
    fn limiter_caps_the_bus_and_reports_gain_reduction() {
        let mut core = AudioParityCore::default();
        let result = core.process_block(request(vec![2.0; 48])).unwrap();
        assert!(result.bus_output.iter().all(|sample| sample.abs() <= 0.892));
        assert!(result.limiter_gain_reduction_db > 6.0);
    }

    #[test]
    fn emergency_mute_silences_destinations_but_keeps_pre_bus_metering() {
        let mut core = AudioParityCore::default();
        let mut input = request(vec![0.5; 48]);
        input.emergency_muted = true;
        let result = core.process_block(input).unwrap();
        assert!(result.direct_output.iter().all(|sample| *sample == 0.0));
        assert!(result.bus_output.iter().all(|sample| *sample == 0.0));
        assert_eq!(result.bus_input_meter.peak, 0.5);
    }

    #[test]
    fn rejects_unbounded_or_non_finite_input() {
        let mut core = AudioParityCore::default();
        assert!(core.process_block(request(Vec::new())).is_err());
        assert!(
            core.process_block(request(vec![0.0; BLOCK_SIZE as usize + 1]))
                .is_err()
        );
        assert!(core.process_block(request(vec![f32::NAN])).is_err());
    }

    #[test]
    fn high_pass_filter_rejects_dc_across_blocks() {
        let mut core = AudioParityCore::default();
        let mut result = None;
        for _ in 0..20 {
            let mut input = request(vec![0.5; BLOCK_SIZE as usize]);
            input.hpf_enabled = true;
            result = Some(core.process_block(input).unwrap());
        }
        assert!(result.unwrap().processed.last().unwrap().abs() < 0.001);
    }

    #[test]
    fn loudness_reports_a_calibrated_tone() {
        let mut core = AudioParityCore::default();
        let gain = db_to_gain(-18.0);
        let mut phase = 0.0_f64;
        let mut result = None;
        for _ in 0..310 {
            let samples = (0..BLOCK_SIZE)
                .map(|_| {
                    let sample = (phase.sin() * gain) as f32;
                    phase += 2.0 * std::f64::consts::PI * 1_000.0 / f64::from(SAMPLE_RATE);
                    sample
                })
                .collect();
            result = Some(core.process_block(request(samples)).unwrap());
        }
        let loudness = result.unwrap().bus_loudness;
        assert!((loudness.momentary - -21.0).abs() < 0.1);
        assert!((loudness.short_term - -21.0).abs() < 0.1);
        assert!((loudness.integrated - -21.0).abs() < 0.1);
    }
}
