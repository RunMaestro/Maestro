/**
 * Renderer writes to the `acappella` settings blob, one section at a time.
 *
 * A Cappella keeps everything it persists in ONE settings object: providers,
 * voices, the Voice Controls (`controls`) and the HUD's own preferences (`ui`).
 * There is no per-field setter, so changing one field is a read of the whole
 * blob, a merge, and a write of the whole blob.
 *
 * Two things about that sequence are easy to get wrong, and both lose a setting
 * without an error:
 *
 *   1. **Write the patch, not the form.** A writer that saves every field it
 *      holds turns the DEFAULTS it was showing into stored values. The Voice
 *      Controls panel did that, which is why a later change to a default (the
 *      wake phrase, then the send phrases) reached nobody who had ever touched
 *      a slider, and needed a migration each time.
 *   2. **One write at a time.** Two surfaces write this blob (Settings and the
 *      HUD), and a read-modify-write that interleaves with another drops
 *      whichever write landed first. Every patch here goes through one queue.
 *
 * Main reads the blob per turn (`readVoiceProviderSettings`), so a patch
 * written here applies to the next thing said with no further signal.
 */

import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';

/** Settings key holding everything A Cappella persists. Mirrors the main-side constant. */
export const ACAPPELLA_SETTINGS_KEY = 'acappella';

/** The sections a renderer surface patches field by field. */
export type VoiceSettingsSection = 'ui' | 'controls' | 'voiceStudio';

export interface VoiceSettingsBlob {
	ui?: Record<string, unknown>;
	controls?: Record<string, unknown>;
	[key: string]: unknown;
}

// Module scope: the callers are a store, a hook and a HUD panel, and a queue
// held by any one of them would not order the other two.
const writes = createKeyedWriteQueue();

/** The stored blob, or an empty one before anything was saved. */
export async function readVoiceSettingsBlob(): Promise<VoiceSettingsBlob> {
	return ((await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) ?? {}) as VoiceSettingsBlob;
}

/**
 * Merge `patch` into one section and leave every other field as it is stored.
 *
 * Only the keys in `patch` are written. A field the caller did not name keeps
 * whatever is on disk, including "nothing", which is what lets a default change
 * later.
 */
export function patchVoiceSettingsSection(
	section: VoiceSettingsSection,
	// `object` rather than a string-keyed record: callers pass typed patches
	// (`Partial<VoiceUiPrefs>`), and an interface has no index signature.
	patch: object
): Promise<void> {
	return writes.enqueue(ACAPPELLA_SETTINGS_KEY, async () => {
		const stored = await readVoiceSettingsBlob();
		await window.maestro.settings.set(ACAPPELLA_SETTINGS_KEY, {
			...stored,
			[section]: { ...(stored[section] ?? {}), ...patch },
		});
	});
}
