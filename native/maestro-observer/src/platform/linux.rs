//! Linux adapter: AT-SPI2 over D-Bus through `atspi` / `zbus` (pure Rust, no
//! libdbus).
//!
//! AT-SPI is asynchronous, so a worker thread owns the accessibility-bus
//! connection and translates events into [`Signal`]s on a channel. Snapshot
//! queries are sent to the worker and answered on a one-shot channel.
//!
//! The session bus property `org.a11y.Status.IsEnabled` is what the GNOME and
//! KDE accessibility toggles flip. Toolkits read it when an app starts, so
//! apps launched while it was off expose little or nothing until restarted.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::pin::pin;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use atspi::connection::{read_session_accessibility, set_session_accessibility};
use atspi::events::focus::FocusEvent;
use atspi::events::object::{StateChangedEvent, TextChangedEvent, TextSelectionChangedEvent};
use atspi::events::window::ActivateEvent;
use atspi::proxy::accessible::{AccessibleProxy, ObjectRefExt};
use atspi::proxy::document::DocumentProxy;
use atspi::proxy::text::TextProxy;
use atspi::{
    AccessibilityConnection, Event, FocusEvents, ObjectEvents, ObjectRefOwned, Role, State,
    WindowEvents,
};
use futures_lite::future::{self, block_on};
use futures_lite::StreamExt;

use super::{clamp_os_text, MAX_OS_TEXT_BYTES};
use crate::engine::{
    Access, AppFilter, ElementInfo, Observer, Signal, Snapshot, SnapshotLimits, WindowInfo,
};
use crate::protocol::{
    AccessibilityBus, ElementRole, ObservedApp, Permission, Platform, SessionType,
};

const RECONNECT_DELAY: Duration = Duration::from_secs(5);
const WORKER_TICK: Duration = Duration::from_millis(100);
const SNAPSHOT_REPLY_GRACE: Duration = Duration::from_millis(300);
const MAX_TRACKED_CHARS: i32 = 200_000;
const MAX_SNAPSHOT_NODE_CHARS: i32 = 16_384;
const URL_SEARCH_NODES: usize = 300;
const URL_SEARCH_DEPTH: usize = 25;
const URL_SEARCH_BUDGET: Duration = Duration::from_millis(80);

/// AT-SPI embeds child objects (links, images) in a parent's text as U+FFFC.
const OBJECT_REPLACEMENT: char = '\u{FFFC}';

type AnyResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

struct Shared {
    filter: AppFilter,
    running: bool,
    refresh: bool,
}

struct SnapshotRequest {
    limits: SnapshotLimits,
    reply: Sender<Snapshot>,
}

pub struct LinuxObserver {
    shared: Arc<Mutex<Shared>>,
    signals: Option<Receiver<Signal>>,
    requests: Option<Sender<SnapshotRequest>>,
    session: SessionType,
}

impl LinuxObserver {
    pub fn new() -> Self {
        LinuxObserver {
            shared: Arc::new(Mutex::new(Shared {
                filter: AppFilter::default(),
                running: false,
                refresh: false,
            })),
            signals: None,
            requests: None,
            session: session_type(),
        }
    }

    fn ensure_worker(&mut self) {
        if self.signals.is_some() {
            return;
        }
        let (signal_tx, signal_rx) = mpsc::channel();
        let (request_tx, request_rx) = mpsc::channel();
        let shared = Arc::clone(&self.shared);
        let spawned = thread::Builder::new()
            .name("atspi".into())
            .spawn(move || block_on(worker(shared, signal_tx, request_rx)));
        if spawned.is_ok() {
            self.signals = Some(signal_rx);
            self.requests = Some(request_tx);
        }
    }
}

fn session_type() -> SessionType {
    match std::env::var("XDG_SESSION_TYPE").as_deref() {
        Ok("wayland") => return SessionType::Wayland,
        Ok("x11") => return SessionType::X11,
        _ => {}
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        SessionType::Wayland
    } else if std::env::var_os("DISPLAY").is_some() {
        SessionType::X11
    } else {
        SessionType::Unknown
    }
}

