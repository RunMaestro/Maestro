/**
 * useOwnsVoiceSession - does THIS window get to show the voice session?
 *
 * There is one voice session for the whole app, and every window receives its
 * whole event stream: `acappella:event` is broadcast like every other
 * main -> renderer push (see the multi-window invariant in
 * `src/main/utils/safe-send.ts`), so each window mirrors the same session and
 * decides for itself whether to draw a surface. Without that decision, opening
 * voice in one window drew an identical HUD in every window, and one microphone
 * looked like several.
 *
 * The rule, in one place because two surfaces need it (the HUD and the Left Bar
 * indicator) and a second copy would drift into showing one without the other:
 *
 *   - The session names a window, and it is this one -> yes.
 *   - The session names a window that is NOT this one -> no.
 *   - The session names no window -> the primary window shows it, so a session
 *     started by something with no window behind it always has exactly one
 *     surface rather than none.
 *   - Web-desktop is not one of several Electron windows. It mirrors the whole
 *     app, so it shows everything, matching `WindowContext`'s own permit-all.
 *   - Outside a `WindowProvider` (a single-window host, an isolation test) there
 *     is no window to be the wrong one, so it shows everything.
 */

import { useWindowContextOptional } from '../../contexts/WindowContext';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { isWebDesktop } from '../../utils/runtimeContext';

export function useOwnsVoiceSession(): boolean {
	const sessionWindowId = useVoiceSessionStore((s) => s.windowId);
	const windowContext = useWindowContextOptional();

	if (isWebDesktop() || !windowContext) return true;
	if (sessionWindowId === null) return windowContext.isMainWindow;
	return sessionWindowId === windowContext.windowId;
}
