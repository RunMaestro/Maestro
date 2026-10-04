//! Platform-agnostic policy: commands, configuration, pause, blocklists,
//! private-window and domain suppression, text-commit and selection debounce,
//! snapshot throttling, byte caps, and the NDJSON writer.
//!
//! Platform adapters only translate OS accessibility callbacks into
//! [`Signal`]s and answer snapshot queries. Every decision about what reaches
//! stdout is made here so it can be unit-tested on any OS with a fake clock.

use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::protocol::{
    parse_command, AccessibilityBus, Command, ConfigureCommand, ElementRole, EventKind,
    HelperState, HelperStatus, ObservedApp, ObservedElement, ObservedEvent, ObservedWindow,
    Permission, Platform, SessionType, TextCommitReason, HELPER_VERSION,
};

/// A field's value is committed after this long without a change.
pub const TEXT_IDLE_MS: u64 = 1500;
/// A selection is emitted once it has been stable this long.
pub const SELECTION_STABLE_MS: u64 = 1000;
/// Delay between an activation / window change and its first snapshot, so the
/// window has a moment to render.
pub const SNAPSHOT_SETTLE_MS: u64 = 400;
/// Minimum spacing between snapshots of the same focused window.
pub const SNAPSHOT_INTERVAL_MS: u64 = 30_000;
/// How often permission / accessibility-bus state is re-checked.
pub const ACCESS_POLL_MS: u64 = 5000;

const MAX_LABEL_BYTES: usize = 512;
const MAX_TITLE_BYTES: usize = 2048;
const MAX_URL_BYTES: usize = 4096;
const MIN_TEXT_CAP: usize = 16;
const MAX_SNAPSHOT_HASHES: usize = 1024;

/// Case-insensitive title markers of private / incognito browser windows.
const PRIVATE_TITLE_MARKERS: [&str; 4] = [
    "incognito",
    "private browsing",
    "inprivate",
    "private window",
];

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/// A moment as seen by the engine: a monotonic reading for timers and a wall
/// clock reading for `ts`. Tests construct these directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Now {
    pub mono_ms: u64,
    pub wall_ms: i64,
}

impl Now {
    pub fn system() -> Now {
        static START: OnceLock<Instant> = OnceLock::new();
        let start = *START.get_or_init(Instant::now);
        let wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Now {
            mono_ms: start.elapsed().as_millis() as u64,
            wall_ms,
        }
    }
}