impl Observer for LinuxObserver {
    fn platform(&self) -> Platform {
        Platform::Linux
    }

    fn access(&mut self) -> Access {
        let (bus, detail) = match block_on(read_session_accessibility()) {
            Ok(true) => (AccessibilityBus::Enabled, None),
            Ok(false) => (
                AccessibilityBus::Disabled,
                Some(
                    "The accessibility bus is off (org.a11y.Status.IsEnabled = false). \
                     Turn it on, then restart the apps to record."
                        .to_string(),
                ),
            ),
            Err(e) => (
                AccessibilityBus::Unavailable,
                Some(format!("Cannot reach the accessibility bus: {e}")),
            ),
        };
        Access {
            permission: Permission::NotRequired,
            can_observe: bus == AccessibilityBus::Enabled,
            accessibility_bus: Some(bus),
            session: Some(self.session),
            detail,
        }
    }

    fn request_access(&mut self) -> Result<(), String> {
        block_on(set_session_accessibility(true))
            .map_err(|e| format!("cannot enable the accessibility bus: {e}"))
    }

    fn start(&mut self, filter: &AppFilter) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.filter = filter.clone();
            shared.running = true;
            shared.refresh = true;
        }
        self.ensure_worker();
    }

    fn stop(&mut self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.running = false;
            shared.refresh = false;
        }
    }

    fn poll(&mut self, timeout: Duration) -> Vec<Signal> {
        let mut out = Vec::new();
        let Some(rx) = &self.signals else {
            thread::sleep(timeout);
            return out;
        };
        match rx.recv_timeout(timeout) {
            Ok(signal) => out.push(signal),
            Err(RecvTimeoutError::Timeout) => return out,
            Err(RecvTimeoutError::Disconnected) => {
                self.signals = None;
                self.requests = None;
                out.push(Signal::Error("AT-SPI worker stopped".into()));
                return out;
            }
        }
        out.extend(rx.try_iter());
        out
    }

    fn snapshot_focused_window_text(&mut self, limits: &SnapshotLimits) -> Snapshot {
        let Some(requests) = self.requests.as_ref() else {
            return Snapshot::Unavailable;
        };
        let (reply_tx, reply_rx) = mpsc::channel();
        if requests
            .send(SnapshotRequest {
                limits: *limits,
                reply: reply_tx,
            })
            .is_err()
        {
            return Snapshot::Unavailable;
        }
        reply_rx
            .recv_timeout(limits.budget + SNAPSHOT_REPLY_GRACE)
            .unwrap_or(Snapshot::Unavailable)
    }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Session {
    /// Unique bus name of the frontmost app's connection.
    app_bus: Option<String>,
    app: Option<ObservedApp>,
    app_blocked: bool,
    frame: Option<ObjectRefOwned>,
    /// The window last reported to the engine.
    window: Option<WindowInfo>,
    focused: Option<ObjectRefOwned>,
    apps: HashMap<String, ObservedApp>,
}

impl Session {
    fn forget_context(&mut self) {
        self.app_bus = None;
        self.app = None;
        self.app_blocked = false;
        self.frame = None;
        self.window = None;
        self.focused = None;
    }
}

struct Worker {
    conn: zbus::Connection,
    signals: Sender<Signal>,
    session: Session,
    filter: AppFilter,
    /// The engine side hung up; the worker should exit.
    closed: bool,
}

async fn worker(
    shared: Arc<Mutex<Shared>>,
    signals: Sender<Signal>,
    requests: Receiver<SnapshotRequest>,
) {
    loop {
        match AccessibilityConnection::new().await {
            Ok(a11y) => match run_session(&a11y, &shared, &signals, &requests).await {
                // Ok means the engine hung up.
                Ok(()) => return,
                Err(e) => {
                    if signals
                        .send(Signal::Error(format!("AT-SPI session ended: {e}")))
                        .is_err()
                    {
                        return;
                    }
                }
            },
            Err(e) => {
                if signals
                    .send(Signal::Error(format!(
                        "cannot connect to the accessibility bus: {e}"
                    )))
                    .is_err()
                {
                    return;
                }
            }
        }
        // Retry later; answer snapshot queries meanwhile so callers never wait
        // on a dead worker.
        let until = Instant::now() + RECONNECT_DELAY;
        while Instant::now() < until {
            for request in requests.try_iter() {
                let _ = request.reply.send(Snapshot::Unavailable);
            }
            async_io::Timer::after(WORKER_TICK).await;
        }
    }
}

