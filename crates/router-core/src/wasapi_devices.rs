use serde::Serialize;
use std::collections::HashSet;
use std::error::Error;
use std::fmt::{Display, Formatter};

const UNNAMED_ENDPOINT: &str = "Unnamed Core Audio endpoint";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiEndpoint {
    /// Opaque identifier returned by Core Audio. It must never be parsed.
    pub id: String,
    pub name: String,
    pub direction: WasapiEndpointDirection,
    pub state: WasapiEndpointState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WasapiEndpointDirection {
    Render,
    Capture,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WasapiEndpointState {
    Active,
    Disabled,
    NotPresent,
    Unplugged,
    Unknown,
}

pub trait WasapiEndpointProvider {
    fn endpoints(&self) -> Result<Vec<WasapiEndpoint>, WasapiEndpointError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WasapiEndpointError {
    Platform { operation: &'static str, code: i32 },
    InvalidEndpointText,
    EmptyEndpointId,
    DuplicateEndpointId,
    EndpointNotFound,
}

impl Display for WasapiEndpointError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Platform { operation, code } => {
                write!(
                    formatter,
                    "Core Audio {operation} failed (HRESULT {code:#010x})"
                )
            }
            Self::InvalidEndpointText => {
                formatter.write_str("Core Audio returned invalid endpoint text")
            }
            Self::EmptyEndpointId => {
                formatter.write_str("Core Audio returned an empty endpoint ID")
            }
            Self::DuplicateEndpointId => {
                formatter.write_str("Core Audio returned a duplicate endpoint ID")
            }
            Self::EndpointNotFound => {
                formatter.write_str("the explicitly selected Core Audio endpoint is unavailable")
            }
        }
    }
}

impl Error for WasapiEndpointError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiDeviceSnapshot {
    pub endpoints: Vec<WasapiEndpoint>,
    pub selected_endpoint_id: Option<String>,
    pub selected_endpoint_name: Option<String>,
    pub selected_available: bool,
}

/// Maintains a read-only endpoint inventory and an operator-selected opaque ID.
///
/// Refresh is transactional. A malformed enumeration never replaces the last known-good list,
/// and a missing selected endpoint remains selected-but-unavailable instead of falling back.
#[derive(Debug)]
pub struct WasapiDeviceCatalog<P> {
    provider: P,
    endpoints: Vec<WasapiEndpoint>,
    selected_endpoint_id: Option<String>,
}

impl<P: WasapiEndpointProvider> WasapiDeviceCatalog<P> {
    pub fn new(provider: P) -> Self {
        Self {
            provider,
            endpoints: Vec::new(),
            selected_endpoint_id: None,
        }
    }

    pub fn refresh(&mut self) -> Result<&[WasapiEndpoint], WasapiEndpointError> {
        let mut next = self.provider.endpoints()?;
        let mut seen = HashSet::with_capacity(next.len());

        for endpoint in &mut next {
            if endpoint.id.trim().is_empty() {
                return Err(WasapiEndpointError::EmptyEndpointId);
            }
            if !seen.insert(endpoint.id.clone()) {
                return Err(WasapiEndpointError::DuplicateEndpointId);
            }
            if endpoint.name.trim().is_empty() {
                endpoint.name = UNNAMED_ENDPOINT.to_owned();
            }
        }

        next.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.id.cmp(&right.id))
        });
        self.endpoints = next;
        Ok(&self.endpoints)
    }

    pub fn select(&mut self, endpoint_id: &str) -> Result<(), WasapiEndpointError> {
        if !self
            .endpoints
            .iter()
            .any(|endpoint| endpoint.id == endpoint_id)
        {
            return Err(WasapiEndpointError::EndpointNotFound);
        }
        self.selected_endpoint_id = Some(endpoint_id.to_owned());
        Ok(())
    }

    pub fn clear_selection(&mut self) {
        self.selected_endpoint_id = None;
    }

    pub fn snapshot(&self) -> WasapiDeviceSnapshot {
        let selected = self.selected_endpoint_id.as_deref().and_then(|id| {
            self.endpoints.iter().find(|endpoint| {
                endpoint.id == id
                    && endpoint.direction == WasapiEndpointDirection::Render
                    && endpoint.state == WasapiEndpointState::Active
            })
        });
        WasapiDeviceSnapshot {
            endpoints: self.endpoints.clone(),
            selected_endpoint_id: self.selected_endpoint_id.clone(),
            selected_endpoint_name: selected.map(|endpoint| endpoint.name.clone()),
            selected_available: selected.is_some(),
        }
    }
}

