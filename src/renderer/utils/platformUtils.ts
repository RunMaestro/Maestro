/**
 * Renderer-side platform detection helpers.
 *
 * Reads `window.maestro.platform` (set via the Electron preload bridge), which
 * is the only authoritative source in the renderer:
 *   - navigator.userAgent / navigator.platform are unreliable and deprecated.
 *   - `process.platform` is the string 'browser', hard-coded by the renderer's
 *     polyfill (`src/renderer/public/process-shim.js`).
 *
 * Renderer code should prefer these helpers. `src/shared/platformDetection.ts`
 * covers code that also runs in the main process; it reads `process.platform`
 * first (rejecting the 'browser' sentinel) and falls back to this same bridge.
 */

import { isWebDesktop } from './runtimeContext';

/**
 * The raw `process.platform` string as the preload bridge reported it, or '' in
 * a context with no bridge. Exported for the callers that need the value itself
 * rather than a boolean - a platform-keyed lookup table has no business being
 * rewritten as a chain of `isMacOSPlatform()` tests.
 */
export function getPlatform(): string {
	return (window as any).maestro?.platform ?? '';
}

/**
 * The operating system Maestro itself RUNS on, or '' when this client cannot
 * know it. In the desktop app that is the preload's `process.platform`. In a
 * web-desktop browser `window.maestro.platform` describes the BROWSER's device
 * (a phone can be pointed at a Mac host), so it is no answer to "what can the
 * host install or run": that case returns ''.
 */
export function hostPlatform(): string {
	return isWebDesktop() ? '' : getPlatform();
}

export function isWindowsPlatform(): boolean {
	return getPlatform() === 'win32';
}

export function isMacOSPlatform(): boolean {
	return getPlatform() === 'darwin';
}

export function isLinuxPlatform(): boolean {
	return getPlatform() === 'linux';
}

/** Physical client keyboard conventions; remote commands still use the host platform above. */
export function isMacOSKeyboard(): boolean {
	if (window.__MAESTRO_CONFIG__) {
		return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
	}
	return isMacOSPlatform();
}

/**
 * The platform's name for its file manager, for use inside a sentence.
 *   darwin (and other/unknown) → "Finder"
 *   win32               → "Explorer"
 *   linux               → "File Manager"
 *
 * Every label below reads the noun from here so a new piece of copy can't
 * hard-code "Finder" and then read wrong on Windows.
 */
export function getFileManagerName(platform: string): string {
	if (platform === 'win32') return 'Explorer';
	if (platform === 'linux') return 'File Manager';
	return 'Finder';
}

/** Same as `getFileManagerName`, resolving the platform from the bridge. */
export function fileManagerName(): string {
	return getFileManagerName(getPlatform());
}

/**
 * Returns the platform-appropriate label for the "reveal in file manager" action.
 *   darwin (and other/unknown) → "Reveal in Finder" (macOS default)
 *   win32               → "Reveal in Explorer" (Windows)
 *   linux               → "Reveal in File Manager" (Linux)
 */
export function getRevealLabel(platform: string): string {
	return `Reveal in ${getFileManagerName(platform)}`;
}

/**
 * Returns the platform-appropriate label for "open folder in file manager".
 *   darwin (and other/unknown) → "Open in Finder"
 *   win32               → "Open in Explorer"
 *   linux               → "Open in File Manager"
 */
export function getOpenInLabel(platform: string): string {
	return `Open in ${getFileManagerName(platform)}`;
}
