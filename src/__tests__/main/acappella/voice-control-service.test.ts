/**
 * @file voice-control-service.test.ts
 * @description The one entry point `maestro-cli voice` reaches: a request is
 * read off the wire, held to the Encore gate, and run by the handler of its own
 * action. A refusal a handler raises on purpose comes back as a reason; any
 * other error stays an error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
	VOICE_DISABLED_REASON,
	VoiceControlRefusal,
	registerVoiceControlService,
	runVoiceControlRequest,
	type VoiceControlHandlers,
} from '../../../main/acappella/voice-control-service';

/** Handlers that fail loudly unless a test replaces the one it calls. */
function handlers(overrides: Partial<VoiceControlHandlers> = {}): VoiceControlHandlers {
	const unexpected = (action: string) => () => {
		throw new Error(`unexpected handler: ${action}`);
	};
	return new Proxy(overrides, {
		get: (target, action: string) =>
			(target as Record<string, unknown>)[action] ?? unexpected(action),
	}) as VoiceControlHandlers;
}

describe('runVoiceControlRequest', () => {
	let release: (() => void) | null = null;

	beforeEach(() => {
		release = null;
	});
	afterEach(() => {
		release?.();
	});

	it('refuses a request it cannot read', async () => {
		release = registerVoiceControlService(handlers(), () => true);
		expect(await runVoiceControlRequest({ action: 'launch-missiles' })).toEqual({
			ok: false,
			reason: 'Unknown voice request.',
		});
		expect(await runVoiceControlRequest(undefined)).toMatchObject({ ok: false });
	});

	it('says voice is not available before the handlers are registered', async () => {
		expect(await runVoiceControlRequest({ action: 'status' })).toEqual({
			ok: false,
			reason: 'Voice is not available in this build.',
		});
	});

	it('runs the handler of the action and returns its result', async () => {
		const stop = vi.fn().mockResolvedValue({ session: null });
		release = registerVoiceControlService(handlers({ stop }), () => true);

		expect(await runVoiceControlRequest({ action: 'stop' })).toEqual({
			ok: true,
			result: { session: null },
		});
		expect(stop).toHaveBeenCalledWith({ action: 'stop' });
	});

	it('hands the handler the request as parsed, not as sent', async () => {
		const wait = vi.fn().mockResolvedValue({ waitMs: 1500 });
		release = registerVoiceControlService(handlers({ wait }), () => true);

		await runVoiceControlRequest({ action: 'wait', waitMs: 1500, smuggled: true });

		expect(wait).toHaveBeenCalledWith({ action: 'wait', waitMs: 1500 });
	});

	it('refuses an action that needs voice while it is switched off, without running it', async () => {
		const start = vi.fn();
		release = registerVoiceControlService(handlers({ start }), () => false);

		expect(await runVoiceControlRequest({ action: 'start', scope: { kind: 'conductor' } })).toEqual(
			{ ok: false, reason: VOICE_DISABLED_REASON }
		);
		expect(start).not.toHaveBeenCalled();
	});

	it('still ends a session and revokes a device while voice is switched off', async () => {
		// Switching the feature off is exactly when someone wants to close a
		// microphone or cut a phone loose.
		const stop = vi.fn().mockResolvedValue({ session: null });
		const revoke = vi.fn().mockResolvedValue({ deviceId: 'd1' });
		release = registerVoiceControlService(handlers({ stop, 'revoke-device': revoke }), () => false);

		expect(await runVoiceControlRequest({ action: 'stop' })).toMatchObject({ ok: true });
		expect(await runVoiceControlRequest({ action: 'revoke-device', deviceId: 'd1' })).toMatchObject(
			{ ok: true, result: { deviceId: 'd1' } }
		);
	});

	it('answers a refusal a handler raised as a reason', async () => {
		release = registerVoiceControlService(
			handlers({
				'revoke-device': async () => {
					throw new VoiceControlRefusal('No paired device has the id "d9".');
				},
			}),
			() => true
		);

		expect(await runVoiceControlRequest({ action: 'revoke-device', deviceId: 'd9' })).toEqual({
			ok: false,
			reason: 'No paired device has the id "d9".',
		});
	});

	it('lets any other error through, because that one is a bug', async () => {
		release = registerVoiceControlService(
			handlers({
				latency: async () => {
					throw new Error('boom');
				},
			}),
			() => true
		);

		await expect(runVoiceControlRequest({ action: 'latency' })).rejects.toThrow('boom');
	});

	it('answers with the newest registration, and unregistering an old one changes nothing', async () => {
		const first = registerVoiceControlService(
			handlers({ stop: async () => ({ session: null }) }),
			() => true
		);
		const second = vi.fn().mockResolvedValue({ session: null });
		release = registerVoiceControlService(handlers({ stop: second }), () => true);

		first();
		await runVoiceControlRequest({ action: 'stop' });

		expect(second).toHaveBeenCalledTimes(1);
	});
});
