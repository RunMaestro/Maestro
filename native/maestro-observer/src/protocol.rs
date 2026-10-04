//! Wire types for the helper protocol (v1).
//!
//! These mirror `src/shared/computer-history/types.ts` field for field. The
//! TypeScript file is the contract; a field renamed here without a matching
//! change there breaks the main-process ingest silently, so the JSON shape is
//! pinned by tests at the bottom of `engine.rs`.

use serde::{Deserialize, Serialize};

/// Must equal `COMPUTER_HISTORY_PROTOCOL_VERSION` in types.ts.
pub const PROTOCOL_VERSION: u32 = 1;

/// Reported in `helper.status` and by `--version`.
pub const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const DEFAULT_MAX_TEXT_BYTES: usize = 8192;
pub const DEFAULT_MAX_SNAPSHOT_BYTES: usize = 32768;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    #[serde(rename = "app.activated")]
    AppActivated,
    #[serde(rename = "window.changed")]
    WindowChanged,
    #[serde(rename = "text.committed")]
    TextCommitted,
    #[serde(rename = "selection.changed")]
    SelectionChanged,
    #[serde(rename = "content.snapshot")]
    ContentSnapshot,
    #[serde(rename = "helper.status")]
    HelperStatus,
    #[serde(rename = "helper.error")]
    HelperError,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ElementRole {
    TextField,
    TextArea,
    ComboBox,
    SearchField,
    Document,
    WebArea,
    Other,
}

impl ElementRole {
    /// Roles whose committed value is recorded as `text.committed`.
    pub fn is_text_entry(self) -> bool {
        matches!(
            self,
            ElementRole::TextField
                | ElementRole::TextArea
                | ElementRole::ComboBox
                | ElementRole::SearchField
        )
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextCommitReason {
    Idle,
    Blur,
    Cleared,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct ObservedApp {
    pub id: String,
    pub name: String,
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aumid: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct ObservedWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ObservedElement {
    pub role: ElementRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HelperState {
    Running,
    Paused,
    Blocked,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Granted,
    Denied,
    NotRequired,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccessibilityBus {
    Enabled,
    Disabled,
    Unavailable,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    X11,
    Wayland,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    pub version: String,
    pub platform: Platform,
    pub state: HelperState,
    pub permission: Permission,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessibility_bus: Option<AccessibilityBus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ObservedEvent {
    pub v: u32,
    pub ts: String,
    pub kind: EventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<ObservedApp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<ObservedWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<ObservedElement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<TextCommitReason>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<HelperStatus>,
}

impl ObservedEvent {
    pub fn new(kind: EventKind, ts: String) -> Self {
        ObservedEvent {
            v: PROTOCOL_VERSION,
            ts,
            kind,
            app: None,
            window: None,
            element: None,
            text: None,
            reason: None,
            truncated: false,
            status: None,
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_max_text() -> usize {
    DEFAULT_MAX_TEXT_BYTES
}
fn default_max_snapshot() -> usize {
    DEFAULT_MAX_SNAPSHOT_BYTES
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureCommand {
    #[serde(default)]
    pub block_apps: Vec<String>,
    #[serde(default)]
    pub block_pids: Vec<u32>,
    #[serde(default)]
    pub block_domains: Vec<String>,
    #[serde(default = "default_true")]
    pub snapshots: bool,
    #[serde(default = "default_max_text")]
    pub max_text_bytes: usize,
    #[serde(default = "default_max_snapshot")]
    pub max_snapshot_bytes: usize,
}

impl Default for ConfigureCommand {
    fn default() -> Self {
        ConfigureCommand {
            block_apps: Vec::new(),
            block_pids: Vec::new(),
            block_domains: Vec::new(),
            snapshots: true,
            max_text_bytes: DEFAULT_MAX_TEXT_BYTES,
            max_snapshot_bytes: DEFAULT_MAX_SNAPSHOT_BYTES,
        }
    }
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "cmd", rename_all = "kebab-case")]
pub enum Command {
    Configure(ConfigureCommand),
    Pause,
    Resume,
    Status,
    EnableAccessibility,
    Shutdown,
}

/// Parses one stdin line. The error string is what goes into `helper.error`.
pub fn parse_command(line: &str) -> Result<Command, String> {
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("invalid command JSON: {e}"))?;
    let name = value
        .get("cmd")
        .and_then(|c| c.as_str())
        .ok_or_else(|| "command is missing a string \"cmd\" field".to_string())?
        .to_string();
    const KNOWN: [&str; 6] = [
        "configure",
        "pause",
        "resume",
        "status",
        "enable-accessibility",
        "shutdown",
    ];
    if !KNOWN.contains(&name.as_str()) {
        return Err(format!("unknown command: {name}"));
    }
    serde_json::from_value(value).map_err(|e| format!("invalid {name} command: {e}"))
}
