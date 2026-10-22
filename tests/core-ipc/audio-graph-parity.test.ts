import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AudioChannel, AudioEngine, VcBus, type SourceProvider } from "../../services/router-core-sim/src/audio-engine.ts";

const CHILD_ENVIRONMENT_ALLOWLIST = new Set(["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"]);

interface ParityConfig {
  samples: number[];
  trimDb: number;
  faderDb: number;
  channelMuted: boolean;
  directTap: "PRE" | "POST";
  directGainDb: number;
  directMuted: boolean;
  sendGainDb: number;
  sendMuted: boolean;
  busMasterDb: number;
  busMuted: boolean;
  limiterEnabled: boolean;
  emergencyMuted: boolean;
}

interface MeterResult {
  peak: number;
  rms: number;
  hold: number;
  clip: boolean;
  voiceActive: boolean;
}

interface LoudnessResult {
  momentary: number;
  shortTerm: number;
  integrated: number;
}

interface CompressorSettings {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

interface AdditionalSourceConfig {
  id: string;
  samples: number[];
  trimDb: number;
  faderDb: number;
  channelMuted: boolean;
  sendGainDb: number;
  sendMuted: boolean;
  hpfEnabled: boolean;
  compressorEnabled: boolean;
  compressor: CompressorSettings;
}

interface FullParityConfig extends ParityConfig {
  hpfEnabled: boolean;
  compressorEnabled: boolean;
  compressor: CompressorSettings;
  busCompressorEnabled: boolean;
  busCompressor: CompressorSettings;
  additionalSources: AdditionalSourceConfig[];
  summaryOnly: boolean;
}

interface AdditionalSourceResult {
  id: string;
  processed: number[];
  post: number[];
  inputMeter: MeterResult;
  outputMeter: MeterResult;
  loudness: LoudnessResult;
  compressorGainReductionDb: number;
}

interface ParityResult {
  processed: number[];
  post: number[];
  directOutput: number[];
  busOutput: number[];
  inputMeter: MeterResult;
  outputMeter: MeterResult;
  busInputMeter: MeterResult;
  busMeter: MeterResult;
  limiterGainReductionDb: number;
  emergencyMuted: boolean;
  loudness?: LoudnessResult;
  busLoudness?: LoudnessResult;
  compressorGainReductionDb?: number;
  busCompressorGainReductionDb?: number;
  additionalSources?: AdditionalSourceResult[];
}

interface TopologyResult {
  outputs: number[][];
  buses: number[][];
  metersFinite: boolean;
}

interface ParityResponse<T = unknown> {
  v: number;
  id: string;
  type: string;
  ok: boolean;
  payload?: T;
  error?: string;
}

class FixtureSource implements SourceProvider {
  samples: Float32Array;

  constructor(samples: number[]) {
    this.samples = Float32Array.from(samples);
  }

  fill(target: Float32Array): boolean {
    target.set(this.samples);
    return true;
  }
}

function parityBinary(): string {
  const executable = process.platform === "win32" ? "router-core-audio-parity.exe" : "router-core-audio-parity";
  return fileURLToPath(new URL(`../../target/debug/${executable}`, import.meta.url));
}

function parityChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => (
    value !== undefined && CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())
  )));
}

async function runRustRequests<T>(requests: Array<{ type: string; payload: unknown }>): Promise<T[]> {
  const child = spawn(parityBinary(), [], {
    env: parityChildEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("audio parity process timed out"));
    }, 15_000);
    timer.unref();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`audio parity process exited (${code ?? signal ?? "unknown"}): ${stderr.trim()}`));
    });
  });
  requests.forEach((request, index) => {
    child.stdin.write(`${JSON.stringify({ v: 1, id: `block-${index}`, ...request })}\n`);
  });
  child.stdin.end();
  await completed;

  const responses = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ParityResponse<T>);
  assert.equal(responses.length, requests.length);
  return responses.map((response, index) => {
    assert.equal(response.v, 1);
    assert.equal(response.id, `block-${index}`);
    assert.equal(response.type, requests[index].type);
    assert.equal(response.ok, true, response.error ?? "audio parity request failed");
    assert.ok(response.payload);
    return response.payload;
  });
}

async function runRustSequence(configs: ParityConfig[]): Promise<ParityResult[]> {
  return runRustRequests<ParityResult>(configs.map((payload) => ({ type: "process_block", payload })));
}

