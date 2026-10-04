//! Platform adapters. Each one implements [`Observer`] and keeps policy out:
//! it reports what the OS says and consults the [`AppFilter`] before reading
//! anything from an app.
//!
//! [`AppFilter`]: crate::engine::AppFilter

use crate::engine::Observer;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// The adapter for the OS this binary was built for.
pub fn create() -> Box<dyn Observer> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacObserver::new())
    }
    #[cfg(windows)]
    {
        Box::new(self::windows::WindowsObserver::new())
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(linux::LinuxObserver::new())
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
compile_error!("maestro-observer supports macOS, Windows, and Linux only");

/// Clamps a string read from the OS before it enters the engine, so a
/// pathological multi-megabyte value cannot balloon memory. The engine applies
/// the configured byte caps afterwards.
pub(crate) fn clamp_os_text(s: String, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        s
    } else {
        crate::engine::truncate_utf8(&s, max_bytes).0
    }
}

/// Upper bound on any single string an adapter keeps (1 MiB).
pub(crate) const MAX_OS_TEXT_BYTES: usize = 1 << 20;
