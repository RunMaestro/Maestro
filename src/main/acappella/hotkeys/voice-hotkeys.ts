/**
 * The two A Cappella global hotkeys.
 *
 * `voiceConductor` opens a Conductor-scoped session and deliberately does NOT
 * touch window focus: the point of a voice assistant is talking to it while
 * doing something else, and a hotkey that yanks a window to the front every time
 * you speak is a hotkey people stop pressing. `voiceCurrentAgent` is the
 * opposite gesture and summons Maestro on purpose, because "the current agent"
 * is a thing you have to be looking at to mean.
 *
 * Both route through `audio/floor-control.ts` rather than driving the session
 * service themselves. That module already owns what a second press means, what a
 * release means, and when an untouched microphone goes cold; a hotkey that
 * re-derived any of it would drift from the HUD button and the phone button
 * within a week.
 *
 * Every seam here is SYNCHRONOUS on purpose. A hotkey handler that awaits a
 * capability gate before deciding whether to open the floor is a hotkey whose
 * behaviour depends on disk latency, and keyboard input that is sometimes
 * dropped is worse than a feature that is off.
 */

import type { VoiceScope, WakeSource } from '../../../shared/acappella/protocol';
import {
	VOICE_AGENT_HOTKEY_ID,
	VOICE_CONDUCTOR_HOTKEY_ID,
	defaultGlobalHotkeyKeys,
	getGlobalHotkeyDefinition,
	type GlobalHotkeyStatus,
} from '../../../shared/global-hotkeys';
import type { GlobalHotkeyRegistry } from '../../global-hotkey-manager';
import { logger } from '../../utils/logger';
import type { FloorControlConfig, FloorMode } from '../audio/floor-control';
import {
	PressHoldDetector,
	resolvePlatformKeyStateProbe,
	resolvePressHoldCapability,
	type KeyStateProbe,
	type PressHoldCapability,
} from './press-hold';

const LOG_CONTEXT = 'ACappella';

export const VOICE_HOTKEY_IDS = [VOICE_CONDUCTOR_HOTKEY_ID, VOICE_AGENT_HOTKEY_ID] as const;

export type VoiceHotkeyId = (typeof VOICE_HOTKEY_IDS)[number];

/** The shipped bindings, read from the one shared definition table. */
export function defaultVoiceHotkeyKeys(): Record<VoiceHotkeyId, string[]> {
	return {
		[VOICE_CONDUCTOR_HOTKEY_ID]: defaultGlobalHotkeyKeys(VOICE_CONDUCTOR_HOTKEY_ID),
		[VOICE_AGENT_HOTKEY_ID]: defaultGlobalHotkeyKeys(VOICE_AGENT_HOTKEY_ID),
	};
}

/**
 * The slice of `FloorController` a hotkey drives.
 *
 * `FloorController` satisfies this structurally, so nothing has to be adapted;
 * stating it narrowly is what keeps a hotkey from growing the ability to route a
 * turn or cancel speech behind the floor's back.
 */
export interface VoiceFloorSurface {
	readonly mode: FloorMode;
	configure(overrides: Partial<FloorControlConfig>): void;
	press(source?: WakeSource): Promise<void>;
	release(source?: WakeSource): Promise<void>;
}

/** Why a press did nothing. Distinct values because the user's next move differs. */
export type VoiceHotkeyRefusal =
	/** The A Cappella Encore Feature is switched off. */
	| 'feature-disabled'
	/** A required slot (model, runtime, microphone) is unsatisfied. */
	| 'not-ready'
	/** `voiceCurrentAgent` fired with nothing focused. */
	| 'no-focused-agent'
	/** Nothing is holding a floor to press. */
	| 'no-floor';

export interface VoiceHotkeyRefusalInfo {
	id: VoiceHotkeyId;
	reason: VoiceHotkeyRefusal;
	/** Ready to show. Carries the capability gate's own sentence when it has one. */
	message: string;
}

