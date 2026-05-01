/**
 * Install-path constants for the HumpfTech Maestro fork environment.
 *
 * These constants distinguish the development source tree from the packaged
 * install destination and the runtime user-data directory. They should be used
 * anywhere a literal `/opt/Maestro-fork`, `/opt/Maestro`, or user-data path is
 * needed so that future relocation is a single diff here rather than a grep-and-
 * replace across the entire codebase.
 *
 * Quick reference:
 *   - MAESTRO_FORK_SOURCE_ROOT  — where you cloned and run `npm run dev`
 *   - MAESTRO_INSTALL_ROOT      — where the packaged app lands on Linux
 *   - MAESTRO_USER_DATA_DIR     — Electron user-data at runtime (config, stores)
 */

/**
 * Root of the Maestro fork source repository.
 *
 * Use this constant whenever code needs to reference files that live inside the
 * development clone (e.g. local scripts, worktree paths, or dev-only tooling).
 * Do NOT use this in production code paths — production should rely on
 * `app.getAppPath()` or `MAESTRO_INSTALL_ROOT` instead.
 */
export const MAESTRO_FORK_SOURCE_ROOT = '/opt/Maestro-fork';

/**
 * Root of the packaged Maestro install on Linux (deb/rpm, electron-builder
 * default for the `linux` target when using an `/opt/<AppName>` install prefix).
 *
 * Use this constant to build paths to bundled resources such as
 * `maestro-cli.js` that ship inside the installed package.  On macOS and
 * Windows the equivalent paths differ; guard with platform checks or use
 * `app.getAppPath()` for cross-platform code.
 */
export const MAESTRO_INSTALL_ROOT = '/opt/Maestro';

/**
 * Electron user-data directory for the `maestro` system account on Linux.
 *
 * This is where Electron writes app settings, session storage, and other
 * runtime data.  The path follows the electron-builder lowercase convention
 * (`maestro`, not `Maestro`) and is consistent with the XDG base-directory
 * spec on Linux.  Use this constant instead of hard-coding the path in IPC
 * handlers, CLI scripts, or test fixtures that need to reference config files
 * at runtime.
 */
export const MAESTRO_USER_DATA_DIR = '/home/maestro/.config/maestro';
