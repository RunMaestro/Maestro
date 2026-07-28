/**
 * Centralized platform detection utilities.
 *
 * All functions read the platform string at call time so that tests can
 * override it via Object.defineProperty(process, 'platform', { value: '...', configurable: true })
 * without module-level caching defeating the mock.
 *
 * Do NOT convert these to module-level constants.
 *
 * In renderer (browser) contexts there is no real `process` global; the platform
 * string is exposed via the preload bridge at `window.maestro.platform`.
 * Touching the bare `process` identifier in renderer code throws a
 * ReferenceError, so the lookup goes through `globalThis` instead.
 *
 * The renderer also loads a `process` polyfill
 * (`src/renderer/public/process-shim.js`) that reports the sentinel platform
 * 'browser' so vendor libs don't throw. That sentinel is explicitly rejected:
 * treating it as a real platform made every renderer look non-macOS, which is
 * how the Settings shortcut hints ended up saying "Ctrl+0" on a Mac.
 */

/** Sentinel reported by the renderer's `process` polyfill - never a real platform. */
const SHIM_PLATFORM = 'browser';

type GlobalWithPlatform = {
	process?: { platform?: string };
	maestro?: { platform?: string };
};

function getPlatform(): string {
	const g = globalThis as GlobalWithPlatform;
	const fromProcess = g.process?.platform;
	if (fromProcess && fromProcess !== SHIM_PLATFORM) return fromProcess;
	if (g.maestro?.platform) return g.maestro.platform;
	return 'linux';
}

/** Returns true when running on Windows (win32). */
export function isWindows(): boolean {
	return getPlatform() === 'win32';
}

/** Returns true when running on macOS (darwin). */
export function isMacOS(): boolean {
	return getPlatform() === 'darwin';
}

/** Returns true when running on Linux. */
export function isLinux(): boolean {
	return getPlatform() === 'linux';
}

/**
 * Returns the platform-appropriate command for locating binaries.
 * 'where' on Windows, 'which' on Unix-like systems.
 */
export function getWhichCommand(): string {
	return isWindows() ? 'where' : 'which';
}
