//! macOS adapter: Accessibility (AX) API plus NSWorkspace for the frontmost
//! app.
//!
//! Runs on the main thread. `poll` pumps the main CFRunLoop, which delivers
//! AXObserver callbacks and keeps `NSWorkspace.frontmostApplication` current
//! (that property is refreshed by notifications on the main run loop and goes
//! stale in a process that never runs it).

use std::cell::RefCell;
use std::collections::HashSet;
use std::ffi::c_void;
use std::ptr;
use std::thread;
use std::time::{Duration, Instant};

use accessibility_sys::{
    kAXErrorSuccess, kAXTrustedCheckOptionPrompt, AXError, AXIsProcessTrusted,
    AXIsProcessTrustedWithOptions, AXObserverAddNotification, AXObserverCreate,
    AXObserverGetRunLoopSource, AXObserverRef, AXUIElementCopyAttributeValue,
    AXUIElementCopyMultipleAttributeValues, AXUIElementCreateApplication, AXUIElementGetTypeID,
    AXUIElementRef, AXUIElementSetAttributeValue, AXUIElementSetMessagingTimeout,
};
use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::array::{
    CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef,
};
use core_foundation_sys::base::{CFEqual, CFGetTypeID, CFHash, CFRelease, CFRetain, CFTypeRef};
use core_foundation_sys::number::{
    CFBooleanGetTypeID, CFBooleanGetValue, CFBooleanRef, CFNumberGetTypeID, CFNumberRef,
};
use core_foundation_sys::runloop::{
    kCFRunLoopDefaultMode, kCFRunLoopRunFinished, CFRunLoopAddSource, CFRunLoopGetCurrent,
    CFRunLoopRemoveSource, CFRunLoopRunInMode, CFRunLoopSourceRef,
};
use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};
use core_foundation_sys::url::{CFURLGetString, CFURLGetTypeID, CFURLRef};
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;

use super::{clamp_os_text, MAX_OS_TEXT_BYTES};
use crate::engine::{Access, AppFilter, ElementInfo, Observer, Signal, SnapshotLimits};
use crate::protocol::{ElementRole, ObservedApp, ObservedWindow, Permission, Platform};

const FRONTMOST_POLL: Duration = Duration::from_millis(250);
/// Per-call AX timeout so a hung app cannot stall the helper for the system
/// default of 6 s.
const AX_TIMEOUT_SECS: f32 = 0.25;
/// Larger text values are treated as documents and not tracked per keystroke.
const MAX_TRACKED_CHARS: i64 = 200_000;
const URL_SEARCH_NODES: usize = 400;
const URL_SEARCH_DEPTH: usize = 30;
const URL_SEARCH_BUDGET: Duration = Duration::from_millis(60);
const MAX_PENDING_NOTIFICATIONS: usize = 1024;

const NOTIFICATIONS: [&str; 6] = [
    "AXFocusedUIElementChanged",
    "AXValueChanged",
    "AXSelectedTextChanged",
    "AXTitleChanged",
    "AXFocusedWindowChanged",
    "AXMainWindowChanged",
];

const DENIED_DETAIL: &str = "Accessibility permission is not granted. Enable Maestro in System \
Settings > Privacy & Security > Accessibility.";

// ---------------------------------------------------------------------------
// CF / AX ownership helpers
// ---------------------------------------------------------------------------

/// An owned (+1) CF object of any type.
struct CfOwned(CFTypeRef);

impl Drop for CfOwned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

impl CfOwned {
    fn type_id(&self) -> usize {
        unsafe { CFGetTypeID(self.0) as usize }
    }

    fn as_string(&self) -> Option<String> {
        cf_to_string(self.0)
    }

    fn as_bool(&self) -> Option<bool> {
        unsafe {
            if CFGetTypeID(self.0) == CFBooleanGetTypeID() {
                Some(CFBooleanGetValue(self.0 as CFBooleanRef))
            } else {
                None
            }
        }
    }

    fn as_element(&self) -> Option<AxEl> {
        unsafe {
            if CFGetTypeID(self.0) == AXUIElementGetTypeID() {
                Some(AxEl::retain(self.0 as AXUIElementRef))
            } else {
                None
            }
        }
    }

