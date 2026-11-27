// Covers the voice_control WebSocket message that backs `maestro-cli voice`.
// The hop is thin: it lets only maestro-cli through (a voice credential is not
// a browser's to write), passes the request to the one voice entry point, and
// reports a thrown error as a failed round trip. A refusal the app gave on
// purpose is a SUCCESSFUL round trip with the reason in `reply`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/acappella/voice-control-service', () => ({
	runVoiceControlRequest: vi.fn(),
}));

import {
	VOICE_CONTROL_MESSAGE,
	handleVoiceControl,
} from '../../../../main/web-server/handlers/messageHandlers/voiceControl';
import { runVoiceControlRequest } from '../../../../main/acappella/voice-control-service';
import type {
	MessageHandlerContext,
	WebClient,
} from '../../../../main/web-server/handlers/messageHandlers/types';

function createContext() {
	const send = vi.fn();
	const ctx = { callbacks: {}, send, sendError: vi.fn(), reportHandlerError: vi.fn() };
	return { ctx: ctx as unknown as MessageHandlerContext, send };
}

function client(cli: boolean): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
		...(cli ? { cli: true } : {}),
	} as WebClient;
}

describe('voice_control handler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('names the message the CLI sends', () => {
		expect(VOICE_CONTROL_MESSAGE).toBe('voice_control');
	});

	it('passes the request to the voice entry point and returns its reply', async () => {
		const { ctx, send } = createContext();
		const reply = { ok: true, result: { session: null } };
		vi.mocked(runVoiceControlRequest).mockResolvedValue(reply as never);
		const who = client(true);

		await handleVoiceControl(ctx, who, {
			type: 'voice_control',
			requestId: 'req-1',
			request: { action: 'stop' },
		} as never);

		expect(runVoiceControlRequest).toHaveBeenCalledWith({ action: 'stop' });
		expect(send).toHaveBeenCalledWith(who, {
			type: 'voice_control_result',
			success: true,
			reply,
			requestId: 'req-1',
		});
	});

	it('reports a refusal as a successful round trip with the reason', async () => {
		const { ctx, send } = createContext();
		const reply = { ok: false, reason: 'A Cappella is switched off.' };
		vi.mocked(runVoiceControlRequest).mockResolvedValue(reply as never);

		await handleVoiceControl(ctx, client(true), {
			type: 'voice_control',
			requestId: 'req-2',
			request: { action: 'start', scope: { kind: 'conductor' } },
		} as never);

		expect(send.mock.calls[0][1]).toMatchObject({ success: true, reply });
	});

	it('refuses a client that is not maestro-cli, and runs nothing', async () => {
		const { ctx, send } = createContext();

		await handleVoiceControl(ctx, client(false), {
			type: 'voice_control',
			requestId: 'req-3',
			request: { action: 'set-credential', service: 'openai', key: 'sk-test' },
		} as never);

		expect(runVoiceControlRequest).not.toHaveBeenCalled();
		expect(send.mock.calls[0][1]).toMatchObject({
			type: 'voice_control_result',
			success: false,
			requestId: 'req-3',
		});
		expect(send.mock.calls[0][1].error).toContain('maestro-cli');
	});

	it('reports a thrown error as a failed round trip', async () => {
		const { ctx, send } = createContext();
		vi.mocked(runVoiceControlRequest).mockRejectedValue(new Error('boom'));

		await handleVoiceControl(ctx, client(true), {
			type: 'voice_control',
			requestId: 'req-4',
			request: { action: 'latency' },
		} as never);

		expect(send.mock.calls[0][1]).toEqual({
			type: 'voice_control_result',
			success: false,
			error: 'boom',
			requestId: 'req-4',
		});
	});
});
