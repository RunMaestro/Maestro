/**
 * Tests for the webhook.received trigger source.
 *
 * Covers secret resolution (literal vs env var), path defaulting off the
 * subscription name, payload shaping, filter integration, the enabled() gate,
 * and idempotent start/stop. The shared listener is driven directly rather
 * than over a socket - the HTTP layer is covered by cue-webhook-server.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCueWebhookTriggerSource } from '../../../../main/cue/triggers/cue-webhook-trigger-source';
import { createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import {
	handleCueWebhookRequest,
	resetCueWebhookServerForTests,
} from '../../../../main/cue/cue-webhook-server';
import type { CueEvent, CueSubscription } from '../../../../main/cue/cue-types';
import type { SessionInfo } from '../../../../shared/types';
import { EventEmitter } from 'events';
import type * as http from 'http';

function makeSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
	};
}

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'PR Review',
		event: 'webhook.received',
		enabled: true,
		prompt: 'review it',
		webhook: { secret: 's3cret' },
		...overrides,
	};
}

function makeCtx(sub: CueSubscription, enabled = true) {
	const emit = vi.fn();
	const onLog = vi.fn();
	return {
		emit,
		onLog,
		ctx: {
			session: makeSession(),
			subscription: sub,
			registry: createCueSessionRegistry(),
			enabled: () => enabled,
			onLog,
			emit,
		},
	};
}

/** POST a body to the shared listener and resolve once it has responded. */
async function deliver(
	path: string,
	body: string,
	headers: Record<string, string> = { 'x-maestro-cue-secret': 's3cret' }
): Promise<number> {
	const req = new EventEmitter() as unknown as http.IncomingMessage & { destroy: () => void };
	req.method = 'POST';
	req.url = `/cue/${path}`;
	req.headers = headers;
	req.destroy = () => {};
	queueMicrotask(() => {
		req.emit('data', Buffer.from(body, 'utf8'));
		req.emit('end');
	});

	let status = 0;
	const res = {
		writeHead: (code: number) => {
			status = code;
		},
		end: () => {},
	};
	await handleCueWebhookRequest(req, res as unknown as http.ServerResponse);
	return status;
}

describe('cue-webhook-trigger-source', () => {
	const originalPort = process.env.MAESTRO_CUE_WEBHOOK_PORT;

	beforeEach(() => {
		process.env.MAESTRO_CUE_WEBHOOK_PORT = '0';
		resetCueWebhookServerForTests();
	});

	afterEach(() => {
		resetCueWebhookServerForTests();
		delete process.env.WEBHOOK_TEST_SECRET;
		if (originalPort === undefined) {
			delete process.env.MAESTRO_CUE_WEBHOOK_PORT;
		} else {
			process.env.MAESTRO_CUE_WEBHOOK_PORT = originalPort;
		}
	});

	it('returns null when the subscription has no webhook block', () => {
		const { ctx } = makeCtx(makeSub({ webhook: undefined }));
		expect(createCueWebhookTriggerSource(ctx)).toBeNull();
	});

	it('returns null and logs when no secret can be resolved', () => {
		const { ctx, onLog } = makeCtx(makeSub({ webhook: {} }));
		expect(createCueWebhookTriggerSource(ctx)).toBeNull();
		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('no secret resolved'));
	});

	it('returns null when secret_env points at an unset variable', () => {
		const { ctx, onLog } = makeCtx(makeSub({ webhook: { secret_env: 'WEBHOOK_TEST_SECRET' } }));
		expect(createCueWebhookTriggerSource(ctx)).toBeNull();
		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('WEBHOOK_TEST_SECRET'));
	});

	it('resolves the secret from secret_env', async () => {
		process.env.WEBHOOK_TEST_SECRET = 'from-env';
		const { ctx, emit } = makeCtx(
			makeSub({ webhook: { path: 'hook', secret_env: 'WEBHOOK_TEST_SECRET' } })
		);
		const source = createCueWebhookTriggerSource(ctx);
		source?.start();

		expect(await deliver('hook', '{}', { 'x-maestro-cue-secret': 'from-env' })).toBe(202);
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('defaults the path to a slug of the subscription name', async () => {
		const { ctx, emit } = makeCtx(makeSub());
		const source = createCueWebhookTriggerSource(ctx);
		source?.start();

		// "PR Review" → "pr-review"
		expect(await deliver('pr-review', '{}')).toBe(202);
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('returns null when the name and path both slug to nothing', () => {
		const { ctx } = makeCtx(makeSub({ name: '!!!', webhook: { secret: 's3cret' } }));
		expect(createCueWebhookTriggerSource(ctx)).toBeNull();
	});

	it('emits an event carrying the parsed body and vendor metadata', async () => {
		const { ctx, emit } = makeCtx(makeSub({ webhook: { path: 'hook', secret: 's3cret' } }));
		createCueWebhookTriggerSource(ctx)?.start();

		await deliver('hook', JSON.stringify({ action: 'opened', number: 12 }), {
			'x-maestro-cue-secret': 's3cret',
			'x-github-event': 'pull_request',
			'x-github-delivery': 'abc-123',
		});

		const event = emit.mock.calls[0][0] as CueEvent;
		expect(event.type).toBe('webhook.received');
		expect(event.triggerName).toBe('PR Review');
		expect(event.payload.path).toBe('hook');
		expect(event.payload.webhook_event).toBe('pull_request');
		expect(event.payload.delivery_id).toBe('abc-123');
		expect(event.payload.body).toEqual({ action: 'opened', number: 12 });
	});

	it('applies the subscription filter against nested body fields', async () => {
		const { ctx, emit } = makeCtx(
			makeSub({
				webhook: { path: 'hook', secret: 's3cret' },
				filter: { 'body.action': 'opened' },
			})
		);
		createCueWebhookTriggerSource(ctx)?.start();

		await deliver('hook', JSON.stringify({ action: 'closed' }));
		expect(emit).not.toHaveBeenCalled();

		await deliver('hook', JSON.stringify({ action: 'opened' }));
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('does not emit while the engine is disabled', async () => {
		const { ctx, emit } = makeCtx(makeSub({ webhook: { path: 'hook', secret: 's3cret' } }), false);
		createCueWebhookTriggerSource(ctx)?.start();

		// The listener still accepts the delivery - the gate is on dispatch, so
		// a sender doesn't start seeing errors just because Cue is paused.
		expect(await deliver('hook', '{}')).toBe(202);
		expect(emit).not.toHaveBeenCalled();
	});

	it('has no scheduled next-trigger time', () => {
		const { ctx } = makeCtx(makeSub());
		expect(createCueWebhookTriggerSource(ctx)?.nextTriggerAt()).toBeNull();
	});

	it('start and stop are idempotent, and stop deregisters the path', async () => {
		const { ctx, emit } = makeCtx(makeSub({ webhook: { path: 'hook', secret: 's3cret' } }));
		const source = createCueWebhookTriggerSource(ctx);

		source?.start();
		source?.start();
		await deliver('hook', '{}');
		// Double-start must not register the path twice, or every delivery
		// would dispatch two runs.
		expect(emit).toHaveBeenCalledTimes(1);

		source?.stop();
		source?.stop();
		expect(await deliver('hook', '{}')).toBe(404);
		expect(emit).toHaveBeenCalledTimes(1);
	});
});