async fn run_session(
    a11y: &AccessibilityConnection,
    shared: &Arc<Mutex<Shared>>,
    signals: &Sender<Signal>,
    requests: &Receiver<SnapshotRequest>,
) -> AnyResult<()> {
    a11y.register_event::<ActivateEvent>().await?;
    a11y.register_event::<StateChangedEvent>().await?;
    a11y.register_event::<FocusEvent>().await?;
    a11y.register_event::<TextChangedEvent>().await?;
    a11y.register_event::<TextSelectionChangedEvent>().await?;
    let mut events = pin!(a11y.event_stream());
    let mut worker = Worker {
        conn: a11y.connection().clone(),
        signals: signals.clone(),
        session: Session::default(),
        filter: AppFilter::default(),
        closed: false,
    };
    loop {
        let (running, refresh, filter) = match shared.lock() {
            Ok(mut s) => (s.running, std::mem::take(&mut s.refresh), s.filter.clone()),
            Err(_) => return Err("shared state poisoned".into()),
        };
        worker.filter = filter;
        if !running {
            worker.session.forget_context();
        } else if refresh {
            worker.session.forget_context();
            worker.announce_active().await;
        }
        for request in requests.try_iter() {
            let result = if running {
                worker.snapshot(&request.limits).await
            } else {
                Snapshot::Unavailable
            };
            let _ = request.reply.send(result);
        }
        let next = future::or(async { Some(events.next().await) }, async {
            async_io::Timer::after(WORKER_TICK).await;
            None
        })
        .await;
        match next {
            Some(None) => return Err("event stream closed".into()),
            Some(Some(Ok(event))) if running => worker.handle(event).await,
            // Timer tick, an event while stopped, or a signal that does not
            // parse as a known event.
            _ => {}
        }
        if worker.closed {
            return Ok(());
        }
    }
}

fn object_key(obj: &ObjectRefOwned) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    obj.hash(&mut hasher);
    hasher.finish()
}

fn bus_name(obj: &ObjectRefOwned) -> Option<String> {
    obj.name_as_str().map(str::to_string)
}

impl Worker {
    fn send(&mut self, signal: Signal) {
        if self.signals.send(signal).is_err() {
            self.closed = true;
        }
    }

    /// Content of the current window may be read.
    fn content_allowed(&self) -> bool {
        match &self.session.app {
            Some(app) => {
                !self.session.app_blocked
                    && !self
                        .filter
                        .content_blocked(app, self.session.window.as_ref())
            }
            None => false,
        }
    }

    async fn proxy<'a>(&'a self, obj: &'a ObjectRefOwned) -> Option<AccessibleProxy<'a>> {
        if obj.is_null() {
            return None;
        }
        obj.as_accessible_proxy(&self.conn).await.ok()
    }

