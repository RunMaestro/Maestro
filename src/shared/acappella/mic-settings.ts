/**
 * Where the OS keeps the microphone permission, per platform.
 *
 * Shared rather than main-only because two processes need the same answer and
 * must not disagree: main opens the URL, and the HUD decides whether to offer
 * the button at all. A button that opens nothing is worse than no button when
 * the user is already staring at a microphone that will not work.
 *
 * Linux is deliberately absent. There is no deep link that works across GNOME,
 * KDE, and the rest, and PipeWire/PulseAudio permission lives in a different
 * place on each; guessing one would send most users to a window that has nothing
 * to do with their problem. `micSettingsUrl` returns null there and the HUD says
 * what to look for instead.
 */

/** Platform -> the URL that opens the microphone privacy pane. */
export const MIC_SETTINGS_URLS: Readonly<Record<string, string>> = {
	darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
	win32: 'ms-settings:privacy-microphone',
};

/**
 * The URL that opens the microphone permission settings, or null when the
 * platform has no such link.
 *
 * @param platform A `process.platform` value ('darwin', 'win32', 'linux').
 */
export function micSettingsUrl(platform: string): string | null {
	return MIC_SETTINGS_URLS[platform] ?? null;
}

/** Button text, naming the place the user is actually being sent. */
export function micSettingsLabel(platform: string): string {
	if (platform === 'win32') return 'Open Microphone Settings';
	return 'Open Privacy Settings';
}
