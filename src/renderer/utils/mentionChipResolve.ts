/**
 * mentionChipResolve - turn a raw mention token into the display data a
 * {@link MentionChip} needs (label, icon color, jump target).
 *
 * Kept out of the pure `MentionChip` primitive so the chip stays state-free.
 * Agent resolution reads the session store imperatively (`getState()`), not via
 * a hook, so it can run from the input overlay's per-keystroke render and from
 * the markdown render callbacks without adding a subscription per chip.
 */

import type { Theme } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { normalizeMentionName, generateParticipantColor } from './participantColors';
import { getExtensionColor } from './extensionColors';

export interface ResolvedAgentMention {
	/** Display name to show on the chip (falls back to the raw name). */
	label: string;
	/** Participant dot color. */
	color: string;
	/** Target agent id for jump-to, when the name resolves to a live agent. */
	sessionId?: string;
}

/**
 * Resolve a `@name` mention to the agent it points at. Matches on the same
 * normalized mention name the picker/dispatch use, so a chip and its dispatch
 * target always agree. Unknown names render with the theme accent and no jump.
 */
export function resolveAgentMention(name: string, theme: Theme): ResolvedAgentMention {
	const normalized = normalizeMentionName(name);
	const mentionable = useSessionStore.getState().sessions.filter((s) => s.toolType !== 'terminal');
	const index = mentionable.findIndex((s) => normalizeMentionName(s.name) === normalized);
	if (index === -1) {
		return { label: name, color: theme.colors.accent };
	}
	const target = mentionable[index];
	// +1 keeps agents off the Moderator-reserved index 0 (blue), matching the
	// group-chat palette's "agents start at 1" convention closely enough for a dot.
	return {
		label: target.name,
		color: generateParticipantColor(index + 1, theme),
		sessionId: target.id,
	};
}

/**
 * Icon tint for a `@file` chip, derived from the extension color map (same one
 * the tab badges use) so a `.ts` chip and a `.md` chip read differently.
 */
export function resolveFileMentionIconColor(
	extension: string,
	theme: Theme,
	colorBlindMode: boolean
): string {
	const ext = extension ? `.${extension}` : '';
	return getExtensionColor(ext, theme, colorBlindMode).text;
}
