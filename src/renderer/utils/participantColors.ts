/**
 * @file participantColors.ts
 * @description Utilities for group chat participants - colors and preferences.
 * Name normalization utilities are in shared/group-chat-types.ts.
 */

import type { Theme } from '../types';

// Re-export name normalization utilities from shared for backward compatibility
export { normalizeMentionName, mentionMatches } from '../../shared/group-chat-types';

/**
 * Generate a theme-compatible color for a participant based on their index.
 * Uses golden ratio distribution for visually distinct hues.
 * Colors are adjusted for light/dark themes automatically.
 *
 * @param index - The participant's index in the list
 * @param theme - The current theme
 * @returns HSL color string
 */
// Base hues that work well together (golden ratio distribution)
// Index 0 (hue 210, blue) is reserved for the Moderator
const BASE_HUES = [210, 150, 30, 270, 0, 180, 60, 300, 120, 330];

/** The color index reserved for the Moderator (always blue-ish) */
export const MODERATOR_COLOR_INDEX = 0;

/** Number of unique base colors in the palette */
export const COLOR_PALETTE_SIZE = BASE_HUES.length;

export function generateParticipantColor(index: number, theme: Theme): string {
	// Detect if theme is light or dark based on background color
	const bgHex = theme.colors.bgMain.match(/^#([0-9a-f]{2})/i)?.[1];
	const bgBrightness = bgHex ? parseInt(bgHex, 16) : 20;
	const isLightTheme = bgBrightness > 128;

	// Base saturation and lightness
	const baseSaturation = isLightTheme ? 65 : 55;
	const baseLightness = isLightTheme ? 45 : 60;

	// Calculate which "round" we're on (for when we exceed palette size)
	const round = Math.floor(index / BASE_HUES.length);
	const hueIndex = index % BASE_HUES.length;
	const hue = BASE_HUES[hueIndex];

	// Vary saturation and lightness for subsequent rounds to differentiate
	// Round 0: base values, Round 1: slightly different, Round 2: more different, etc.
	const saturationVariation = round * 10; // Reduce saturation each round
	const lightnessVariation = round * 8; // Adjust lightness each round

	const saturation = Math.max(25, baseSaturation - saturationVariation);
	const lightness = isLightTheme
		? Math.min(70, baseLightness + lightnessVariation) // Lighter for light themes
		: Math.max(40, baseLightness - lightnessVariation); // Darker for dark themes

	return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Build a color map for all participants.
 * Useful for ensuring consistent colors across components.
 *
 * @param participantNames - Array of participant names in order
 * @param theme - The current theme
 * @returns Map of name to color
 */
export function buildParticipantColorMap(
	participantNames: string[],
	theme: Theme
): Record<string, string> {
	const colors: Record<string, string> = {};
	participantNames.forEach((name, index) => {
		colors[name] = generateParticipantColor(index, theme);
	});
	return colors;
}

/**
 * Color preference storage key prefix
 */
const COLOR_PREF_KEY = 'groupChatColorPreferences';

/**
 * Load color preferences from settings.
 * Maps session paths to their preferred color indices.
 *
 * @returns Promise resolving to preferences map (sessionPath -> colorIndex)
 */
export async function loadColorPreferences(): Promise<Record<string, number>> {
	try {
		const prefs = await window.maestro.settings.get(COLOR_PREF_KEY);
		return (prefs as Record<string, number>) || {};
	} catch {
		return {};
	}
}

/**
 * Save color preferences to settings.
 *
 * @param preferences - Map of sessionPath -> colorIndex
 */
export async function saveColorPreferences(preferences: Record<string, number>): Promise<void> {
	await window.maestro.settings.set(COLOR_PREF_KEY, preferences);
}

/**
 * Participant info for color assignment
 */
export interface ParticipantColorInfo {
	name: string;
	/** Session path (project root) - used as stable identifier for color preferences */
	sessionPath?: string;
}

/**
 * Build a color map for participants with preference support.
 * Agents keep their preferred color index across different group chats when possible.
 *
 * @param participants - Array of participant info (name and optional sessionPath)
 * @param theme - The current theme
 * @param preferences - Existing color preferences (sessionPath -> colorIndex)
 * @returns Object with colors map and any new preferences to save
 */
export function buildParticipantColorMapWithPreferences(
	participants: ParticipantColorInfo[],
	theme: Theme,
	preferences: Record<string, number>
): {
	colors: Record<string, string>;
	newPreferences: Record<string, number>;
} {
	const colors: Record<string, string> = {};
	const usedIndices = new Set<number>();
	const newPreferences: Record<string, number> = {};

	// Reserve index 0 for the Moderator (always blue)
	// The Moderator is identified by name "Moderator" with no sessionPath
	const moderator = participants.find((p) => p.name === 'Moderator' && !p.sessionPath);
	if (moderator) {
		colors['Moderator'] = generateParticipantColor(MODERATOR_COLOR_INDEX, theme);
		usedIndices.add(MODERATOR_COLOR_INDEX);
	}

	// First pass: assign colors to participants with existing preferences
	for (const participant of participants) {
		if (colors[participant.name]) continue; // Already assigned (e.g., Moderator)
		if (participant.sessionPath && preferences[participant.sessionPath] !== undefined) {
			const preferredIndex = preferences[participant.sessionPath];
			// Don't allow non-moderators to claim the moderator's reserved index
			if (!usedIndices.has(preferredIndex) && preferredIndex !== MODERATOR_COLOR_INDEX) {
				colors[participant.name] = generateParticipantColor(preferredIndex, theme);
				usedIndices.add(preferredIndex);
			}
		}
	}

	// Second pass: assign colors to remaining participants (skip index 0, reserved for Moderator)
	let nextIndex = 1; // Start at 1, not 0
	for (const participant of participants) {
		if (colors[participant.name]) continue; // Already assigned

		// Find next available index (skip 0)
		while (usedIndices.has(nextIndex) || nextIndex === MODERATOR_COLOR_INDEX) {
			nextIndex++;
		}

		colors[participant.name] = generateParticipantColor(nextIndex, theme);
		usedIndices.add(nextIndex);

		// Save this as the participant's preferred index if they have a sessionPath
		if (participant.sessionPath) {
			newPreferences[participant.sessionPath] = nextIndex;
		}

		nextIndex++;
	}

	return { colors, newPreferences };
}