#[cfg(windows)]
mod windows_provider {
    use super::{
        WasapiEndpoint, WasapiEndpointDirection, WasapiEndpointError, WasapiEndpointProvider,
        WasapiEndpointState,
    };
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        DEVICE_STATE, DEVICE_STATE_ACTIVE, DEVICE_STATE_DISABLED, DEVICE_STATE_NOTPRESENT,
        DEVICE_STATE_UNPLUGGED, DEVICE_STATEMASK_ALL, EDataFlow, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, eCapture, eRender,
    };
    use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize, STGM_READ,
    };

    #[derive(Debug, Default, Clone, Copy)]
    pub struct WindowsWasapiEndpointProvider;

    struct ComGuard;

    impl ComGuard {
        fn initialize() -> Result<Self, WasapiEndpointError> {
            // SAFETY: This initializes COM for the current enumeration thread and the matching
            // guard calls CoUninitialize on the same thread.
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .map_err(|error| platform_error("COM initialization", error.code().0))?;
            Ok(Self)
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            // SAFETY: The guard only exists after successful CoInitializeEx on this thread.
            unsafe { CoUninitialize() };
        }
    }

    impl WasapiEndpointProvider for WindowsWasapiEndpointProvider {
        fn endpoints(&self) -> Result<Vec<WasapiEndpoint>, WasapiEndpointError> {
            let _com = ComGuard::initialize()?;
            // SAFETY: COM is initialized for this thread and MMDeviceEnumerator is an in-process
            // COM class. The returned interface owns its COM reference.
            let enumerator: IMMDeviceEnumerator =
                unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER) }
                    .map_err(|error| platform_error("enumerator creation", error.code().0))?;
            let mut endpoints = enumerate(&enumerator, eRender, WasapiEndpointDirection::Render)?;
            endpoints.extend(enumerate(
                &enumerator,
                eCapture,
                WasapiEndpointDirection::Capture,
            )?);
            Ok(endpoints)
        }
    }

    fn enumerate(
        enumerator: &IMMDeviceEnumerator,
        flow: EDataFlow,
        direction: WasapiEndpointDirection,
    ) -> Result<Vec<WasapiEndpoint>, WasapiEndpointError> {
        // SAFETY: The enumerator interface is valid and both enum arguments are documented.
        let collection =
            unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE(DEVICE_STATEMASK_ALL)) }
                .map_err(|error| platform_error("endpoint enumeration", error.code().0))?;
        // SAFETY: The collection interface is valid.
        let count = unsafe { collection.GetCount() }
            .map_err(|error| platform_error("endpoint count", error.code().0))?;
        let mut endpoints = Vec::with_capacity(count as usize);

        for index in 0..count {
            // SAFETY: index is within the collection count obtained above.
            let device = unsafe { collection.Item(index) }
                .map_err(|error| platform_error("endpoint access", error.code().0))?;
            endpoints.push(WasapiEndpoint {
                id: endpoint_id(&device)?,
                name: endpoint_name(&device).unwrap_or_default(),
                direction,
                state: endpoint_state(&device)?,
            });
        }
        Ok(endpoints)
    }

    fn endpoint_state(device: &IMMDevice) -> Result<WasapiEndpointState, WasapiEndpointError> {
        // SAFETY: device is a valid IMMDevice and GetState has no additional preconditions.
        let state = unsafe { device.GetState() }
            .map_err(|error| platform_error("endpoint state read", error.code().0))?;
        Ok(if state == DEVICE_STATE_ACTIVE {
            WasapiEndpointState::Active
        } else if state == DEVICE_STATE_DISABLED {
            WasapiEndpointState::Disabled
        } else if state == DEVICE_STATE_NOTPRESENT {
            WasapiEndpointState::NotPresent
        } else if state == DEVICE_STATE_UNPLUGGED {
            WasapiEndpointState::Unplugged
        } else {
            WasapiEndpointState::Unknown
        })
    }

    fn endpoint_id(device: &IMMDevice) -> Result<String, WasapiEndpointError> {
        // SAFETY: device is a valid IMMDevice. GetId allocates the returned string with the COM
        // task allocator; it is released below after copying it into a Rust String.
        let raw_id = unsafe { device.GetId() }
            .map_err(|error| platform_error("endpoint ID read", error.code().0))?;
        if raw_id.0.is_null() {
            return Err(WasapiEndpointError::InvalidEndpointText);
        }
        if raw_id.0.is_null() {
            return Err(WasapiEndpointError::InvalidEndpointText);
        }
        // SAFETY: GetId returned a valid NUL-terminated UTF-16 string on success.
        let id =
            unsafe { raw_id.to_string() }.map_err(|_| WasapiEndpointError::InvalidEndpointText);
        // SAFETY: raw_id was allocated by GetId with the COM task allocator and is no longer used.
        unsafe { CoTaskMemFree(Some(raw_id.0.cast())) };
        id
    }

    fn endpoint_name(device: &IMMDevice) -> Result<String, WasapiEndpointError> {
        // SAFETY: device is a valid IMMDevice and the property store is opened read-only.
        let store = unsafe { device.OpenPropertyStore(STGM_READ) }
            .map_err(|error| platform_error("property store open", error.code().0))?;
        // SAFETY: The store and property key are valid. PROPVARIANT owns its returned resources.
        let value = unsafe { store.GetValue(&PKEY_Device_FriendlyName) }
            .map_err(|error| platform_error("friendly name read", error.code().0))?;
        // SAFETY: PropVariantToStringAlloc converts supported string variants and returns a COM
        // task-allocated string that is released below.
        let raw_name = unsafe { PropVariantToStringAlloc(&value) }
            .map_err(|error| platform_error("friendly name conversion", error.code().0))?;
        if raw_name.0.is_null() {
            return Err(WasapiEndpointError::InvalidEndpointText);
        }
        if raw_name.0.is_null() {
            return Err(WasapiEndpointError::InvalidEndpointText);
        }
        // SAFETY: the conversion returned a valid NUL-terminated UTF-16 string.
        let name =
            unsafe { raw_name.to_string() }.map_err(|_| WasapiEndpointError::InvalidEndpointText);
        // SAFETY: raw_name was allocated by PropVariantToStringAlloc and is no longer used.
        unsafe { CoTaskMemFree(Some(raw_name.0.cast())) };
        name
    }

    fn platform_error(operation: &'static str, code: i32) -> WasapiEndpointError {
        WasapiEndpointError::Platform { operation, code }
    }
}