function meterResult(meter: { peak: number; rms: number; hold: number; clip: boolean; voiceActive: boolean }): MeterResult {
  return {
    peak: meter.peak,
    rms: meter.rms,
    hold: meter.hold,
    clip: meter.clip,
    voiceActive: meter.voiceActive,
  };
}

function assertNumbersClose(actual: number[], expected: number[], label: string, tolerance = 3e-6): void {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < actual.length; index += 1) {
    const difference = Math.abs(actual[index] - expected[index]);
    assert.ok(difference <= tolerance, `${label}[${index}] differs by ${difference}`);
  }
}

function assertMeterClose(actual: MeterResult, expected: MeterResult, label: string): void {
  assertNumbersClose(
    [actual.peak, actual.rms, actual.hold],
    [expected.peak, expected.rms, expected.hold],
    label,
    1e-8,
  );
  assert.equal(actual.clip, expected.clip, `${label}.clip`);
  assert.equal(actual.voiceActive, expected.voiceActive, `${label}.voiceActive`);
}

function loudnessResult(value: { momentary: number; shortTerm: number; integrated: number }): LoudnessResult {
  const finiteOrFloor = (input: number): number => Number.isFinite(input) ? input : -120;
  return {
    momentary: finiteOrFloor(value.momentary),
    shortTerm: finiteOrFloor(value.shortTerm),
    integrated: finiteOrFloor(value.integrated),
  };
}

function assertLoudnessClose(actual: LoudnessResult, expected: LoudnessResult, label: string): void {
  assertNumbersClose(
    [actual.momentary, actual.shortTerm, actual.integrated],
    [expected.momentary, expected.shortTerm, expected.integrated],
    label,
    1e-7,
  );
}

function configureCompressor(
  compressor: { thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number },
  settings: CompressorSettings,
): void {
  compressor.thresholdDb = settings.thresholdDb;
  compressor.ratio = settings.ratio;
  compressor.attackMs = settings.attackMs;
  compressor.releaseMs = settings.releaseMs;
  compressor.makeupDb = settings.makeupDb;
}

