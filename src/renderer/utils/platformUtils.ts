/**
 * Renderer-side platform detection helpers.
 * Uses `window.maestro.platform` (set via Electron preload bridge)
 * instead of navigator.userAgent / navigator.platform which are unreliable.
 */

function getPlatform(): string {
	return (window as any).maestro?.platform ?? '';
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

/**
 * Returns the platform-appropriate label for the "reveal in file manager" action.
 *   darwin (and other/unknown) → "Reveal in Finder" (macOS default)
 *   win32               → "Reveal in Explorer" (Windows)
 *   linux               → "Reveal in File Manager" (Linux)
 */
export function getRevealLabel(platform: string): string {
	if (platform === 'win32') return 'Reveal in Explorer';
	if (platform === 'linux') return 'Reveal in File Manager';
	return 'Reveal in Finder';
}

/**
 * Returns the platform-appropriate label for "open folder in file manager".
 *   darwin (and other/unknown) → "Open in Finder"
 *   win32               → "Open in Explorer"
 *   linux               → "Open in File Manager"
 */
export function getOpenInLabel(platform: string): string {
	if (platform === 'win32') return 'Open in Explorer';
	if (platform === 'linux') return 'Open in File Manager';
	return 'Open in Finder';
}
