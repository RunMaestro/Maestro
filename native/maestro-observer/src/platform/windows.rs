//! Windows adapter: UI Automation, polled every 250 ms.
//!
//! Polling the foreground window and the focused element is deliberate: UIA
//! event handlers fire on arbitrary MTA threads and re-enter the provider,
//! which is a common source of hangs; reading one focused element four times a
//! second is cheap and keeps all COM calls on this thread. No permission is
//! needed. Windows of elevated processes cannot be read from a non-elevated
//! helper (UIPI), so for those only app and window title are reported.

use std::collections::{HashSet, VecDeque};
use std::thread;
use std::time::{Duration, Instant};

use ::windows::core::PWSTR;
use ::windows::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE, HWND};
use ::windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use ::windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
};
use uiautomation::patterns::{UITextPattern, UIValuePattern};
use uiautomation::types::{ControlType, Handle};
use uiautomation::{UIAutomation, UIElement};

use super::{clamp_os_text, MAX_OS_TEXT_BYTES};
use crate::engine::{Access, AppFilter, ElementInfo, Observer, Signal, SnapshotLimits};
use crate::protocol::{ElementRole, ObservedApp, ObservedWindow, Permission, Platform};

const TICK: Duration = Duration::from_millis(250);
const E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;
const MAX_TRACKED_CHARS: i32 = 200_000;
const URL_SEARCH_NODES: usize = 300;
const URL_SEARCH_DEPTH: usize = 25;
const URL_SEARCH_BUDGET: Duration = Duration::from_millis(60);

pub struct WindowsObserver {
    uia: Option<UIAutomation>,
    init_error: Option<String>,
    filter: AppFilter,
    running: bool,
    refresh: bool,
    next_tick: Instant,
    hwnd: isize,
    pid: u32,
    app_id: String,
    blocked: bool,
    title: Option<String>,
    focus_key: Option<u64>,
    focus_value: Option<String>,
    last_selection: String,
    uipi_pids: HashSet<u32>,
}

impl WindowsObserver {
    pub fn new() -> Self {
        let (uia, init_error) = match UIAutomation::new() {
            Ok(uia) => (Some(uia), None),
            Err(e) => (None, Some(format!("UI Automation is unavailable: {e}"))),
        };
        WindowsObserver {
            uia,
            init_error,
            filter: AppFilter::default(),
            running: false,
            refresh: false,
            next_tick: Instant::now(),
            hwnd: 0,
            pid: 0,
            app_id: String::new(),
            blocked: false,
            title: None,
            focus_key: None,
            focus_value: None,
            last_selection: String::new(),
            uipi_pids: HashSet::new(),
        }
    }

    fn reset_app(&mut self) {
        self.hwnd = 0;
        self.pid = 0;
        self.app_id.clear();
        self.blocked = false;
        self.title = None;
        self.focus_key = None;
        self.focus_value = None;
        self.last_selection.clear();
    }