test("Rust minimum audio graph matches TypeScript blocks, meters, limiter, and emergency transitions", async () => {
  const samples = Array.from({ length: 96 }, (_, index) => (
    Math.sin(index * 0.37) * 0.92 + (index % 11 === 0 ? 0.24 : 0)
  ));
  const base: ParityConfig = {
    samples,
    trimDb: 3,
    faderDb: -8,
    channelMuted: false,
    directTap: "PRE",
    directGainDb: -2,
    directMuted: false,
    sendGainDb: 4,
    sendMuted: false,
    busMasterDb: 1,
    busMuted: false,
    limiterEnabled: true,
    emergencyMuted: false,
  };
  const configs: ParityConfig[] = [
    base,
    { ...base, directTap: "POST", faderDb: -12 },
    { ...base, channelMuted: true },
    { ...base, directMuted: true },
    { ...base, sendMuted: true },
    { ...base, busMuted: true },
    { ...base, emergencyMuted: true },
    base,
  ];

  const source = new FixtureSource(samples);
  const engine = new AudioEngine(48_000, samples.length, 2);
  const channel = new AudioChannel("fixture", "Fixture", "TestTone", source, samples.length, 48_000);
  channel.hpfEnabled = false;
  channel.compressorEnabled = false;
  channel.trimDb = base.trimDb;
  channel.faderDb = base.faderDb;
  channel.directOutput = { output: 0, tap: base.directTap, gainDb: base.directGainDb, mute: false };
  channel.vcSends.set("fixture-bus", { gainDb: base.sendGainDb, mute: false });
  const bus = new VcBus("fixture-bus", "Fixture Bus", samples.length, 48_000);
  bus.compressorEnabled = false;
  bus.masterDb = base.busMasterDb;
  engine.addChannel(channel);
  engine.addBus(bus);
  engine.addMatrixRoute({ id: "bus-output", sourceId: bus.id, output: 1, gainDb: 0, mute: false, tap: "POST" });

  const reference = configs.map((config): ParityResult => {
    channel.trimDb = config.trimDb;
    channel.faderDb = config.faderDb;
    channel.mute = config.channelMuted;
    channel.directOutput = {
      output: 0,
      tap: config.directTap,
      gainDb: config.directGainDb,
      mute: config.directMuted,
    };
    channel.vcSends.set(bus.id, { gainDb: config.sendGainDb, mute: config.sendMuted });
    bus.masterDb = config.busMasterDb;
    bus.mute = config.busMuted;
    bus.limiter.enabled = config.limiterEnabled;
    engine.emergencyMuted = config.emergencyMuted;
    engine.processBlock();
    return {
      processed: Array.from(channel.processed),
      post: Array.from(channel.post),
      directOutput: Array.from(engine.outputs[0]),
      busOutput: Array.from(engine.outputs[1]),
      inputMeter: meterResult(channel.inputMeter),
      outputMeter: meterResult(channel.outputMeter),
      busInputMeter: meterResult(bus.inputMeter),
      busMeter: meterResult(bus.meter),
      limiterGainReductionDb: bus.limiter.gainReductionDb,
      emergencyMuted: engine.emergencyMuted,
    };
  });
  const rust = await runRustSequence(configs);

  for (let index = 0; index < reference.length; index += 1) {
    assertNumbersClose(rust[index].processed, reference[index].processed, `block ${index} processed`);
    assertNumbersClose(rust[index].post, reference[index].post, `block ${index} post`);
    assertNumbersClose(rust[index].directOutput, reference[index].directOutput, `block ${index} direct`);
    assertNumbersClose(rust[index].busOutput, reference[index].busOutput, `block ${index} bus`);
    assertMeterClose(rust[index].inputMeter, reference[index].inputMeter, `block ${index} input meter`);
    assertMeterClose(rust[index].outputMeter, reference[index].outputMeter, `block ${index} output meter`);
    assertMeterClose(rust[index].busInputMeter, reference[index].busInputMeter, `block ${index} bus input meter`);
    assertMeterClose(rust[index].busMeter, reference[index].busMeter, `block ${index} bus meter`);
    assertNumbersClose(
      [rust[index].limiterGainReductionDb],
      [reference[index].limiterGainReductionDb],
      `block ${index} limiter GR`,
      1e-8,
    );
    assert.equal(rust[index].emergencyMuted, reference[index].emergencyMuted);
  }

  assert.ok(Math.max(...reference[0].busOutput.map(Math.abs)) <= 10 ** (-1 / 20));
  assert.ok(reference[0].limiterGainReductionDb > 0);
  assert.equal(Math.max(...reference[2].post.map(Math.abs)), 0);
  assert.ok(Math.max(...reference[2].directOutput.map(Math.abs)) > 0);
  assert.equal(Math.max(...reference[3].directOutput.map(Math.abs)), 0);
  assert.equal(Math.max(...reference[4].busOutput.map(Math.abs)), 0);
  assert.equal(Math.max(...reference[5].busOutput.map(Math.abs)), 0);
  assert.equal(Math.max(...reference[6].directOutput.map(Math.abs)), 0);
  assert.equal(Math.max(...reference[6].busOutput.map(Math.abs)), 0);
  assert.ok(Math.max(...reference[7].busOutput.map(Math.abs)) > 0);
});

