//! maestro-observer: Maestro's Computer History accessibility helper.
//!
//! A long-lived child of the Electron main process. Reads NDJSON commands on
//! stdin, writes NDJSON `ObservedEvent`s on stdout, free-form diagnostics on
//! stderr. Exits within 1 s of stdin EOF. See Plans/computer-history-plan.md.

mod engine;
mod platform;
mod protocol;

use std::io::{self, BufRead};
use std::process;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use engine::{Engine, Input, Now};
use protocol::{EventKind, ObservedEvent, HELPER_VERSION};

const USAGE: &str = "usage: maestro-observer [--version | --probe]\n\
  (no arguments)  run: NDJSON commands on stdin, events on stdout\n\
  --version       print the helper version and exit\n\
  --probe         print one helper.status line and exit";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => run(),
        Some("--version") | Some("-V") => println!("maestro-observer {HELPER_VERSION}"),
        Some("--probe") => probe(),
        Some("--help") | Some("-h") => println!("{USAGE}"),
        Some(other) => {
            eprintln!("maestro-observer: unknown argument {other:?}\n{USAGE}");
            process::exit(2);
        }
    }
}

fn probe() {
    let mut observer = platform::create();
    let access = observer.access();
    let mut event = ObservedEvent::new(
        EventKind::HelperStatus,
        engine::iso_utc_ms(Now::system().wall_ms),
    );
    event.status = Some(Engine::probe_status(observer.platform(), &access));
    let stdout = io::stdout();
    if let Err(e) = engine::write_event(&mut stdout.lock(), &event) {
        eprintln!("maestro-observer: cannot write probe result: {e}");
        process::exit(1);
    }
}

fn run() {
    let (tx, rx) = mpsc::channel::<Input>();
    let reader = thread::Builder::new().name("stdin".into()).spawn(move || {
        let stdin = io::stdin();
        let mut lock = stdin.lock();
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match lock.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    if tx.send(Input::Line(line)).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = tx.send(Input::Eof);
        // The parent is gone. The engine loop normally returns well before
        // this, but an OS accessibility call into a hung app can block it,
        // so enforce the 1 s exit contract from here.
        thread::sleep(Duration::from_millis(900));
        process::exit(0);
    });
    if let Err(e) = reader {
        eprintln!("maestro-observer: cannot start stdin reader: {e}");
        process::exit(1);
    }

    // The observer lives on the main thread: macOS delivers AXObserver
    // callbacks and NSWorkspace updates through the main run loop.
    let mut observer = platform::create();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if let Err(e) = engine::run(observer.as_mut(), &rx, &mut out, &Now::system) {
        if e.kind() != io::ErrorKind::BrokenPipe {
            eprintln!("maestro-observer: stopped: {e}");
        }
    }
}
