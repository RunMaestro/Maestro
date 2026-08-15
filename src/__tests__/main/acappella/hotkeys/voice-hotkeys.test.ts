/**
 * @file voice-hotkeys.test.ts
 *
 * The two A Cappella hotkeys: what each one does to window focus, how a scope is
 * resolved, and every way a press is refused rather than silently doing nothing.
 *
 * The focus rule is the interesting one and it is asymmetric on purpose. Talking
 * to the Conductor must NOT steal focus, because the whole point is speaking to
 * Maestro from inside another application; talking to the current agent must,
 * because "current" is a thing you have to be looking at to mean.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('electron', () => ({
	app: { show: vi.fn() },
	BrowserWindow: class {},
	globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isMacOS: () => true,
	isWindows: () => false,
	isLinux: () => false,
}));

import type { VoiceScope, WakeSource } from '../../../../shared/acappella/protocol';
import {
	VOICE_AGENT_HOTKEY_ID,
	VOICE_CONDUCTOR_HOTKEY_ID,
} from '../../../../shared/global-hotkeys';
import {
	GlobalHotkeyRegistry,
	type GlobalShortcutBackend,
} from '../../../../main/global-hotkey-manager';
import type { FloorControlConfig } from '../../../../main/acappella/audio/floor-control';
import {
	VoiceHotkeyController,
	createVoiceHotkeyController,
	defaultVoiceHotkeyKeys,
	type VoiceFloorSurface,
	type VoiceHotkeyRefusalInfo,
} from '../../../../main/acappella/hotkeys/voice-hotkeys';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeBackend implements GlobalShortcutBackend {
	readonly bound = new Map<string, () => void>();
	register(accelerator: string, callback: () => void): boolean {
		this.bound.set(accelerator, callback);
		return true;
	}
	unregister(accelerator: string): void {
		this.bound.delete(accelerator);
	}
	fire(accelerator: string): void {
		this.bound.get(accelerator)?.();
	}
}

class FakeFloor implements VoiceFloorSurface {
	mode: FloorControlConfig['mode'] = 'tap-to-toggle';
	readonly presses: WakeSource[] = [];
	readonly releases: WakeSource[] = [];
	readonly modes: string[] = [];

	configure(overrides: Partial<FloorControlConfig>): void {
		if (overrides.mode) {
			this.mode = overrides.mode;
			this.modes.push(overrides.mode);
		}
	}
	async press(source: WakeSource = 'client-button'): Promise<void> {
		this.presses.push(source);
	}
	async release(source: WakeSource = 'client-button'): Promise<void> {
		this.releases.push(source);
	}
}

describe('VoiceHotkeyController', () => {
	let backend: FakeBackend;
	let registry: GlobalHotkeyRegistry;
	let floor: FakeFloor;
	let scopes: VoiceScope[];
	let summons: number;
	let refusals: VoiceHotkeyRefusalInfo[];
	let available: { ok: true } | { ok: false; reason: 'feature-disabled'; message: string };
	let focusedAgent: string | null;

	function build(overrides: Record<string, unknown> = {}): VoiceHotkeyController {
		return createVoiceHotkeyController({
			registry,
			checkAvailability: () => available,
			acquireFloor: (scope) => {
				scopes.push(scope);
				return floor;
			},
			resolveFocusedAgent: () => (focusedAgent ? { kind: 'agent', sessionId: focusedAgent } : null),
			summon: () => {
				summons += 1;
			},
			onRefused: (info) => refusals.push(info),
			// Forces tap-only, which is what every platform gets today.
			probe: null,
			...overrides,
		});
	}

	beforeEach(() => {
		backend = new FakeBackend();
		registry = new GlobalHotkeyRegistry(backend);
		floor = new FakeFloor();
		scopes = [];
		summons = 0;
		refusals = [];
		available = { ok: true };
		focusedAgent = 'agent-7';
	});

	it('binds both hotkeys to their shipped defaults', () => {
		const controller = build();
		const statuses = controller.sync();

		expect(statuses[VOICE_CONDUCTOR_HOTKEY_ID].registered).toBe(true);
		expect(statuses[VOICE_AGENT_HOTKEY_ID].registered).toBe(true);
		expect(statuses[VOICE_CONDUCTOR_HOTKEY_ID].keys).toEqual(
			defaultVoiceHotkeyKeys()[VOICE_CONDUCTOR_HOTKEY_ID]
		);
	});

	it('ships defaults that do not collide with each other', () => {
		const controller = build();
		const statuses = controller.sync();
		expect(statuses[VOICE_AGENT_HOTKEY_ID].reason).toBeUndefined();
		expect(statuses[VOICE_CONDUCTOR_HOTKEY_ID].accelerator).not.toBe(
			statuses[VOICE_AGENT_HOTKEY_ID].accelerator
		);
	});

	it('honours an explicitly cleared binding rather than restoring the default', () => {
		const controller = build();
		const statuses = controller.sync({ [VOICE_CONDUCTOR_HOTKEY_ID]: [] });
		expect(statuses[VOICE_CONDUCTOR_HOTKEY_ID].accelerator).toBeNull();
		expect(statuses[VOICE_AGENT_HOTKEY_ID].registered).toBe(true);
	});

	it('opens a Conductor session without touching window focus', () => {
		const controller = build();
		const statuses = controller.sync();
		backend.fire(statuses[VOICE_CONDUCTOR_HOTKEY_ID].accelerator!);

		expect(summons).toBe(0);
		expect(scopes).toEqual([{ kind: 'conductor' }]);
		expect(floor.presses).toEqual(['hotkey']);
		expect(floor.mode).toBe('tap-to-toggle');
	});

	it('summons Maestro and binds the focused agent', () => {
		const controller = build();
		const statuses = controller.sync();
		backend.fire(statuses[VOICE_AGENT_HOTKEY_ID].accelerator!);

		expect(summons).toBe(1);
		expect(scopes).toEqual([{ kind: 'agent', sessionId: 'agent-7' }]);
	});

	it('refuses the agent hotkey rather than guessing when nothing is focused', () => {
		focusedAgent = null;
		const controller = build();
		const statuses = controller.sync();
		backend.fire(statuses[VOICE_AGENT_HOTKEY_ID].accelerator!);

		expect(refusals.map((r) => r.reason)).toEqual(['no-focused-agent']);
		// Notably NOT a fall back to the Conductor: a spoken instruction must not
		// land somewhere the user did not aim it.
		expect(scopes).toHaveLength(0);
		expect(floor.presses).toHaveLength(0);
	});

	it('refuses with a reason when the Encore Feature is off', () => {
		available = { ok: false, reason: 'feature-disabled', message: 'A Cappella is switched off.' };
		const controller = build();
		const statuses = controller.sync();
		backend.fire(statuses[VOICE_CONDUCTOR_HOTKEY_ID].accelerator!);

		expect(refusals[0]).toMatchObject({
			id: VOICE_CONDUCTOR_HOTKEY_ID,
			reason: 'feature-disabled',
		});
		expect(floor.presses).toHaveLength(0);
	});

	it('refuses when nothing can give it a floor', () => {
		const controller = build({ acquireFloor: () => null });
		const statuses = controller.sync();
		backend.fire(statuses[VOICE_CONDUCTOR_HOTKEY_ID].accelerator!);

		expect(refusals.map((r) => r.reason)).toEqual(['no-floor']);
	});

	it('reports tap-only on a platform with no key-release signal', () => {
		expect(build().capability).toBe('tap-only');
	});

	it('holds the floor open while the key is down when a probe exists', () => {
		vi.useFakeTimers();
		try {
			let now = 0;
			let down = true;
			const controller = new VoiceHotkeyController({
				registry,
				checkAvailability: () => available,
				acquireFloor: () => floor,
				resolveFocusedAgent: () => null,
				summon: vi.fn(),
				probe: () => down,
				getHoldThresholdMs: () => 300,
			});
			const statuses = controller.sync();
			const accelerator = statuses[VOICE_CONDUCTOR_HOTKEY_ID].accelerator!;

			vi.setSystemTime(now);
			backend.fire(accelerator);
			// Past the threshold with the key still down: the floor opens in hold mode.
			now += 400;
			vi.setSystemTime(now);
			vi.advanceTimersByTime(400);
			expect(floor.mode).toBe('hold-to-talk');
			expect(floor.presses).toEqual(['hotkey']);

			down = false;
			now += 50;
			vi.setSystemTime(now);
			vi.advanceTimersByTime(50);
			expect(floor.releases).toEqual(['hotkey']);
			// The user's own mode is restored: a push-to-talk gesture must not convert
			// the session to push-to-talk forever.
			expect(floor.mode).toBe('tap-to-toggle');
		} finally {
			vi.useRealTimers();
		}
	});

	it('dispose releases both combos', () => {
		const controller = build();
		controller.sync();
		controller.dispose();

		expect(backend.bound.size).toBe(0);
		expect(registry.status(VOICE_CONDUCTOR_HOTKEY_ID)).toBeNull();
	});

	it('ignores presses after dispose', () => {
		const controller = build();
		const statuses = controller.sync();
		const accelerator = statuses[VOICE_CONDUCTOR_HOTKEY_ID].accelerator!;
		controller.dispose();
		backend.fire(accelerator);

		expect(floor.presses).toHaveLength(0);
	});
});