export interface VoiceHotkeyDeps {
	registry: GlobalHotkeyRegistry;
	/**
	 * Whether A Cappella is usable right now, or the sentence explaining why not.
	 *
	 * Synchronous, and therefore a CACHED view of the capability gate rather than
	 * a fresh resolve. See the module header: a hotkey must not be able to take
	 * longer to respond because a model file is being stat'ed.
	 */
	checkAvailability: () =>
		| { ok: true }
		| { ok: false; reason: VoiceHotkeyRefusal; message: string };
	/** The floor for a scope, or null when A Cappella has never been started. */
	acquireFloor: (scope: VoiceScope) => VoiceFloorSurface | null;
	/** The agent the user is looking at - in the FOCUSED window, when there are several. */
	resolveFocusedAgent: () => VoiceScope | null;
	/** Bring Maestro to the front. Only `voiceCurrentAgent` calls it. */
	summon: () => void;
	/** A press was refused. The seam a toast or HUD line binds to. */
	onRefused?: (info: VoiceHotkeyRefusalInfo) => void;
	/** Tap-vs-hold threshold, read per press so a settings change takes effect live. */
	getHoldThresholdMs?: () => number;
	/**
	 * Override the key-state probe. `undefined` uses the platform's, which is how
	 * the capability ends up honest; tests pass one to exercise the hold path.
	 */
	probe?: KeyStateProbe | null;
}

/**
 * Owns the registration and the press semantics of both voice hotkeys.
 *
 * One instance for the app. Rebinding is `sync()` with new keys; the registry
 * releases the old combo and reports per-id failure on its own.
 */
export class VoiceHotkeyController {
	/** What these hotkeys can do on this machine. Shown, never silently assumed. */
	readonly capability: PressHoldCapability;

	private readonly deps: VoiceHotkeyDeps;
	private readonly probe: KeyStateProbe | null;
	private readonly detectors = new Map<VoiceHotkeyId, PressHoldDetector>();
	/** The floor a hold opened, so the release closes the same one. */
	private readonly heldFloors = new Map<VoiceHotkeyId, VoiceFloorSurface>();
	/** The mode the floor was in before a hold forced `hold-to-talk`. */
	private readonly restoreModes = new Map<VoiceHotkeyId, FloorMode>();
	private disposed = false;

	constructor(deps: VoiceHotkeyDeps) {
		this.deps = deps;
		this.probe = deps.probe === undefined ? resolvePlatformKeyStateProbe() : deps.probe;
		this.capability = resolvePressHoldCapability(this.probe);

		for (const id of VOICE_HOTKEY_IDS) {
			this.deps.registry.define(id, () => this.handleTrigger(id));
		}
	}

	/**
	 * Bind (or rebind) both hotkeys.
	 *
	 * A missing entry takes the shipped default rather than unbinding: the
	 * persisted `shortcuts` blob only contains ids the user has touched, so an
	 * absent key is "never customised", not "deliberately cleared". An explicitly
	 * empty array IS a deliberate clear and is honoured.
	 */
	sync(
		keysById: Partial<Record<VoiceHotkeyId, string[]>> = {}
	): Record<VoiceHotkeyId, GlobalHotkeyStatus> {
		const statuses = {} as Record<VoiceHotkeyId, GlobalHotkeyStatus>;
		for (const id of VOICE_HOTKEY_IDS) {
			const keys = keysById[id] ?? defaultGlobalHotkeyKeys(id);
			// A rebind mid-hold would leave the floor open with nothing watching it.
			this.endHold(id);
			statuses[id] = this.deps.registry.setKeys(id, keys);
		}
		return statuses;
	}

	/** Release both combos and end any press in flight. Safe to call twice. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const id of VOICE_HOTKEY_IDS) {
			this.endHold(id);
			this.deps.registry.remove(id);
		}
	}

	status(id: VoiceHotkeyId): GlobalHotkeyStatus | null {
		return this.deps.registry.status(id);
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * The shortcut fired.
	 *
	 * The detector is built lazily per gesture rather than at registration,
	 * because the accelerator changes on rebind and the threshold changes in
	 * settings, and a detector captured at startup would answer with both stale.
	 */
	private handleTrigger(id: VoiceHotkeyId): void {
		if (this.disposed) return;

		const existing = this.detectors.get(id);
		if (existing?.isPressed) {
			// Auto-repeat, or a second fire while a hold is being classified.
			existing.trigger();
			return;
		}

		const accelerator = this.deps.registry.status(id)?.accelerator ?? id;
		const detector = new PressHoldDetector({
			accelerator,
			holdThresholdMs: this.deps.getHoldThresholdMs?.(),
			probe: this.probe,
			onTap: () => this.handleTap(id),
			onHoldStart: () => this.handleHoldStart(id),
			onHoldEnd: () => this.endHold(id),
		});
		this.detectors.set(id, detector);
		detector.trigger();
	}