test("Rust multi-bus and matrix topology matches TypeScript outputs", async () => {
  const blockSize = 96;
  const sampleBlocks = [
    Float32Array.from({ length: blockSize }, (_, index) => Math.sin(index * 0.19) * 0.4),
    Float32Array.from({ length: blockSize }, (_, index) => Math.cos(index * 0.27) * 0.3),
    Float32Array.from({ length: blockSize }, (_, index) => ((index % 9) - 4) * 0.04),
  ];
  const sources = sampleBlocks.map((samples) => new FixtureSource(Array.from(samples)));
  const engine = new AudioEngine(48_000, blockSize, 4);
  const channels = sources.map((source, index) => {
    const channel = new AudioChannel(`source-${index}`, `Source ${index}`, "TestTone", source, blockSize, 48_000);
    channel.hpfEnabled = false;
    channel.compressorEnabled = false;
    engine.addChannel(channel);
    return channel;
  });
  const buses = [new VcBus("bus-0", "Bus 0", blockSize), new VcBus("bus-1", "Bus 1", blockSize)];
  for (const bus of buses) {
    bus.compressorEnabled = false;
    bus.limiter.enabled = false;
    engine.addBus(bus);
  }
  channels[0].trimDb = 1;
  channels[0].directOutput = { output: 0, tap: "PRE", gainDb: -2, mute: false };
  channels[0].vcSends.set(buses[0].id, { gainDb: -3, mute: false });
  channels[1].faderDb = -4;
  channels[1].directOutput = { output: 1, tap: "POST", gainDb: -3, mute: false };
  channels[1].vcSends.set(buses[0].id, { gainDb: -4, mute: false });
  channels[1].vcSends.set(buses[1].id, { gainDb: -5, mute: false });
  channels[2].trimDb = -1;
  channels[2].faderDb = -2;
  channels[2].vcSends.set(buses[1].id, { gainDb: -2, mute: false });
  buses[0].masterDb = -1;
  buses[1].masterDb = -2;
  engine.addMatrixRoute({ id: "bus-0-out", sourceId: buses[0].id, output: 2, gainDb: -1, mute: false, tap: "POST" });
  engine.addMatrixRoute({ id: "bus-1-out", sourceId: buses[1].id, output: 3, gainDb: -2, mute: false, tap: "POST" });
  engine.addMatrixRoute({ id: "source-2-out", sourceId: channels[2].id, output: 0, gainDb: -6, mute: false, tap: "POST" });

  const compressor = { thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 100, makeupDb: 0 };
  const graph = {
    blockSize,
    outputCount: 4,
    sources: [
      {
        trimDb: 1, faderDb: 0, mute: false, hpfEnabled: false, compressorEnabled: false, compressor,
        direct: { output: 0, tap: "PRE", gainDb: -2, mute: false },
        sends: [{ bus: 0, gainDb: -3, mute: false }],
      },
      {
        trimDb: 0, faderDb: -4, mute: false, hpfEnabled: false, compressorEnabled: false, compressor,
        direct: { output: 1, tap: "POST", gainDb: -3, mute: false },
        sends: [{ bus: 0, gainDb: -4, mute: false }, { bus: 1, gainDb: -5, mute: false }],
      },
      {
        trimDb: -1, faderDb: -2, mute: false, hpfEnabled: false, compressorEnabled: false, compressor,
        direct: null,
        sends: [{ bus: 1, gainDb: -2, mute: false }],
      },
    ],
    buses: [
      { masterDb: -1, mute: false, compressorEnabled: false, compressor, limiterEnabled: false },
      { masterDb: -2, mute: false, compressorEnabled: false, compressor, limiterEnabled: false },
    ],
    matrixRoutes: [
      { source: { kind: "BUS", index: 0 }, output: 2, tap: "POST", gainDb: -1, mute: false },
      { source: { kind: "BUS", index: 1 }, output: 3, tap: "POST", gainDb: -2, mute: false },
      { source: { kind: "CHANNEL", index: 2 }, output: 0, tap: "POST", gainDb: -6, mute: false },
    ],
  };
  const requests = [false, true].map((emergencyMuted) => ({
    type: "process_topology_block",
    payload: { graph, inputs: sampleBlocks.map((samples) => Array.from(samples)), emergencyMuted },
  }));

  const reference = [false, true].map((emergencyMuted): TopologyResult => {
    engine.emergencyMuted = emergencyMuted;
    engine.processBlock();
    return {
      outputs: engine.outputs.map((output) => Array.from(output)),
      buses: buses.map((bus) => Array.from(bus.buffer)),
      metersFinite: buses.every((bus) => Number.isFinite(bus.meter.rms)),
    };
  });
  const rust = await runRustRequests<TopologyResult>(requests);
  for (let block = 0; block < reference.length; block += 1) {
    assert.equal(rust[block].metersFinite, true);
    for (let output = 0; output < 4; output += 1) {
      assertNumbersClose(rust[block].outputs[output], reference[block].outputs[output], `topology block ${block} output ${output}`);
    }
    for (let bus = 0; bus < 2; bus += 1) {
      assertNumbersClose(rust[block].buses[bus], reference[block].buses[bus], `topology block ${block} bus ${bus}`);
    }
  }
  assert.ok(reference[0].outputs.every((output) => Math.max(...output.map(Math.abs)) > 0));
  assert.ok(reference[1].outputs.every((output) => Math.max(...output.map(Math.abs)) === 0));
});