#[cfg(windows)]
pub use windows_provider::WindowsWasapiEndpointProvider;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeProvider {
        responses: RefCell<Vec<Result<Vec<WasapiEndpoint>, WasapiEndpointError>>>,
    }

    impl FakeProvider {
        fn new(responses: Vec<Result<Vec<WasapiEndpoint>, WasapiEndpointError>>) -> Self {
            Self {
                responses: RefCell::new(responses.into_iter().rev().collect()),
            }
        }
    }

    impl WasapiEndpointProvider for FakeProvider {
        fn endpoints(&self) -> Result<Vec<WasapiEndpoint>, WasapiEndpointError> {
            self.responses.borrow_mut().pop().expect("fake response")
        }
    }

    fn endpoint(id: &str, name: &str) -> WasapiEndpoint {
        WasapiEndpoint {
            id: id.to_owned(),
            name: name.to_owned(),
            direction: WasapiEndpointDirection::Render,
            state: WasapiEndpointState::Active,
        }
    }

    fn capture_endpoint(id: &str, name: &str, state: WasapiEndpointState) -> WasapiEndpoint {
        WasapiEndpoint {
            id: id.to_owned(),
            name: name.to_owned(),
            direction: WasapiEndpointDirection::Capture,
            state,
        }
    }

    #[test]
    fn refresh_lists_endpoints_without_implicit_selection() {
        let provider = FakeProvider::new(vec![Ok(vec![
            endpoint("id-b", "Speakers"),
            endpoint("id-a", "Headphones"),
        ])]);
        let mut catalog = WasapiDeviceCatalog::new(provider);

        catalog.refresh().unwrap();
        let snapshot = catalog.snapshot();
        assert_eq!(snapshot.endpoints[0].name, "Headphones");
        assert_eq!(snapshot.endpoints[1].name, "Speakers");
        assert_eq!(snapshot.selected_endpoint_id, None);
        assert!(!snapshot.selected_available);
    }

    #[test]
    fn refresh_preserves_render_capture_direction_stable_id_and_state() {
        let provider = FakeProvider::new(vec![Ok(vec![
            endpoint("render-id", "Speakers"),
            capture_endpoint("capture-id", "Microphone", WasapiEndpointState::Unplugged),
        ])]);
        let mut catalog = WasapiDeviceCatalog::new(provider);

        catalog.refresh().unwrap();
        let snapshot = catalog.snapshot();
        assert!(snapshot.endpoints.iter().any(|endpoint| {
            endpoint.id == "render-id"
                && endpoint.direction == WasapiEndpointDirection::Render
                && endpoint.state == WasapiEndpointState::Active
        }));
        assert!(snapshot.endpoints.iter().any(|endpoint| {
            endpoint.id == "capture-id"
                && endpoint.direction == WasapiEndpointDirection::Capture
                && endpoint.state == WasapiEndpointState::Unplugged
        }));
    }

    #[test]
    fn selection_requires_an_exact_current_endpoint_id() {
        let provider = FakeProvider::new(vec![Ok(vec![endpoint("opaque-id", "Speakers")])]);
        let mut catalog = WasapiDeviceCatalog::new(provider);
        catalog.refresh().unwrap();

        assert_eq!(
            catalog.select("missing"),
            Err(WasapiEndpointError::EndpointNotFound)
        );
        catalog.select("opaque-id").unwrap();
        assert!(catalog.snapshot().selected_available);
        catalog.clear_selection();
        assert_eq!(catalog.snapshot().selected_endpoint_id, None);
    }

    #[test]
    fn refresh_never_falls_back_when_the_selected_endpoint_disappears() {
        let provider = FakeProvider::new(vec![
            Ok(vec![
                endpoint("selected", "Studio"),
                endpoint("other", "Desktop"),
            ]),
            Ok(vec![endpoint("other", "Desktop")]),
        ]);
        let mut catalog = WasapiDeviceCatalog::new(provider);
        catalog.refresh().unwrap();
        catalog.select("selected").unwrap();

        catalog.refresh().unwrap();
        let snapshot = catalog.snapshot();
        assert_eq!(snapshot.selected_endpoint_id.as_deref(), Some("selected"));
        assert_eq!(snapshot.selected_endpoint_name, None);
        assert!(!snapshot.selected_available);
    }

    #[test]
    fn malformed_refresh_preserves_the_last_known_good_inventory() {
        for malformed in [
            vec![endpoint("", "Broken")],
            vec![endpoint("same", "One"), endpoint("same", "Two")],
        ] {
            let provider = FakeProvider::new(vec![
                Ok(vec![endpoint("known-good", "Studio")]),
                Ok(malformed),
            ]);
            let mut catalog = WasapiDeviceCatalog::new(provider);
            catalog.refresh().unwrap();
            assert!(catalog.refresh().is_err());
            assert_eq!(catalog.snapshot().endpoints[0].id, "known-good");
        }
    }

    #[test]
    fn provider_failure_preserves_the_last_known_good_inventory() {
        let provider = FakeProvider::new(vec![
            Ok(vec![endpoint("known-good", "Studio")]),
            Err(WasapiEndpointError::Platform {
                operation: "test enumeration",
                code: -1,
            }),
        ]);
        let mut catalog = WasapiDeviceCatalog::new(provider);
        catalog.refresh().unwrap();

        assert!(catalog.refresh().is_err());
        assert_eq!(catalog.snapshot().endpoints[0].id, "known-good");
    }

    #[test]
    fn blank_friendly_name_is_normalized_without_changing_the_id() {
        let provider = FakeProvider::new(vec![Ok(vec![endpoint("opaque", "  ")])]);
        let mut catalog = WasapiDeviceCatalog::new(provider);
        catalog.refresh().unwrap();
        let snapshot = catalog.snapshot();
        assert_eq!(snapshot.endpoints[0].id, "opaque");
        assert_eq!(snapshot.endpoints[0].name, UNNAMED_ENDPOINT);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the Windows Audio service; performs read-only endpoint enumeration"]
    fn windows_provider_enumerates_unique_nonempty_render_and_capture_ids() {
        let endpoints = WindowsWasapiEndpointProvider
            .endpoints()
            .expect("read-only WASAPI enumeration");
        let mut ids = HashSet::new();
        for endpoint in endpoints {
            assert!(!endpoint.id.trim().is_empty());
            assert!(ids.insert((endpoint.direction, endpoint.id)));
        }
    }
}
