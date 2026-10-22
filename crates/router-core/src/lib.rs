use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Instant;

#[cfg(windows)]
use crate::wasapi_devices::{WasapiDeviceCatalog, WindowsWasapiEndpointProvider};
#[cfg(windows)]
use crate::wasapi_stream::WasapiLiveCounters;
use crate::wasapi_stream::WasapiStreamDescriptor;
#[cfg(windows)]
use crate::wasapi_stream::WindowsWasapiRenderThread;
#[cfg(windows)]
use crate::{
    audio_callback::OfflineAudioCallback,
    core_audio_adapter::{CoreAudioDevice, CoreAudioRenderAdapter},
    realtime_graph::{RealtimeAudioGraph, dense_load_config},
};
#[cfg(windows)]
use std::sync::Arc;

pub mod audio_callback;
pub mod audio_parity;
pub mod core_audio_adapter;
pub mod discord_ipc;
pub mod program_audio_ipc;
pub mod realtime_graph;
pub mod wasapi_devices;
pub mod wasapi_stream;

pub const CORE_IPC_VERSION: u8 = 1;
pub const CORE_IPC_MAX_LINE_BYTES: usize = 64 * 1024;
pub const SAMPLE_RATE: u32 = 48_000;
pub const BLOCK_SIZE: u32 = 480;
const WASAPI_ENDPOINT_ID_MAX_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OnAirState {
    Setup,
    Ready,
    OnAir,
    Fault,
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub status: &'static str,
    pub protocol_version: u8,
    pub implementation: &'static str,
    pub pid: u32,
    pub uptime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterSnapshot {
    pub revision: u64,
    pub state: OnAirState,
    pub emergency_muted: bool,
    pub monitor_source_id: Option<String>,
    pub sample_rate: u32,
    pub block_size: u32,
    pub uptime_seconds: f64,
    pub callback_load: f64,
    pub xruns: u64,
    pub channels: Vec<Value>,
    pub buses: Vec<Value>,
    pub alerts: Vec<Value>,
    pub scenes: Vec<Value>,
    pub recall_safe: Vec<String>,
    pub scene_parameters: Vec<Value>,
    pub wasapi: WasapiManagementSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiManagementSnapshot {
    pub supported: bool,
    pub selected_endpoint_id: Option<String>,
    pub selected_endpoint_name: Option<String>,
    pub selected_available: bool,
    pub preflight_ready: bool,
    pub descriptor: Option<WasapiStreamDescriptor>,
    pub stream_started: bool,
    pub stream_state: WasapiStreamState,
    pub stream_error: Option<String>,
    pub mmcss_registered: bool,
    pub render_callbacks: u64,
    pub output_underruns: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WasapiStreamState {
    Stopped,
    Running,
    Fault,
}

#[derive(Debug)]
pub struct CoreState {
    started_at: Instant,
    revision: u64,
    state: OnAirState,
    emergency_muted: bool,
    monitor_source_id: Option<String>,
    wasapi_selected_endpoint_id: Option<String>,
    wasapi_selected_endpoint_name: Option<String>,
    wasapi_selected_available: bool,
    wasapi_descriptor: Option<WasapiStreamDescriptor>,
    wasapi_stream_state: WasapiStreamState,
    wasapi_stream_error: Option<String>,
    wasapi_mmcss_registered: bool,
    wasapi_render_callbacks: u64,
    wasapi_output_underruns: u64,
    #[cfg(windows)]
    wasapi_live_counters: Option<Arc<WasapiLiveCounters>>,
    #[cfg(windows)]
    wasapi_catalog: WasapiDeviceCatalog<WindowsWasapiEndpointProvider>,
    #[cfg(windows)]
    wasapi_stream: Option<WindowsWasapiRenderThread>,
}

impl Default for CoreState {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
            revision: 1,
            state: OnAirState::Setup,
            emergency_muted: false,
            monitor_source_id: None,
            wasapi_selected_endpoint_id: None,
            wasapi_selected_endpoint_name: None,
            wasapi_selected_available: false,
            wasapi_descriptor: None,
            wasapi_stream_state: WasapiStreamState::Stopped,
            wasapi_stream_error: None,
            wasapi_mmcss_registered: false,
            wasapi_render_callbacks: 0,
            wasapi_output_underruns: 0,
            #[cfg(windows)]
            wasapi_live_counters: None,
            #[cfg(windows)]
            wasapi_catalog: WasapiDeviceCatalog::new(WindowsWasapiEndpointProvider),
            #[cfg(windows)]
            wasapi_stream: None,
        }
    }
}

impl CoreState {
    pub fn handle_line(&mut self, line: &str) -> String {
        let response = match serde_json::from_str::<Request>(line) {
            Ok(request) => self.handle(request),
            Err(error) => Response::error("", "error", format!("invalid request: {error}")),
        };
        let encoded =
            serde_json::to_string(&response).expect("serializing an IPC response cannot fail");
        if encoded.len() <= CORE_IPC_MAX_LINE_BYTES {
            return encoded;
        }
        let id = if response.id.len() <= 1_024 {
            response.id
        } else {
            String::new()
        };
        let kind = if response.kind.len() <= 128 {
            response.kind
        } else {
            "error".to_owned()
        };
        serde_json::to_string(&Response::error(
            id,
            kind,
            "response exceeds 64 KiB".to_owned(),
        ))
        .expect("serializing a bounded IPC error cannot fail")
    }

    pub fn handle(&mut self, request: Request) -> Response {
        #[cfg(windows)]
        self.reconcile_wasapi_stream();

        if request.v != CORE_IPC_VERSION {
            return Response::error(
                request.id,
                request.kind,
                format!(
                    "unsupported protocol version: {}; expected {CORE_IPC_VERSION}",
                    request.v
                ),
            );
        }

        match request.kind.as_str() {
            "health" => Response::ok(
                request.id,
                request.kind,
                json!(HealthSnapshot {
                    status: "ok",
                    protocol_version: CORE_IPC_VERSION,
                    implementation: "rust",
                    pid: std::process::id(),
                    uptime_ms: self.started_at.elapsed().as_millis() as u64,
                }),
            ),
            "get_snapshot" => Response::ok(
                request.id,
                request.kind,
                serde_json::to_value(self.snapshot()).expect("snapshot serialization cannot fail"),
            ),
            "list_wasapi_endpoints" => self.list_wasapi_endpoints(request.id, request.kind),
            "select_wasapi_endpoint" => {
                self.select_wasapi_endpoint(request.id, request.kind, &request.payload)
            }
            "clear_wasapi_endpoint" => self.clear_wasapi_endpoint(request.id, request.kind),
            "preflight_wasapi_endpoint" => self.preflight_wasapi_endpoint(request.id, request.kind),
            "start_wasapi_stream" => self.start_wasapi_stream(request.id, request.kind),
            "stop_wasapi_stream" => self.stop_wasapi_stream(request.id, request.kind),
            "command" => {
                let result = self.execute_command(&request.payload);
                Response::ok(request.id, request.kind, result)
            }
            _ => Response::error(request.id, request.kind, "unknown request type".to_owned()),
        }
    }

    pub fn snapshot(&self) -> RouterSnapshot {
        RouterSnapshot {
            revision: self.revision,
            state: self.state,
            emergency_muted: self.emergency_muted,
            monitor_source_id: self.monitor_source_id.clone(),
            sample_rate: SAMPLE_RATE,
            block_size: BLOCK_SIZE,
            uptime_seconds: self.started_at.elapsed().as_secs_f64(),
            callback_load: 0.0,
            xruns: 0,
            channels: Vec::new(),
            buses: Vec::new(),
            alerts: Vec::new(),
            scenes: Vec::new(),
            recall_safe: Vec::new(),
            scene_parameters: Vec::new(),
            wasapi: self.wasapi_snapshot(),
        }
    }

    fn wasapi_snapshot(&self) -> WasapiManagementSnapshot {
        #[cfg(windows)]
        let (live_callbacks, live_underruns) = self
            .wasapi_live_counters
            .as_ref()
            .map(|counters| counters.snapshot())
            .unwrap_or((0, 0));
        #[cfg(not(windows))]
        let (live_callbacks, live_underruns) = (0, 0);
        WasapiManagementSnapshot {
            supported: cfg!(windows),
            selected_endpoint_id: self.wasapi_selected_endpoint_id.clone(),
            selected_endpoint_name: self.wasapi_selected_endpoint_name.clone(),
            selected_available: self.wasapi_selected_available,
            preflight_ready: self.wasapi_descriptor.is_some(),
            descriptor: self.wasapi_descriptor.clone(),
            stream_started: self.wasapi_stream_state == WasapiStreamState::Running,
            stream_state: self.wasapi_stream_state,
            stream_error: self.wasapi_stream_error.clone(),
            mmcss_registered: self.wasapi_mmcss_registered,
            render_callbacks: self.wasapi_render_callbacks.max(live_callbacks),
            output_underruns: self.wasapi_output_underruns.max(live_underruns),
        }
    }

    fn reset_wasapi_stream_status(&mut self) {
        self.wasapi_stream_state = WasapiStreamState::Stopped;
        self.wasapi_stream_error = None;
        self.wasapi_mmcss_registered = false;
        self.wasapi_render_callbacks = 0;
        self.wasapi_output_underruns = 0;
        #[cfg(windows)]
        {
            self.wasapi_live_counters = None;
        }
    }

    #[cfg(windows)]
    fn fold_wasapi_live_counters(&mut self) {
        if let Some(counters) = &self.wasapi_live_counters {
            let (callbacks, underruns) = counters.snapshot();
            self.wasapi_render_callbacks = self.wasapi_render_callbacks.max(callbacks);
            self.wasapi_output_underruns = self.wasapi_output_underruns.max(underruns);
        }
    }

    fn fail_wasapi_stream(&mut self, error: String) {
        self.wasapi_stream_state = WasapiStreamState::Fault;
        self.wasapi_stream_error = Some(error);
        self.wasapi_descriptor = None;
        #[cfg(windows)]
        {
            self.fold_wasapi_live_counters();
            self.wasapi_live_counters = None;
        }
        self.revision += 1;
    }

    fn finish_wasapi_stream(
        &mut self,
        result: Result<wasapi_stream::WasapiRenderReport, wasapi_stream::WasapiStreamError>,
    ) -> Result<(), String> {
        match result {
            Ok(report) => {
                #[cfg(windows)]
                self.fold_wasapi_live_counters();
                self.wasapi_stream_state = WasapiStreamState::Stopped;
                self.wasapi_stream_error = None;
                self.wasapi_mmcss_registered = report.mmcss_registered;
                self.wasapi_render_callbacks = self
                    .wasapi_render_callbacks
                    .max(report.adapter.render_callbacks);
                self.wasapi_output_underruns = self
                    .wasapi_output_underruns
                    .max(report.adapter.output_underruns);
                #[cfg(windows)]
                {
                    self.wasapi_live_counters = None;
                }
                self.revision += 1;
                Ok(())
            }
            Err(error) => {
                if matches!(error, wasapi_stream::WasapiStreamError::DeviceInvalidated) {
                    self.wasapi_selected_available = false;
                }
                let message = error.to_string();
                self.fail_wasapi_stream(message.clone());
                Err(message)
            }
        }
    }

    #[cfg(windows)]
    fn diagnose_wasapi_stream_error(
        &mut self,
        error: wasapi_stream::WasapiStreamError,
    ) -> wasapi_stream::WasapiStreamError {
        if error != wasapi_stream::WasapiStreamError::RenderEventTimeout {
            return error;
        }
        let expected = self.wasapi_descriptor.clone();
        if self.refresh_wasapi_endpoints().is_err() || !self.wasapi_selected_available {
            return if self.wasapi_selected_available {
                error
            } else {
                wasapi_stream::WasapiStreamError::DeviceInvalidated
            };
        }
        let Some(endpoint_id) = self.wasapi_selected_endpoint_id.as_deref() else {
            return error;
        };
        match WindowsWasapiRenderThread::inspect(endpoint_id) {
            Ok(current) if expected.as_ref() != Some(&current) => {
                wasapi_stream::WasapiStreamError::FormatChanged
            }
            Err(wasapi_stream::WasapiStreamError::DeviceInvalidated) => {
                wasapi_stream::WasapiStreamError::DeviceInvalidated
            }
            _ => error,
        }
    }

    #[cfg(windows)]
    fn reconcile_wasapi_stream(&mut self) {
        if !self
            .wasapi_stream
            .as_ref()
            .is_some_and(WindowsWasapiRenderThread::is_finished)
        {
            return;
        }
        let stream = self
            .wasapi_stream
            .take()
            .expect("a finished WASAPI stream was just observed");
        let result = match stream.stop() {
            Ok(report) => Ok(report),
            Err(error) => Err(self.diagnose_wasapi_stream_error(error)),
        };
        let _ = self.finish_wasapi_stream(result);
    }

    #[cfg(windows)]
    fn refresh_wasapi_endpoints(&mut self) -> Result<Vec<wasapi_devices::WasapiEndpoint>, String> {
        let endpoints = self
            .wasapi_catalog
            .refresh()
            .map_err(|error| error.to_string())?
            .to_vec();
        let selected = self.wasapi_selected_endpoint_id.as_deref().and_then(|id| {
            endpoints.iter().find(|endpoint| {
                endpoint.id == id
                    && endpoint.direction == wasapi_devices::WasapiEndpointDirection::Render
                    && endpoint.state == wasapi_devices::WasapiEndpointState::Active
            })
        });
        let available = selected.is_some();
        let name = selected
            .map(|endpoint| endpoint.name.clone())
            .or_else(|| self.wasapi_selected_endpoint_name.clone());
        let changed = self.wasapi_selected_available != available
            || self.wasapi_selected_endpoint_name != name;
        let preflight_invalidated = !available && self.wasapi_descriptor.take().is_some();
        self.wasapi_selected_available = available;
        self.wasapi_selected_endpoint_name = name;
        if changed || preflight_invalidated {
            self.revision += 1;
        }
        Ok(endpoints)
    }

    #[cfg(not(windows))]
    fn list_wasapi_endpoints(&mut self, id: String, kind: String) -> Response {
        Response::ok(
            id,
            kind,
            json!({
                "supported": false,
                "endpoints": [],
                "selectedEndpointId": null,
                "selectedEndpointName": null,
                "selectedAvailable": false,
            }),
        )
    }

    #[cfg(windows)]
    fn list_wasapi_endpoints(&mut self, id: String, kind: String) -> Response {
        match self.refresh_wasapi_endpoints() {
            Ok(endpoints) => Response::ok(
                id,
                kind,
                json!({
                    "supported": true,
                    "endpoints": endpoints,
                    "selectedEndpointId": self.wasapi_selected_endpoint_id.clone(),
                    "selectedEndpointName": self.wasapi_selected_endpoint_name.clone(),
                    "selectedAvailable": self.wasapi_selected_available,
                }),
            ),
            Err(error) => Response::error(id, kind, error),
        }
    }

    #[cfg(not(windows))]
    fn select_wasapi_endpoint(&mut self, id: String, kind: String, _payload: &Value) -> Response {
        Response::error(
            id,
            kind,
            "WASAPI endpoint management is unavailable on this platform".to_owned(),
        )
    }

    #[cfg(windows)]
    fn select_wasapi_endpoint(&mut self, id: String, kind: String, payload: &Value) -> Response {
        if self.wasapi_stream_state == WasapiStreamState::Running {
            return Response::error(
                id,
                kind,
                "stop the WASAPI stream before changing the endpoint".to_owned(),
            );
        }
        let Some(endpoint_id) = payload.get("endpointId").and_then(Value::as_str) else {
            return Response::error(id, kind, "endpointId is required".to_owned());
        };
        if endpoint_id.trim().is_empty()
            || endpoint_id.contains('\0')
            || endpoint_id.len() > WASAPI_ENDPOINT_ID_MAX_BYTES
        {
            return Response::error(id, kind, "endpointId is invalid".to_owned());
        }
        let endpoints = match self.refresh_wasapi_endpoints() {
            Ok(endpoints) => endpoints,
            Err(error) => return Response::error(id, kind, error),
        };
        let Some(endpoint) = endpoints.iter().find(|endpoint| {
            endpoint.id == endpoint_id
                && endpoint.direction == wasapi_devices::WasapiEndpointDirection::Render
                && endpoint.state == wasapi_devices::WasapiEndpointState::Active
        }) else {
            return Response::error(
                id,
                kind,
                "the explicitly selected Core Audio endpoint is unavailable".to_owned(),
            );
        };
        if self.wasapi_catalog.select(endpoint_id).is_err() {
            return Response::error(
                id,
                kind,
                "the explicitly selected Core Audio endpoint is unavailable".to_owned(),
            );
        }
        let changed = self.wasapi_selected_endpoint_id.as_deref() != Some(endpoint_id);
        self.wasapi_selected_endpoint_id = Some(endpoint.id.clone());
        self.wasapi_selected_endpoint_name = Some(endpoint.name.clone());
        self.wasapi_selected_available = true;
        if changed {
            self.wasapi_descriptor = None;
            self.reset_wasapi_stream_status();
            self.revision += 1;
        }
        Response::ok(
            id,
            kind,
            json!({ "revision": self.revision, "wasapi": self.wasapi_snapshot() }),
        )
    }

    fn clear_wasapi_endpoint(&mut self, id: String, kind: String) -> Response {
        if self.wasapi_stream_state == WasapiStreamState::Running {
            return Response::error(
                id,
                kind,
                "stop the WASAPI stream before clearing the endpoint".to_owned(),
            );
        }
        if self.wasapi_selected_endpoint_id.is_some() {
            #[cfg(windows)]
            self.wasapi_catalog.clear_selection();
            self.wasapi_selected_endpoint_id = None;
            self.wasapi_selected_endpoint_name = None;
            self.wasapi_selected_available = false;
            self.wasapi_descriptor = None;
            self.reset_wasapi_stream_status();
            self.revision += 1;
        }
        Response::ok(
            id,
            kind,
            json!({ "revision": self.revision, "wasapi": self.wasapi_snapshot() }),
        )
    }

    #[cfg(not(windows))]
    fn preflight_wasapi_endpoint(&mut self, id: String, kind: String) -> Response {
        Response::error(
            id,
            kind,
            "WASAPI endpoint management is unavailable on this platform".to_owned(),
        )
    }

    #[cfg(windows)]
    fn preflight_wasapi_endpoint(&mut self, id: String, kind: String) -> Response {
        if self.wasapi_stream_state == WasapiStreamState::Running {
            return Response::error(
                id,
                kind,
                "stop the WASAPI stream before running preflight".to_owned(),
            );
        }
        let Some(endpoint_id) = self.wasapi_selected_endpoint_id.clone() else {
            return Response::error(
                id,
                kind,
                "an explicitly selected WASAPI endpoint is required".to_owned(),
            );
        };
        if let Err(error) = self.refresh_wasapi_endpoints() {
            return Response::error(id, kind, error);
        }
        if !self.wasapi_selected_available {
            return Response::error(
                id,
                kind,
                "the explicitly selected Core Audio endpoint is unavailable".to_owned(),
            );
        }
        match WindowsWasapiRenderThread::inspect(&endpoint_id) {
            Ok(descriptor) => {
                if self.wasapi_descriptor.as_ref() != Some(&descriptor) {
                    self.wasapi_descriptor = Some(descriptor.clone());
                    self.revision += 1;
                }
                if self.wasapi_stream_state == WasapiStreamState::Fault {
                    self.reset_wasapi_stream_status();
                    self.revision += 1;
                }
                Response::ok(
                    id,
                    kind,
                    json!({
                        "revision": self.revision,
                        "descriptor": descriptor,
                        "streamStarted": false,
                    }),
                )
            }
            Err(error) => {
                if self.wasapi_descriptor.take().is_some() {
                    self.revision += 1;
                }
                Response::error(id, kind, error.to_string())
            }
        }
    }

    #[cfg(not(windows))]
    fn start_wasapi_stream(&mut self, id: String, kind: String) -> Response {
        Response::error(
            id,
            kind,
            "WASAPI stream is unavailable on this platform".to_owned(),
        )
    }

    #[cfg(windows)]
    fn start_wasapi_stream(&mut self, id: String, kind: String) -> Response {
        if self.state != OnAirState::Setup {
            return Response::error(id, kind, "WASAPI stream can start only in SETUP".to_owned());
        }
        if self.wasapi_stream_state == WasapiStreamState::Running || self.wasapi_stream.is_some() {
            return Response::error(id, kind, "WASAPI stream is already running".to_owned());
        }
        if let Err(error) = self.refresh_wasapi_endpoints() {
            return Response::error(id, kind, error);
        }
        let Some(endpoint_id) = self.wasapi_selected_endpoint_id.clone() else {
            return Response::error(
                id,
                kind,
                "an explicitly selected WASAPI endpoint is required".to_owned(),
            );
        };
        if !self.wasapi_selected_available {
            return Response::error(
                id,
                kind,
                "the explicitly selected Core Audio endpoint is unavailable".to_owned(),
            );
        }
        let Some(descriptor) = self.wasapi_descriptor.clone() else {
            return Response::error(
                id,
                kind,
                "WASAPI preflight is required before stream start".to_owned(),
            );
        };
        let graph = match dense_load_config(1, 1, descriptor.format.channels)
            .map_err(|_| ())
            .and_then(|configuration| RealtimeAudioGraph::new(configuration).map_err(|_| ()))
        {
            Ok(graph) => graph,
            Err(()) => {
                return Response::error(
                    id,
                    kind,
                    "silent WASAPI acceptance graph could not be initialized".to_owned(),
                );
            }
        };
        let (_callback, io) = match OfflineAudioCallback::new(graph, 2) {
            Ok(parts) => parts,
            Err(_) => {
                return Response::error(
                    id,
                    kind,
                    "silent WASAPI acceptance queues could not be initialized".to_owned(),
                );
            }
        };
        let (_input, output, control) = io.into_parts();
        let device_name = self
            .wasapi_selected_endpoint_name
            .clone()
            .unwrap_or_else(|| "Explicit WASAPI acceptance endpoint".to_owned());
        let adapter = match CoreAudioRenderAdapter::new(
            CoreAudioDevice {
                id: endpoint_id,
                name: device_name,
            },
            descriptor.format,
            descriptor.format.channels,
            output,
            control,
        ) {
            Ok(adapter) => adapter,
            Err(_) => {
                return Response::error(
                    id,
                    kind,
                    "silent WASAPI render adapter could not be initialized".to_owned(),
                );
            }
        };
        match WindowsWasapiRenderThread::start(descriptor, adapter) {
            Ok(stream) => {
                self.wasapi_live_counters = Some(stream.live_counters());
                self.wasapi_stream = Some(stream);
                self.wasapi_stream_state = WasapiStreamState::Running;
                self.wasapi_stream_error = None;
                self.wasapi_mmcss_registered = true;
                self.wasapi_render_callbacks = 0;
                self.wasapi_output_underruns = 0;
                self.revision += 1;
                Response::ok(
                    id,
                    kind,
                    json!({ "revision": self.revision, "wasapi": self.wasapi_snapshot() }),
                )
            }
            Err(error) => {
                let message = error.to_string();
                self.fail_wasapi_stream(message.clone());
                Response::error(id, kind, message)
            }
        }
    }

    #[cfg(not(windows))]
    fn stop_wasapi_stream(&mut self, id: String, kind: String) -> Response {
        Response::error(
            id,
            kind,
            "WASAPI stream is unavailable on this platform".to_owned(),
        )
    }

    #[cfg(windows)]
    fn stop_wasapi_stream(&mut self, id: String, kind: String) -> Response {
        let Some(stream) = self.wasapi_stream.take() else {
            return Response::ok(
                id,
                kind,
                json!({ "revision": self.revision, "wasapi": self.wasapi_snapshot() }),
            );
        };
        let result = match stream.stop() {
            Ok(report) => Ok(report),
            Err(error) => Err(self.diagnose_wasapi_stream_error(error)),
        };
        match self.finish_wasapi_stream(result) {
            Ok(()) => Response::ok(
                id,
                kind,
                json!({ "revision": self.revision, "wasapi": self.wasapi_snapshot() }),
            ),
            Err(message) => Response::error(id, kind, message),
        }
    }

    fn execute_command(&mut self, command: &Value) -> Value {
        let Some(kind) = command.get("type").and_then(Value::as_str) else {
            return self.command_error("command.type is required", false);
        };

        match kind {
            "SET_STATE" => self.set_state(command),
            "SET_PFL" => self.set_pfl(command),
            "EMERGENCY_MUTE" => self.set_emergency_mute(command),
            "ACKNOWLEDGE_FAULT" => self.acknowledge_fault(command),
            _ => self.command_error(
                &format!("{kind} is not owned by the Rust core in Phase 10"),
                false,
            ),
        }
    }

    fn set_pfl(&mut self, command: &Value) -> Value {
        let source_id = match command.get("sourceId") {
            Some(Value::Null) => None,
            Some(Value::String(value))
                if !value.is_empty() && value.encode_utf16().count() <= 256 =>
            {
                Some(value.clone())
            }
            _ => {
                return self.command_error(
                    "sourceId must be null or a non-empty string up to 256 characters",
                    false,
                );
            }
        };
        self.monitor_source_id = source_id;
        self.revision += 1;
        self.command_ok()
    }

    fn set_state(&mut self, command: &Value) -> Value {
        let next = match command.get("state").and_then(Value::as_str) {
            Some("SETUP") => OnAirState::Setup,
            Some("READY") => OnAirState::Ready,
            Some("ON_AIR") => OnAirState::OnAir,
            Some("FAULT") => {
                return self.command_error(
                    "FAULT is entered by a detected failure, not an operator command",
                    false,
                );
            }
            _ => return self.command_error("unknown router state", false),
        };

        if self.state == OnAirState::Fault {
            return self.command_error("FAULT must be acknowledged with ACKNOWLEDGE_FAULT", true);
        }
        if self.wasapi_stream_state == WasapiStreamState::Running && next != OnAirState::Setup {
            return self.command_error("stop the WASAPI stream before leaving SETUP", false);
        }
        if next == OnAirState::OnAir {
            return self.command_error(
                "Rust audio graph and safety limiters are not production-ready in Phase 10",
                false,
            );
        }
        let confirmed = command
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if self.state == OnAirState::OnAir && next != OnAirState::OnAir && !confirmed {
            return self.command_error("state transition requires confirmation", true);
        }

        self.state = next;
        self.revision += 1;
        self.command_ok()
    }

    fn set_emergency_mute(&mut self, command: &Value) -> Value {
        let Some(active) = command.get("active").and_then(Value::as_bool) else {
            return self.command_error("active must be a boolean", false);
        };
        let confirmed = command
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !active && !confirmed {
            return self.command_error("Confirmation is required to release emergency mute", true);
        }
        self.emergency_muted = active;
        self.revision += 1;
        self.command_ok()
    }

    fn acknowledge_fault(&mut self, command: &Value) -> Value {
        if self.state != OnAirState::Fault {
            return self.command_error("Router is not in FAULT state", false);
        }
        if !command
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return self.command_error("fault acknowledgement requires confirmation", true);
        }
        self.state = OnAirState::Setup;
        self.emergency_muted = true;
        self.revision += 1;
        self.command_ok()
    }

    fn command_ok(&self) -> Value {
        json!({ "ok": true, "revision": self.revision })
    }

    fn command_error(&self, error: &str, confirmation_required: bool) -> Value {
        let mut result = json!({
            "ok": false,
            "revision": self.revision,
            "error": error,
        });
        if confirmation_required {
            result["confirmationRequired"] = Value::Bool(true);
        }
        result
    }
}

