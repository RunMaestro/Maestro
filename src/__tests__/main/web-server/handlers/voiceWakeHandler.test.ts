/**
 * @file voiceWakeHandler.test.ts
 *
 * `maestro-cli voice wake`'s arrival in the desktop: the bridge message goes to
 * the one enrollment entry point the IPC channel also calls, a refusal is a
 * successful round trip, and only a throw is a failed one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/acappella/wake/wake-enrollment-service', () => ({
	runWakeEnrollmentRequest: vi.fn(),
}));

import { runWakeEnrollmentRequest } from '../../../../main/acappella/wake/wake-enrollment-service';
import {
	VOICE_WAKE_ENROLLMENT_MESSAGE,
	handleVoiceWakeEnrollment,
} from '../../../../main/web-server/handlers/messageHandlers/voiceWake';

const client = { id: 'cli-1' } as never;

function context() {
	const sent: Array<Record<string, unknown>> = [];
	return {
		sent,
		ctx: {
			send: (_client: unknown, message: Record<string, unknown>) => sent.push(message),
		} as never,
	};
}

describe('handleVoiceWakeEnrollment', () => {
	beforeEach(() => vi.clearAllMocks());

	it("answers with the entry point's reply, under the request id", async () => {
		const reply = { ok: true as const, status: null, phrases: ['hey scout'] };
		vi.mocked(runWakeEnrollmentRequest).mockResolvedValue(reply);
		const { ctx, sent } = context();

		await handleVoiceWakeEnrollment(ctx, client, {
			type: VOICE_WAKE_ENROLLMENT_MESSAGE,
			requestId: 'req-7',
			request: { action: 'list' },
		} as never);

		expect(runWakeEnrollmentRequest).toHaveBeenCalledWith({ action: 'list' });
		expect(sent).toEqual([
			{ type: 'voice_wake_enrollment_result', success: true, reply, requestId: 'req-7' },
		]);
	});

	it('treats a refusal as an answer, not a failure', async () => {
		const reply = { ok: false as const, reason: 'Wait for training to finish.' };
		vi.mocked(runWakeEnrollmentRequest).mockResolvedValue(reply);
		const { ctx, sent } = context();

		await handleVoiceWakeEnrollment(ctx, client, { requestId: 'r', request: {} } as never);

		expect(sent[0]).toMatchObject({ success: true, reply });
	});

	it('reports a throw as a failed round trip', async () => {
		vi.mocked(runWakeEnrollmentRequest).mockRejectedValue(new Error('disk full'));
		const { ctx, sent } = context();

		await handleVoiceWakeEnrollment(ctx, client, { requestId: 'r', request: {} } as never);

		expect(sent).toEqual([
			{ type: 'voice_wake_enrollment_result', success: false, error: 'disk full', requestId: 'r' },
		]);
	});
});
