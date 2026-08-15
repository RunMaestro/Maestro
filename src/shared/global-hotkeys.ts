/**
 * The shape of a system-wide hotkey's registration state.
 *
 * Shared because the fact travels: `src/main/global-hotkey-manager.ts` produces
 * it, the preload bridge carries it, and the Settings rows render it inline
 * ("registered", or "the OS already owns this combo"). Keeping the contract in
 * one pure-data module is what stops the renderer from importing a module that
 * reaches for `electron`.
 */

/** The id of the original "bring Maestro to the front" hotkey. */
export const SHOW_MAESTRO_HOTKEY_ID = 'showMaestro';

/** Opens a Conductor-scoped voice session without stealing window focus. */
export const VOICE_CONDUCTOR_HOTKEY_ID = 'voiceConductor';

/** Summons Maestro and opens a voice session bound to the focused agent. */
export const VOICE_AGENT_HOTKEY_ID = 'voiceCurrentAgent';

/** One named hotkey the registry knows how to bind. */
export interface GlobalHotkeyDefinition {
	id: string;
	/** Shown in Settings rows and in the failure toast. */
	label: string;
	description: string;
	/**
	 * What the hotkey binds to out of the box.
	 *
	 * `showMaestro` ships EMPTY on purpose: a system-wide combo nobody asked for
	 * is a combo stolen from whatever the user already had on it. The two voice
	 * hotkeys do ship bound, because a voice assistant with no way to summon it is
	 * not a feature, and they only ever register while the A Cappella Encore
	 * Feature is on - which is itself opt-in.
	 */
	defaultKeys: string[];
}

/**
 * Every system-wide hotkey Maestro can register.
 *
 * The voice combos avoid every binding in `DEFAULT_SHORTCUTS`: a GLOBAL hotkey
 * outranks the in-app one, so shipping a global default that shadows an existing
 * in-app shortcut would silently break it everywhere including inside Maestro.
 */
export const GLOBAL_HOTKEY_DEFINITIONS: readonly GlobalHotkeyDefinition[] = Object.freeze([
	{
		id: SHOW_MAESTRO_HOTKEY_ID,
		label: 'Show Maestro',
		description: 'Bring Maestro to the foreground from any application.',
		defaultKeys: [],
	},
	{
		id: VOICE_CONDUCTOR_HOTKEY_ID,
		label: 'Talk to Maestro',
		description:
			'Open a voice session with the Conductor without stealing focus, so you can talk while working in another app.',
		defaultKeys: ['Meta', 'Alt', 'v'],
	},
	{
		id: VOICE_AGENT_HOTKEY_ID,
		label: 'Talk to Current Agent',
		description: 'Summon Maestro and open a voice session bound to the agent you are looking at.',
		defaultKeys: ['Meta', 'Alt', 'a'],
	},
]);

const DEFINITIONS_BY_ID = new Map(GLOBAL_HOTKEY_DEFINITIONS.map((entry) => [entry.id, entry]));

export function getGlobalHotkeyDefinition(id: string): GlobalHotkeyDefinition | undefined {
	return DEFINITIONS_BY_ID.get(id);
}

/** The display name for a hotkey id, falling back to the id so a toast is never blank. */
export function globalHotkeyLabel(id: string): string {
	return DEFINITIONS_BY_ID.get(id)?.label ?? id;
}

/** The shipped binding for an id, or an empty array for one that ships unbound. */
export function defaultGlobalHotkeyKeys(id: string): string[] {
	return [...(DEFINITIONS_BY_ID.get(id)?.defaultKeys ?? [])];
}

/** Why a registration did not take. */
export type GlobalHotkeyFailureReason =
	/** The key array had no non-modifier key, so there is no accelerator to bind. */
	| 'invalid-accelerator'
	/** Another Maestro hotkey already holds this combo. `conflictsWith` names it. */
	| 'maestro-conflict'
	/** Electron refused: the OS or another application owns the combo. */
	| 'os-conflict'
	/** `globalShortcut.register` threw. */
	| 'register-error';

/** What a hotkey id is currently doing. One of these exists per known id. */
export interface GlobalHotkeyStatus {
	id: string;
	/** The key array as stored in settings. Empty means the user cleared it. */
	keys: string[];
	/** The Electron accelerator, or null when the keys do not translate to one. */
	accelerator: string | null;
	registered: boolean;
	reason?: GlobalHotkeyFailureReason;
	/** Set only for `maestro-conflict`: the id already holding the combo. */
	conflictsWith?: string;
	/** Human-readable, ready for a settings row. Present whenever `reason` is. */
	message?: string;
}

/**
 * One line describing a status, for a settings row or a toast.
 *
 * Derived rather than stored so the copy cannot drift between the four places
 * that show it. `combo` is passed in already formatted, because only the
 * renderer knows whether to draw the macOS glyphs or the Windows words - see
 * `formatShortcutKeys()`.
 */
export function describeGlobalHotkeyStatus(status: GlobalHotkeyStatus, combo: string): string {
	if (status.registered) return `Registered as ${combo}`;
	if (!status.reason) return 'Not set';
	switch (status.reason) {
		case 'invalid-accelerator':
			return 'Add a non-modifier key to this combination.';
		case 'maestro-conflict':
			return `${combo} is already used by another Maestro hotkey. Pick a different combo.`;
		case 'os-conflict':
			return `${combo} is already taken by another app. Pick a different combo.`;
		case 'register-error':
			return status.message ?? `${combo} could not be registered.`;
	}
}
