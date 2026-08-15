/**
 * Wiring for the two A Cappella global hotkeys.
 *
 * Everything interesting lives in `voice-hotkeys.ts` and `press-hold.ts`; this
 * file is the part that knows about Electron, the settings store, and the
 * running session, and it exists so those two stay testable without any of them.
 *
 * The bindings come from the same `shortcuts` settings map the Shortcuts tab
 * writes, so rebinding a voice hotkey there rebinds the real system-wide combo
 * with no second code path. A settings watcher re-syncs on every change, which
 * is also how switching the Encore Feature off releases both combos: a global
 * shortcut left registered for a feature nobody has enabled is a combo stolen
 * from whatever app the user actually wanted it for.
 */

import type { BrowserWindow } from 'electron';

import type { VoiceOrigin, VoiceScope } from '../../../shared/acappella/protocol';
import type { Shortcut } from '../../../shared/shortcut-types';
import { getGlobalHotkeyRegistry, summonMainWindow } from '../../global-hotkey-manager';
import type { GlobalHotkeyStatus } from '../../../shared/global-hotkeys';
import { logger } from '../../utils/logger';
import type { FloorControlSession } from '../audio/floor-control';
import { createFloorController, type FloorController } from '../audio/floor-control';
import {
	VOICE_HOTKEY_IDS,
	VoiceHotkeyController,
	type VoiceHotkeyId,
	type VoiceHotkeyRefusalInfo,
} from './voice-hotkeys';
import { resolveHoldThresholdMs } from './press-hold';

const LOG_CONTEXT = 'ACappella';

/** The settings blob key A Cappella keeps everything under. Mirrors the registry's. */
const ACAPPELLA_SETTINGS_KEY = 'acappella';

export interface VoiceHotkeySettingsStore {
	get: (key: string, defaultValue?: unknown) => unknown;
	onDidChange?: (key: string, callback: (value: unknown) => void) => void;
}

export interface InstallVoiceHotkeysDeps {
	settingsStore: VoiceHotkeySettingsStore;
	/** The floor's view of the session service. Supplied by the IPC layer. */
	session: FloorControlSession;
	getMainWindow: () => BrowserWindow | null;
	/**
	 * The agent the user is looking at, in the FOCUSED window when there are
	 * several. Null when nothing is focused, which refuses the agent hotkey rather
	 * than guessing.
	 */
	getFocusedAgentSessionId: () => string | null;
	/** Force the recogniser to endpoint. The hold-to-talk release path. */
	endUtterance?: () => void | Promise<void>;
	/** A press was refused. Surfaced to the user by the caller. */
	onRefused?: (info: VoiceHotkeyRefusalInfo) => void;
}

export interface VoiceHotkeyInstallation {
	controller: VoiceHotkeyController;
	/** Re-read settings and rebind. Called by the settings watcher and by tests. */
	sync: () => Record<VoiceHotkeyId, GlobalHotkeyStatus>;
	statuses: () => GlobalHotkeyStatus[];
	/**
	 * The one floor controller, aimed at a scope and an origin.
	 *
	 * Exposed so a paired device presses the SAME state machine the hotkey does
	 * (see `../transport/remote-session.ts`). There is one microphone and one
	 * session, so a second controller would be two state machines racing for the
	 * same device - which is exactly the failure the hotkey path already avoids by
	 * keeping one instance behind a mutable scope.
	 */
	acquireFloor: (scope: VoiceScope, origin?: VoiceOrigin) => FloorController;
	dispose: () => void;
}

/** True only when `encoreFeatures.aCappella` is explicitly on. */
function isEnabled(store: VoiceHotkeySettingsStore): boolean {
	const flags = (store.get('encoreFeatures', {}) ?? {}) as Record<string, unknown>;
	return flags.aCappella === true;
}

/** The A Cappella settings blob's `controls` section, or an empty object. */
export function readVoiceControlSettings(store: VoiceHotkeySettingsStore): Record<string, unknown> {
	const blob = (store.get(ACAPPELLA_SETTINGS_KEY, {}) ?? {}) as { controls?: unknown };
	return (blob.controls ?? {}) as Record<string, unknown>;
}

/**
 * The user's binding for a hotkey id, or undefined when they have never touched
 * it.
 *
 * Undefined and `[]` mean different things and must not be collapsed: the
 * persisted map only holds ids the user has customised, so a missing entry is
 * "take the shipped default" while an empty array is "I cleared this on purpose".
 */
function readHotkeyKeys(store: VoiceHotkeySettingsStore, id: VoiceHotkeyId): string[] | undefined {
	const shortcuts = (store.get('shortcuts', {}) ?? {}) as Record<string, Shortcut | undefined>;
	const entry = shortcuts[id];
	return Array.isArray(entry?.keys) ? entry.keys : undefined;
}

/**
 * Register both voice hotkeys and keep them in step with settings.
 *
 * Safe to call once per process. The returned handle is what the IPC layer uses
 * to answer "is this combo actually bound" for the settings rows.
 */