    fn as_elements(&self) -> Vec<AxEl> {
        cf_array_elements(self.0)
    }

    fn as_number(&self) -> Option<i64> {
        if self.type_id() != unsafe { CFNumberGetTypeID() } as usize {
            return None;
        }
        unsafe { CFNumber::wrap_under_get_rule(self.0 as CFNumberRef) }.to_i64()
    }
}

/// CFString or CFURL to a Rust string. Borrowed reference.
fn cf_to_string(value: CFTypeRef) -> Option<String> {
    if value.is_null() {
        return None;
    }
    unsafe {
        let tid = CFGetTypeID(value);
        if tid == CFStringGetTypeID() {
            let s = CFString::wrap_under_get_rule(value as CFStringRef).to_string();
            Some(clamp_os_text(s, MAX_OS_TEXT_BYTES))
        } else if tid == CFURLGetTypeID() {
            let s = CFURLGetString(value as CFURLRef);
            if s.is_null() {
                None
            } else {
                Some(CFString::wrap_under_get_rule(s).to_string())
            }
        } else {
            None
        }
    }
}

/// Elements of a borrowed CFArray, retained.
fn cf_array_elements(value: CFTypeRef) -> Vec<AxEl> {
    let mut out = Vec::new();
    unsafe {
        if value.is_null() || CFGetTypeID(value) != CFArrayGetTypeID() {
            return out;
        }
        let array = value as CFArrayRef;
        let ax_type = AXUIElementGetTypeID();
        for i in 0..CFArrayGetCount(array) {
            let item = CFArrayGetValueAtIndex(array, i);
            if !item.is_null() && CFGetTypeID(item) == ax_type {
                out.push(AxEl::retain(item as AXUIElementRef));
            }
        }
    }
    out
}

/// An owned AXUIElementRef.
struct AxEl(AXUIElementRef);

impl Drop for AxEl {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) }
    }
}

impl Clone for AxEl {
    fn clone(&self) -> Self {
        unsafe { AxEl::retain(self.0) }
    }
}

impl AxEl {
    /// Wraps a borrowed reference, taking a +1 retain.
    unsafe fn retain(r: AXUIElementRef) -> AxEl {
        CFRetain(r as CFTypeRef);
        AxEl(r)
    }

    fn application(pid: i32) -> Option<AxEl> {
        let r = unsafe { AXUIElementCreateApplication(pid) };
        if r.is_null() {
            None
        } else {
            Some(AxEl(r))
        }
    }

    fn attr(&self, name: &str) -> Option<CfOwned> {
        let key = CFString::new(name);
        let mut value: CFTypeRef = ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, key.as_concrete_TypeRef(), &mut value) };
        if err == kAXErrorSuccess && !value.is_null() {
            Some(CfOwned(value))
        } else {
            None
        }
    }

    fn string_attr(&self, name: &str) -> Option<String> {
        self.attr(name)
            .and_then(|v| v.as_string())
            .filter(|s| !s.is_empty())
    }

    fn element_attr(&self, name: &str) -> Option<AxEl> {
        self.attr(name).and_then(|v| v.as_element())
    }

    fn bool_attr(&self, name: &str) -> Option<bool> {
        self.attr(name).and_then(|v| v.as_bool())
    }

    /// One IPC round trip for several attributes. Missing attributes come back
    /// as AXValue error placeholders, which the typed accessors ignore.
    fn attrs(&self, names: &CFArray<CFString>) -> Vec<Option<CfOwned>> {
        let mut values: CFArrayRef = ptr::null();
        let err = unsafe {
            AXUIElementCopyMultipleAttributeValues(
                self.0,
                names.as_concrete_TypeRef(),
                0,
                &mut values,
            )
        };
        let count = names.len() as usize;
        if err != kAXErrorSuccess || values.is_null() {
            return (0..count).map(|_| None).collect();
        }
        let owned = CfOwned(values as CFTypeRef);
        let mut out = Vec::with_capacity(count);
        unsafe {
            let n = CFArrayGetCount(values) as usize;
            for i in 0..count {
                if i >= n {
                    out.push(None);
                    continue;
                }
                let item = CFArrayGetValueAtIndex(values, i as isize);
                if item.is_null() {
                    out.push(None);
                } else {
                    CFRetain(item);
                    out.push(Some(CfOwned(item)));
                }
            }
        }
        drop(owned);
        out
    }

    fn set_bool(&self, name: &str, value: bool) -> AXError {
        let key = CFString::new(name);
        let v = if value {
            CFBoolean::true_value()
        } else {
            CFBoolean::false_value()
        };
        unsafe { AXUIElementSetAttributeValue(self.0, key.as_concrete_TypeRef(), v.as_CFTypeRef()) }
    }

    fn set_timeout(&self, secs: f32) {
        unsafe {
            AXUIElementSetMessagingTimeout(self.0, secs);
        }
    }

    fn key(&self) -> u64 {
        unsafe { CFHash(self.0 as CFTypeRef) as u64 }
    }

    fn same_as(&self, other: &AxEl) -> bool {
        unsafe { CFEqual(self.0 as CFTypeRef, other.0 as CFTypeRef) != 0 }
    }
}

