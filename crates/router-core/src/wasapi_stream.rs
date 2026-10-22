use serde::Serialize;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::core_audio_adapter::{CoreAudioAdapterSnapshot, CoreAudioStreamFormat};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiEnginePeriod {
    pub default_frames: u32,
    pub fundamental_frames: u32,
    pub minimum_frames: u32,
    pub maximum_frames: u32,
}

impl WasapiEnginePeriod {
    pub fn supports(&self, frames: u32) -> bool {
        self.fundamental_frames > 0
            && frames >= self.minimum_frames
            && frames <= self.maximum_frames
            && frames.is_multiple_of(self.fundamental_frames)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiStreamDescriptor {
    pub endpoint_id: String,
    pub format: CoreAudioStreamFormat,
    pub engine_period: WasapiEnginePeriod,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiRenderReport {
    pub descriptor: WasapiStreamDescriptor,
    pub mmcss_registered: bool,
    pub adapter: CoreAudioAdapterSnapshot,
}

/// Render-thread-owned, management-observed counters. Relaxed ordering is sufficient because
/// each counter is independent telemetry, not a synchronization signal.
#[derive(Debug, Default)]
pub struct WasapiLiveCounters {
    render_callbacks: AtomicU64,
    output_underruns: AtomicU64,
}

impl WasapiLiveCounters {
    pub fn snapshot(&self) -> (u64, u64) {
        (
            self.render_callbacks.load(Ordering::Relaxed),
            self.output_underruns.load(Ordering::Relaxed),
        )
    }

    pub fn publish(&self, callbacks: u64, underruns: u64) {
        self.render_callbacks
            .fetch_max(callbacks, Ordering::Relaxed);
        self.output_underruns
            .fetch_max(underruns, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WasapiMixFormatDetails {
    pub encoding: &'static str,
    pub sample_rate: u32,
    pub channels: u16,
    pub container_bits: u16,
    pub valid_bits: u16,
    pub block_align: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WasapiStreamError {
    EndpointIdRequired,
    InvalidEndpointId,
    UnsupportedMixFormat(WasapiMixFormatDetails),
    UnsupportedEnginePeriod,
    InvalidEngineBuffer {
        buffer_frames: u32,
        padding_frames: u32,
        period_frames: u32,
    },
    AdapterEndpointMismatch,
    AdapterFormatMismatch,
    AdapterFaultLatched,
    DescriptorChanged,
    FormatChanged,
    MmcssRegistrationFailed {
        code: i32,
    },
    RenderEventTimeout,
    DeviceInvalidated,
    Platform {
        operation: &'static str,
        code: i32,
    },
    ThreadSpawnFailed,
    ThreadStoppedBeforeReady,
    ThreadPanicked,
}

impl Display for WasapiStreamError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EndpointIdRequired => {
                formatter.write_str("an explicit WASAPI endpoint ID is required")
            }
            Self::InvalidEndpointId => {
                formatter.write_str("the explicit WASAPI endpoint ID is invalid")
            }
            Self::UnsupportedMixFormat(details) => write!(
                formatter,
                "unsupported WASAPI mix format (encoding={}, sample_rate={}, channels={}, container_bits={}, valid_bits={}, block_align={}); expected 48 or 96 kHz Float32 with 1..64 channels",
                details.encoding,
                details.sample_rate,
                details.channels,
                details.container_bits,
                details.valid_bits,
                details.block_align,
            ),
            Self::UnsupportedEnginePeriod => formatter
                .write_str("WASAPI shared engine does not support the required 10 ms period"),
            Self::InvalidEngineBuffer {
                buffer_frames,
                padding_frames,
                period_frames,
            } => write!(
                formatter,
                "WASAPI engine buffer is invalid (buffer_frames={buffer_frames}, padding_frames={padding_frames}, period_frames={period_frames})",
            ),
            Self::AdapterEndpointMismatch => formatter
                .write_str("render adapter endpoint does not match the explicit WASAPI endpoint"),
            Self::AdapterFormatMismatch => {
                formatter.write_str("render adapter format does not match the WASAPI mix format")
            }
            Self::AdapterFaultLatched => {
                formatter.write_str("the Core Audio render adapter latched a fault")
            }
            Self::DescriptorChanged => {
                formatter.write_str("WASAPI endpoint format or period changed before stream start")
            }
            Self::FormatChanged => {
                formatter.write_str("WASAPI endpoint format or period changed while running")
            }
            Self::MmcssRegistrationFailed { code } => {
                write!(
                    formatter,
                    "MMCSS Pro Audio registration failed (HRESULT {code:#010x})"
                )
            }
            Self::RenderEventTimeout => formatter.write_str("WASAPI render event timed out"),
            Self::DeviceInvalidated => {
                formatter.write_str("the selected WASAPI endpoint was invalidated")
            }
            Self::Platform { operation, code } => {
                write!(
                    formatter,
                    "WASAPI {operation} failed (HRESULT {code:#010x})"
                )
            }
            Self::ThreadSpawnFailed => {
                formatter.write_str("WASAPI render thread could not be spawned")
            }
            Self::ThreadStoppedBeforeReady => {
                formatter.write_str("WASAPI render thread stopped before stream readiness")
            }
            Self::ThreadPanicked => formatter.write_str("WASAPI render thread panicked"),
        }
    }
}

impl Error for WasapiStreamError {}

fn available_periods(
    buffer_frames: u32,
    padding_frames: u32,
    period_frames: u32,
) -> Result<u32, WasapiStreamError> {
    if period_frames == 0 || padding_frames > buffer_frames {
        return Err(invalid_engine_buffer(
            buffer_frames,
            padding_frames,
            period_frames,
        ));
    }
    let available = buffer_frames - padding_frames;
    Ok(available / period_frames)
}

fn invalid_engine_buffer(
    buffer_frames: u32,
    padding_frames: u32,
    period_frames: u32,
) -> WasapiStreamError {
    WasapiStreamError::InvalidEngineBuffer {
        buffer_frames,
        padding_frames,
        period_frames,
    }
}

#[cfg(windows)]
mod windows_stream {
    use super::{
        WasapiEnginePeriod, WasapiLiveCounters, WasapiMixFormatDetails, WasapiRenderReport,
        WasapiStreamDescriptor, WasapiStreamError, available_periods, invalid_engine_buffer,
    };
    use crate::core_audio_adapter::{
        CoreAudioAdapterSnapshot, CoreAudioRenderAdapter, CoreAudioSampleFormat,
        CoreAudioStreamFormat,
    };
    use std::slice;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Media::Audio::{
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_E_RESOURCES_INVALIDATED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, IAudioClient3, IAudioRenderClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    };
    use windows::Win32::Media::Multimedia::{
        KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT,
    };
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize,
    };
    use windows::Win32::System::Threading::{
        AVRT_PRIORITY_HIGH, AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW,
        AvSetMmThreadPriority, CreateEventW, WaitForSingleObject,
    };
    use windows::core::{GUID, PCWSTR, w};

    const WAVE_FORMAT_EXTENSIBLE_VALUE: u16 = 0xfffe;
    const KSDATAFORMAT_SUBTYPE_PCM_VALUE: GUID =
        GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
    const WAIT_TIMEOUT_MS: u32 = 100;

    #[derive(Debug)]
    pub struct WindowsWasapiRenderThread {
        descriptor: WasapiStreamDescriptor,
        stop_requested: Arc<AtomicBool>,
        live_counters: Arc<WasapiLiveCounters>,
        join: Option<JoinHandle<Result<CoreAudioAdapterSnapshot, WasapiStreamError>>>,
    }

    impl WindowsWasapiRenderThread {
        pub fn inspect(endpoint_id: &str) -> Result<WasapiStreamDescriptor, WasapiStreamError> {
            if endpoint_id.trim().is_empty() {
                return Err(WasapiStreamError::EndpointIdRequired);
            }
            if endpoint_id.contains('\0') {
                return Err(WasapiStreamError::InvalidEndpointId);
            }
            let _com = ComGuard::initialize()?;
            inspect_on_current_thread(endpoint_id)
        }

        pub fn start(
            descriptor: WasapiStreamDescriptor,
            adapter: CoreAudioRenderAdapter,
        ) -> Result<Self, WasapiStreamError> {
            if descriptor.endpoint_id.trim().is_empty() {
                return Err(WasapiStreamError::EndpointIdRequired);
            }
            if descriptor.endpoint_id.contains('\0') {
                return Err(WasapiStreamError::InvalidEndpointId);
            }
            if adapter.selected_device_id() != descriptor.endpoint_id {
                return Err(WasapiStreamError::AdapterEndpointMismatch);
            }
            if adapter.format() != descriptor.format {
                return Err(WasapiStreamError::AdapterFormatMismatch);
            }

            let stop_requested = Arc::new(AtomicBool::new(false));
            let thread_stop = Arc::clone(&stop_requested);
            let live_counters = Arc::new(WasapiLiveCounters::default());
            let thread_counters = Arc::clone(&live_counters);
            let thread_descriptor = descriptor.clone();
            let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
            let join = thread::Builder::new()
                .name("dbr-wasapi-render".to_owned())
                .spawn(move || {
                    run_render_thread(
                        thread_descriptor,
                        adapter,
                        thread_stop,
                        thread_counters,
                        ready_sender,
                    )
                })
                .map_err(|_| WasapiStreamError::ThreadSpawnFailed)?;

            match ready_receiver.recv() {
                Ok(Ok(())) => Ok(Self {
                    descriptor,
                    stop_requested,
                    live_counters,
                    join: Some(join),
                }),
                Ok(Err(error)) => {
                    let _ = join.join();
                    Err(error)
                }
                Err(_) => match join.join() {
                    Err(_) => Err(WasapiStreamError::ThreadPanicked),
                    Ok(_) => Err(WasapiStreamError::ThreadStoppedBeforeReady),
                },
            }
        }

        pub fn descriptor(&self) -> &WasapiStreamDescriptor {
            &self.descriptor
        }

        pub fn is_finished(&self) -> bool {
            self.join.as_ref().is_none_or(JoinHandle::is_finished)
        }

        pub fn live_counters(&self) -> Arc<WasapiLiveCounters> {
            Arc::clone(&self.live_counters)
        }

        pub fn stop(mut self) -> Result<WasapiRenderReport, WasapiStreamError> {
            self.stop_requested.store(true, Ordering::Release);
            let adapter = join_render_thread(self.join.take())?;
            Ok(WasapiRenderReport {
                descriptor: self.descriptor.clone(),
                mmcss_registered: true,
                adapter,
            })
        }
    }

    impl Drop for WindowsWasapiRenderThread {
        fn drop(&mut self) {
            self.stop_requested.store(true, Ordering::Release);
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    fn join_render_thread(
        join: Option<JoinHandle<Result<CoreAudioAdapterSnapshot, WasapiStreamError>>>,
    ) -> Result<CoreAudioAdapterSnapshot, WasapiStreamError> {
        let Some(join) = join else {
            return Err(WasapiStreamError::ThreadStoppedBeforeReady);
        };
        join.join().map_err(|_| WasapiStreamError::ThreadPanicked)?
    }

    fn run_render_thread(
        expected: WasapiStreamDescriptor,
        mut adapter: CoreAudioRenderAdapter,
        stop_requested: Arc<AtomicBool>,
        live_counters: Arc<WasapiLiveCounters>,
        ready: mpsc::SyncSender<Result<(), WasapiStreamError>>,
    ) -> Result<CoreAudioAdapterSnapshot, WasapiStreamError> {
        let result = run_initialized_stream(
            &expected,
            &mut adapter,
            &stop_requested,
            &live_counters,
            &ready,
        );
        if let Err(error) = &result {
            adapter.notify_device_lost(&expected.endpoint_id);
            let _ = ready.try_send(Err(error.clone()));
        }
        result.map(|()| adapter.snapshot())
    }

    fn run_initialized_stream(
        expected: &WasapiStreamDescriptor,
        adapter: &mut CoreAudioRenderAdapter,
        stop_requested: &AtomicBool,
        live_counters: &WasapiLiveCounters,
        ready: &mpsc::SyncSender<Result<(), WasapiStreamError>>,
    ) -> Result<(), WasapiStreamError> {
        let _com = ComGuard::initialize()?;
        let initialized = InitializedStream::open(expected)?;
        let _mmcss = MmcssGuard::enter()?;

        if !adapter.start() {
            return Err(WasapiStreamError::AdapterFormatMismatch);
        }
        // SAFETY: The audio client is initialized, its event handle is set, the initial endpoint
        // buffer is primed with silence, and all stream calls remain on this thread.
        unsafe { initialized.client.Start() }
            .map_err(|error| map_platform_error("stream start", error.code().0))?;
        if ready.send(Ok(())).is_err() {
            // SAFETY: Start succeeded on this thread; stop before returning without an owner.
            let _ = unsafe { initialized.client.Stop() };
            adapter.stop();
            return Err(WasapiStreamError::ThreadStoppedBeforeReady);
        }

        let render_result = render_loop(&initialized, adapter, stop_requested, live_counters);
        // SAFETY: Start succeeded on this thread; Stop is paired here before COM interfaces drop.
        let stop_result = unsafe { initialized.client.Stop() }
            .map_err(|error| map_platform_error("stream stop", error.code().0));
        adapter.stop();
        render_result.and(stop_result)
    }

    fn render_loop(
        stream: &InitializedStream,
        adapter: &mut CoreAudioRenderAdapter,
        stop_requested: &AtomicBool,
        live_counters: &WasapiLiveCounters,
    ) -> Result<(), WasapiStreamError> {
        while !stop_requested.load(Ordering::Acquire) {
            // SAFETY: render_event is a valid event owned by stream for the entire wait.
            let wait = unsafe { WaitForSingleObject(stream.render_event.0, WAIT_TIMEOUT_MS) };
            if wait == WAIT_TIMEOUT {
                if stop_requested.load(Ordering::Acquire) {
                    return Ok(());
                }
                return Err(WasapiStreamError::RenderEventTimeout);
            }
            if wait != WAIT_OBJECT_0 {
                return Err(WasapiStreamError::Platform {
                    operation: "render event wait",
                    code: wait.0 as i32,
                });
            }
            // SAFETY: The initialized client is used on its owning render thread.
            let padding = unsafe { stream.client.GetCurrentPadding() }
                .map_err(|error| map_platform_error("padding query", error.code().0))?;
            let period_frames = stream.descriptor.format.frames_per_buffer as u32;
            let periods = available_periods(stream.buffer_frames, padding, period_frames)?;
            for _ in 0..periods {
                // This is the last real padding observation for this event batch.
                // Do not query again only for diagnostics in the render callback.
                render_one_period(stream, adapter, live_counters, padding)?;
            }
        }
        Ok(())
    }

    fn render_one_period(
        stream: &InitializedStream,
        adapter: &mut CoreAudioRenderAdapter,
        live_counters: &WasapiLiveCounters,
        last_observed_padding_frames: u32,
    ) -> Result<(), WasapiStreamError> {
        let period_frames = stream.descriptor.format.frames_per_buffer as u32;
        // SAFETY: Exactly one supported period is requested, no prior packet is outstanding, and
        // ReleaseBuffer below occurs on this same thread.
        let pointer = unsafe { stream.render_client.GetBuffer(period_frames) }
            .map_err(|error| map_platform_error("render buffer acquire", error.code().0))?;
        if pointer.is_null() {
            adapter.notify_callback_buffer_size_changed();
            // SAFETY: Even a malformed successful GetBuffer must be paired on this same thread;
            // SILENT prevents the invalid pointer from being dereferenced.
            unsafe {
                stream
                    .render_client
                    .ReleaseBuffer(period_frames, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
            }
            .map_err(|error| map_platform_error("render buffer release", error.code().0))?;
            return Err(invalid_engine_buffer(
                stream.buffer_frames,
                last_observed_padding_frames,
                period_frames,
            ));
        }
        let samples =
            stream.descriptor.format.frames_per_buffer * stream.descriptor.format.channels;
        // SAFETY: WASAPI returned a writable packet for one validated 10 ms Float32 device period
        // mix format. The slice is used only until the paired ReleaseBuffer call.
        let output = unsafe { slice::from_raw_parts_mut(pointer.cast::<f32>(), samples) };
        adapter.render(output);
        let (callbacks, underruns) = adapter.render_counters();
        live_counters.publish(callbacks, underruns);
        // SAFETY: This exactly pairs the successful GetBuffer above on the same thread.
        unsafe { stream.render_client.ReleaseBuffer(period_frames, 0) }
            .map_err(|error| map_platform_error("render buffer release", error.code().0))?;
        if adapter.is_fault_latched() {
            return Err(WasapiStreamError::AdapterFaultLatched);
        }
        Ok(())
    }

    struct InitializedStream {
        descriptor: WasapiStreamDescriptor,
        client: IAudioClient3,
        render_client: IAudioRenderClient,
        render_event: OwnedHandle,
        buffer_frames: u32,
    }

    impl InitializedStream {
        fn open(expected: &WasapiStreamDescriptor) -> Result<Self, WasapiStreamError> {
            let (client, mix_format, descriptor) = open_client(&expected.endpoint_id)?;
            if descriptor != *expected {
                return Err(WasapiStreamError::DescriptorChanged);
            }
            // SAFETY: descriptor was derived from this mix format and the period was validated
            // against GetSharedModeEnginePeriod on this client.
            unsafe {
                client.InitializeSharedAudioStream(
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    expected.format.frames_per_buffer as u32,
                    mix_format.0,
                    None,
                )
            }
            .map_err(|error| map_platform_error("shared stream initialization", error.code().0))?;
            // SAFETY: Creates an unnamed auto-reset event with no custom security attributes.
            let render_event = OwnedHandle(
                unsafe { CreateEventW(None, false, false, None) }
                    .map_err(|error| map_platform_error("render event creation", error.code().0))?,
            );
            // SAFETY: The event remains alive for the client and render loop lifetime.
            unsafe { client.SetEventHandle(render_event.0) }
                .map_err(|error| map_platform_error("render event registration", error.code().0))?;
            // SAFETY: The client is initialized and IAudioRenderClient is the render service.
            let render_client: IAudioRenderClient =
                unsafe { client.GetService() }.map_err(|error| {
                    map_platform_error("render service acquisition", error.code().0)
                })?;
            // SAFETY: The initialized client owns a stable buffer size.
            let buffer_frames = unsafe { client.GetBufferSize() }
                .map_err(|error| map_platform_error("engine buffer size", error.code().0))?;
            if available_periods(buffer_frames, 0, expected.format.frames_per_buffer as u32)
                .is_err()
                || buffer_frames == 0
            {
                // Before Start, GetCurrentPadding is defined as zero. Keep this
                // pre-start diagnostic distinct from callback observations.
                return Err(invalid_engine_buffer(
                    buffer_frames,
                    0,
                    expected.format.frames_per_buffer as u32,
                ));
            }
            // SAFETY: Before Start, the entire buffer is available. GetBuffer and ReleaseBuffer
            // are paired on this thread and SILENT avoids touching uninitialized audio memory.
            unsafe { render_client.GetBuffer(buffer_frames) }
                .map_err(|error| map_platform_error("initial buffer acquire", error.code().0))?;
            // SAFETY: This pairs the successful full-buffer GetBuffer immediately above.
            unsafe {
                render_client.ReleaseBuffer(buffer_frames, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
            }
            .map_err(|error| map_platform_error("initial buffer release", error.code().0))?;
            Ok(Self {
                descriptor,
                client,
                render_client,
                render_event,
                buffer_frames,
            })
        }
    }

    fn inspect_on_current_thread(
        endpoint_id: &str,
    ) -> Result<WasapiStreamDescriptor, WasapiStreamError> {
        let (_client, _mix_format, descriptor) = open_client(endpoint_id)?;
        Ok(descriptor)
    }

    fn open_client(
        endpoint_id: &str,
    ) -> Result<(IAudioClient3, MixFormat, WasapiStreamDescriptor), WasapiStreamError> {
        let endpoint_wide: Vec<u16> = endpoint_id.encode_utf16().chain(Some(0)).collect();
        // SAFETY: COM is initialized by the caller and MMDeviceEnumerator is an in-process class.
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| map_platform_error("enumerator creation", error.code().0))?;
        // SAFETY: endpoint_wide is a valid NUL-terminated UTF-16 copy of the exact opaque ID.
        let device = unsafe { enumerator.GetDevice(PCWSTR(endpoint_wide.as_ptr())) }
            .map_err(|error| map_platform_error("explicit endpoint open", error.code().0))?;
        // SAFETY: The selected device is valid and IAudioClient3 is requested in-process.
        let client: IAudioClient3 = unsafe { device.Activate(CLSCTX_INPROC_SERVER, None) }
            .map_err(|error| map_platform_error("audio client activation", error.code().0))?;
        // SAFETY: The client returns a COM-task-allocated mix-format structure.
        let mix_format = MixFormat(
            unsafe { client.GetMixFormat() }
                .map_err(|error| map_platform_error("mix format query", error.code().0))?,
        );
        let format = parse_mix_format(mix_format.0)?;
        let mut default_frames = 0;
        let mut fundamental_frames = 0;
        let mut minimum_frames = 0;
        let mut maximum_frames = 0;
        // SAFETY: mix_format is valid for this client and all output pointers reference live u32s.
        unsafe {
            client.GetSharedModeEnginePeriod(
                mix_format.0,
                &mut default_frames,
                &mut fundamental_frames,
                &mut minimum_frames,
                &mut maximum_frames,
            )
        }
        .map_err(|error| map_platform_error("engine period query", error.code().0))?;
        let engine_period = WasapiEnginePeriod {
            default_frames,
            fundamental_frames,
            minimum_frames,
            maximum_frames,
        };
        if !engine_period.supports(format.frames_per_buffer as u32) {
            return Err(WasapiStreamError::UnsupportedEnginePeriod);
        }
        Ok((
            client,
            mix_format,
            WasapiStreamDescriptor {
                endpoint_id: endpoint_id.to_owned(),
                format,
                engine_period,
            },
        ))
    }

    fn parse_mix_format(
        pointer: *const WAVEFORMATEX,
    ) -> Result<CoreAudioStreamFormat, WasapiStreamError> {
        if pointer.is_null() {
            return Err(WasapiStreamError::UnsupportedMixFormat(
                WasapiMixFormatDetails {
                    encoding: "UNKNOWN",
                    sample_rate: 0,
                    channels: 0,
                    container_bits: 0,
                    valid_bits: 0,
                    block_align: 0,
                },
            ));
        }
        // SAFETY: pointer is a non-null mix-format structure returned by GetMixFormat.
        let format = unsafe { *pointer };
        let channels = usize::from(format.nChannels);
        let block_align = usize::from(format.nBlockAlign);
        let (encoding, is_float, valid_bits) = if format.wFormatTag == WAVE_FORMAT_IEEE_FLOAT as u16
        {
            ("IEEE_FLOAT", true, format.wBitsPerSample)
        } else if format.wFormatTag == WAVE_FORMAT_EXTENSIBLE_VALUE
            && usize::from(format.cbSize)
                >= std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>()
        {
            // SAFETY: cbSize proves the returned allocation contains WAVEFORMATEXTENSIBLE.
            let extensible = pointer.cast::<WAVEFORMATEXTENSIBLE>();
            // SAFETY: The packed extension may not align GUID/u16 fields, so copy them unaligned.
            let sub_format =
                unsafe { std::ptr::addr_of!((*extensible).SubFormat).read_unaligned() };
            let is_float = sub_format == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
            let encoding = if is_float {
                "EXTENSIBLE_IEEE_FLOAT"
            } else if sub_format == KSDATAFORMAT_SUBTYPE_PCM_VALUE {
                "EXTENSIBLE_PCM"
            } else {
                "EXTENSIBLE_OTHER"
            };
            // SAFETY: For PCM and IEEE float, this union member contains the valid bit depth.
            let valid_bits = unsafe {
                std::ptr::addr_of!((*extensible).Samples.wValidBitsPerSample).read_unaligned()
            };
            (encoding, is_float, valid_bits)
        } else {
            let encoding = if format.wFormatTag == 1 {
                "PCM"
            } else {
                "OTHER"
            };
            (encoding, false, format.wBitsPerSample)
        };
        if !is_float
            || !matches!(format.nSamplesPerSec, 48_000 | 96_000)
            || format.wBitsPerSample != 32
            || channels == 0
            || channels > 64
            || block_align != channels * std::mem::size_of::<f32>()
            || usize::try_from(format.nAvgBytesPerSec).ok()
                != usize::try_from(format.nSamplesPerSec)
                    .ok()
                    .and_then(|rate| rate.checked_mul(block_align))
        {
            return Err(WasapiStreamError::UnsupportedMixFormat(
                WasapiMixFormatDetails {
                    encoding,
                    sample_rate: format.nSamplesPerSec,
                    channels: format.nChannels,
                    container_bits: format.wBitsPerSample,
                    valid_bits,
                    block_align: format.nBlockAlign,
                },
            ));
        }
        Ok(CoreAudioStreamFormat {
            sample_rate: format.nSamplesPerSec,
            frames_per_buffer: format.nSamplesPerSec as usize / 100,
            channels,
            sample_format: CoreAudioSampleFormat::Float32,
        })
    }

    struct MixFormat(*mut WAVEFORMATEX);

    impl Drop for MixFormat {
        fn drop(&mut self) {
            // SAFETY: The pointer was allocated by GetMixFormat with the COM task allocator.
            unsafe { CoTaskMemFree(Some(self.0.cast())) };
        }
    }

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: This handle was created by CreateEventW and is closed exactly once here.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    struct ComGuard;

    impl ComGuard {
        fn initialize() -> Result<Self, WasapiStreamError> {
            // SAFETY: Initializes COM on the current thread; Drop balances it on the same thread.
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .map_err(|error| map_platform_error("COM initialization", error.code().0))?;
            Ok(Self)
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            // SAFETY: This guard exists only after successful CoInitializeEx on this thread.
            unsafe { CoUninitialize() };
        }
    }

    struct MmcssGuard(HANDLE);

    impl MmcssGuard {
        fn enter() -> Result<Self, WasapiStreamError> {
            let mut task_index = 0;
            // SAFETY: Registers the calling render thread for the built-in Pro Audio task.
            let handle = unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) }
                .map_err(|error| WasapiStreamError::MmcssRegistrationFailed {
                    code: error.code().0,
                })?;
            // SAFETY: handle belongs to this thread's MMCSS registration.
            if let Err(error) = unsafe { AvSetMmThreadPriority(handle, AVRT_PRIORITY_HIGH) } {
                // SAFETY: Registration happened on this thread and is reverted before returning.
                let _ = unsafe { AvRevertMmThreadCharacteristics(handle) };
                return Err(WasapiStreamError::MmcssRegistrationFailed {
                    code: error.code().0,
                });
            }
            Ok(Self(handle))
        }
    }

    impl Drop for MmcssGuard {
        fn drop(&mut self) {
            // SAFETY: Revert runs on the same render thread that created this registration.
            let _ = unsafe { AvRevertMmThreadCharacteristics(self.0) };
        }
    }

    fn map_platform_error(operation: &'static str, code: i32) -> WasapiStreamError {
        if code == AUDCLNT_E_DEVICE_INVALIDATED.0 || code == AUDCLNT_E_RESOURCES_INVALIDATED.0 {
            WasapiStreamError::DeviceInvalidated
        } else {
            WasapiStreamError::Platform { operation, code }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn float_extensible(sample_rate: u32) -> WAVEFORMATEXTENSIBLE {
            WAVEFORMATEXTENSIBLE {
                Format: WAVEFORMATEX {
                    wFormatTag: WAVE_FORMAT_EXTENSIBLE_VALUE,
                    nChannels: 2,
                    nSamplesPerSec: sample_rate,
                    nAvgBytesPerSec: sample_rate * 8,
                    nBlockAlign: 8,
                    wBitsPerSample: 32,
                    cbSize: (std::mem::size_of::<WAVEFORMATEXTENSIBLE>()
                        - std::mem::size_of::<WAVEFORMATEX>()) as u16,
                },
                Samples: windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE_0 {
                    wValidBitsPerSample: 32,
                },
                dwChannelMask: 3,
                SubFormat: KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
            }
        }

        #[test]
        fn parses_96_khz_float_as_a_ten_millisecond_device_period() {
            let format = float_extensible(96_000);
            let parsed = parse_mix_format(std::ptr::addr_of!(format.Format)).unwrap();
            assert_eq!(
                parsed,
                CoreAudioStreamFormat {
                    sample_rate: 96_000,
                    frames_per_buffer: 960,
                    channels: 2,
                    sample_format: CoreAudioSampleFormat::Float32,
                }
            );
        }

        #[test]
        fn unsupported_rate_reports_safe_format_details() {
            let format = float_extensible(44_100);
            assert_eq!(
                parse_mix_format(std::ptr::addr_of!(format.Format)),
                Err(WasapiStreamError::UnsupportedMixFormat(
                    WasapiMixFormatDetails {
                        encoding: "EXTENSIBLE_IEEE_FLOAT",
                        sample_rate: 44_100,
                        channels: 2,
                        container_bits: 32,
                        valid_bits: 32,
                        block_align: 8,
                    }
                ))
            );
        }

        #[test]
        fn device_and_resource_invalidation_share_the_fail_closed_device_fault() {
            assert_eq!(
                map_platform_error("test", AUDCLNT_E_DEVICE_INVALIDATED.0),
                WasapiStreamError::DeviceInvalidated
            );
            assert_eq!(
                map_platform_error("test", AUDCLNT_E_RESOURCES_INVALIDATED.0),
                WasapiStreamError::DeviceInvalidated
            );
        }
    }
}

#[cfg(windows)]
pub use windows_stream::WindowsWasapiRenderThread;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_period_requires_bounds_and_fundamental_alignment() {
        let period = WasapiEnginePeriod {
            default_frames: 480,
            fundamental_frames: 16,
            minimum_frames: 160,
            maximum_frames: 960,
        };
        assert!(period.supports(480));
        assert!(!period.supports(152));
        assert!(!period.supports(976));
        assert!(!period.supports(482));
        assert!(
            !WasapiEnginePeriod {
                fundamental_frames: 0,
                ..period
            }
            .supports(480)
        );
    }

    #[test]
    fn live_counters_are_monotonic_and_expose_the_final_render_values() {
        let counters = WasapiLiveCounters::default();
        counters.publish(4, 3);
        counters.publish(2, 1);
        assert_eq!(counters.snapshot(), (4, 3));
        counters.publish(7, 7);
        assert_eq!(counters.snapshot(), (7, 7));
    }

    #[test]
    fn available_engine_space_is_split_into_exact_callback_periods() {
        assert_eq!(available_periods(960, 480, 480), Ok(1));
        assert_eq!(available_periods(960, 0, 480), Ok(2));
        assert_eq!(available_periods(960, 960, 480), Ok(0));
    }

    #[test]
    fn partial_period_is_left_with_wasapi_and_invalid_engine_space_fails_closed() {
        assert_eq!(available_periods(1000, 480, 480), Ok(1));
        assert_eq!(
            available_periods(480, 481, 480),
            Err(WasapiStreamError::InvalidEngineBuffer {
                buffer_frames: 480,
                padding_frames: 481,
                period_frames: 480,
            })
        );
        assert_eq!(
            available_periods(480, 0, 0),
            Err(WasapiStreamError::InvalidEngineBuffer {
                buffer_frames: 480,
                padding_frames: 0,
                period_frames: 0,
            })
        );
    }

    #[test]
    fn callback_buffer_diagnostic_preserves_the_last_observed_padding() {
        assert_eq!(
            invalid_engine_buffer(2_112, 1_920, 960),
            WasapiStreamError::InvalidEngineBuffer {
                buffer_frames: 2_112,
                padding_frames: 1_920,
                period_frames: 960,
            }
        );
    }

    #[cfg(windows)]
    #[test]
    fn inspect_requires_an_explicit_endpoint_id() {
        assert_eq!(
            WindowsWasapiRenderThread::inspect(""),
            Err(WasapiStreamError::EndpointIdRequired)
        );
        assert_eq!(
            WindowsWasapiRenderThread::inspect("bad\0id"),
            Err(WasapiStreamError::InvalidEndpointId)
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires DBR_WASAPI_ENDPOINT_ID and opens only that endpoint with a silent stream"]
    fn explicit_windows_endpoint_runs_event_callback_with_mmcss() {
        use crate::audio_callback::OfflineAudioCallback;
        use crate::core_audio_adapter::{CoreAudioDevice, CoreAudioRenderAdapter};
        use crate::realtime_graph::{RealtimeAudioGraph, dense_load_config};
        use std::time::Duration;

        let endpoint_id = std::env::var("DBR_WASAPI_ENDPOINT_ID")
            .expect("DBR_WASAPI_ENDPOINT_ID must contain an operator-selected endpoint ID");
        let descriptor = WindowsWasapiRenderThread::inspect(&endpoint_id)
            .expect("explicit WASAPI endpoint preflight");
        let graph = RealtimeAudioGraph::new(
            dense_load_config(1, 1, descriptor.format.channels).expect("bounded test graph"),
        )
        .expect("test graph");
        let (_callback, io) = OfflineAudioCallback::new(graph, 2).expect("callback queues");
        let (_input, output, control) = io.into_parts();
        let adapter = CoreAudioRenderAdapter::new(
            CoreAudioDevice {
                id: endpoint_id,
                name: "Explicit WASAPI acceptance endpoint".to_owned(),
            },
            descriptor.format,
            descriptor.format.channels,
            output,
            control,
        )
        .expect("render adapter");

        let stream = WindowsWasapiRenderThread::start(descriptor, adapter)
            .expect("event-driven WASAPI stream start");
        std::thread::sleep(Duration::from_millis(250));
        let report = stream.stop().expect("event-driven WASAPI stream stop");
        assert!(report.mmcss_registered);
        assert!(report.adapter.render_callbacks > 0);
        assert!(report.adapter.output_underruns > 0);
        assert!(!report.adapter.fault_latched);
    }
}