test("Rust DSP, loudness, and multi-source sum match the stateful TypeScript graph", { timeout: 30_000 }, async () => {
  const blockSize = 480;
  const checkpoints = new Set([0, 39, 139, 299, 309]);
  const primaryCompressor: CompressorSettings = {
    thresholdDb: -20,
    ratio: 4,
    attackMs: 3,
    releaseMs: 120,
    makeupDb: 1,
  };
  const secondaryCompressor: CompressorSettings = {
    thresholdDb: -22,
    ratio: 2.5,
    attackMs: 10,
    releaseMs: 200,
    makeupDb: 0,
  };
  const busCompressor: CompressorSettings = {
    thresholdDb: -35,
    ratio: 2,
    attackMs: 5,
    releaseMs: 150,
    makeupDb: 0.5,
  };

  const primarySource = new FixtureSource(new Array(blockSize).fill(0));
  const secondarySource = new FixtureSource(new Array(blockSize).fill(0));
  const engine = new AudioEngine(48_000, blockSize, 2);
  const primary = new AudioChannel("primary", "Primary", "TestTone", primarySource, blockSize, 48_000);
  const secondary = new AudioChannel("secondary", "Secondary", "TestTone", secondarySource, blockSize, 48_000);
  const bus = new VcBus("program", "Program", blockSize, 48_000);
  primary.trimDb = 2;
  primary.faderDb = -3;
  primary.directOutput = { output: 0, tap: "PRE", gainDb: -4, mute: false };
  primary.vcSends.set(bus.id, { gainDb: -6, mute: false });
  secondary.trimDb = -1;
  secondary.faderDb = -4;
  secondary.vcSends.set(bus.id, { gainDb: -8, mute: false });
  bus.masterDb = -2;
  configureCompressor(primary.compressor, primaryCompressor);
  configureCompressor(secondary.compressor, secondaryCompressor);
  configureCompressor(bus.compressor, busCompressor);
  engine.addChannel(primary);
  engine.addChannel(secondary);
  engine.addBus(bus);
  engine.addMatrixRoute({ id: "program-output", sourceId: bus.id, output: 1, gainDb: 0, mute: false, tap: "POST" });

  let primaryPhase = 0;
  let secondaryPhase = 0;
  const configs: FullParityConfig[] = [];
  const reference: ParityResult[] = [];
  for (let blockIndex = 0; blockIndex < 310; blockIndex += 1) {
    const primarySamples = new Float32Array(blockSize);
    const secondarySamples = new Float32Array(blockSize);
    for (let index = 0; index < blockSize; index += 1) {
      primarySamples[index] = Math.sin(primaryPhase) * 0.5 + 0.08;
      secondarySamples[index] = Math.sin(secondaryPhase) * 0.3 - 0.04;
      primaryPhase += 2 * Math.PI * 1_000 / 48_000;
      secondaryPhase += 2 * Math.PI * 350 / 48_000;
      if (primaryPhase >= 2 * Math.PI) primaryPhase -= 2 * Math.PI;
      if (secondaryPhase >= 2 * Math.PI) secondaryPhase -= 2 * Math.PI;
    }
    primarySource.samples = primarySamples;
    secondarySource.samples = secondarySamples;
    engine.processBlock();
    const summaryOnly = !checkpoints.has(blockIndex);
    configs.push({
      samples: Array.from(primarySamples),
      trimDb: primary.trimDb,
      faderDb: primary.faderDb,
      channelMuted: primary.mute,
      directTap: "PRE",
      directGainDb: -4,
      directMuted: false,
      sendGainDb: -6,
      sendMuted: false,
      busMasterDb: bus.masterDb,
      busMuted: bus.mute,
      limiterEnabled: bus.limiter.enabled,
      emergencyMuted: false,
      hpfEnabled: primary.hpfEnabled,
      compressorEnabled: primary.compressorEnabled,
      compressor: primaryCompressor,
      busCompressorEnabled: bus.compressorEnabled,
      busCompressor,
      additionalSources: [{
        id: secondary.id,
        samples: Array.from(secondarySamples),
        trimDb: secondary.trimDb,
        faderDb: secondary.faderDb,
        channelMuted: secondary.mute,
        sendGainDb: -8,
        sendMuted: false,
        hpfEnabled: secondary.hpfEnabled,
        compressorEnabled: secondary.compressorEnabled,
        compressor: secondaryCompressor,
      }],
      summaryOnly,
    });
    reference.push({
      processed: summaryOnly ? [] : Array.from(primary.processed),
      post: summaryOnly ? [] : Array.from(primary.post),
      directOutput: summaryOnly ? [] : Array.from(engine.outputs[0]),
      busOutput: summaryOnly ? [] : Array.from(engine.outputs[1]),
      inputMeter: meterResult(primary.inputMeter),
      outputMeter: meterResult(primary.outputMeter),
      busInputMeter: meterResult(bus.inputMeter),
      busMeter: meterResult(bus.meter),
      limiterGainReductionDb: bus.limiter.gainReductionDb,
      emergencyMuted: false,
      loudness: loudnessResult(primary.loudnessValue),
      busLoudness: loudnessResult(bus.loudnessValue),
      compressorGainReductionDb: primary.compressor.gainReductionDb,
      busCompressorGainReductionDb: bus.compressor.gainReductionDb,
      additionalSources: [{
        id: secondary.id,
        processed: summaryOnly ? [] : Array.from(secondary.processed),
        post: summaryOnly ? [] : Array.from(secondary.post),
        inputMeter: meterResult(secondary.inputMeter),
        outputMeter: meterResult(secondary.outputMeter),
        loudness: loudnessResult(secondary.loudnessValue),
        compressorGainReductionDb: secondary.compressor.gainReductionDb,
      }],
    });
  }

  const rust = await runRustSequence(configs);
  for (let index = 0; index < reference.length; index += 1) {
    const expected = reference[index];
    const actual = rust[index];
    assertNumbersClose(actual.processed, expected.processed, `DSP block ${index} primary processed`, 5e-6);
    assertNumbersClose(actual.post, expected.post, `DSP block ${index} primary post`, 5e-6);
    assertNumbersClose(actual.directOutput, expected.directOutput, `DSP block ${index} direct`, 5e-6);
    assertNumbersClose(actual.busOutput, expected.busOutput, `DSP block ${index} bus`, 5e-6);
    assertMeterClose(actual.inputMeter, expected.inputMeter, `DSP block ${index} primary input meter`);
    assertMeterClose(actual.outputMeter, expected.outputMeter, `DSP block ${index} primary output meter`);
    assertMeterClose(actual.busInputMeter, expected.busInputMeter, `DSP block ${index} bus input meter`);
    assertMeterClose(actual.busMeter, expected.busMeter, `DSP block ${index} bus meter`);
    assert.ok(actual.loudness && expected.loudness);
    assert.ok(actual.busLoudness && expected.busLoudness);
    assertLoudnessClose(actual.loudness, expected.loudness, `DSP block ${index} primary loudness`);
    assertLoudnessClose(actual.busLoudness, expected.busLoudness, `DSP block ${index} bus loudness`);
    assertNumbersClose(
      [actual.compressorGainReductionDb ?? -1, actual.busCompressorGainReductionDb ?? -1],
      [expected.compressorGainReductionDb ?? -1, expected.busCompressorGainReductionDb ?? -1],
      `DSP block ${index} compressor GR`,
      1e-7,
    );
    assert.equal(actual.additionalSources?.length, 1);
    assert.equal(expected.additionalSources?.length, 1);
    const actualSecondary = actual.additionalSources?.[0];
    const expectedSecondary = expected.additionalSources?.[0];
    assert.ok(actualSecondary && expectedSecondary);
    assert.equal(actualSecondary.id, expectedSecondary.id);
    assertNumbersClose(actualSecondary.processed, expectedSecondary.processed, `DSP block ${index} secondary processed`, 5e-6);
    assertNumbersClose(actualSecondary.post, expectedSecondary.post, `DSP block ${index} secondary post`, 5e-6);
    assertMeterClose(actualSecondary.inputMeter, expectedSecondary.inputMeter, `DSP block ${index} secondary input meter`);
    assertMeterClose(actualSecondary.outputMeter, expectedSecondary.outputMeter, `DSP block ${index} secondary output meter`);
    assertLoudnessClose(actualSecondary.loudness, expectedSecondary.loudness, `DSP block ${index} secondary loudness`);
    assertNumbersClose(
      [actualSecondary.compressorGainReductionDb],
      [expectedSecondary.compressorGainReductionDb],
      `DSP block ${index} secondary compressor GR`,
      1e-7,
    );
  }

  assert.ok((reference.at(-1)?.busLoudness?.momentary ?? -120) > -120);
  assert.ok((reference.at(-1)?.busLoudness?.shortTerm ?? -120) > -120);
  assert.ok((reference.at(-1)?.busLoudness?.integrated ?? -120) > -120);
  assert.ok(reference.some((result) => (result.compressorGainReductionDb ?? 0) > 0));
  assert.ok(reference.some((result) => (result.busCompressorGainReductionDb ?? 0) > 0));
  assert.ok(reference.some((result) => (result.additionalSources?.[0]?.compressorGainReductionDb ?? 0) > 0));
});