fn cf_strings(names: &[&str]) -> CFArray<CFString> {
    let items: Vec<CFString> = names.iter().map(|n| CFString::new(n)).collect();
    CFArray::from_CFTypes(&items)
}

// ---------------------------------------------------------------------------
// AXObserver plumbing
// ---------------------------------------------------------------------------

thread_local! {
    /// Notifications delivered during the last run-loop pump. The callback
    /// runs on this (main) thread inside CFRunLoopRunInMode.
    static PENDING: RefCell<Vec<(String, AxEl)>> = const { RefCell::new(Vec::new()) };
}

unsafe extern "C" fn ax_callback(
    _observer: AXObserverRef,
    element: AXUIElementRef,
    notification: CFStringRef,
    _refcon: *mut c_void,
) {
    if element.is_null() || notification.is_null() {
        return;
    }
    let name = CFString::wrap_under_get_rule(notification).to_string();
    let el = AxEl::retain(element);
    PENDING.with(|p| {
        let mut p = p.borrow_mut();
        if p.len() < MAX_PENDING_NOTIFICATIONS {
            p.push((name, el));
        }
    });
}

/// An AXObserver attached to one app, registered on the main run loop.
struct AppWatch {
    observer: AXObserverRef,
    source: CFRunLoopSourceRef,
}

impl AppWatch {
    fn attach(pid: i32, app: &AxEl) -> Result<AppWatch, AXError> {
        let mut observer: AXObserverRef = ptr::null_mut();
        let err = unsafe { AXObserverCreate(pid, ax_callback, &mut observer) };
        if err != kAXErrorSuccess || observer.is_null() {
            return Err(err);
        }
        for name in NOTIFICATIONS {
            let key = CFString::new(name);
            // Registering on the application element delivers the
            // notification for every element in the app. Some apps reject
            // individual notifications; the rest still work.
            unsafe {
                AXObserverAddNotification(
                    observer,
                    app.0,
                    key.as_concrete_TypeRef(),
                    ptr::null_mut(),
                );
            }
        }
        let source = unsafe { AXObserverGetRunLoopSource(observer) };
        unsafe { CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode) };
        Ok(AppWatch { observer, source })
    }
}

impl Drop for AppWatch {
    fn drop(&mut self) {
        unsafe {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), self.source, kCFRunLoopDefaultMode);
            CFRelease(self.observer as CFTypeRef);
        }
    }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

struct CachedWindow {
    key: u64,
    title: Option<String>,
    window: ObservedWindow,
}

pub struct MacObserver {
    filter: AppFilter,
    running: bool,
    refresh: bool,
    last_front_check: Option<Instant>,
    current_pid: Option<i32>,
    current_id: String,
    current_blocked: bool,
    app_el: Option<AxEl>,
    watch: Option<AppWatch>,
    focused: Option<AxEl>,
    window: Option<CachedWindow>,
    enhanced_pids: HashSet<i32>,
    snapshot_attrs: CFArray<CFString>,
    search_attrs: CFArray<CFString>,
}