impl Response {
    fn ok(id: String, kind: String, payload: Value) -> Self {
        Self {
            v: CORE_IPC_VERSION,
            id,
            kind,
            ok: true,
            payload: Some(payload),
            error: None,
        }
    }

    fn error(id: impl Into<String>, kind: impl Into<String>, error: String) -> Self {
        Self {
            v: CORE_IPC_VERSION,
            id: id.into(),
            kind: kind.into(),
            ok: false,
            payload: None,
            error: Some(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(core: &mut CoreState, request: Value) -> Value {
        serde_json::from_str(&core.handle_line(&request.to_string())).unwrap()
    }

    #[test]
    fn health_and_snapshot_are_correlated() {
        let mut core = CoreState::default();
        let health = call(&mut core, json!({"v": 1, "id": "h1", "type": "health"}));
        assert_eq!(health["id"], "h1");
        assert_eq!(health["payload"]["implementation"], "rust");

        let snapshot = call(
            &mut core,
            json!({"v": 1, "id": "s1", "type": "get_snapshot"}),
        );
        assert_eq!(snapshot["payload"]["state"], "SETUP");
        assert_eq!(snapshot["payload"]["sampleRate"], SAMPLE_RATE);
        assert_eq!(snapshot["payload"]["blockSize"], BLOCK_SIZE);
    }

    #[test]
    fn command_round_trip_updates_revision_and_snapshot() {
        let mut core = CoreState::default();
        let result = call(
            &mut core,
            json!({
                "v": 1,
                "id": "c1",
                "type": "command",
                "payload": {"type": "SET_STATE", "state": "READY"}
            }),
        );
        assert_eq!(result["payload"]["ok"], true);
        assert_eq!(result["payload"]["revision"], 2);
        assert_eq!(core.snapshot().state, OnAirState::Ready);

        let pfl = call(
            &mut core,
            json!({
                "v": 1,
                "id": "c2",
                "type": "command",
                "payload": {"type": "SET_PFL", "sourceId": "user-01"}
            }),
        );
        assert_eq!(pfl["payload"]["ok"], true);
        assert_eq!(pfl["payload"]["revision"], 3);
        assert_eq!(
            core.snapshot().monitor_source_id.as_deref(),
            Some("user-01")
        );
    }

    #[test]
    fn safety_confirmations_match_the_reference_semantics() {
        let mut core = CoreState::default();
        let on_air = call(
            &mut core,
            json!({
                "v": 1,
                "id": "c1",
                "type": "command",
                "payload": {"type": "SET_STATE", "state": "ON_AIR"}
            }),
        );
        assert_eq!(on_air["payload"]["ok"], false);
        assert!(on_air["payload"]["confirmationRequired"].is_null());
        assert!(
            on_air["payload"]["error"]
                .as_str()
                .unwrap()
                .contains("not production-ready")
        );
        assert_eq!(core.snapshot().state, OnAirState::Setup);

        let muting = call(
            &mut core,
            json!({
                "v": 1,
                "id": "c2",
                "type": "command",
                "payload": {"type": "EMERGENCY_MUTE", "active": true}
            }),
        );
        assert_eq!(muting["payload"]["ok"], true);
        let release = call(
            &mut core,
            json!({
                "v": 1,
                "id": "c3",
                "type": "command",
                "payload": {"type": "EMERGENCY_MUTE", "active": false}
            }),
        );
        assert_eq!(release["payload"]["confirmationRequired"], true);
        assert!(core.snapshot().emergency_muted);
    }

    #[test]
    fn oversized_snapshot_response_fails_closed_within_the_ipc_bound() {
        let mut core = CoreState {
            wasapi_selected_endpoint_id: Some("x".repeat(CORE_IPC_MAX_LINE_BYTES)),
            ..CoreState::default()
        };

        let encoded =
            core.handle_line(&json!({"v": 1, "id": "bounded", "type": "get_snapshot"}).to_string());
        assert!(encoded.len() <= CORE_IPC_MAX_LINE_BYTES);
        let response: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(response["id"], "bounded");
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"], "response exceeds 64 KiB");
    }

    #[test]
    fn running_wasapi_acceptance_blocks_leaving_setup() {
        let mut core = CoreState {
            wasapi_stream_state: WasapiStreamState::Running,
            ..CoreState::default()
        };
        let result = call(
            &mut core,
            json!({
                "v": 1,
                "id": "state-gate",
                "type": "command",
                "payload": {"type": "SET_STATE", "state": "READY"}
            }),
        );
        assert_eq!(result["payload"]["ok"], false);
        assert!(
            result["payload"]["error"]
                .as_str()
                .unwrap()
                .contains("stop the WASAPI stream")
        );
        assert_eq!(core.snapshot().state, OnAirState::Setup);
    }

    #[cfg(windows)]
    #[test]
    fn wasapi_snapshot_uses_live_counters_without_regressing_final_values() {
        let counters = Arc::new(WasapiLiveCounters::default());
        counters.publish(12, 9);
        let mut core = CoreState {
            wasapi_render_callbacks: 10,
            wasapi_output_underruns: 8,
            wasapi_live_counters: Some(Arc::clone(&counters)),
            ..CoreState::default()
        };
        assert_eq!(core.wasapi_snapshot().render_callbacks, 12);
        assert_eq!(core.wasapi_snapshot().output_underruns, 9);

        core.wasapi_render_callbacks = 15;
        core.wasapi_output_underruns = 11;
        assert_eq!(core.wasapi_snapshot().render_callbacks, 15);
        assert_eq!(core.wasapi_snapshot().output_underruns, 11);
    }

    #[cfg(windows)]
    #[test]
    fn wasapi_fault_folds_live_counters_before_the_stream_is_detached() {
        let counters = Arc::new(WasapiLiveCounters::default());
        counters.publish(12, 9);
        let mut core = CoreState {
            wasapi_live_counters: Some(counters),
            ..CoreState::default()
        };
        core.fail_wasapi_stream("sanitized fault".to_owned());
        let snapshot = core.wasapi_snapshot();
        assert_eq!(snapshot.stream_state, WasapiStreamState::Fault);
        assert_eq!(
            (snapshot.render_callbacks, snapshot.output_underruns),
            (12, 9)
        );
    }

    #[test]
    fn wasapi_device_invalidation_latches_fault_without_selecting_a_fallback() {
        let descriptor = WasapiStreamDescriptor {
            endpoint_id: "operator-selected-endpoint".to_owned(),
            format: core_audio_adapter::CoreAudioStreamFormat::production(2),
            engine_period: wasapi_stream::WasapiEnginePeriod {
                default_frames: 480,
                fundamental_frames: 480,
                minimum_frames: 480,
                maximum_frames: 480,
            },
        };
        let mut core = CoreState {
            revision: 7,
            wasapi_selected_endpoint_id: Some(descriptor.endpoint_id.clone()),
            wasapi_selected_endpoint_name: Some("Operator Output".to_owned()),
            wasapi_selected_available: true,
            wasapi_descriptor: Some(descriptor),
            wasapi_stream_state: WasapiStreamState::Running,
            wasapi_mmcss_registered: true,
            ..CoreState::default()
        };

        let result =
            core.finish_wasapi_stream(Err(wasapi_stream::WasapiStreamError::DeviceInvalidated));

        assert!(result.unwrap_err().contains("endpoint was invalidated"));
        let snapshot = core.wasapi_snapshot();
        assert_eq!(snapshot.stream_state, WasapiStreamState::Fault);
        assert!(!snapshot.stream_started);
        assert!(!snapshot.preflight_ready);
        assert_eq!(
            snapshot.selected_endpoint_id.as_deref(),
            Some("operator-selected-endpoint")
        );
        assert_eq!(
            snapshot.selected_endpoint_name.as_deref(),
            Some("Operator Output")
        );
        assert!(!snapshot.selected_available);
        assert!(
            snapshot
                .stream_error
                .as_deref()
                .is_some_and(|message| message.contains("endpoint was invalidated"))
        );
        assert_eq!(core.revision, 8);
    }

    #[test]
    fn wasapi_format_change_latches_fault_and_requires_preflight_again() {
        let descriptor = WasapiStreamDescriptor {
            endpoint_id: "operator-selected-endpoint".to_owned(),
            format: core_audio_adapter::CoreAudioStreamFormat::production(2),
            engine_period: wasapi_stream::WasapiEnginePeriod {
                default_frames: 480,
                fundamental_frames: 480,
                minimum_frames: 480,
                maximum_frames: 480,
            },
        };
        let mut core = CoreState {
            revision: 11,
            wasapi_selected_endpoint_id: Some(descriptor.endpoint_id.clone()),
            wasapi_selected_endpoint_name: Some("Operator Output".to_owned()),
            wasapi_selected_available: true,
            wasapi_descriptor: Some(descriptor),
            wasapi_stream_state: WasapiStreamState::Running,
            wasapi_mmcss_registered: true,
            ..CoreState::default()
        };

        let result =
            core.finish_wasapi_stream(Err(wasapi_stream::WasapiStreamError::FormatChanged));

        assert!(result.unwrap_err().contains("changed while running"));
        let snapshot = core.wasapi_snapshot();
        assert_eq!(snapshot.stream_state, WasapiStreamState::Fault);
        assert!(!snapshot.stream_started);
        assert!(!snapshot.preflight_ready);
        assert_eq!(
            snapshot.selected_endpoint_id.as_deref(),
            Some("operator-selected-endpoint")
        );
        assert_eq!(
            snapshot.selected_endpoint_name.as_deref(),
            Some("Operator Output")
        );
        assert!(snapshot.selected_available);
        assert!(
            snapshot
                .stream_error
                .as_deref()
                .is_some_and(|message| message.contains("changed while running"))
        );
        assert_eq!(core.revision, 12);
    }
}