/// UTC ISO-8601 with millisecond precision, e.g. `2026-10-03T14:10:00.123Z`.
pub fn iso_utc_ms(wall_ms: i64) -> String {
    let secs = wall_ms.div_euclid(1000);
    let ms = wall_ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian
/// (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/// Cuts `s` to at most `max` bytes on a UTF-8 character boundary. The flag is
/// true when anything was dropped.
pub fn truncate_utf8(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

fn cap(s: Option<String>, max: usize) -> Option<String> {
    s.map(|v| truncate_utf8(&v, max).0)
        .filter(|v| !v.trim().is_empty())
}

fn is_blank(s: &str) -> bool {
    s.trim().is_empty()
}

/// True when a window title carries a private / incognito marker.
pub fn is_private_title(title: &str) -> bool {
    let lower = title.to_lowercase();
    PRIVATE_TITLE_MARKERS.iter().any(|m| lower.contains(m))
}

/// Normalizes a user-entered block domain: lowercase, no scheme, path, port,
/// wildcard prefix, or trailing dot. Empty input yields `None`.
pub fn normalize_domain(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_lowercase();
    if let Some(idx) = s.find("://") {
        s = s[idx + 3..].to_string();
    }
    if let Some(idx) = s.find(['/', '?', '#']) {
        s.truncate(idx);
    }
    if let Some(idx) = s.rfind('@') {
        s = s[idx + 1..].to_string();
    }
    if !s.starts_with('[') {
        if let Some(idx) = s.find(':') {
            s.truncate(idx);
        }
    }
    let s = s
        .trim_start_matches("*.")
        .trim_start_matches('.')
        .trim_end_matches('.');
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Lowercase host of a URL, or `None` when it has none (`file:`, `about:`).
pub fn url_host(url: &str) -> Option<String> {
    let rest = &url[url.find("://")? + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let mut authority = &rest[..authority_end];
    if let Some(idx) = authority.rfind('@') {
        authority = &authority[idx + 1..];
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let host = host.trim_end_matches('.').to_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// True when `url`'s host is one of `domains` or a subdomain of one.
pub fn domain_blocked(url: &str, domains: &[String]) -> bool {
    let Some(host) = url_host(url) else {
        return false;
    };
    domains.iter().any(|d| {
        host == *d
            || (host.len() > d.len()
                && host.ends_with(d.as_str())
                && host.as_bytes()[host.len() - d.len() - 1] == b'.')
    })
}

/// FNV-1a, stable across runs and platforms (unlike `DefaultHasher`).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// Flattens snapshot lines: trims, drops blanks, collapses repeats.
pub fn flatten_lines(lines: &[String]) -> String {
    let mut out: Vec<&str> = Vec::new();
    for raw in lines {
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || out.last() == Some(&line) {
                continue;
            }
            out.push(line);
        }
    }
    out.join("\n")
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/// Bundle ids, executable names, and desktop ids of browsers. A browser whose
/// URL cannot be resolved is treated as possibly on a blocked domain.
const BROWSER_IDS: [&str; 37] = [
    // macOS bundle ids
    "com.google.chrome",
    "org.chromium.chromium",
    "com.microsoft.edgemac",
    "com.brave.browser",
    "company.thebrowser.browser",
    "org.mozilla.firefox",
    "org.mozilla.firefoxdeveloperedition",
    "org.mozilla.nightly",
    "com.apple.safari",
    "com.apple.safaritechnologypreview",
    "com.vivaldi.vivaldi",
    "com.operasoftware.opera",
    "com.operasoftware.operagx",
    // Windows executables (".exe" stripped before matching)
    "chrome",
    "chromium",
    "msedge",
    "brave",
    "arc",
    "firefox",
    "vivaldi",
    "opera",
    // Linux executables and desktop ids
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "google-chrome-beta",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "firefox-esr",
    "firefox-bin",
    "vivaldi-bin",
    "vivaldi-stable",
    "opera-stable",
    "com.google.chrome",
    "com.microsoft.edge",
    "com.opera.opera",
    "librewolf",
];

/// Id prefixes covering channel variants (`com.google.Chrome.canary`, ...).
const BROWSER_ID_PREFIXES: [&str; 6] = [
    "com.google.chrome.",
    "com.microsoft.edgemac.",
    "com.brave.browser.",
    "org.mozilla.firefox",
    "org.chromium.",
    "com.vivaldi.",
];

const BROWSER_NAMES: [&str; 10] = [
    "google chrome",
    "chromium",
    "microsoft edge",
    "brave browser",
    "arc",
    "firefox",
    "safari",
    "vivaldi",
    "opera",
    "opera gx",
];

/// True for Chrome, Chromium, Edge, Brave, Arc, Firefox, Safari, Vivaldi,
/// and Opera, matched by id (bundle id, exe, desktop id) or display name.
pub fn is_known_browser(app: &ObservedApp) -> bool {
    let id = app.id.trim().to_lowercase();
    let id = id.strip_suffix(".exe").unwrap_or(&id);
    let name = app.name.trim().to_lowercase();
    BROWSER_IDS.contains(&id)
        || BROWSER_ID_PREFIXES.iter().any(|p| id.starts_with(p))
        || BROWSER_NAMES.contains(&name.as_str())
}

/// A window as an adapter read it: raw OS strings plus an identity key (AX
/// element hash, HWND, AT-SPI object hash). Policy decisions use the raw
/// strings; they are capped only when an event is emitted.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WindowInfo {
    pub key: u64,
    pub title: Option<String>,
    pub url: Option<String>,
}

impl WindowInfo {
    fn observed(&self) -> ObservedWindow {
        ObservedWindow {
            title: cap(self.title.clone(), MAX_TITLE_BYTES),
            url: cap(self.url.clone(), MAX_URL_BYTES),
        }
    }
}

/// What the helper must never read from or emit. Adapters consult this
/// before any tree walk or value read; the engine re-checks before emitting.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppFilter {
    apps: HashSet<String>,
    pids: HashSet<u32>,
    domains: Vec<String>,
}

impl AppFilter {
    pub fn new(apps: &[String], pids: &[u32], domains: &[String]) -> Self {
        AppFilter {
            apps: apps
                .iter()
                .map(|a| a.trim().to_lowercase())
                .filter(|a| !a.is_empty())
                .collect(),
            pids: pids.iter().copied().collect(),
            domains: domains.iter().filter_map(|d| normalize_domain(d)).collect(),
        }
    }

    /// Blocked by pid, or by a rule equal (case-insensitive) to the app's id
    /// or its display name, so `--app Slack` works as well as a bundle id.
    pub fn is_blocked(&self, app: &ObservedApp) -> bool {
        self.pids.contains(&app.pid)
            || self.apps.contains(&app.id.trim().to_lowercase())
            || self.apps.contains(&app.name.trim().to_lowercase())
    }

    pub fn has_domain_rules(&self) -> bool {
        !self.domains.is_empty()
    }

    /// Private window or blocked domain: emit nothing for this window, not
    /// even its title.
    pub fn window_hidden(&self, window: Option<&WindowInfo>) -> bool {
        let Some(w) = window else { return false };
        w.title.as_deref().is_some_and(is_private_title)
            || w.url
                .as_deref()
                .is_some_and(|u| domain_blocked(u, &self.domains))
    }

    /// The window's content (field values, selections, snapshots) must not be
    /// read: hidden windows, plus browsers whose URL could not be resolved
    /// while domain rules exist (fail closed). Titles may still be reported.
    pub fn content_blocked(&self, app: &ObservedApp, window: Option<&WindowInfo>) -> bool {
        if self.window_hidden(window) {
            return true;
        }
        let url_known = window.is_some_and(|w| w.url.is_some());
        self.has_domain_rules() && !url_known && is_known_browser(app)
    }
}

/// The focused (or changed) UI element as an adapter read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElementInfo {
    /// Stable identity for "is this the same element": CFHash, UIA runtime id
    /// hash, or AT-SPI bus name + path hash.
    pub key: u64,
    pub role: ElementRole,
    pub label: Option<String>,
    /// `None` for secure fields and elements whose value was not read.
    pub value: Option<String>,
    pub secure: bool,
}

impl ElementInfo {
    fn observed(&self) -> ObservedElement {
        ObservedElement {
            role: self.role,
            label: cap(self.label.clone(), MAX_LABEL_BYTES),
        }
    }

    fn is_capturable_field(&self) -> bool {
        !self.secure && self.role.is_text_entry()
    }
}

/// Raw platform signals. Adapters emit them in the order they happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// A different app is frontmost. `window` is `None` for blocked apps (the
    /// adapter must not read their windows).
    AppActivated {
        app: ObservedApp,
        window: Option<WindowInfo>,
    },
    /// The frontmost app's focused window, or its title / URL, changed.
    WindowChanged { window: WindowInfo },
    /// Keyboard focus moved to `element` (or to nothing readable).
    FocusChanged { element: Option<ElementInfo> },
    /// The focused element's value changed.
    ValueChanged { element: ElementInfo },
    /// Selected text changed; an empty string means the selection collapsed.
    SelectionChanged {
        element: Option<ElementInfo>,
        text: String,
    },
    /// A recoverable failure worth surfacing as `helper.error`.
    Error(String),
}

/// What the platform currently allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    pub permission: Permission,
    /// False when permission is denied or the accessibility bus is off.
    pub can_observe: bool,
    pub accessibility_bus: Option<AccessibilityBus>,
    pub session: Option<SessionType>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotLimits {
    pub max_nodes: usize,
    pub max_depth: usize,
    pub budget: Duration,
}

impl Default for SnapshotLimits {
    fn default() -> Self {
        SnapshotLimits {
            max_nodes: 4000,
            max_depth: 40,
            budget: Duration::from_millis(150),
        }
    }
}

/// Result of a snapshot query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Snapshot {
    /// Visible text of the focused window, as lines.
    Lines(Vec<String>),
    /// The focused window (key, title, or URL) is not the one the adapter last
    /// reported. Nothing was walked; the engine re-runs suppression first.
    WindowChanged(WindowInfo),
    /// Nothing readable (blocked app, content blocked, no window).
    Unavailable,
}

/// A platform accessibility adapter. All methods are called from the engine
/// thread.
pub trait Observer {
    fn platform(&self) -> Platform;
    /// Current permission / bus state. Cheap; called every few seconds.
    fn access(&mut self) -> Access;
    /// `enable-accessibility`: prompt (macOS) or flip the bus on (Linux).
    fn request_access(&mut self) -> Result<(), String>;
    /// Begin observing, or apply a new filter if already observing. Must
    /// re-announce the current frontmost app (`AppActivated`, then
    /// `FocusChanged`) so the engine has context.
    fn start(&mut self, filter: &AppFilter);
    /// Stop observing and release OS observers.
    fn stop(&mut self);
    /// Wait up to `timeout` for OS callbacks and return the signals they
    /// produced.
    fn poll(&mut self, timeout: Duration) -> Vec<Signal>;
    /// Visible text of the focused window, bounded by `limits`. Must first
    /// re-read the focused window and return [`Snapshot::WindowChanged`] when
    /// it differs from the last reported one, and must return
    /// [`Snapshot::Unavailable`] for blocked apps and blocked content.
    fn snapshot_focused_window_text(&mut self, limits: &SnapshotLimits) -> Snapshot;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/// Minimum spacing between `window.changed` events for one app; changes in
/// between are coalesced to the latest window.
pub const WINDOW_EVENT_MIN_MS: u64 = 1000;

#[derive(Debug, Clone)]
struct Config {
    filter: AppFilter,
    snapshots: bool,
    max_text_bytes: usize,
    max_snapshot_bytes: usize,
}

impl From<ConfigureCommand> for Config {
    fn from(c: ConfigureCommand) -> Self {
        Config {
            filter: AppFilter::new(&c.block_apps, &c.block_pids, &c.block_domains),
            snapshots: c.snapshots,
            max_text_bytes: c.max_text_bytes.max(MIN_TEXT_CAP),
            max_snapshot_bytes: c.max_snapshot_bytes.max(MIN_TEXT_CAP),
        }
    }
}

#[derive(Debug, Clone)]
struct Field {
    key: u64,
    element: ObservedElement,
    value: String,
    last_change: u64,
    dirty: bool,
    committed: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingSelection {
    text: String,
    element: Option<ObservedElement>,
    since: u64,
}

pub struct Engine {
    platform: Platform,
    config: Option<Config>,
    user_paused: bool,
    observing: bool,
    access: Option<Access>,
    last_access_check: Option<u64>,
    exit: bool,

    app: Option<ObservedApp>,
    app_blocked: bool,
    /// Raw, as the adapter read it; capped only on emission.
    window: Option<WindowInfo>,
    /// Private window or blocked domain: nothing is emitted.
    window_hidden: bool,
    /// Content must not be emitted (hidden, or a browser with unknown URL).
    content_hidden: bool,
    /// pid of the app whose `app.activated` was last emitted.
    announced_pid: Option<u32>,
    /// Window carried by the last `app.activated` / `window.changed`.
    announced_window: Option<WindowInfo>,
    last_window_event: Option<u64>,
    window_event_pending: bool,
    field: Option<Field>,
    selection: Option<PendingSelection>,
    last_selection: Option<String>,
    next_snapshot_at: Option<u64>,
    snapshot_hashes: HashMap<String, u64>,

    out: Vec<ObservedEvent>,
}

impl Engine {
    pub fn new(platform: Platform) -> Self {
        Engine {
            platform,
            config: None,
            user_paused: false,
            observing: false,
            access: None,
            last_access_check: None,
            exit: false,
            app: None,
            app_blocked: false,
            window: None,
            window_hidden: false,
            content_hidden: false,
            announced_pid: None,
            announced_window: None,
            last_window_event: None,
            window_event_pending: false,
            field: None,
            selection: None,
            last_selection: None,
            next_snapshot_at: None,
            snapshot_hashes: HashMap::new(),
            out: Vec::new(),
        }
    }

    pub fn is_observing(&self) -> bool {
        self.observing
    }

    pub fn should_exit(&self) -> bool {
        self.exit
    }

    pub fn drain(&mut self) -> Vec<ObservedEvent> {
        std::mem::take(&mut self.out)
    }

    /// Reads access state and emits the startup `helper.status`. Observation
    /// does not begin until the first `configure`.
    pub fn start(&mut self, obs: &mut dyn Observer, now: Now) {
        self.access = Some(obs.access());
        self.last_access_check = Some(now.mono_ms);
        self.emit_status(now);
    }

    /// The status a fresh, unconfigured helper reports (`--probe`).
    pub fn probe_status(platform: Platform, access: &Access) -> HelperStatus {
        let mut engine = Engine::new(platform);
        engine.access = Some(access.clone());
        engine.status()
    }

    fn status(&self) -> HelperStatus {
        let access = self.access.clone().unwrap_or(Access {
            permission: Permission::Denied,
            can_observe: false,
            accessibility_bus: None,
            session: None,
            detail: None,
        });
        let (state, detail) = if !access.can_observe {
            (HelperState::Blocked, access.detail.clone())
        } else if self.config.is_none() {
            (
                HelperState::Paused,
                Some("waiting for configure".to_string()),
            )
        } else if self.user_paused {
            (HelperState::Paused, Some("paused by command".to_string()))
        } else {
            (HelperState::Running, access.detail.clone())
        };
        HelperStatus {
            version: HELPER_VERSION.to_string(),
            platform: self.platform,
            state,
            permission: access.permission,
            accessibility_bus: access.accessibility_bus,
            session: access.session,
            detail,
        }
    }

    fn emit_status(&mut self, now: Now) {
        let mut ev = ObservedEvent::new(EventKind::HelperStatus, iso_utc_ms(now.wall_ms));
        ev.status = Some(self.status());
        self.out.push(ev);
    }

    fn emit_error(&mut self, now: Now, message: String) {
        let mut ev = ObservedEvent::new(EventKind::HelperError, iso_utc_ms(now.wall_ms));
        ev.text = Some(truncate_utf8(&message, MAX_TITLE_BYTES).0);
        self.out.push(ev);
    }

    // -- commands ----------------------------------------------------------

    pub fn handle_line(&mut self, line: &str, obs: &mut dyn Observer, now: Now) {
        if line.trim().is_empty() {
            return;
        }
        match parse_command(line) {
            Ok(cmd) => self.handle_command(cmd, obs, now),
            Err(message) => {
                self.emit_error(now, message);
                self.emit_status(now);
            }
        }
    }

    pub fn handle_command(&mut self, cmd: Command, obs: &mut dyn Observer, now: Now) {
        match cmd {
            Command::Configure(c) => {
                self.config = Some(Config::from(c));
                self.snapshot_hashes.clear();
                self.reconcile(obs, true);
            }
            Command::Pause => {
                self.user_paused = true;
                self.reconcile(obs, false);
            }
            Command::Resume => {
                self.user_paused = false;
                self.reconcile(obs, false);
            }
            Command::Status => {}
            Command::EnableAccessibility => {
                if let Err(message) = obs.request_access() {
                    self.emit_error(now, message);
                }
                self.access = Some(obs.access());
                self.last_access_check = Some(now.mono_ms);
                self.reconcile(obs, false);
            }
            Command::Shutdown => {
                self.exit = true;
                if self.observing {
                    obs.stop();
                    self.observing = false;
                }
                self.reset_context();
            }
        }
        self.emit_status(now);
    }

    fn wants_observation(&self) -> bool {
        self.config.is_some()
            && !self.user_paused
            && self.access.as_ref().is_some_and(|a| a.can_observe)
    }

    /// Starts or stops the adapter to match config / pause / access. With
    /// `refilter`, an already running adapter is restarted with the new filter.
    fn reconcile(&mut self, obs: &mut dyn Observer, refilter: bool) {
        let want = self.wants_observation();
        if want && (!self.observing || refilter) {
            self.reset_context();
            if let Some(cfg) = &self.config {
                obs.start(&cfg.filter);
            }
            self.observing = true;
        } else if !want && self.observing {
            obs.stop();
            self.observing = false;
            self.reset_context();
        }
    }

    /// Forgets the current app, window, and pending text. Pending text is
    /// dropped rather than flushed: a pause means "stop recording now".
    fn reset_context(&mut self) {
        self.app = None;
        self.app_blocked = false;
        self.window = None;
        self.window_hidden = false;
        self.content_hidden = false;
        self.announced_pid = None;
        self.announced_window = None;
        self.last_window_event = None;
        self.window_event_pending = false;
        self.field = None;
        self.selection = None;
        self.last_selection = None;
        self.next_snapshot_at = None;
    }

    // -- signals -----------------------------------------------------------

    /// Nothing at all may be emitted for the current context.
    fn suppressed(&self) -> bool {
        self.app.is_none() || self.app_blocked || self.window_hidden
    }

    /// Window content (text, selections, snapshots) may not be emitted.
    fn content_suppressed(&self) -> bool {
        self.suppressed() || self.content_hidden
    }

    /// Re-evaluates suppression on the raw (untruncated) window strings.
    fn evaluate_window(&mut self) {
        let (hidden, content) = match (&self.config, &self.app) {
            (Some(cfg), Some(app)) => (
                cfg.filter.window_hidden(self.window.as_ref()),
                cfg.filter.content_blocked(app, self.window.as_ref()),
            ),
            _ => (false, false),
        };
        self.window_hidden = hidden;
        self.content_hidden = content;
    }

    fn base_event(&self, kind: EventKind, now: Now) -> ObservedEvent {
        let mut ev = ObservedEvent::new(kind, iso_utc_ms(now.wall_ms));
        ev.app = self.app.clone();
        ev.window = self.window.as_ref().map(WindowInfo::observed);
        ev
    }

    pub fn handle_signal(&mut self, signal: Signal, now: Now) {
        if !self.observing {
            return;
        }
        match signal {
            Signal::AppActivated { app, window } => self.on_app(app, window, now),
            Signal::WindowChanged { window } => self.on_window(window, now),
            Signal::FocusChanged { element } => self.on_focus(element, now),
            Signal::ValueChanged { element } => self.on_value(element, now),
            Signal::SelectionChanged { element, text } => self.on_selection(element, text, now),
            Signal::Error(message) => self.emit_error(now, message),
        }
    }

    fn on_app(&mut self, app: ObservedApp, window: Option<WindowInfo>, now: Now) {
        if self.app.as_ref().is_some_and(|a| a.pid == app.pid) && !self.app_blocked {
            if let Some(w) = window {
                self.on_window(w, now);
            }
            return;
        }
        self.flush_field(now);
        self.selection = None;
        self.last_selection = None;
        let blocked = self
            .config
            .as_ref()
            .is_some_and(|c| c.filter.is_blocked(&app));
        self.app = Some(app);
        self.app_blocked = blocked;
        self.field = None;
        self.announced_pid = None;
        self.announced_window = None;
        self.last_window_event = None;
        self.window_event_pending = false;
        self.next_snapshot_at = None;
        if blocked {
            self.window = None;
            self.window_hidden = false;
            self.content_hidden = false;
            return;
        }
        self.window = window;
        self.evaluate_window();
        self.announce(now);
    }

    fn on_window(&mut self, window: WindowInfo, now: Now) {
        if self.app.is_none() || self.app_blocked {
            return;
        }
        if self.window.as_ref() == Some(&window) {
            return;
        }
        self.flush_field(now);
        self.selection = None;
        self.field = None;
        self.window = Some(window);
        self.evaluate_window();
        self.announce(now);
    }

    /// Emits `app.activated` (first event for this app) or `window.changed`
    /// (at most once per second per app; later changes are coalesced), and
    /// schedules a snapshot. Silent while suppressed.
    fn announce(&mut self, now: Now) {
        if self.suppressed() {
            self.window_event_pending = false;
            self.next_snapshot_at = None;
            return;
        }
        let pid = self.app.as_ref().map(|a| a.pid);
        if self.announced_pid != pid {
            let mut ev = self.base_event(EventKind::AppActivated, now);
            if ev
                .window
                .as_ref()
                .is_some_and(|w| *w == ObservedWindow::default())
            {
                ev.window = None;
            }
            self.out.push(ev);
            self.announced_pid = pid;
            self.mark_window_announced(now);
        } else if self.window.is_some() {
            let recent = self
                .last_window_event
                .is_some_and(|t| now.mono_ms.saturating_sub(t) < WINDOW_EVENT_MIN_MS);
            if recent {
                self.window_event_pending = true;
                self.next_snapshot_at = None;
                return;
            }
            self.emit_window_changed(now);
        }
    }

    fn emit_window_changed(&mut self, now: Now) {
        let ev = self.base_event(EventKind::WindowChanged, now);
        self.out.push(ev);
        self.mark_window_announced(now);
    }

    fn mark_window_announced(&mut self, now: Now) {
        self.announced_window = self.window.clone();
        self.last_window_event = Some(now.mono_ms);
        self.window_event_pending = false;
        self.next_snapshot_at = Some(now.mono_ms + SNAPSHOT_SETTLE_MS);
    }

    fn on_focus(&mut self, element: Option<ElementInfo>, now: Now) {
        if self.content_suppressed() {
            self.field = None;
            return;
        }
        if let (Some(field), Some(el)) = (&self.field, &element) {
            if field.key == el.key {
                return;
            }
        }
        self.flush_field(now);
        self.field = element
            .filter(ElementInfo::is_capturable_field)
            .map(|el| Field {
                key: el.key,
                element: el.observed(),
                value: el.value.clone().unwrap_or_default(),
                last_change: now.mono_ms,
                dirty: false,
                committed: None,
            });
    }

    fn on_value(&mut self, element: ElementInfo, now: Now) {
        if self.content_suppressed() {
            return;
        }
        if !element.is_capturable_field() {
            if self.field.as_ref().is_some_and(|f| f.key == element.key) {
                self.field = None;
            }
            return;
        }
        if self.field.as_ref().map(|f| f.key) != Some(element.key) {
            // A change on an element we never saw focus on: treat it as a
            // focus move whose baseline is empty, so the change itself counts.
            self.flush_field(now);
            self.field = Some(Field {
                key: element.key,
                element: element.observed(),
                value: String::new(),
                last_change: now.mono_ms,
                dirty: false,
                committed: None,
            });
        }
        let new_value = element.value.clone().unwrap_or_default();
        let label = element.observed();
        let mut cleared: Option<String> = None;
        if let Some(field) = self.field.as_mut() {
            field.element = label;
            if field.value == new_value {
                return;
            }
            // "cleared" = a multi-character value emptied in one step, which is
            // what sending a message looks like. Backspacing to empty passes
            // through one character and does not count.
            if is_blank(&new_value) && field.value.trim().chars().count() > 1 {
                cleared = Some(std::mem::take(&mut field.value));
                field.value = new_value;
                field.dirty = false;
                field.committed = None;
            } else {
                field.value = new_value;
                field.last_change = now.mono_ms;
                field.dirty = true;
            }
        }
        if let Some(text) = cleared {
            self.emit_text(text, TextCommitReason::Cleared, now);
        }
    }

    fn on_selection(&mut self, element: Option<ElementInfo>, text: String, now: Now) {
        if self.content_suppressed() || element.as_ref().is_some_and(|e| e.secure) {
            return;
        }
        if is_blank(&text) {
            self.selection = None;
            return;
        }
        if self.selection.as_ref().is_some_and(|p| p.text == text) {
            return;
        }
        self.selection = Some(PendingSelection {
            text,
            element: element.map(|e| e.observed()),
            since: now.mono_ms,
        });
    }

    /// Commits the focused field on blur (focus, app, or window change).
    fn flush_field(&mut self, now: Now) {
        let Some(field) = self.field.as_ref() else {
            return;
        };
        if self.content_suppressed() || !field.dirty || is_blank(&field.value) {
            return;
        }
        if field.committed.as_deref() == Some(field.value.as_str()) {
            return;
        }
        let text = field.value.clone();
        self.emit_text(text, TextCommitReason::Blur, now);
        if let Some(field) = self.field.as_mut() {
            field.dirty = false;
            field.committed = Some(field.value.clone());
        }
    }

    fn emit_text(&mut self, text: String, reason: TextCommitReason, now: Now) {
        let Some(field) = self.field.as_ref() else {
            return;
        };
        let max = self
            .config
            .as_ref()
            .map_or(usize::MAX, |c| c.max_text_bytes);
        let (text, truncated) = truncate_utf8(&text, max);
        let mut ev = self.base_event(EventKind::TextCommitted, now);
        ev.element = Some(field.element.clone());
        ev.text = Some(text);
        ev.reason = Some(reason);
        ev.truncated = truncated;
        self.out.push(ev);
    }

    // -- timers ------------------------------------------------------------

    /// Fires coalesced window events, idle commits, stable selections, due
    /// snapshots, and the periodic access re-check.
    pub fn tick(&mut self, obs: &mut dyn Observer, now: Now) {
        self.poll_access(obs, now);
        if !self.observing {
            return;
        }
        self.tick_window(now);
        self.tick_field(now);
        self.tick_selection(now);
        self.tick_snapshot(obs, now);
    }

    fn poll_access(&mut self, obs: &mut dyn Observer, now: Now) {
        let due = self
            .last_access_check
            .is_none_or(|t| now.mono_ms.saturating_sub(t) >= ACCESS_POLL_MS);
        if !due {
            return;
        }
        self.last_access_check = Some(now.mono_ms);
        let access = obs.access();
        if self.access.as_ref() != Some(&access) {
            self.access = Some(access);
            self.reconcile(obs, false);
            self.emit_status(now);
        }
    }

    fn tick_window(&mut self, now: Now) {
        if !self.window_event_pending {
            return;
        }
        if self.suppressed() {
            self.window_event_pending = false;
            return;
        }
        let due = self
            .last_window_event
            .is_none_or(|t| now.mono_ms.saturating_sub(t) >= WINDOW_EVENT_MIN_MS);
        if !due {
            return;
        }
        if self.window == self.announced_window {
            // Changed and changed back within the window: nothing to report.
            self.window_event_pending = false;
            self.next_snapshot_at = Some(now.mono_ms + SNAPSHOT_SETTLE_MS);
            return;
        }
        self.emit_window_changed(now);
    }

    fn tick_field(&mut self, now: Now) {
        let due = self
            .field
            .as_ref()
            .is_some_and(|f| f.dirty && now.mono_ms.saturating_sub(f.last_change) >= TEXT_IDLE_MS);
        if !due || self.content_suppressed() {
            return;
        }
        let Some(field) = self.field.as_mut() else {
            return;
        };
        field.dirty = false;
        if is_blank(&field.value) || field.committed.as_deref() == Some(field.value.as_str()) {
            return;
        }
        field.committed = Some(field.value.clone());
        let text = field.value.clone();
        self.emit_text(text, TextCommitReason::Idle, now);
    }

    fn tick_selection(&mut self, now: Now) {
        let due = self
            .selection
            .as_ref()
            .is_some_and(|p| now.mono_ms.saturating_sub(p.since) >= SELECTION_STABLE_MS);
        if !due || self.content_suppressed() {
            return;
        }
        let Some(pending) = self.selection.take() else {
            return;
        };
        if self.last_selection.as_deref() == Some(pending.text.as_str()) {
            return;
        }
        let max = self
            .config
            .as_ref()
            .map_or(usize::MAX, |c| c.max_text_bytes);
        let (text, truncated) = truncate_utf8(&pending.text, max);
        let mut ev = self.base_event(EventKind::SelectionChanged, now);
        ev.element = pending.element;
        ev.text = Some(text);
        ev.truncated = truncated;
        self.out.push(ev);
        self.last_selection = Some(pending.text);
    }

    fn tick_snapshot(&mut self, obs: &mut dyn Observer, now: Now) {
        let enabled = self.config.as_ref().is_some_and(|c| c.snapshots);
        let due = self.next_snapshot_at.is_some_and(|t| now.mono_ms >= t);
        if !enabled || !due || self.content_suppressed() {
            return;
        }
        self.next_snapshot_at = Some(now.mono_ms + SNAPSHOT_INTERVAL_MS);
        match obs.snapshot_focused_window_text(&SnapshotLimits::default()) {
            Snapshot::Lines(lines) => self.on_snapshot(lines, now),
            // Skip this snapshot; the window event re-runs suppression and
            // schedules a fresh one.
            Snapshot::WindowChanged(window) => self.on_window(window, now),
            Snapshot::Unavailable => {}
        }
    }

    /// Dedupe key: app plus URL, or the window identity when there is no URL.
    /// Titles are left out so a ticking title does not defeat the dedupe.
    fn snapshot_key(&self) -> String {
        let pid = self.app.as_ref().map_or(0, |a| a.pid);
        match &self.window {
            Some(WindowInfo { url: Some(url), .. }) => format!("{pid}\u{1f}u\u{1f}{url}"),
            Some(w) => format!("{pid}\u{1f}w\u{1f}{}", w.key),
            None => format!("{pid}\u{1f}none"),
        }
    }

    fn on_snapshot(&mut self, lines: Vec<String>, now: Now) {
        if self.content_suppressed() {
            return;
        }
        let text = flatten_lines(&lines);
        if text.is_empty() {
            return;
        }
        let hash = fnv1a(text.as_bytes());
        let key = self.snapshot_key();
        if self.snapshot_hashes.get(&key) == Some(&hash) {
            return;
        }
        if self.snapshot_hashes.len() >= MAX_SNAPSHOT_HASHES {
            self.snapshot_hashes.clear();
        }
        self.snapshot_hashes.insert(key, hash);
        let max = self
            .config
            .as_ref()
            .map_or(usize::MAX, |c| c.max_snapshot_bytes);
        let (text, truncated) = truncate_utf8(&text, max);
        let mut ev = self.base_event(EventKind::ContentSnapshot, now);
        ev.text = Some(text);
        ev.truncated = truncated;
        self.out.push(ev);
    }
}

// ---------------------------------------------------------------------------
// NDJSON output and the run loop
// ---------------------------------------------------------------------------

/// Writes one event as a JSON line and flushes, so the parent sees each event
/// as soon as it happens.
pub fn write_event<W: Write>(out: &mut W, event: &ObservedEvent) -> io::Result<()> {
    let mut line = serde_json::to_vec(event).map_err(io::Error::other)?;
    line.push(b'\n');
    out.write_all(&line)?;
    out.flush()
}

/// What the stdin reader thread sends to the engine loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    Line(String),
    Eof,
}

const OBSERVE_POLL: Duration = Duration::from_millis(50);
const IDLE_WAIT: Duration = Duration::from_millis(100);

/// The engine loop. Returns when stdin closes, on `shutdown`, or when stdout
/// can no longer be written (the parent is gone).
pub fn run<W: Write>(
    obs: &mut dyn Observer,
    input: &Receiver<Input>,
    out: &mut W,
    clock: &dyn Fn() -> Now,
) -> io::Result<()> {
    let mut engine = Engine::new(obs.platform());
    engine.start(obs, clock());
    flush(&mut engine, out)?;
    loop {
        let mut pending: Vec<Input> = Vec::new();
        let signals = if engine.is_observing() {
            obs.poll(OBSERVE_POLL)
        } else {
            match input.recv_timeout(IDLE_WAIT) {
                Ok(i) => pending.push(i),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
            Vec::new()
        };
        loop {
            match input.try_recv() {
                Ok(i) => pending.push(i),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    pending.push(Input::Eof);
                    break;
                }
            }
        }
        let now = clock();
        for signal in signals {
            engine.handle_signal(signal, now);
        }
        for i in pending {
            match i {
                Input::Line(line) => engine.handle_line(&line, obs, now),
                Input::Eof => {
                    if engine.is_observing() {
                        obs.stop();
                    }
                    return flush(&mut engine, out);
                }
            }
        }
        engine.tick(obs, now);
        flush(&mut engine, out)?;
        if engine.should_exit() {
            return Ok(());
        }
    }
}

fn flush<W: Write>(engine: &mut Engine, out: &mut W) -> io::Result<()> {
    for event in engine.drain() {
        write_event(out, &event)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::mpsc;

    #[derive(Default)]
    struct FakeObserver {
        access: Option<Access>,
        started: usize,
        stopped: usize,
        last_filter: Option<AppFilter>,
        snapshot: Option<Vec<String>>,
        /// Returned once, instead of lines, to simulate a window that moved.
        snapshot_window: Option<WindowInfo>,
        snapshot_calls: usize,
        requested: usize,
    }

    impl FakeObserver {
        fn granted() -> Self {
            FakeObserver {
                access: Some(Access {
                    permission: Permission::Granted,
                    can_observe: true,
                    accessibility_bus: None,
                    session: None,
                    detail: None,
                }),
                ..Default::default()
            }
        }
        fn denied() -> Self {
            FakeObserver {
                access: Some(Access {
                    permission: Permission::Denied,
                    can_observe: false,
                    accessibility_bus: None,
                    session: None,
                    detail: Some("not trusted".into()),
                }),
                ..Default::default()
            }
        }
    }

    impl Observer for FakeObserver {
        fn platform(&self) -> Platform {
            Platform::Macos
        }
        fn access(&mut self) -> Access {
            self.access.clone().unwrap()
        }
        fn request_access(&mut self) -> Result<(), String> {
            self.requested += 1;
            Ok(())
        }
        fn start(&mut self, filter: &AppFilter) {
            self.started += 1;
            self.last_filter = Some(filter.clone());
        }
        fn stop(&mut self) {
            self.stopped += 1;
        }
        fn poll(&mut self, _timeout: Duration) -> Vec<Signal> {
            Vec::new()
        }
        fn snapshot_focused_window_text(&mut self, _l: &SnapshotLimits) -> Snapshot {
            self.snapshot_calls += 1;
            if let Some(window) = self.snapshot_window.take() {
                return Snapshot::WindowChanged(window);
            }
            match &self.snapshot {
                Some(lines) => Snapshot::Lines(lines.clone()),
                None => Snapshot::Unavailable,
            }
        }
    }

    fn at(ms: u64) -> Now {
        Now {
            mono_ms: ms,
            wall_ms: 1_790_000_000_000 + ms as i64,
        }
    }

    fn app(id: &str, pid: u32) -> ObservedApp {
        ObservedApp {
            id: id.into(),
            name: id.into(),
            pid,
            aumid: None,
        }
    }

    /// A window whose identity follows its title (distinct titles are
    /// distinct windows).
    fn win(title: &str, url: Option<&str>) -> WindowInfo {
        win_k(fnv1a(title.as_bytes()), title, url)
    }

    fn win_k(key: u64, title: &str, url: Option<&str>) -> WindowInfo {
        WindowInfo {
            key,
            title: Some(title.into()),
            url: url.map(String::from),
        }
    }

    fn field(key: u64, value: &str) -> ElementInfo {
        ElementInfo {
            key,
            role: ElementRole::TextField,
            label: Some("Message".into()),
            value: Some(value.into()),
            secure: false,
        }
    }

    fn configured(cfg: ConfigureCommand) -> (Engine, FakeObserver) {
        let mut obs = FakeObserver::granted();
        let mut engine = Engine::new(Platform::Macos);
        engine.start(&mut obs, at(0));
        engine.handle_command(Command::Configure(cfg), &mut obs, at(0));
        engine.drain();
        (engine, obs)
    }

    fn kinds(events: &[ObservedEvent]) -> Vec<EventKind> {
        events.iter().map(|e| e.kind).collect()
    }

    fn activate(engine: &mut Engine, id: &str, pid: u32, title: &str, t: u64) {
        engine.handle_signal(
            Signal::AppActivated {
                app: app(id, pid),
                window: Some(win(title, None)),
            },
            at(t),
        );
    }

    // -- helpers --

    #[test]
    fn iso_timestamps_are_utc_millis() {
        assert_eq!(iso_utc_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc_ms(1_791_036_600_123), "2026-10-03T14:10:00.123Z");
        assert_eq!(iso_utc_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn truncation_respects_utf8_boundaries() {
        assert_eq!(truncate_utf8("hello", 10), ("hello".into(), false));
        assert_eq!(truncate_utf8("hello", 3), ("hel".into(), true));
        // "é" is 2 bytes; cutting at 2 would split it.
        assert_eq!(truncate_utf8("aé", 2), ("a".into(), true));
        // A 4-byte emoji cut anywhere inside collapses to nothing.
        let (s, t) = truncate_utf8("\u{1F600}", 3);
        assert_eq!((s.as_str(), t), ("", true));
        let (s, t) = truncate_utf8("ab\u{1F600}cd", 5);
        assert_eq!((s.as_str(), t), ("ab", true));
    }

    #[test]
    fn domains_match_host_and_subdomains_only() {
        let domains = vec![normalize_domain("Bank.Example.com").unwrap()];
        assert!(domain_blocked("https://bank.example.com/login", &domains));
        assert!(domain_blocked("https://www.bank.example.com/", &domains));
        assert!(domain_blocked(
            "https://user:pw@BANK.example.com:8443/x",
            &domains
        ));
        assert!(domain_blocked("https://bank.example.com./", &domains));
        assert!(!domain_blocked("https://notbank.example.com/", &domains));
        assert!(!domain_blocked("https://example.com/", &domains));
        assert!(!domain_blocked(
            "https://bank.example.com.evil.net/",
            &domains
        ));
        assert!(!domain_blocked(
            "file:///Users/me/bank.example.com",
            &domains
        ));
        assert_eq!(
            normalize_domain("https://*.foo.org/path"),
            Some("foo.org".into())
        );
        assert_eq!(normalize_domain(" .bar.net:443 "), Some("bar.net".into()));
        assert_eq!(normalize_domain("  "), None);
        assert_eq!(url_host("http://[::1]:3000/"), Some("::1".into()));
    }

    #[test]
    fn private_markers_are_case_insensitive() {
        assert!(is_private_title("New Tab - Google Chrome (Incognito)"));
        assert!(is_private_title("Mozilla Firefox Private Browsing"));
        assert!(is_private_title("Bing - InPrivate - Microsoft Edge"));
        assert!(is_private_title("Start Page - private window"));
        assert!(!is_private_title("Inbox - Gmail"));
    }

    // -- commands --

    #[test]
    fn starts_paused_until_configured() {
        let mut obs = FakeObserver::granted();
        let mut engine = Engine::new(Platform::Macos);
        engine.start(&mut obs, at(0));
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::HelperStatus]);
        let status = out[0].status.as_ref().unwrap();
        assert_eq!(status.state, HelperState::Paused);
        assert_eq!(status.detail.as_deref(), Some("waiting for configure"));
        assert_eq!(obs.started, 0);
        // Signals before configure are ignored entirely.
        activate(&mut engine, "com.apple.Safari", 10, "Home", 10);
        engine.tick(&mut obs, at(5000));
        assert!(engine.drain().is_empty());
        assert_eq!(obs.snapshot_calls, 0);

        engine.handle_command(
            Command::Configure(ConfigureCommand::default()),
            &mut obs,
            at(6000),
        );
        assert_eq!(obs.started, 1);
        let out = engine.drain();
        assert_eq!(out[0].status.as_ref().unwrap().state, HelperState::Running);
    }

    #[test]
    fn blocked_access_reports_blocked_and_starts_when_granted() {
        let mut obs = FakeObserver::denied();
        let mut engine = Engine::new(Platform::Macos);
        engine.start(&mut obs, at(0));
        engine.handle_command(
            Command::Configure(ConfigureCommand::default()),
            &mut obs,
            at(0),
        );
        let out = engine.drain();
        assert_eq!(
            out.last().unwrap().status.as_ref().unwrap().state,
            HelperState::Blocked
        );
        assert_eq!(obs.started, 0);

        obs.access = FakeObserver::granted().access;
        engine.tick(&mut obs, at(1000));
        assert_eq!(obs.started, 0, "access is re-checked only every 5 s");
        engine.tick(&mut obs, at(ACCESS_POLL_MS));
        assert_eq!(obs.started, 1);
        let out = engine.drain();
        assert_eq!(out[0].status.as_ref().unwrap().state, HelperState::Running);
    }

    #[test]
    fn unknown_and_malformed_commands_emit_helper_error() {
        let mut obs = FakeObserver::granted();
        let mut engine = Engine::new(Platform::Macos);
        engine.start(&mut obs, at(0));
        engine.drain();
        engine.handle_line(r#"{"cmd":"explode"}"#, &mut obs, at(1));
        let out = engine.drain();
        assert_eq!(
            kinds(&out),
            vec![EventKind::HelperError, EventKind::HelperStatus]
        );
        assert_eq!(out[0].text.as_deref(), Some("unknown command: explode"));

        engine.handle_line("not json", &mut obs, at(2));
        let out = engine.drain();
        assert_eq!(out[0].kind, EventKind::HelperError);
        assert!(out[0]
            .text
            .as_deref()
            .unwrap()
            .starts_with("invalid command JSON"));

        engine.handle_line(r#"{"nope":1}"#, &mut obs, at(3));
        assert_eq!(engine.drain()[0].kind, EventKind::HelperError);

        engine.handle_line(r#"{"cmd":"configure","blockPids":"x"}"#, &mut obs, at(4));
        let out = engine.drain();
        assert_eq!(out[0].kind, EventKind::HelperError);
        assert_eq!(obs.started, 0);
    }

    #[test]
    fn parses_every_command() {
        let cfg = parse_command(
            r#"{"cmd":"configure","blockApps":["com.1password.1password"],"blockPids":[1234],
                "blockDomains":["bank.example.com"],"snapshots":false,"maxTextBytes":100,
                "maxSnapshotBytes":200,"futureField":true}"#,
        )
        .unwrap();
        assert_eq!(
            cfg,
            Command::Configure(ConfigureCommand {
                block_apps: vec!["com.1password.1password".into()],
                block_pids: vec![1234],
                block_domains: vec!["bank.example.com".into()],
                snapshots: false,
                max_text_bytes: 100,
                max_snapshot_bytes: 200,
            })
        );
        assert_eq!(
            parse_command(r#"{"cmd":"configure"}"#).unwrap(),
            Command::Configure(ConfigureCommand::default())
        );
        assert_eq!(parse_command(r#"{"cmd":"pause"}"#).unwrap(), Command::Pause);
        assert_eq!(
            parse_command(r#"{"cmd":"resume"}"#).unwrap(),
            Command::Resume
        );
        assert_eq!(
            parse_command(r#"{"cmd":"status"}"#).unwrap(),
            Command::Status
        );
        assert_eq!(
            parse_command(r#"{"cmd":"enable-accessibility"}"#).unwrap(),
            Command::EnableAccessibility
        );
        assert_eq!(
            parse_command(r#"{"cmd":"shutdown"}"#).unwrap(),
            Command::Shutdown
        );
    }

    #[test]
    fn pause_stops_observing_and_drops_pending_text() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.tinyspeck.slackmacgap", 7, "general", 0);
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "secret plan"),
            },
            at(100),
        );
        engine.drain();
        engine.handle_command(Command::Pause, &mut obs, at(200));
        assert_eq!(obs.stopped, 1);
        engine.tick(&mut obs, at(5000));
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::HelperStatus]);
        assert_eq!(out[0].status.as_ref().unwrap().state, HelperState::Paused);
        // Signals while paused are ignored.
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "more"),
            },
            at(6000),
        );
        engine.tick(&mut obs, at(9000));
        assert!(engine.drain().is_empty());

        engine.handle_command(Command::Resume, &mut obs, at(10_000));
        assert_eq!(obs.started, 2);
    }

    #[test]
    fn shutdown_requests_exit() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        engine.handle_command(Command::Shutdown, &mut obs, at(1));
        assert!(engine.should_exit());
        assert_eq!(obs.stopped, 1);
    }

    #[test]
    fn enable_accessibility_calls_adapter_and_reports_status() {
        let mut obs = FakeObserver::denied();
        let mut engine = Engine::new(Platform::Macos);
        engine.start(&mut obs, at(0));
        engine.drain();
        engine.handle_command(Command::EnableAccessibility, &mut obs, at(1));
        assert_eq!(obs.requested, 1);
        assert_eq!(kinds(&engine.drain()), vec![EventKind::HelperStatus]);
    }

    // -- blocklists and suppression --

    #[test]
    fn blocked_app_emits_nothing_at_all() {
        let (mut engine, mut obs) = configured(ConfigureCommand {
            block_apps: vec!["com.1Password.1password".into()],
            block_pids: vec![999],
            ..Default::default()
        });
        assert!(obs
            .last_filter
            .as_ref()
            .unwrap()
            .is_blocked(&app("COM.1PASSWORD.1PASSWORD", 1)));
        activate(&mut engine, "com.1password.1password", 5, "Vault", 0);
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(10),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "hunter2!"),
            },
            at(20),
        );
        engine.handle_signal(
            Signal::SelectionChanged {
                element: None,
                text: "hunter2!".into(),
            },
            at(30),
        );
        engine.handle_signal(
            Signal::WindowChanged {
                window: win("Other", None),
            },
            at(40),
        );
        engine.tick(&mut obs, at(3000));
        engine.tick(&mut obs, at(40_000));
        assert!(engine.drain().is_empty());
        assert_eq!(obs.snapshot_calls, 0);

        // Blocked by pid as well.
        activate(&mut engine, "com.example.anything", 999, "x", 50_000);
        engine.tick(&mut obs, at(60_000));
        assert!(engine.drain().is_empty());

        // An allowed app afterwards is announced normally.
        activate(&mut engine, "com.apple.TextEdit", 6, "Notes", 70_000);
        assert_eq!(kinds(&engine.drain()), vec![EventKind::AppActivated]);
    }

    #[test]
    fn returning_from_blocked_app_is_a_fresh_activation() {
        let (mut engine, _obs) = configured(ConfigureCommand {
            block_apps: vec!["com.agilebits.onepassword7".into()],
            ..Default::default()
        });
        activate(&mut engine, "com.apple.Safari", 4, "News", 0);
        activate(&mut engine, "com.agilebits.onepassword7", 5, "Vault", 100);
        activate(&mut engine, "com.apple.Safari", 4, "News", 200);
        let out = engine.drain();
        assert_eq!(
            kinds(&out),
            vec![EventKind::AppActivated, EventKind::AppActivated]
        );
        assert!(out.iter().all(|e| e.app.as_ref().unwrap().pid == 4));
    }

    #[test]
    fn app_rules_match_display_name_case_insensitively() {
        let filter = AppFilter::new(&["Slack".into(), " zoom.US ".into()], &[], &[]);
        let slack = ObservedApp {
            id: "com.tinyspeck.slackmacgap".into(),
            name: "Slack".into(),
            pid: 1,
            aumid: None,
        };
        let slack_win = ObservedApp {
            id: "slack.exe".into(),
            name: "slack".into(),
            pid: 2,
            aumid: None,
        };
        let zoom = ObservedApp {
            id: "us.zoom.xos".into(),
            name: "zoom.us".into(),
            pid: 3,
            aumid: None,
        };
        let notes = ObservedApp {
            id: "com.apple.Notes".into(),
            name: "Notes".into(),
            pid: 4,
            aumid: None,
        };
        assert!(filter.is_blocked(&slack));
        assert!(filter.is_blocked(&slack_win));
        assert!(filter.is_blocked(&zoom));
        assert!(!filter.is_blocked(&notes));

        let (mut engine, _obs) = configured(ConfigureCommand {
            block_apps: vec!["SLACK".into()],
            ..Default::default()
        });
        engine.handle_signal(
            Signal::AppActivated {
                app: slack,
                window: Some(win("general", None)),
            },
            at(0),
        );
        assert!(engine.drain().is_empty());
    }

    #[test]
    fn known_browsers_are_recognized() {
        for (id, name) in [
            ("com.google.Chrome", "Google Chrome"),
            ("com.google.Chrome.canary", "Google Chrome Canary"),
            ("com.microsoft.edgemac", "Microsoft Edge"),
            ("company.thebrowser.Browser", "Arc"),
            ("org.mozilla.firefox", "Firefox"),
            ("com.apple.Safari", "Safari"),
            ("msedge.exe", "msedge"),
            ("firefox.exe", "firefox"),
            ("google-chrome", "Google Chrome"),
            ("org.chromium.Chromium", "Chromium"),
            ("vivaldi-bin", "Vivaldi"),
            ("x.y", "Opera"),
        ] {
            let a = ObservedApp {
                id: id.into(),
                name: name.into(),
                pid: 1,
                aumid: None,
            };
            assert!(is_known_browser(&a), "{id}");
        }
        assert!(!is_known_browser(&app("com.apple.TextEdit", 1)));
        assert!(!is_known_browser(&app("slack.exe", 1)));
    }

    #[test]
    fn browser_without_url_fails_closed_only_with_domain_rules() {
        let (mut engine, mut obs) = configured(ConfigureCommand {
            block_domains: vec!["bank.example.com".into()],
            ..Default::default()
        });
        obs.snapshot = Some(vec!["page".into()]);
        engine.handle_signal(
            Signal::AppActivated {
                app: app("com.google.Chrome", 3),
                window: Some(win("Sign in", None)),
            },
            at(0),
        );
        // The title is still reported.
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::AppActivated]);
        assert_eq!(
            out[0].window.as_ref().unwrap().title.as_deref(),
            Some("Sign in")
        );
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(10),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "user@example.com"),
            },
            at(20),
        );
        engine.handle_signal(
            Signal::SelectionChanged {
                element: None,
                text: "balance".into(),
            },
            at(30),
        );
        engine.tick(&mut obs, at(5000));
        assert!(engine.drain().is_empty());
        assert_eq!(obs.snapshot_calls, 0);

        // Once the URL resolves to an allowed host, content flows again.
        engine.handle_signal(
            Signal::WindowChanged {
                window: win("Sign in", Some("https://news.example.com/")),
            },
            at(6000),
        );
        assert_eq!(kinds(&engine.drain()), vec![EventKind::WindowChanged]);
        engine.tick(&mut obs, at(6000 + SNAPSHOT_SETTLE_MS));
        assert_eq!(kinds(&engine.drain()), vec![EventKind::ContentSnapshot]);

        // Without domain rules an unknown URL is not a reason to hide content.
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        obs.snapshot = Some(vec!["page".into()]);
        activate(&mut engine, "com.google.Chrome", 3, "Sign in", 0);
        engine.drain();
        engine.tick(&mut obs, at(SNAPSHOT_SETTLE_MS));
        assert_eq!(kinds(&engine.drain()), vec![EventKind::ContentSnapshot]);
    }

    #[test]
    fn suppression_uses_raw_strings_before_truncation() {
        let (mut engine, _obs) = configured(ConfigureCommand {
            block_domains: vec!["bank.example.com".into()],
            ..Default::default()
        });
        // The marker sits past the 2048-byte title cap.
        let title = format!("{} - Incognito", "x".repeat(MAX_TITLE_BYTES + 10));
        activate(&mut engine, "com.google.Chrome", 3, &title, 0);
        assert!(engine.drain().is_empty());

        // A long title is capped on emission.
        let long = "y".repeat(MAX_TITLE_BYTES + 10);
        engine.handle_signal(
            Signal::WindowChanged {
                window: win(&long, Some("https://news.example.com/")),
            },
            at(100),
        );
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::AppActivated]);
        assert_eq!(
            out[0]
                .window
                .as_ref()
                .unwrap()
                .title
                .as_deref()
                .unwrap()
                .len(),
            MAX_TITLE_BYTES
        );
    }

    #[test]
    fn window_changes_are_rate_limited_and_coalesced() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.apple.Terminal", 9, "build 1%", 0);
        assert_eq!(kinds(&engine.drain()), vec![EventKind::AppActivated]);
        for (i, t) in [100u64, 300, 600, 900].iter().enumerate() {
            engine.handle_signal(
                Signal::WindowChanged {
                    window: win_k(7, &format!("build {}%", (i + 2) * 10), None),
                },
                at(*t),
            );
        }
        engine.tick(&mut obs, at(950));
        assert!(engine.drain().is_empty(), "within 1 s of app.activated");
        engine.tick(&mut obs, at(1000));
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::WindowChanged]);
        assert_eq!(
            out[0].window.as_ref().unwrap().title.as_deref(),
            Some("build 50%"),
            "coalesced to the latest"
        );
        // A change more than 1 s later goes out at once.
        engine.handle_signal(
            Signal::WindowChanged {
                window: win_k(7, "build 60%", None),
            },
            at(2100),
        );
        assert_eq!(kinds(&engine.drain()), vec![EventKind::WindowChanged]);
        // Changed and changed back within the second: nothing to report.
        engine.handle_signal(
            Signal::WindowChanged {
                window: win_k(7, "build 70%", None),
            },
            at(2200),
        );
        engine.handle_signal(
            Signal::WindowChanged {
                window: win_k(7, "build 60%", None),
            },
            at(2300),
        );
        engine.tick(&mut obs, at(3200));
        assert!(engine
            .drain()
            .iter()
            .all(|e| e.kind != EventKind::WindowChanged));
    }

    #[test]
    fn snapshot_dedupe_ignores_title_churn() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        obs.snapshot = Some(vec!["same content".into()]);
        engine.handle_signal(
            Signal::AppActivated {
                app: app("com.apple.Terminal", 9),
                window: Some(win_k(7, "1 job", None)),
            },
            at(0),
        );
        engine.tick(&mut obs, at(SNAPSHOT_SETTLE_MS));
        assert_eq!(
            kinds(&engine.drain()),
            vec![EventKind::AppActivated, EventKind::ContentSnapshot]
        );
        engine.handle_signal(
            Signal::WindowChanged {
                window: win_k(7, "2 jobs", None),
            },
            at(5000),
        );
        engine.tick(&mut obs, at(5000 + SNAPSHOT_SETTLE_MS));
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::WindowChanged]);
        assert_eq!(obs.snapshot_calls, 2, "walked again but deduped");

        // Same title, different URL: a different page, so not deduped.
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        obs.snapshot = Some(vec!["same content".into()]);
        engine.handle_signal(
            Signal::AppActivated {
                app: app("com.apple.Safari", 4),
                window: Some(win_k(1, "Home", Some("https://a.example/"))),
            },
            at(0),
        );
        engine.tick(&mut obs, at(SNAPSHOT_SETTLE_MS));
        engine.drain();
        engine.handle_signal(
            Signal::WindowChanged {
                window: win_k(1, "Home", Some("https://b.example/")),
            },
            at(5000),
        );
        engine.tick(&mut obs, at(5000 + SNAPSHOT_SETTLE_MS));
        assert_eq!(
            kinds(&engine.drain()),
            vec![EventKind::WindowChanged, EventKind::ContentSnapshot]
        );
    }

    #[test]
    fn snapshot_detects_moved_window_and_resuppresses() {
        let (mut engine, mut obs) = configured(ConfigureCommand {
            block_domains: vec!["bank.example.com".into()],
            ..Default::default()
        });
        obs.snapshot = Some(vec!["account 123".into()]);
        engine.handle_signal(
            Signal::AppActivated {
                app: app("com.apple.Safari", 4),
                window: Some(win_k(1, "Sign in", Some("https://news.example.com/"))),
            },
            at(0),
        );
        engine.drain();
        // Navigated to a blocked domain without a title change.
        obs.snapshot_window = Some(win_k(1, "Sign in", Some("https://bank.example.com/")));
        engine.tick(&mut obs, at(5000));
        assert_eq!(obs.snapshot_calls, 1);
        assert!(engine.drain().is_empty(), "no snapshot, no window event");
        engine.tick(&mut obs, at(60_000));
        assert_eq!(obs.snapshot_calls, 1, "hidden window is never walked");
    }

    #[test]
    fn switching_into_blocked_app_still_commits_previous_field_but_nothing_after() {
        let (mut engine, _obs) = configured(ConfigureCommand {
            block_apps: vec!["com.bitwarden.desktop".into()],
            ..Default::default()
        });
        activate(&mut engine, "com.apple.TextEdit", 6, "Notes", 0);
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "draft"),
            },
            at(100),
        );
        engine.drain();
        activate(&mut engine, "com.bitwarden.desktop", 8, "Vault", 200);
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::TextCommitted]);
        assert_eq!(out[0].reason, Some(TextCommitReason::Blur));
        assert_eq!(out[0].app.as_ref().unwrap().id, "com.apple.TextEdit");
    }

    #[test]
    fn private_windows_are_skipped_and_app_announced_later() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        obs.snapshot = Some(vec!["secret page".into()]);
        activate(
            &mut engine,
            "com.google.Chrome",
            3,
            "Bank - Google Chrome (Incognito)",
            0,
        );
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(10),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "query"),
            },
            at(20),
        );
        engine.tick(&mut obs, at(5000));
        assert!(engine.drain().is_empty());
        assert_eq!(obs.snapshot_calls, 0);

        engine.handle_signal(
            Signal::WindowChanged {
                window: win("Docs - Google Chrome", None),
            },
            at(6000),
        );
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::AppActivated]);
        assert_eq!(
            out[0].window.as_ref().unwrap().title.as_deref(),
            Some("Docs - Google Chrome")
        );
        engine.handle_signal(
            Signal::WindowChanged {
                window: win("Mail - Google Chrome", None),
            },
            at(7000),
        );
        assert_eq!(kinds(&engine.drain()), vec![EventKind::WindowChanged]);
    }

    #[test]
    fn blocked_domains_suppress_window_and_subdomains() {
        let (mut engine, mut obs) = configured(ConfigureCommand {
            block_domains: vec!["bank.example.com".into()],
            ..Default::default()
        });
        obs.snapshot = Some(vec!["balance".into()]);
        engine.handle_signal(
            Signal::AppActivated {
                app: app("com.apple.Safari", 4),
                window: Some(win("Login", Some("https://secure.bank.example.com/login"))),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::SelectionChanged {
                element: None,
                text: "account 123".into(),
            },
            at(10),
        );
        engine.tick(&mut obs, at(3000));
        assert!(engine.drain().is_empty());
        assert_eq!(obs.snapshot_calls, 0);

        engine.handle_signal(
            Signal::WindowChanged {
                window: win("News", Some("https://news.example.com/")),
            },
            at(4000),
        );
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::AppActivated]);
        assert_eq!(
            out[0].window.as_ref().unwrap().url.as_deref(),
            Some("https://news.example.com/")
        );
    }

    // -- text commits --

    #[test]
    fn idle_commit_after_quiet_period() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.apple.TextEdit", 6, "Notes", 0);
        engine.drain();
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "old")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "old h"),
            },
            at(100),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "old hi"),
            },
            at(1000),
        );
        engine.tick(&mut obs, at(2000));
        assert!(
            engine.drain().is_empty(),
            "only 1.0 s since the last change"
        );
        engine.tick(&mut obs, at(2500));
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::TextCommitted]);
        assert_eq!(out[0].text.as_deref(), Some("old hi"));
        assert_eq!(out[0].reason, Some(TextCommitReason::Idle));
        assert_eq!(
            out[0].element.as_ref().unwrap().role,
            ElementRole::TextField
        );
        // No duplicate on blur after an idle commit of the same value.
        engine.handle_signal(Signal::FocusChanged { element: None }, at(3000));
        engine.tick(&mut obs, at(9000));
        let out = engine.drain();
        assert!(out.iter().all(|e| e.kind != EventKind::TextCommitted));
    }

    #[test]
    fn focus_without_change_commits_nothing() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.apple.TextEdit", 6, "Notes", 0);
        engine.drain();
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "prefilled")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(2, "")),
            },
            at(100),
        );
        engine.tick(&mut obs, at(5000));
        assert!(engine.drain().is_empty());
    }

    #[test]
    fn blur_commits_before_idle() {
        let (mut engine, _obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.apple.TextEdit", 6, "Notes", 0);
        engine.drain();
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "typed"),
            },
            at(100),
        );
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(2, "")),
            },
            at(500),
        );
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::TextCommitted]);
        assert_eq!(out[0].reason, Some(TextCommitReason::Blur));
        assert_eq!(out[0].text.as_deref(), Some("typed"));
    }

    #[test]
    fn cleared_after_send_carries_previous_value() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.tinyspeck.slackmacgap", 7, "general", 0);
        engine.drain();
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "ship it"),
            },
            at(100),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, ""),
            },
            at(300),
        );
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::TextCommitted]);
        assert_eq!(out[0].reason, Some(TextCommitReason::Cleared));
        assert_eq!(out[0].text.as_deref(), Some("ship it"));
        engine.tick(&mut obs, at(5000));
        assert!(
            engine.drain().is_empty(),
            "the empty field is not committed again"
        );
    }

    #[test]
    fn backspacing_to_empty_is_not_cleared() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.apple.TextEdit", 6, "Notes", 0);
        engine.drain();
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "ab"),
            },
            at(10),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "a"),
            },
            at(20),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, ""),
            },
            at(30),
        );
        engine.tick(&mut obs, at(5000));
        assert!(engine.drain().is_empty());
    }

    #[test]
    fn secure_fields_are_never_committed() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.apple.Safari", 4, "Login", 0);
        engine.drain();
        let secure = ElementInfo {
            key: 9,
            role: ElementRole::TextField,
            label: Some("Password".into()),
            value: Some("hunter2".into()),
            secure: true,
        };
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(secure.clone()),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: secure.clone(),
            },
            at(10),
        );
        engine.handle_signal(
            Signal::SelectionChanged {
                element: Some(secure),
                text: "hunter2".into(),
            },
            at(20),
        );
        engine.handle_signal(Signal::FocusChanged { element: None }, at(30));
        engine.tick(&mut obs, at(5000));
        let out = engine.drain();
        assert!(out
            .iter()
            .all(|e| e.kind != EventKind::TextCommitted && e.kind != EventKind::SelectionChanged));
    }

    #[test]
    fn text_is_capped_with_truncated_flag() {
        let (mut engine, mut obs) = configured(ConfigureCommand {
            max_text_bytes: 20,
            ..Default::default()
        });
        activate(&mut engine, "com.apple.TextEdit", 6, "Notes", 0);
        engine.drain();
        let long = "\u{e9}".repeat(30);
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, &long),
            },
            at(10),
        );
        engine.tick(&mut obs, at(2000));
        let out = engine.drain();
        assert_eq!(out[0].text.as_deref().unwrap().len(), 20);
        assert!(out[0].truncated);
    }

    // -- selection --

    #[test]
    fn selection_debounce_and_skip_empty() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        activate(&mut engine, "com.apple.Safari", 4, "Article", 0);
        engine.drain();
        let sel = |text: &str| Signal::SelectionChanged {
            element: None,
            text: text.into(),
        };
        engine.handle_signal(sel("the qu"), at(0));
        engine.handle_signal(sel("the quick"), at(300));
        engine.tick(&mut obs, at(1200));
        assert!(engine.drain().is_empty(), "changed 0.9 s ago");
        engine.tick(&mut obs, at(1300));
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::SelectionChanged]);
        assert_eq!(out[0].text.as_deref(), Some("the quick"));

        // A selection that collapses before 1 s is never emitted.
        engine.handle_signal(sel("brown fox"), at(2000));
        engine.handle_signal(sel(""), at(2500));
        engine.tick(&mut obs, at(4000));
        assert!(engine.drain().is_empty());

        // Whitespace-only selections are skipped.
        engine.handle_signal(sel("   "), at(5000));
        engine.tick(&mut obs, at(7000));
        assert!(engine.drain().is_empty());

        // Re-selecting the same text is not re-emitted.
        engine.handle_signal(sel("the quick"), at(8000));
        engine.tick(&mut obs, at(9500));
        assert!(engine.drain().is_empty());
    }

    // -- snapshots --

    #[test]
    fn snapshot_on_activation_then_throttled_and_deduped() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        obs.snapshot = Some(vec![
            "  line one ".into(),
            "".into(),
            "line two\nline two".into(),
        ]);
        activate(&mut engine, "com.apple.Notes", 11, "Groceries", 0);
        engine.drain();
        engine.tick(&mut obs, at(100));
        assert_eq!(obs.snapshot_calls, 0, "waits for the window to settle");
        engine.tick(&mut obs, at(SNAPSHOT_SETTLE_MS));
        assert_eq!(obs.snapshot_calls, 1);
        let out = engine.drain();
        assert_eq!(kinds(&out), vec![EventKind::ContentSnapshot]);
        assert_eq!(out[0].text.as_deref(), Some("line one\nline two"));

        // Not again before 30 s.
        engine.tick(&mut obs, at(20_000));
        assert_eq!(obs.snapshot_calls, 1);
        // At 30 s it walks again, but identical content is skipped.
        engine.tick(&mut obs, at(SNAPSHOT_SETTLE_MS + SNAPSHOT_INTERVAL_MS));
        assert_eq!(obs.snapshot_calls, 2);
        assert!(engine.drain().is_empty());
        // Changed content is emitted at the next interval.
        obs.snapshot = Some(vec!["line one".into(), "line three".into()]);
        engine.tick(&mut obs, at(SNAPSHOT_SETTLE_MS + 2 * SNAPSHOT_INTERVAL_MS));
        assert_eq!(kinds(&engine.drain()), vec![EventKind::ContentSnapshot]);

        // Window change schedules a prompt snapshot of the new window.
        engine.handle_signal(
            Signal::WindowChanged {
                window: win("Todo", None),
            },
            at(70_000),
        );
        engine.drain();
        engine.tick(&mut obs, at(70_000 + SNAPSHOT_SETTLE_MS));
        assert_eq!(kinds(&engine.drain()), vec![EventKind::ContentSnapshot]);
        // Returning to the first window with unchanged content: deduped per window.
        engine.handle_signal(
            Signal::WindowChanged {
                window: win("Groceries", None),
            },
            at(71_000),
        );
        engine.drain();
        engine.tick(&mut obs, at(71_000 + SNAPSHOT_SETTLE_MS));
        assert!(engine.drain().is_empty());
    }

    #[test]
    fn snapshots_disabled_and_capped() {
        let (mut engine, mut obs) = configured(ConfigureCommand {
            snapshots: false,
            ..Default::default()
        });
        obs.snapshot = Some(vec!["x".into()]);
        activate(&mut engine, "com.apple.Notes", 11, "A", 0);
        engine.tick(&mut obs, at(1000));
        assert_eq!(obs.snapshot_calls, 0);

        let (mut engine, mut obs) = configured(ConfigureCommand {
            max_snapshot_bytes: 32,
            ..Default::default()
        });
        obs.snapshot = Some(vec!["0123456789".repeat(10)]);
        activate(&mut engine, "com.apple.Notes", 11, "A", 0);
        engine.drain();
        engine.tick(&mut obs, at(1000));
        let out = engine.drain();
        assert_eq!(out[0].text.as_deref().unwrap().len(), 32);
        assert!(out[0].truncated);
    }

    // -- protocol shape --

    #[test]
    fn event_json_matches_ts_contract() {
        let (mut engine, mut obs) = configured(ConfigureCommand::default());
        engine.handle_signal(
            Signal::AppActivated {
                app: app("com.tinyspeck.slackmacgap", 4242),
                window: Some(win("general - Acme", None)),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::FocusChanged {
                element: Some(field(1, "")),
            },
            at(0),
        );
        engine.handle_signal(
            Signal::ValueChanged {
                element: field(1, "hi"),
            },
            at(10),
        );
        engine.tick(&mut obs, at(2000));
        let out = engine.drain();
        let activated: Value = serde_json::to_value(&out[0]).unwrap();
        assert_eq!(
            activated,
            json!({
                "v": 1,
                "ts": "2026-09-21T14:13:20.000Z",
                "kind": "app.activated",
                "app": { "id": "com.tinyspeck.slackmacgap", "name": "com.tinyspeck.slackmacgap", "pid": 4242 },
                "window": { "title": "general - Acme" }
            })
        );
        let committed: Value = serde_json::to_value(&out[1]).unwrap();
        assert_eq!(
            committed,
            json!({
                "v": 1,
                "ts": "2026-09-21T14:13:22.000Z",
                "kind": "text.committed",
                "app": { "id": "com.tinyspeck.slackmacgap", "name": "com.tinyspeck.slackmacgap", "pid": 4242 },
                "window": { "title": "general - Acme" },
                "element": { "role": "text_field", "label": "Message" },
                "text": "hi",
                "reason": "idle"
            })
        );
    }

    #[test]
    fn status_and_error_json_match_ts_contract() {
        let status = HelperStatus {
            version: "0.1.0".into(),
            platform: Platform::Linux,
            state: HelperState::Blocked,
            permission: Permission::NotRequired,
            accessibility_bus: Some(AccessibilityBus::Disabled),
            session: Some(SessionType::Wayland),
            detail: Some("bus off".into()),
        };
        let mut ev = ObservedEvent::new(EventKind::HelperStatus, iso_utc_ms(0));
        ev.status = Some(status);
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({
                "v": 1,
                "ts": "1970-01-01T00:00:00.000Z",
                "kind": "helper.status",
                "status": {
                    "version": "0.1.0",
                    "platform": "linux",
                    "state": "blocked",
                    "permission": "not_required",
                    "accessibilityBus": "disabled",
                    "session": "wayland",
                    "detail": "bus off"
                }
            })
        );

        let mac = HelperStatus {
            version: "0.1.0".into(),
            platform: Platform::Macos,
            state: HelperState::Running,
            permission: Permission::Granted,
            accessibility_bus: None,
            session: None,
            detail: None,
        };
        let v = serde_json::to_value(&mac).unwrap();
        assert_eq!(
            v,
            json!({ "version": "0.1.0", "platform": "macos", "state": "running", "permission": "granted" })
        );

        let mut err = ObservedEvent::new(EventKind::HelperError, iso_utc_ms(0));
        err.text = Some("boom".into());
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "v": 1, "ts": "1970-01-01T00:00:00.000Z", "kind": "helper.error", "text": "boom" })
        );

        let app = ObservedApp {
            id: "slack.exe".into(),
            name: "slack".into(),
            pid: 1,
            aumid: Some("com.squirrel.slack.slack".into()),
        };
        assert_eq!(
            serde_json::to_value(&app).unwrap(),
            json!({ "id": "slack.exe", "name": "slack", "pid": 1, "aumid": "com.squirrel.slack.slack" })
        );
        for (role, name) in [
            (ElementRole::TextField, "text_field"),
            (ElementRole::TextArea, "text_area"),
            (ElementRole::ComboBox, "combo_box"),
            (ElementRole::SearchField, "search_field"),
            (ElementRole::Document, "document"),
            (ElementRole::WebArea, "web_area"),
            (ElementRole::Other, "other"),
        ] {
            assert_eq!(serde_json::to_value(role).unwrap(), json!(name));
        }
        for (reason, name) in [
            (TextCommitReason::Idle, "idle"),
            (TextCommitReason::Blur, "blur"),
            (TextCommitReason::Cleared, "cleared"),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), json!(name));
        }
    }

    #[test]
    fn run_loop_emits_status_and_exits_on_eof() {
        let (tx, rx) = mpsc::channel();
        tx.send(Input::Line(r#"{"cmd":"status"}"#.into())).unwrap();
        tx.send(Input::Line(r#"{"cmd":"bogus"}"#.into())).unwrap();
        tx.send(Input::Eof).unwrap();
        let mut obs = FakeObserver::granted();
        let mut out: Vec<u8> = Vec::new();
        run(&mut obs, &rx, &mut out, &|| at(0)).unwrap();
        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let kinds: Vec<&str> = lines.iter().map(|l| l["kind"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            vec![
                "helper.status",
                "helper.status",
                "helper.error",
                "helper.status"
            ]
        );
        assert_eq!(obs.started, 0);
    }

    #[test]
    fn run_loop_exits_when_sender_drops() {
        let (tx, rx) = mpsc::channel::<Input>();
        drop(tx);
        let mut obs = FakeObserver::granted();
        let mut out: Vec<u8> = Vec::new();
        run(&mut obs, &rx, &mut out, &|| at(0)).unwrap();
        assert_eq!(String::from_utf8(out).unwrap().lines().count(), 1);
    }
}