impl MacObserver {
    pub fn new() -> Self {
        MacObserver {
            filter: AppFilter::default(),
            running: false,
            refresh: false,
            last_front_check: None,
            current_pid: None,
            current_id: String::new(),
            current_blocked: false,
            app_el: None,
            watch: None,
            focused: None,
            window: None,
            enhanced_pids: HashSet::new(),
            snapshot_attrs: cf_strings(&["AXRole", "AXSubrole", "AXChildren"]),
            search_attrs: cf_strings(&["AXRole", "AXURL", "AXChildren"]),
        }
    }

    fn detach(&mut self) {
        self.watch = None;
        self.app_el = None;
        self.focused = None;
        self.window = None;
        PENDING.with(|p| p.borrow_mut().clear());
    }

    fn check_frontmost(&mut self, out: &mut Vec<Signal>, force: bool) {
        let Some(front) = frontmost_app() else {
            return;
        };
        if !force && Some(front.pid as i32) == self.current_pid {
            return;
        }
        self.detach();
        let pid = front.pid as i32;
        self.current_pid = Some(pid);
        self.current_id = front.id.clone();
        if self.filter.is_blocked(&front.id, front.pid) {
            // Nothing is read from a blocked app: no AX element, no observer.
            self.current_blocked = true;
            out.push(Signal::AppActivated {
                app: front,
                window: None,
            });
            return;
        }
        self.current_blocked = false;
        let Some(app_el) = AxEl::application(pid) else {
            out.push(Signal::AppActivated {
                app: front,
                window: None,
            });
            return;
        };
        app_el.set_timeout(AX_TIMEOUT_SECS);
        if self.enhanced_pids.len() > 4096 {
            self.enhanced_pids.clear();
        }
        if self.enhanced_pids.insert(pid) {
            // Electron builds its accessibility tree only when asked
            // (AXManualAccessibility); Chromium does the same for
            // AXEnhancedUserInterface. Both fail harmlessly elsewhere.
            app_el.set_bool("AXManualAccessibility", true);
            app_el.set_bool("AXEnhancedUserInterface", true);
        }
        match AppWatch::attach(pid, &app_el) {
            Ok(watch) => self.watch = Some(watch),
            Err(err) => out.push(Signal::Error(format!(
                "cannot observe {} (AX error {err}); recording app switches only",
                front.id
            ))),
        }
        let window = self.read_window(&app_el, true).unwrap_or_default();
        let focused = app_el.element_attr("AXFocusedUIElement");
        self.app_el = Some(app_el);
        out.push(Signal::AppActivated {
            app: front,
            window: Some(window),
        });
        out.push(Signal::FocusChanged {
            element: focused.as_ref().map(read_element),
        });
        self.focused = focused;
    }

    /// The focused window's title and URL. With `force` false, returns `None`
    /// when neither the window nor its title changed since the last read.
    fn read_window(&mut self, app_el: &AxEl, force: bool) -> Option<ObservedWindow> {
        let Some(win) = app_el.element_attr("AXFocusedWindow") else {
            let empty = ObservedWindow::default();
            let changed = self.window.as_ref().is_none_or(|c| c.window != empty);
            self.window = None;
            return (force || changed).then_some(empty);
        };
        let key = win.key();
        let title = win.string_attr("AXTitle");
        if let Some(cached) = &self.window {
            if cached.key == key && cached.title == title {
                return force.then(|| cached.window.clone());
            }
        }
        let url = win
            .string_attr("AXDocument")
            .or_else(|| self.find_web_url(&win));
        let window = ObservedWindow {
            title: title.clone(),
            url,
        };
        self.window = Some(CachedWindow {
            key,
            title,
            window: window.clone(),
        });
        Some(window)
    }

    /// URL of the first AXWebArea under `root` (browsers, Electron apps).
    fn find_web_url(&self, root: &AxEl) -> Option<String> {
        let deadline = Instant::now() + URL_SEARCH_BUDGET;
        let mut queue = std::collections::VecDeque::from([(root.clone(), 0usize)]);
        let mut visited = 0;
        while let Some((el, depth)) = queue.pop_front() {
            visited += 1;
            if visited > URL_SEARCH_NODES || Instant::now() >= deadline {
                break;
            }
            let values = el.attrs(&self.search_attrs);
            let role = values[0].as_ref().and_then(CfOwned::as_string);
            if role.as_deref() == Some("AXWebArea") {
                if let Some(url) = values[1].as_ref().and_then(CfOwned::as_string) {
                    return Some(url);
                }
            }
            if depth < URL_SEARCH_DEPTH {
                if let Some(children) = &values[2] {
                    queue.extend(children.as_elements().into_iter().map(|c| (c, depth + 1)));
                }
            }
        }
        None
    }