    async fn text_proxy(&self, obj: &ObjectRefOwned) -> Option<TextProxy<'static>> {
        let name = obj.name_as_str()?.to_string();
        let path = obj.path_as_str().to_string();
        TextProxy::builder(&self.conn)
            .destination(name)
            .ok()?
            .path(path)
            .ok()?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .ok()
    }

    async fn full_text(&self, obj: &ObjectRefOwned, max_chars: i32) -> Option<String> {
        let text = self.text_proxy(obj).await?;
        let count = text.character_count().await.ok()?;
        if count > max_chars {
            return None;
        }
        let s = text.get_text(0, count).await.ok()?;
        Some(clamp_os_text(
            s.replace(OBJECT_REPLACEMENT, ""),
            MAX_OS_TEXT_BYTES,
        ))
    }

    /// App identity for a bus connection, cached per unique name. Reads only
    /// the pid (from the bus) and the application root's name, which is what
    /// the block list is checked against.
    async fn app_for(&mut self, obj: &ObjectRefOwned) -> Option<ObservedApp> {
        let bus = bus_name(obj)?;
        if let Some(app) = self.session.apps.get(&bus) {
            return Some(app.clone());
        }
        let pid = match zbus::fdo::DBusProxy::new(&self.conn).await {
            Ok(dbus) => match zbus::names::BusName::try_from(bus.as_str()) {
                Ok(name) => dbus.get_connection_unix_process_id(name).await.unwrap_or(0),
                Err(_) => 0,
            },
            Err(_) => 0,
        };
        let mut app_name = String::new();
        if let Some(root) = self.app_root(obj).await {
            if let Some(app_proxy) = self.proxy(&root).await {
                app_name = app_proxy.name().await.unwrap_or_default();
            }
        }
        let id = app_identity(pid, &app_name);
        let app = ObservedApp {
            name: if app_name.is_empty() {
                id.clone()
            } else {
                app_name
            },
            id,
            pid,
            aumid: None,
        };
        if self.session.apps.len() > 512 {
            self.session.apps.clear();
        }
        self.session.apps.insert(bus, app.clone());
        Some(app)
    }

    async fn app_root(&self, obj: &ObjectRefOwned) -> Option<ObjectRefOwned> {
        let proxy = self.proxy(obj).await?;
        proxy.get_application().await.ok()
    }

    /// Switches the session to the app owning `obj`, emitting
    /// `AppActivated`. Without a `frame`, the app's active frame is resolved
    /// first so private-window and domain suppression apply before anything
    /// content-bearing is emitted. Returns false when the app is blocked.
    async fn enter_app(&mut self, obj: &ObjectRefOwned, frame: Option<&ObjectRefOwned>) -> bool {
        let Some(app) = self.app_for(obj).await else {
            return false;
        };
        self.session.forget_context();
        self.session.app_bus = bus_name(obj);
        self.session.app = Some(app.clone());
        if self.filter.is_blocked(&app) {
            self.session.app_blocked = true;
            self.send(Signal::AppActivated { app, window: None });
            return false;
        }
        let frame = match frame {
            Some(frame) => Some(frame.clone()),
            None => match self.app_root(obj).await {
                Some(root) => self.active_frame_in(&root).await,
                None => None,
            },
        };
        let window = match frame {
            Some(frame) => {
                self.session.frame = Some(frame.clone());
                Some(self.read_frame(&frame).await)
            }
            None => None,
        };
        self.send(Signal::AppActivated { app, window });
        true
    }

    /// Reads the frame's title and URL and records it as the reported window.
    async fn read_frame(&mut self, frame: &ObjectRefOwned) -> WindowInfo {
        let title = match self.proxy(frame).await {
            Some(p) => p.name().await.ok().filter(|t| !t.trim().is_empty()),
            None => None,
        };
        let url = self.find_document_url(frame).await;
        let window = WindowInfo {
            key: object_key(frame),
            title,
            url,
        };
        self.session.window = Some(window.clone());
        window
    }

    /// Re-reads the current frame (title and URL); returns it when it differs
    /// from the last report.
    async fn refresh_window(&mut self) -> Option<WindowInfo> {
        let frame = self.session.frame.clone()?;
        let previous = self.session.window.clone();
        let window = self.read_frame(&frame).await;
        (previous.as_ref() != Some(&window)).then_some(window)
    }

    /// Firefox exposes `DocURL` on its DocumentWeb; Chromium uses `URI`.
    /// `None` when the budget runs out first; for browsers the engine then
    /// treats the content as blocked while domain rules exist.
    async fn find_document_url(&self, frame: &ObjectRefOwned) -> Option<String> {
        let deadline = Instant::now() + URL_SEARCH_BUDGET;
        let mut queue = VecDeque::from([(frame.clone(), 0usize)]);
        let mut visited = 0;
        while let Some((obj, depth)) = queue.pop_front() {
            visited += 1;
            if visited > URL_SEARCH_NODES || Instant::now() >= deadline {
                break;
            }
            let Some(proxy) = self.proxy(&obj).await else {
                continue;
            };
            if proxy.get_role().await.ok() == Some(Role::DocumentWeb) {
                if let Some(url) = self.document_url(&obj).await {
                    return Some(url);
                }
            }
            if depth < URL_SEARCH_DEPTH {
                if let Ok(children) = proxy.get_children().await {
                    queue.extend(children.into_iter().map(|c| (c, depth + 1)));
                }
            }
        }
        None
    }

    async fn document_url(&self, obj: &ObjectRefOwned) -> Option<String> {
        let doc = DocumentProxy::builder(&self.conn)
            .destination(obj.name_as_str()?.to_string())
            .ok()?
            .path(obj.path_as_str().to_string())
            .ok()?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .ok()?;
        let attrs = doc.get_attributes().await.ok()?;
        ["DocURL", "URI", "url"]
            .iter()
            .find_map(|k| attrs.get(*k).cloned())
            .filter(|u| !u.is_empty())
    }

    /// Reads role and label, and, when `read_value` is set and the element is
    /// an editable, non-password text, its value.
    async fn read_element(&self, obj: &ObjectRefOwned, read_value: bool) -> Option<ElementInfo> {
        let proxy = self.proxy(obj).await?;
        let role = proxy.get_role().await.ok()?;
        let editable = proxy
            .get_state()
            .await
            .map(|s| s.contains(State::Editable))
            .unwrap_or(false);
        let secure = role == Role::PasswordText;
        let mut mapped = match role {
            Role::PasswordText => ElementRole::TextField,
            Role::Entry if editable => ElementRole::TextField,
            Role::Text | Role::Paragraph if editable => ElementRole::TextArea,
            Role::ComboBox => ElementRole::ComboBox,
            Role::DocumentWeb => ElementRole::WebArea,
            Role::DocumentText | Role::DocumentFrame | Role::DocumentEmail => ElementRole::Document,
            _ => ElementRole::Other,
        };
        let name = proxy.name().await.unwrap_or_default();
        let label = if name.trim().is_empty() {
            proxy
                .description()
                .await
                .ok()
                .filter(|d| !d.trim().is_empty())
        } else {
            Some(name)
        };
        let mut value = None;
        if read_value && mapped.is_text_entry() && !secure {
            value = self.full_text(obj, MAX_TRACKED_CHARS).await;
        }
        if mapped.is_text_entry() && value.is_none() && !secure {
            // Not read (unreadable, huge, or not wanted): untracked, so it
            // cannot look "cleared".
            mapped = ElementRole::Other;
        }
        Some(ElementInfo {
            key: object_key(obj),
            role: mapped,
            label,
            value,
            secure,
        })
    }

    /// On start / resume: find the active frame and announce its app.
    async fn announce_active(&mut self) {
        let Some(frame) = self.find_active_frame().await else {
            return;
        };
        if self.enter_app(&frame, Some(&frame)).await {
            self.send(Signal::FocusChanged { element: None });
        }
    }

    /// The active frame among all apps. Each app is checked against the block
    /// list (by name and pid) before its children or states are read.
    async fn find_active_frame(&mut self) -> Option<ObjectRefOwned> {
        let root = AccessibleProxy::builder(&self.conn)
            .destination("org.a11y.atspi.Registry")
            .ok()?
            .path("/org/a11y/atspi/accessible/root")
            .ok()?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .ok()?;
        let apps = root.get_children().await.ok()?;
        for app_ref in apps {
            match self.app_for(&app_ref).await {
                Some(app) if !self.filter.is_blocked(&app) => {}
                _ => continue,
            }
            if let Some(frame) = self.active_frame_in(&app_ref).await {
                return Some(frame);
            }
        }
        None
    }

    /// The child frame of an application root that has the Active state.
    async fn active_frame_in(&self, app_root: &ObjectRefOwned) -> Option<ObjectRefOwned> {
        let app_proxy = self.proxy(app_root).await?;
        for frame in app_proxy.get_children().await.ok()? {
            let Some(frame_proxy) = self.proxy(&frame).await else {
                continue;
            };
            if let Ok(state) = frame_proxy.get_state().await {
                if state.contains(State::Active) {
                    return Some(frame);
                }
            }
        }
        None
    }

    async fn on_activate(&mut self, frame: ObjectRefOwned) {
        let same_app = self.session.app_bus.is_some() && self.session.app_bus == bus_name(&frame);
        if !same_app {
            self.enter_app(&frame, Some(&frame)).await;
            return;
        }
        if self.session.app_blocked {
            return;
        }
        if self.session.frame.as_ref() == Some(&frame) {
            return;
        }
        self.session.frame = Some(frame.clone());
        self.session.focused = None;
        let window = self.read_frame(&frame).await;
        self.send(Signal::WindowChanged { window });
    }

    async fn on_focus(&mut self, obj: ObjectRefOwned) {
        if self.session.app_bus != bus_name(&obj) && !self.enter_app(&obj, None).await {
            return;
        }
        if self.session.app_blocked {
            return;
        }
        // Navigation and tab switches change the URL or title without a
        // window event, so both are re-read on every focus move.
        if let Some(window) = self.refresh_window().await {
            self.send(Signal::WindowChanged { window });
        }
        let element = self.read_element(&obj, self.content_allowed()).await;
        self.session.focused = Some(obj);
        self.send(Signal::FocusChanged { element });
    }

    async fn on_text_changed(&mut self, obj: ObjectRefOwned) {
        if !self.content_allowed() || self.session.focused.as_ref() != Some(&obj) {
            return;
        }
        if let Some(element) = self.read_element(&obj, true).await {
            self.send(Signal::ValueChanged { element });
        }
    }

    async fn on_selection_changed(&mut self, obj: ObjectRefOwned) {
        if !self.content_allowed() || self.session.app_bus != bus_name(&obj) {
            return;
        }
        // Role and label only: the full value is not needed for a selection.
        let Some(element) = self.read_element(&obj, false).await else {
            return;
        };
        if element.secure {
            return;
        }
        let Some(text) = self.text_proxy(&obj).await else {
            return;
        };
        let selected = match text.get_n_selections().await {
            Ok(n) if n > 0 => match text.get_selection(0).await {
                Ok((start, end)) if end > start => {
                    text.get_text(start, end).await.unwrap_or_default()
                }
                _ => String::new(),
            },
            _ => String::new(),
        };
        self.send(Signal::SelectionChanged {
            element: Some(element),
            text: clamp_os_text(selected.replace(OBJECT_REPLACEMENT, ""), MAX_OS_TEXT_BYTES),
        });
    }

    async fn handle(&mut self, event: Event) {
        match event {
            Event::Window(WindowEvents::Activate(e)) => self.on_activate(e.item).await,
            Event::Object(ObjectEvents::StateChanged(e)) if e.enabled => match e.state {
                State::Focused => self.on_focus(e.item).await,
                // Some toolkits send only state-changed:active for frames.
                State::Active => {
                    let is_frame = match self.proxy(&e.item).await {
                        Some(p) => matches!(
                            p.get_role().await,
                            Ok(Role::Frame | Role::Window | Role::Dialog)
                        ),
                        None => false,
                    };
                    if is_frame {
                        self.on_activate(e.item).await;
                    }
                }
                _ => {}
            },
            Event::Focus(FocusEvents::Focus(e)) => self.on_focus(e.item).await,
            Event::Object(ObjectEvents::TextChanged(e)) => self.on_text_changed(e.item).await,
            Event::Object(ObjectEvents::TextSelectionChanged(e)) => {
                self.on_selection_changed(e.item).await
            }
            _ => {}
        }
    }

    async fn snapshot(&mut self, limits: &SnapshotLimits) -> Snapshot {
        let Some(app) = self.session.app.clone() else {
            return Snapshot::Unavailable;
        };
        if self.session.app_blocked || self.filter.is_blocked(&app) {
            return Snapshot::Unavailable;
        }
        let Some(frame) = self.session.frame.clone() else {
            return Snapshot::Unavailable;
        };
        // The URL may have changed without a title change; never walk a
        // window the engine has not vetted.
        if let Some(window) = self.refresh_window().await {
            return Snapshot::WindowChanged(window);
        }
        if !self.content_allowed() {
            return Snapshot::Unavailable;
        }
        let deadline = Instant::now() + limits.budget;
        let mut lines = Vec::new();
        let mut stack = vec![(frame, 0usize)];
        let mut visited = 0usize;
        while let Some((obj, depth)) = stack.pop() {
            if visited >= limits.max_nodes || Instant::now() >= deadline {
                break;
            }
            visited += 1;
            let Some(proxy) = self.proxy(&obj).await else {
                continue;
            };
            let Ok(role) = proxy.get_role().await else {
                continue;
            };
            if role == Role::PasswordText {
                continue;
            }
            if matches!(
                role,
                Role::Label
                    | Role::Static
                    | Role::Paragraph
                    | Role::Heading
                    | Role::Text
                    | Role::Entry
                    | Role::Link
                    | Role::Caption
                    | Role::ListItem
                    | Role::TableCell
            ) {
                let text = match self.full_text(&obj, MAX_SNAPSHOT_NODE_CHARS).await {
                    Some(t) if !t.trim().is_empty() => Some(t),
                    _ => proxy.name().await.ok(),
                };
                if let Some(text) = text {
                    lines.push(text);
                }
            }
            if depth < limits.max_depth {
                if let Ok(children) = proxy.get_children().await {
                    for child in children.into_iter().rev() {
                        stack.push((child, depth + 1));
                    }
                }
            }
        }
        Snapshot::Lines(lines)
    }
}