	/** A tap toggles the floor: open it if closed, close it if open. */
	private handleTap(id: VoiceHotkeyId): void {
		const floor = this.beginGesture(id);
		if (!floor) return;
		floor.configure({ mode: 'tap-to-toggle' });
		void floor.press('hotkey');
	}

	/** A hold opens the floor and keeps it open until the key comes up. */
	private handleHoldStart(id: VoiceHotkeyId): void {
		const floor = this.beginGesture(id);
		if (!floor) return;
		this.restoreModes.set(id, floor.mode);
		floor.configure({ mode: 'hold-to-talk' });
		this.heldFloors.set(id, floor);
		void floor.press('hotkey');
	}

	/**
	 * End a hold, whatever ended it: the key came up, the binding changed, or the
	 * app is shutting down. Idempotent, and restores the mode the user chose so a
	 * push-to-talk gesture does not silently convert their session to push-to-talk
	 * forever.
	 */
	private endHold(id: VoiceHotkeyId): void {
		const detector = this.detectors.get(id);
		const floor = this.heldFloors.get(id);
		this.heldFloors.delete(id);
		this.detectors.delete(id);

		if (floor) {
			void floor.release('hotkey');
			const restore = this.restoreModes.get(id);
			if (restore) floor.configure({ mode: restore });
		}
		this.restoreModes.delete(id);
		// Disposing after the release, so the detector's own `onHoldEnd` finds no
		// floor left to release and cannot double-fire.
		detector?.dispose();
	}

	/**
	 * Everything both gestures need before they touch the floor: the feature is
	 * on, the gate is satisfied, a scope resolves, and a floor exists.
	 *
	 * @returns the floor to act on, or null after reporting why not.
	 */
	private beginGesture(id: VoiceHotkeyId): VoiceFloorSurface | null {
		const availability = this.deps.checkAvailability();
		if (!availability.ok) {
			this.refuse(id, availability.reason, availability.message);
			return null;
		}

		let scope: VoiceScope;
		if (id === VOICE_AGENT_HOTKEY_ID) {
			// Summoned BEFORE the scope is resolved: the window that comes forward is
			// the one whose agent the session binds to, and reversing the order would
			// let a focus change between the two steps bind the wrong agent.
			this.deps.summon();
			const focused = this.deps.resolveFocusedAgent();
			if (!focused) {
				// Deliberately not falling back to the Conductor. The user asked to
				// talk to a specific agent; guessing one is how a spoken instruction
				// lands in the wrong terminal.
				this.refuse(
					id,
					'no-focused-agent',
					'No agent is focused, so there is nothing to talk to yet.'
				);
				return null;
			}
			scope = focused;
		} else {
			scope = { kind: 'conductor' };
		}

		const floor = this.deps.acquireFloor(scope);
		if (!floor) {
			this.refuse(id, 'no-floor', 'A Cappella is not running yet.');
			return null;
		}
		return floor;
	}

	private refuse(id: VoiceHotkeyId, reason: VoiceHotkeyRefusal, message: string): void {
		const label = getGlobalHotkeyDefinition(id)?.label ?? id;
		logger.info(`Voice hotkey '${label}' refused: ${message}`, LOG_CONTEXT);
		try {
			this.deps.onRefused?.({ id, reason, message });
		} catch (err) {
			logger.warn(`Voice hotkey refusal listener threw: ${err}`, LOG_CONTEXT);
		}
	}
}

/** Sugar, matching the rest of A Cappella's factories. */
export function createVoiceHotkeyController(deps: VoiceHotkeyDeps): VoiceHotkeyController {
	return new VoiceHotkeyController(deps);
}