export function installVoiceHotkeys(deps: InstallVoiceHotkeysDeps): VoiceHotkeyInstallation {
	const registry = getGlobalHotkeyRegistry();

	/**
	 * One floor, whatever the scope.
	 *
	 * There is only ever one microphone and one session, so a controller per scope
	 * would be two state machines racing for the same device. The scope is a
	 * mutable field the hotkey sets immediately before pressing, read by the
	 * floor's own `getScope` seam.
	 */
	let pendingScope: VoiceScope = { kind: 'conductor' };
	/**
	 * Which microphone the next press opens. Same mutable-field pattern as the
	 * scope, and for the same reason: one controller, several surfaces, and the
	 * only thing that differs between them is what the session is credited to.
	 */
	let pendingOrigin: VoiceOrigin = { kind: 'local' };
	let floor: FloorController | null = null;

	const acquireFloor = (scope: VoiceScope, origin?: VoiceOrigin): FloorController => {
		pendingScope = scope;
		pendingOrigin = origin ?? { kind: 'local' };
		if (!floor) {
			floor = createFloorController({
				session: deps.session,
				getScope: () => pendingScope,
				getOrigin: () => pendingOrigin,
				endUtterance: deps.endUtterance,
				idleTimeoutMs: readIdleTimeoutMs(deps.settingsStore),
			});
		}
		return floor;
	};

	const controller = new VoiceHotkeyController({
		registry,
		checkAvailability: () => {
			if (!isEnabled(deps.settingsStore)) {
				return {
					ok: false,
					reason: 'feature-disabled',
					message: 'A Cappella is switched off in Encore Features.',
				};
			}
			// The capability gate itself is async (it stats model files), and a hotkey
			// must not wait on disk. The session's own `checkReadiness` refuses the
			// start and names the missing slot, so an unsatisfied gate surfaces as a
			// `session-error` event rather than as a hotkey that does nothing.
			return { ok: true };
		},
		acquireFloor,
		resolveFocusedAgent: () => {
			const sessionId = deps.getFocusedAgentSessionId();
			return sessionId ? { kind: 'agent', sessionId } : null;
		},
		summon: () => {
			const win = deps.getMainWindow();
			if (win) summonMainWindow(win);
		},
		onRefused: deps.onRefused,
		getHoldThresholdMs: () =>
			resolveHoldThresholdMs(readVoiceControlSettings(deps.settingsStore).holdThresholdMs),
	});

	const sync = (): Record<VoiceHotkeyId, GlobalHotkeyStatus> => {
		if (!isEnabled(deps.settingsStore)) {
			// Released rather than left bound: see the module header.
			for (const id of VOICE_HOTKEY_IDS) registry.clear(id);
			return Object.fromEntries(
				VOICE_HOTKEY_IDS.map((id) => [
					id,
					registry.status(id) ?? { id, keys: [], accelerator: null, registered: false },
				])
			) as Record<VoiceHotkeyId, GlobalHotkeyStatus>;
		}
		const keysById: Partial<Record<VoiceHotkeyId, string[]>> = {};
		for (const id of VOICE_HOTKEY_IDS) {
			const keys = readHotkeyKeys(deps.settingsStore, id);
			if (keys) keysById[id] = keys;
		}
		return controller.sync(keysById);
	};

	sync();

	deps.settingsStore.onDidChange?.('shortcuts', () => sync());
	deps.settingsStore.onDidChange?.('encoreFeatures', () => sync());
	deps.settingsStore.onDidChange?.(ACAPPELLA_SETTINGS_KEY, () => {
		floor?.configure({ idleTimeoutMs: readIdleTimeoutMs(deps.settingsStore) });
	});

	logger.info(`Voice hotkeys installed (${controller.capability})`, LOG_CONTEXT);

	return {
		controller,
		sync,
		acquireFloor,
		statuses: () =>
			VOICE_HOTKEY_IDS.map(
				(id) => registry.status(id) ?? { id, keys: [], accelerator: null, registered: false }
			),
		dispose: () => {
			controller.dispose();
			void floor?.dispose();
			floor = null;
		},
	};
}

/** The idle timeout from settings. Clamped by `resolveFloorControlConfig` downstream. */
function readIdleTimeoutMs(store: VoiceHotkeySettingsStore): number | undefined {
	const value = readVoiceControlSettings(store).idleTimeoutMs;
	return typeof value === 'number' ? value : undefined;
}

export {
	createVoiceHotkeyController,
	defaultVoiceHotkeyKeys,
	VOICE_HOTKEY_IDS,
	VoiceHotkeyController,
} from './voice-hotkeys';
export type {
	VoiceFloorSurface,
	VoiceHotkeyDeps,
	VoiceHotkeyId,
	VoiceHotkeyRefusal,
	VoiceHotkeyRefusalInfo,
} from './voice-hotkeys';
export {
	createPressHoldDetector,
	describePressHoldCapability,
	PressHoldDetector,
	resolveHoldThresholdMs,
	resolvePlatformKeyStateProbe,
	resolvePressHoldCapability,
	setKeyStateProbe,
} from './press-hold';
export type { KeyStateProbe, PressHoldCapability, PressHoldOptions } from './press-hold';