    fn tick(&mut self, out: &mut Vec<Signal>) {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_invalid() {
            return;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 {
            return;
        }
        let force = std::mem::take(&mut self.refresh);
        if force || pid != self.pid {
            self.reset_app();
            self.pid = pid;
            self.hwnd = hwnd.0 as isize;
            let app = process_app(pid);
            self.app_id = app.id.clone();
            if self.filter.is_blocked(&app.id, pid) {
                // Nothing is read from a blocked app, not even its title.
                self.blocked = true;
                out.push(Signal::AppActivated { app, window: None });
                return;
            }
            let window = self.read_window(hwnd);
            out.push(Signal::AppActivated {
                app,
                window: Some(window),
            });
        } else if self.blocked {
            return;
        } else {
            let title = window_title(hwnd);
            if hwnd.0 as isize != self.hwnd || title != self.title {
                self.hwnd = hwnd.0 as isize;
                let window = self.read_window(hwnd);
                out.push(Signal::WindowChanged { window });
            }
        }
        self.poll_focus(out);
    }

    fn read_window(&mut self, hwnd: HWND) -> ObservedWindow {
        let title = window_title(hwnd);
        self.title = title.clone();
        let url = if self.uipi_pids.contains(&self.pid) {
            None
        } else {
            self.find_document_url(hwnd)
        };
        ObservedWindow { title, url }
    }

    /// Chromium and Firefox expose the page URL as the ValuePattern value of
    /// the top Document control.
    fn find_document_url(&self, hwnd: HWND) -> Option<String> {
        let uia = self.uia.as_ref()?;
        let root = uia.element_from_handle(Handle::from(hwnd)).ok()?;
        let walker = uia.get_control_view_walker().ok()?;
        let deadline = Instant::now() + URL_SEARCH_BUDGET;
        let mut queue = VecDeque::from([(root, 0usize)]);
        let mut visited = 0;
        while let Some((el, depth)) = queue.pop_front() {
            visited += 1;
            if visited > URL_SEARCH_NODES || Instant::now() >= deadline {
                break;
            }
            if el.get_control_type().ok() == Some(ControlType::Document) {
                if let Ok(value) = el
                    .get_pattern::<UIValuePattern>()
                    .and_then(|p| p.get_value())
                {
                    let lower = value.to_ascii_lowercase();
                    if lower.starts_with("http://")
                        || lower.starts_with("https://")
                        || lower.starts_with("file:")
                    {
                        return Some(value);
                    }
                }
            }
            if depth < URL_SEARCH_DEPTH {
                if let Some(children) = walker.get_children(&el) {
                    queue.extend(children.into_iter().map(|c| (c, depth + 1)));
                }
            }
        }
        None
    }

    fn poll_focus(&mut self, out: &mut Vec<Signal>) {
        if self.uipi_pids.contains(&self.pid) {
            return;
        }
        let Some(uia) = self.uia.as_ref() else {
            return;
        };
        let el = match uia.get_focused_element() {
            Ok(el) => el,
            Err(e) => {
                if e.code() == E_ACCESSDENIED {
                    self.mark_uipi(out);
                }
                return;
            }
        };
        // Focus can sit in another process (a tooltip, the shell) for a tick.
        match el.get_process_id() {
            Ok(pid) if pid == self.pid => {}
            Ok(_) => return,
            Err(e) => {
                if e.code() == E_ACCESSDENIED {
                    self.mark_uipi(out);
                }
                return;
            }
        }
        let info = read_element(&el);
        if Some(info.key) != self.focus_key {
            self.focus_key = Some(info.key);
            self.focus_value = info.value.clone();
            self.last_selection.clear();
            out.push(Signal::FocusChanged {
                element: Some(info.clone()),
            });
        } else if info.role.is_text_entry() && !info.secure && info.value != self.focus_value {
            self.focus_value = info.value.clone();
            out.push(Signal::ValueChanged {
                element: info.clone(),
            });
        }
        if info.secure {
            return;
        }
        if let Some(selection) = selected_text(&el) {
            if selection != self.last_selection {
                self.last_selection = selection.clone();
                out.push(Signal::SelectionChanged {
                    element: Some(info),
                    text: selection,
                });
            }
        }
    }

    fn mark_uipi(&mut self, out: &mut Vec<Signal>) {
        if self.uipi_pids.insert(self.pid) {
            out.push(Signal::Error(format!(
                "{} runs elevated; its contents cannot be read (recording app and window title only)",
                self.app_id
            )));
        }
    }
}

fn window_title(hwnd: HWND) -> Option<String> {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if n <= 0 {
        return None;
    }
    let title = String::from_utf16_lossy(&buf[..n as usize]);
    (!title.trim().is_empty()).then_some(title)
}

/// App identity from the process: lowercase exe file name, exe stem as the
/// display name, and the AppUserModelID for packaged apps.
fn process_app(pid: u32) -> ObservedApp {
    let mut app = ObservedApp {
        id: format!("pid-{pid}"),
        name: format!("pid-{pid}"),
        pid,
        aumid: None,
    };
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return app;
    };
    if let Some(path) = image_path(handle) {
        let file = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        let stem = file
            .rsplit_once('.')
            .map_or(file.as_str(), |(stem, _)| stem)
            .to_string();
        app.id = file.to_lowercase();
        app.name = stem;
    }
    app.aumid = aumid(handle);
    unsafe {
        let _ = CloseHandle(handle);
    }
    app
}

fn image_path(handle: HANDLE) -> Option<String> {
    let mut buf = vec![0u16; 32_768];
    let mut size = buf.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
    }
    .ok()?;
    Some(String::from_utf16_lossy(&buf[..size as usize]))
}

fn aumid(handle: HANDLE) -> Option<String> {
    let mut len = 0u32;
    let first = unsafe { GetApplicationUserModelId(handle, &mut len, None) };
    if first != ERROR_INSUFFICIENT_BUFFER || len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    let second =
        unsafe { GetApplicationUserModelId(handle, &mut len, Some(PWSTR(buf.as_mut_ptr()))) };
    if second.0 != 0 {
        return None;
    }
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end])).filter(|s| !s.is_empty())
}

