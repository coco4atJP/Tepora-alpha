//! User-requested first-use discovery/download/probe coordination. No constructor
//! or read starts network requests, browser processes or model installation.
use crate::ApiError;
use serde_json::Value;
mod manager;
mod platform;
mod progress;
pub use manager::{
    configuration, destination, installer_command, installer_url, model_catalog, SetupManager,
    SetupOptions,
};
pub use platform::{memory_gib, open_installer_page, open_installer_page_with, InstallerLauncher};
pub use progress::PullPackets;

#[derive(Clone, Debug)]
pub struct SetupStored {
    pub settings: Value,
    pub model_probe: Value,
    pub dismissed: bool,
    pub transfer: Value,
    pub first_result: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct SelectionContext {
    pub settings: Value,
    pub registry_revision: u64,
    pub registry_configured: bool,
    pub busy: bool,
}
#[derive(Clone, Debug)]
pub struct SelectionCommit {
    pub cancellation: crate::network::RequestCancellation,
    pub expected_configuration: String,
    pub expected_registry_revision: u64,
    pub settings: Value,
    pub report: Value,
    /// The user-safe preset already validated for the probe. Keep its raw
    /// schema: the actor independently derives canonical fields/identity.
    pub registry: Value,
}
/// Implement on the one WorkspaceAccess/actor facade. Capture returns owned
/// values. Activation rechecks busy/settings/revision on the actor and commits
/// settings, registry and probe together, with provider-config -> State locking.
pub trait SetupState: Send + Sync {
    fn capture(&self) -> Result<SetupStored, ApiError>;
    fn selection_context(&self) -> Result<SelectionContext, ApiError>;
    fn activate_selection(&self, commit: SelectionCommit) -> Result<(), ApiError>;
    fn save_transfer(&self, transfer: Value) -> Result<(), ApiError>;
    fn dismiss(&self) -> Result<(), ApiError>;
    fn emit_snapshot(&self, snapshot: Value) -> Result<(), ApiError>;
}
#[cfg(test)]
mod tests;
#[cfg(test)]
mod http_tests;