/// `.desktop` id when the process carries one, else the lowercase executable
/// name, else the accessible application name.
fn app_identity(pid: u32, accessible_name: &str) -> String {
    if pid > 0 {
        if let Ok(environ) = fs::read(format!("/proc/{pid}/environ")) {
            let vars: HashMap<&[u8], &[u8]> = environ
                .split(|b| *b == 0)
                .filter_map(|kv| {
                    let eq = kv.iter().position(|b| *b == b'=')?;
                    Some((&kv[..eq], &kv[eq + 1..]))
                })
                .collect();
            if let Some(id) = vars.get(b"FLATPAK_ID".as_slice()) {
                let id = String::from_utf8_lossy(id).to_string();
                if !id.is_empty() {
                    return id;
                }
            }
            // GIO_LAUNCHED_DESKTOP_FILE is inherited by child processes; only
            // trust it for the process GIO actually launched.
            let launched_pid = vars
                .get(b"GIO_LAUNCHED_DESKTOP_FILE_PID".as_slice())
                .map(|v| String::from_utf8_lossy(v).to_string());
            if launched_pid.as_deref() == Some(pid.to_string().as_str()) {
                if let Some(path) = vars.get(b"GIO_LAUNCHED_DESKTOP_FILE".as_slice()) {
                    if let Some(id) = desktop_id_from_path(&String::from_utf8_lossy(path)) {
                        return id;
                    }
                }
            }
        }
        if let Ok(exe) = fs::read_link(format!("/proc/{pid}/exe")) {
            if let Some(name) = exe.file_name().and_then(|n| n.to_str()) {
                return name.trim_end_matches(" (deleted)").to_lowercase();
            }
        }
    }
    let name = accessible_name.trim().to_lowercase();
    if name.is_empty() {
        format!("pid-{pid}")
    } else {
        name
    }
}

fn desktop_id_from_path(path: &str) -> Option<String> {
    let file = path.rsplit('/').next()?;
    let id = file.strip_suffix(".desktop").unwrap_or(file);
    (!id.is_empty()).then(|| id.to_string())
}