    fn process_notifications(&mut self, out: &mut Vec<Signal>) {
        let pending = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
        if pending.is_empty() || self.current_blocked {
            return;
        }
        let Some(app_el) = self.app_el.clone() else {
            return;
        };
        let mut window_checked = false;
        for (name, el) in pending {
            match name.as_str() {
                "AXFocusedUIElementChanged" => {
                    let info = read_element(&el);
                    self.focused = Some(el);
                    out.push(Signal::FocusChanged {
                        element: Some(info),
                    });
                }
                "AXValueChanged" => {
                    let is_focused = self.focused.as_ref().is_some_and(|f| f.same_as(&el));
                    if is_focused {
                        out.push(Signal::ValueChanged {
                            element: read_element(&el),
                        });
                    } else if el.bool_attr("AXFocused") == Some(true) {
                        // Some web views change focus without sending
                        // AXFocusedUIElementChanged; the engine treats an
                        // unknown element's change as a new field.
                        let info = read_element(&el);
                        if info.role.is_text_entry() {
                            self.focused = Some(el);
                            out.push(Signal::ValueChanged { element: info });
                        }
                    }
                }
                "AXSelectedTextChanged" => {
                    let info = read_element(&el);
                    if info.secure {
                        continue;
                    }
                    let text = el.string_attr("AXSelectedText").unwrap_or_default();
                    out.push(Signal::SelectionChanged {
                        element: Some(info),
                        text,
                    });
                }
                "AXTitleChanged" | "AXFocusedWindowChanged" | "AXMainWindowChanged" => {
                    if window_checked {
                        continue;
                    }
                    window_checked = true;
                    if let Some(window) = self.read_window(&app_el, false) {
                        out.push(Signal::WindowChanged { window });
                    }
                }
                _ => {}
            }
        }
    }
}

/// Reads role, label, and (for non-secure text fields) value.
fn read_element(el: &AxEl) -> ElementInfo {
    let role = el.string_attr("AXRole").unwrap_or_default();
    let subrole = el.string_attr("AXSubrole").unwrap_or_default();
    let secure = subrole == "AXSecureTextField" || role == "AXSecureTextField";
    let mut mapped = match role.as_str() {
        "AXTextField" if subrole == "AXSearchField" => ElementRole::SearchField,
        "AXTextField" => ElementRole::TextField,
        "AXTextArea" => ElementRole::TextArea,
        "AXComboBox" => ElementRole::ComboBox,
        "AXWebArea" => ElementRole::WebArea,
        _ => ElementRole::Other,
    };
    let label = el
        .string_attr("AXTitle")
        .or_else(|| el.string_attr("AXDescription"))
        .or_else(|| el.string_attr("AXPlaceholderValue"));
    let mut value = None;
    if mapped.is_text_entry() && !secure {
        let chars = el
            .attr("AXNumberOfCharacters")
            .and_then(|v| v.as_number())
            .unwrap_or(0);
        if chars > MAX_TRACKED_CHARS {
            mapped = ElementRole::Document;
        } else {
            value = Some(
                el.attr("AXValue")
                    .and_then(|v| v.as_string())
                    .unwrap_or_default(),
            );
        }
    }
    ElementInfo {
        key: el.key(),
        role: mapped,
        label,
        value,
        secure,
    }
}

fn frontmost_app() -> Option<ObservedApp> {
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let pid = app.processIdentifier();
    if pid <= 0 {
        return None;
    }
    let exe_name = app
        .executableURL()
        .and_then(|u| u.lastPathComponent())
        .map(|s| s.to_string());
    let id = app
        .bundleIdentifier()
        .map(|s| s.to_string())
        .or_else(|| exe_name.as_ref().map(|n| n.to_lowercase()))
        .unwrap_or_else(|| format!("pid-{pid}"));
    let name = app
        .localizedName()
        .map(|s| s.to_string())
        .or(exe_name)
        .unwrap_or_else(|| id.clone());
    Some(ObservedApp {
        id,
        name,
        pid: pid as u32,
        aumid: None,
    })
}

