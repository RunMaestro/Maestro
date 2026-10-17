/**
 * Whether an agent finishing in the background is spoken about at all.
 *
 * Shared rather than main-only because Voice Setup renders the choice and the
 * announcer enforces it, and a default computed twice is a default that drifts.
 */

import type { VoiceScope } from './protocol';

/**
 * The setting, with a third value that is not a fudge.
 *
 *   - `on`   - always speak background completions.
 *   - `off`  - never.
 *   - `auto` - the default, and the only honest one, because the right answer
 *              genuinely depends on what the user is doing. In the Conductor
 *              scope they are supervising a fleet and a finished agent is the
 *              news they are waiting for. Inside a focused agent session they are
 *              having a conversation with ONE agent, and another agent talking
 *              over it is an interruption they did not ask for.
 */
export type BackgroundAnnouncementSetting = 'on' | 'off' | 'auto';

export const DEFAULT_BACKGROUND_ANNOUNCEMENT_SETTING: BackgroundAnnouncementSetting = 'auto';

/** Resolve the setting against the scope the session is bound to. */
export function shouldSpeakBackgroundCompletions(
	setting: BackgroundAnnouncementSetting | undefined,
	scope: VoiceScope
): boolean {
	switch (setting ?? DEFAULT_BACKGROUND_ANNOUNCEMENT_SETTING) {
		case 'on':
			return true;
		case 'off':
			return false;
		default:
			return scope.kind === 'conductor';
	}
}
