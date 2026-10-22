use serde::{Deserialize, Serialize};

use crate::audio_parity::{
    Compressor, CompressorSettings, HighPassFilter, LoudnessMeter, PeakRmsMeter, SafetyLimiter,
    TapPoint, db_to_gain, validate_compressor,
};
use crate::{BLOCK_SIZE, SAMPLE_RATE};

pub const MAX_SOURCES: usize = 64;
pub const MAX_BUSES: usize = 64;
pub const MAX_OUTPUTS: usize = 64;
pub const MAX_MATRIX_ROUTES: usize = (MAX_SOURCES + MAX_BUSES) * MAX_OUTPUTS;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectRouteConfig {
    pub output: usize,
    pub tap: TapPoint,
    pub gain_db: f64,
    pub mute: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRouteConfig {
    pub bus: usize,
    pub gain_db: f64,
    pub mute: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfig {
    pub trim_db: f64,
    pub fader_db: f64,
    pub mute: bool,
    pub hpf_enabled: bool,
    pub compressor_enabled: bool,
    pub compressor: CompressorSettings,
    pub direct: Option<DirectRouteConfig>,
    pub sends: Vec<SendRouteConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusConfig {
    pub master_db: f64,
    pub mute: bool,
    pub compressor_enabled: bool,
    pub compressor: CompressorSettings,
    pub limiter_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MatrixSourceConfig {
    Channel { index: usize },
    Bus { index: usize },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRouteConfig {
    pub source: MatrixSourceConfig,
    pub output: usize,
    pub tap: TapPoint,
    pub gain_db: f64,
    pub mute: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeGraphConfig {
    pub block_size: usize,
    pub output_count: usize,
    pub sources: Vec<SourceConfig>,
    pub buses: Vec<BusConfig>,
    pub matrix_routes: Vec<MatrixRouteConfig>,
}

struct SourceState {
    config: SourceConfig,
    processed: Vec<f32>,
    post: Vec<f32>,
    hpf: HighPassFilter,
    compressor: Compressor,
    input_meter: PeakRmsMeter,
    output_meter: PeakRmsMeter,
    loudness: LoudnessMeter,
}

struct BusState {
    config: BusConfig,
    buffer: Vec<f32>,
    compressor: Compressor,
    limiter: SafetyLimiter,
    input_meter: PeakRmsMeter,
    output_meter: PeakRmsMeter,
    loudness: LoudnessMeter,
}

pub struct RealtimeAudioGraph {
    block_size: usize,
    sources: Vec<SourceState>,
    buses: Vec<BusState>,
    matrix_routes: Vec<MatrixRouteConfig>,
    outputs: Vec<Vec<f32>>,
}

impl RealtimeAudioGraph {
    pub fn new(config: RealtimeGraphConfig) -> Result<Self, String> {
        validate_config(&config)?;
        let block_size = config.block_size;
        let output_count = config.output_count;
        let sources = config
            .sources
            .into_iter()
            .map(|source_config| {
                Ok(SourceState {
                    config: source_config,
                    processed: vec![0.0; block_size],
                    post: vec![0.0; block_size],
                    hpf: HighPassFilter::default(),
                    compressor: Compressor::default(),
                    input_meter: PeakRmsMeter::default(),
                    output_meter: PeakRmsMeter::default(),
                    loudness: LoudnessMeter::new(block_size, false)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let buses = config
            .buses
            .into_iter()
            .map(|bus_config| {
                Ok(BusState {
                    config: bus_config,
                    buffer: vec![0.0; block_size],
                    compressor: Compressor::default(),
                    limiter: SafetyLimiter::default(),
                    input_meter: PeakRmsMeter::default(),
                    output_meter: PeakRmsMeter::default(),
                    loudness: LoudnessMeter::new(block_size, true)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self {
            block_size,
            sources,
            buses,
            matrix_routes: config.matrix_routes,
            outputs: vec![vec![0.0; block_size]; output_count],
        })
    }

    pub fn process_block(
        &mut self,
        inputs: &[Vec<f32>],
        emergency_muted: bool,
    ) -> Result<(), String> {
        if inputs.len() != self.sources.len()
            || inputs.iter().any(|input| {
                input.len() != self.block_size || input.iter().any(|sample| !sample.is_finite())
            })
        {
            return Err("input topology or block data does not match the graph".to_owned());
        }

        for output in &mut self.outputs {
            output.fill(0.0);
        }
        for bus in &mut self.buses {
            bus.buffer.fill(0.0);
        }

        for (source, input) in self.sources.iter_mut().zip(inputs) {
            source.input_meter.process(input);
            let trim = db_to_gain(source.config.trim_db);
            for ((processed, post), input) in
                source.processed.iter_mut().zip(&mut source.post).zip(input)
            {
                *processed = (f64::from(*input) * trim) as f32;
                *post = 0.0;
            }
            if source.config.hpf_enabled {
                source.hpf.process(&mut source.processed);
            }
            if source.config.compressor_enabled {
                source
                    .compressor
                    .process(&mut source.processed, &source.config.compressor);
            } else {
                source.compressor.bypass();
            }
            let post_gain = if source.config.mute || emergency_muted {
                0.0
            } else {
                db_to_gain(source.config.fader_db)
            };
            for (post, processed) in source.post.iter_mut().zip(&source.processed) {
                *post = (f64::from(*processed) * post_gain) as f32;
            }
            source.output_meter.process(&source.post);
            source.loudness.process(&source.post);
        }

        {
            let (sources, buses, outputs) = (&self.sources, &mut self.buses, &mut self.outputs);
            for source in sources {
                if let Some(route) = &source.config.direct
                    && !route.mute
                {
                    let input = match route.tap {
                        TapPoint::Pre => &source.processed,
                        TapPoint::Post => &source.post,
                    };
                    let gain = if emergency_muted {
                        0.0
                    } else {
                        db_to_gain(route.gain_db)
                    };
                    mix(&mut outputs[route.output], input, gain);
                }
                for send in &source.config.sends {
                    if !send.mute {
                        mix(
                            &mut buses[send.bus].buffer,
                            &source.processed,
                            db_to_gain(send.gain_db),
                        );
                    }
                }
            }
        }

        for bus in &mut self.buses {
            bus.input_meter.process(&bus.buffer);
            if bus.config.compressor_enabled {
                bus.compressor
                    .process(&mut bus.buffer, &bus.config.compressor);
            } else {
                bus.compressor.bypass();
            }
            let gain = if bus.config.mute || emergency_muted {
                0.0
            } else {
                db_to_gain(bus.config.master_db)
            };
            for sample in &mut bus.buffer {
                *sample = (f64::from(*sample) * gain) as f32;
            }
            bus.limiter
                .process(&mut bus.buffer, bus.config.limiter_enabled);
            bus.output_meter.process(&bus.buffer);
            bus.loudness.process(&bus.buffer);
        }

        {
            let (sources, buses, outputs) = (&self.sources, &self.buses, &mut self.outputs);
            for route in &self.matrix_routes {
                if route.mute {
                    continue;
                }
                let input = match route.source {
                    MatrixSourceConfig::Channel { index } => match route.tap {
                        TapPoint::Pre => &sources[index].processed,
                        TapPoint::Post => &sources[index].post,
                    },
                    MatrixSourceConfig::Bus { index } => &buses[index].buffer,
                };
                let gain = if emergency_muted {
                    0.0
                } else {
                    db_to_gain(route.gain_db)
                };
                mix(&mut outputs[route.output], input, gain);
            }
        }
        Ok(())
    }

    pub fn outputs(&self) -> &[Vec<f32>] {
        &self.outputs
    }

    pub fn block_size(&self) -> usize {
        self.block_size
    }

    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    pub fn output_count(&self) -> usize {
        self.outputs.len()
    }

    pub fn bus_buffers(&self) -> impl Iterator<Item = &[f32]> {
        self.buses.iter().map(|bus| bus.buffer.as_slice())
    }

    pub fn meters_are_finite(&self) -> bool {
        self.sources
            .iter()
            .all(|source| source.input_meter.is_finite() && source.output_meter.is_finite())
            && self
                .buses
                .iter()
                .all(|bus| bus.input_meter.is_finite() && bus.output_meter.is_finite())
    }
}

fn validate_config(config: &RealtimeGraphConfig) -> Result<(), String> {
    if config.block_size == 0
        || config.block_size > BLOCK_SIZE as usize
        || !(SAMPLE_RATE as usize).is_multiple_of(config.block_size)
    {
        return Err("blockSize must divide 48 kHz and be within 1..480".to_owned());
    }
    if config.sources.is_empty() || config.sources.len() > MAX_SOURCES {
        return Err("source count must be within 1..64".to_owned());
    }
    if config.buses.is_empty() || config.buses.len() > MAX_BUSES {
        return Err("bus count must be within 1..64".to_owned());
    }
    if config.output_count == 0 || config.output_count > MAX_OUTPUTS {
        return Err("output count must be within 1..64".to_owned());
    }
    if config.matrix_routes.len() > MAX_MATRIX_ROUTES {
        return Err("matrix route count exceeds the bounded graph capacity".to_owned());
    }
    for source in &config.sources {
        validate_db(source.trim_db)?;
        validate_db(source.fader_db)?;
        validate_compressor(&source.compressor)?;
        let mut seen_buses = [false; MAX_BUSES];
        if let Some(route) = &source.direct {
            if route.output >= config.output_count {
                return Err("direct route output is out of range".to_owned());
            }
            validate_db(route.gain_db)?;
        }
        for send in &source.sends {
            if send.bus >= config.buses.len() {
                return Err("send bus is out of range".to_owned());
            }
            if seen_buses[send.bus] {
                return Err("a source may have only one send per bus".to_owned());
            }
            seen_buses[send.bus] = true;
            validate_db(send.gain_db)?;
        }
    }
    for bus in &config.buses {
        validate_db(bus.master_db)?;
        validate_compressor(&bus.compressor)?;
    }
    for route in &config.matrix_routes {
        if route.output >= config.output_count {
            return Err("matrix output is out of range".to_owned());
        }
        match route.source {
            MatrixSourceConfig::Channel { index } if index >= config.sources.len() => {
                return Err("matrix channel source is out of range".to_owned());
            }
            MatrixSourceConfig::Bus { index } if index >= config.buses.len() => {
                return Err("matrix bus source is out of range".to_owned());
            }
            MatrixSourceConfig::Bus { .. } => {
                if matches!(route.tap, TapPoint::Pre) {
                    return Err("matrix bus PRE tap is not supported".to_owned());
                }
            }
            _ => {}
        }
        validate_db(route.gain_db)?;
    }
    Ok(())
}

fn validate_db(value: f64) -> Result<(), String> {
    if value.is_finite() && (-120.0..=24.0).contains(&value) {
        Ok(())
    } else {
        Err("gain must be finite and within -120..24 dB".to_owned())
    }
}

fn mix(target: &mut [f32], input: &[f32], gain: f64) {
    for (target, input) in target.iter_mut().zip(input) {
        *target = (f64::from(*target) + f64::from(*input) * gain) as f32;
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyBlockRequest {
    pub graph: RealtimeGraphConfig,
    pub inputs: Vec<Vec<f32>>,
    pub emergency_muted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyBlockResult {
    pub outputs: Vec<Vec<f32>>,
    pub buses: Vec<Vec<f32>>,
    pub meters_finite: bool,
}

pub fn process_topology_block(
    request: TopologyBlockRequest,
) -> Result<TopologyBlockResult, String> {
    let mut graph = RealtimeAudioGraph::new(request.graph)?;
    graph.process_block(&request.inputs, request.emergency_muted)?;
    Ok(TopologyBlockResult {
        outputs: graph.outputs().to_vec(),
        buses: graph.bus_buffers().map(<[f32]>::to_vec).collect(),
        meters_finite: graph.meters_are_finite(),
    })
}

pub fn dense_load_config(
    source_count: usize,
    bus_count: usize,
    output_count: usize,
) -> Result<RealtimeGraphConfig, String> {
    if source_count == 0
        || source_count > MAX_SOURCES
        || bus_count == 0
        || bus_count > MAX_BUSES
        || output_count == 0
        || output_count > MAX_OUTPUTS
    {
        return Err("dense load dimensions exceed graph limits".to_owned());
    }
    let channel_compressor = CompressorSettings {
        threshold_db: -18.0,
        ratio: 3.0,
        attack_ms: 8.0,
        release_ms: 100.0,
        makeup_db: 0.0,
    };
    let bus_compressor = CompressorSettings {
        threshold_db: -12.0,
        ratio: 2.0,
        ..channel_compressor.clone()
    };
    let config = RealtimeGraphConfig {
        block_size: BLOCK_SIZE as usize,
        output_count,
        sources: (0..source_count)
            .map(|index| SourceConfig {
                trim_db: 0.0,
                fader_db: 0.0,
                mute: false,
                hpf_enabled: true,
                compressor_enabled: true,
                compressor: channel_compressor.clone(),
                direct: Some(DirectRouteConfig {
                    output: index % output_count,
                    tap: TapPoint::Pre,
                    gain_db: 0.0,
                    mute: false,
                }),
                sends: (0..bus_count)
                    .map(|bus| SendRouteConfig {
                        bus,
                        gain_db: -18.0,
                        mute: false,
                    })
                    .collect(),
            })
            .collect(),
        buses: (0..bus_count)
            .map(|_| BusConfig {
                master_db: 0.0,
                mute: false,
                compressor_enabled: true,
                compressor: bus_compressor.clone(),
                limiter_enabled: true,
            })
            .collect(),
        matrix_routes: (0..bus_count)
            .map(|bus| MatrixRouteConfig {
                source: MatrixSourceConfig::Bus { index: bus },
                output: if bus_count <= output_count {
                    output_count - bus_count + bus
                } else {
                    bus % output_count
                },
                tap: TapPoint::Post,
                gain_db: 0.0,
                mute: false,
            })
            .collect(),
    };
    validate_config(&config)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compressor() -> CompressorSettings {
        CompressorSettings {
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 8.0,
            release_ms: 100.0,
            makeup_db: 0.0,
        }
    }

    #[test]
    fn routes_multiple_sources_buses_and_outputs() {
        let source = |output, bus| SourceConfig {
            trim_db: 0.0,
            fader_db: 0.0,
            mute: false,
            hpf_enabled: false,
            compressor_enabled: false,
            compressor: compressor(),
            direct: Some(DirectRouteConfig {
                output,
                tap: TapPoint::Pre,
                gain_db: 0.0,
                mute: false,
            }),
            sends: vec![SendRouteConfig {
                bus,
                gain_db: 0.0,
                mute: false,
            }],
        };
        let bus = || BusConfig {
            master_db: 0.0,
            mute: false,
            compressor_enabled: false,
            compressor: compressor(),
            limiter_enabled: false,
        };
        let config = RealtimeGraphConfig {
            block_size: 48,
            output_count: 4,
            sources: vec![source(0, 0), source(1, 1)],
            buses: vec![bus(), bus()],
            matrix_routes: vec![
                MatrixRouteConfig {
                    source: MatrixSourceConfig::Bus { index: 0 },
                    output: 2,
                    tap: TapPoint::Post,
                    gain_db: 0.0,
                    mute: false,
                },
                MatrixRouteConfig {
                    source: MatrixSourceConfig::Bus { index: 1 },
                    output: 3,
                    tap: TapPoint::Post,
                    gain_db: 0.0,
                    mute: false,
                },
            ],
        };
        let mut graph = RealtimeAudioGraph::new(config).unwrap();
        graph
            .process_block(&[vec![0.25; 48], vec![0.5; 48]], false)
            .unwrap();
        assert_eq!(graph.outputs()[0][0], 0.25);
        assert_eq!(graph.outputs()[1][0], 0.5);
        assert_eq!(graph.outputs()[2][0], 0.25);
        assert_eq!(graph.outputs()[3][0], 0.5);
    }

    #[test]
    fn rejects_invalid_topology_before_processing() {
        let config = RealtimeGraphConfig {
            block_size: 480,
            output_count: 1,
            sources: Vec::new(),
            buses: Vec::new(),
            matrix_routes: Vec::new(),
        };
        assert!(RealtimeAudioGraph::new(config).is_err());
    }

    #[test]
    fn rejects_pre_tap_for_a_bus_matrix_route() {
        let config = RealtimeGraphConfig {
            block_size: 480,
            output_count: 1,
            sources: vec![SourceConfig {
                trim_db: 0.0,
                fader_db: 0.0,
                mute: false,
                hpf_enabled: false,
                compressor_enabled: false,
                compressor: compressor(),
                direct: None,
                sends: vec![SendRouteConfig {
                    bus: 0,
                    gain_db: 0.0,
                    mute: false,
                }],
            }],
            buses: vec![BusConfig {
                master_db: 0.0,
                mute: false,
                compressor_enabled: false,
                compressor: compressor(),
                limiter_enabled: true,
            }],
            matrix_routes: vec![MatrixRouteConfig {
                source: MatrixSourceConfig::Bus { index: 0 },
                output: 0,
                tap: TapPoint::Pre,
                gain_db: 0.0,
                mute: false,
            }],
        };
        assert!(matches!(RealtimeAudioGraph::new(config), Err(error) if error.contains("PRE tap")));
    }
}