impl Observer for MacObserver {
    fn platform(&self) -> Platform {
        Platform::Macos
    }

    fn access(&mut self) -> Access {
        let trusted = unsafe { AXIsProcessTrusted() };
        Access {
            permission: if trusted {
                Permission::Granted
            } else {
                Permission::Denied
            },
            can_observe: trusted,
            accessibility_bus: None,
            session: None,
            detail: (!trusted).then(|| DENIED_DETAIL.to_string()),
        }
    }

    fn request_access(&mut self) -> Result<(), String> {
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(
            key.as_CFType(),
            CFBoolean::true_value().as_CFType(),
        )]);
        // Opens the system dialog that deep-links to the Accessibility pane.
        // The return value is the current trust state, which is re-read by
        // the engine right after.
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) };
        Ok(())
    }

    fn start(&mut self, filter: &AppFilter) {
        self.filter = filter.clone();
        self.running = true;
        self.refresh = true;
    }

    fn stop(&mut self) {
        self.running = false;
        self.refresh = false;
        self.detach();
        self.current_pid = None;
        self.current_blocked = false;
    }

    fn poll(&mut self, timeout: Duration) -> Vec<Signal> {
        let mut out = Vec::new();
        autoreleasepool(|_| {
            if self.running {
                let due = self
                    .last_front_check
                    .is_none_or(|t| t.elapsed() >= FRONTMOST_POLL);
                if self.refresh || due {
                    let force = std::mem::take(&mut self.refresh);
                    self.last_front_check = Some(Instant::now());
                    self.check_frontmost(&mut out, force);
                }
            }
            let result =
                unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, timeout.as_secs_f64(), 0) };
            if result == kCFRunLoopRunFinished {
                // No sources registered yet: the run loop returns at once.
                thread::sleep(timeout);
            }
            if self.running {
                self.process_notifications(&mut out);
            } else {
                PENDING.with(|p| p.borrow_mut().clear());
            }
        });
        out
    }

    fn snapshot_focused_window_text(&mut self, limits: &SnapshotLimits) -> Option<Vec<String>> {
        if !self.running || self.current_blocked {
            return None;
        }
        if self
            .filter
            .is_blocked(&self.current_id, self.current_pid? as u32)
        {
            return None;
        }
        let win = self.app_el.as_ref()?.element_attr("AXFocusedWindow")?;
        let deadline = Instant::now() + limits.budget;
        let mut lines = Vec::new();
        let mut stack = vec![(win, 0usize)];
        let mut visited = 0usize;
        while let Some((el, depth)) = stack.pop() {
            if visited >= limits.max_nodes || Instant::now() >= deadline {
                break;
            }
            visited += 1;
            // Role, subrole, and children first; a value is fetched only for
            // text roles that are not secure, so a secure field's AXValue is
            // never requested.
            let values = el.attrs(&self.snapshot_attrs);
            let role = values[0]
                .as_ref()
                .and_then(CfOwned::as_string)
                .unwrap_or_default();
            let subrole = values[1]
                .as_ref()
                .and_then(CfOwned::as_string)
                .unwrap_or_default();
            if subrole == "AXSecureTextField" || role == "AXSecureTextField" {
                continue;
            }
            match role.as_str() {
                "AXStaticText" => {
                    let text = el
                        .string_attr("AXValue")
                        .or_else(|| el.string_attr("AXTitle"));
                    lines.extend(text);
                }
                "AXTextField" | "AXTextArea" | "AXComboBox" => {
                    lines.extend(el.string_attr("AXValue"));
                }
                _ => {}
            }
            if depth < limits.max_depth {
                if let Some(children) = &values[2] {
                    // Reverse so the depth-first walk reads in document order.
                    for child in children.as_elements().into_iter().rev() {
                        stack.push((child, depth + 1));
                    }
                }
            }
        }
        Some(lines)
    }
}