fn element_key(el: &UIElement) -> u64 {
    let ids = el.get_runtime_id().unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for id in ids {
        for b in id.to_le_bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash
}

fn read_element(el: &UIElement) -> ElementInfo {
    let control = el.get_control_type().unwrap_or(ControlType::Custom);
    let secure = el.is_password().unwrap_or(false);
    let mut role = match control {
        ControlType::Edit => ElementRole::TextField,
        ControlType::ComboBox => ElementRole::ComboBox,
        ControlType::Document => ElementRole::Document,
        _ => ElementRole::Other,
    };
    let label = el.get_name().ok().filter(|n| !n.trim().is_empty());
    let mut value = None;
    if role.is_text_entry() && !secure {
        value = field_value(el);
        if value.is_none() {
            // No readable value: not trackable, so it cannot look "cleared".
            role = ElementRole::Other;
        }
    }
    ElementInfo {
        key: element_key(el),
        role,
        label,
        value,
        secure,
    }
}

/// ValuePattern first (plain edits), then TextPattern (rich edits).
fn field_value(el: &UIElement) -> Option<String> {
    if let Ok(value) = el
        .get_pattern::<UIValuePattern>()
        .and_then(|p| p.get_value())
    {
        return Some(clamp_os_text(value, MAX_OS_TEXT_BYTES));
    }
    let text = el
        .get_pattern::<UITextPattern>()
        .and_then(|p| p.get_document_range())
        .and_then(|r| r.get_text(MAX_TRACKED_CHARS))
        .ok()?;
    Some(clamp_os_text(text, MAX_OS_TEXT_BYTES))
}

fn selected_text(el: &UIElement) -> Option<String> {
    let pattern = el.get_pattern::<UITextPattern>().ok()?;
    let ranges = pattern.get_selection().ok()?;
    let mut parts = Vec::new();
    for range in ranges {
        if let Ok(text) = range.get_text(MAX_TRACKED_CHARS) {
            parts.push(text);
        }
    }
    Some(clamp_os_text(parts.join("\n"), MAX_OS_TEXT_BYTES))
}

impl Observer for WindowsObserver {
    fn platform(&self) -> Platform {
        Platform::Windows
    }

    fn access(&mut self) -> Access {
        Access {
            permission: Permission::NotRequired,
            can_observe: self.uia.is_some(),
            accessibility_bus: None,
            session: None,
            detail: self.init_error.clone(),
        }
    }

    fn request_access(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn start(&mut self, filter: &AppFilter) {
        self.filter = filter.clone();
        self.running = true;
        self.refresh = true;
        self.next_tick = Instant::now();
    }

    fn stop(&mut self) {
        self.running = false;
        self.refresh = false;
        self.reset_app();
    }

    fn poll(&mut self, timeout: Duration) -> Vec<Signal> {
        let mut out = Vec::new();
        let now = Instant::now();
        if !self.running || now < self.next_tick {
            let wait = self.next_tick.saturating_duration_since(now).min(timeout);
            thread::sleep(if self.running { wait } else { timeout });
            if !self.running || Instant::now() < self.next_tick {
                return out;
            }
        }
        self.next_tick = Instant::now() + TICK;
        self.tick(&mut out);
        out
    }

    fn snapshot_focused_window_text(&mut self, limits: &SnapshotLimits) -> Option<Vec<String>> {
        if !self.running || self.blocked || self.hwnd == 0 {
            return None;
        }
        if self.filter.is_blocked(&self.app_id, self.pid) || self.uipi_pids.contains(&self.pid) {
            return None;
        }
        let uia = self.uia.as_ref()?;
        let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
        let root = uia.element_from_handle(Handle::from(hwnd)).ok()?;
        let walker = uia.get_control_view_walker().ok()?;
        let deadline = Instant::now() + limits.budget;
        let mut lines = Vec::new();
        let mut stack = vec![(root, 0usize)];
        let mut visited = 0usize;
        while let Some((el, depth)) = stack.pop() {
            if visited >= limits.max_nodes || Instant::now() >= deadline {
                break;
            }
            visited += 1;
            let control = el.get_control_type().unwrap_or(ControlType::Custom);
            match control {
                ControlType::Edit => {
                    if el.is_password().unwrap_or(true) {
                        continue;
                    }
                    if let Ok(v) = el
                        .get_pattern::<UIValuePattern>()
                        .and_then(|p| p.get_value())
                    {
                        lines.push(v);
                    }
                }
                ControlType::Document => {
                    if let Ok(text) = el
                        .get_pattern::<UITextPattern>()
                        .and_then(|p| p.get_document_range())
                        .and_then(|r| r.get_text(limits.max_nodes as i32 * 64))
                    {
                        // The document range already holds its descendants'
                        // text; walking them too would duplicate it.
                        lines.push(text);
                        continue;
                    }
                }
                ControlType::Text
                | ControlType::Hyperlink
                | ControlType::ListItem
                | ControlType::DataItem
                | ControlType::TreeItem
                | ControlType::HeaderItem
                | ControlType::TabItem => {
                    if let Ok(name) = el.get_name() {
                        lines.push(name);
                    }
                }
                _ => {}
            }
            if depth < limits.max_depth {
                if let Some(children) = walker.get_children(&el) {
                    for child in children.into_iter().rev() {
                        stack.push((child, depth + 1));
                    }
                }
            }
        }
        Some(lines)
    }
}
