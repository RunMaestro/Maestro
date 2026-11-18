import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GrokAcpSession,
	GrokAcpSessionError,
	type GrokAcpSessionOptions,
} from '../../../../shared/maestro-lib/grok/acp-session';
import {
	GrokAcpRequestError,
	type AcpCall,
} from '../../../../shared/maestro-lib/grok/acp-protocol';

describe('GrokAcpSession lifecycle over fake ACP bytes', () => {
	const fixtures: ReturnType<typeof harness>[] = [];
	function harness(overrides: Partial<GrokAcpSessionOptions> = {}) {
		// No process is spawned; termination and pipe closure remain independently observable.
		const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
		const terminate = vi.fn();
		const onNotification = vi.fn();
		const write = vi.fn<(frame: Uint8Array) => void>();
		const session = new GrokAcpSession({
			cwd: '/synthetic/project',
			account: 'fixture-account',
			host: 'fixture-host',
			idleTimeoutMs: 100,
			maxTurnMs: 300,
			cancelGraceMs: 40,
			...overrides,
			child: child as unknown as ChildProcess,
			write,
			terminate,
			onNotification,
		});
		const sent = (method: string): AcpCall[] =>
			write.mock.calls
				.map(([frame]) => JSON.parse(new TextDecoder().decode(frame)) as AcpCall)
				.filter((message) => message.method === method);
		const receive = (...messages: Record<string, unknown>[]) =>
			session.feedStdout(
				new TextEncoder().encode(
					messages.map((message) => JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n').join('')
				)
			);
		const reply = (request: AcpCall, result: unknown) => receive({ id: request.id, result });
		async function next(method: string, count = 1) {
			// Drain promise continuations without advancing any lifecycle budget.
			await vi.advanceTimersByTimeAsync(0);
			expect(sent(method)).toHaveLength(count);
			return sent(method)[count - 1];
		}
		async function allocation(loadSession = true) {
			reply(await next('initialize'), { protocolVersion: 1, agentCapabilities: { loadSession } });
			return next(overrides.resumeSessionId ? 'session/load' : 'session/new');
		}
		async function ready(result: unknown = { sessionId: 'native-1' }) {
			const opening = session.open();
			reply(await allocation(), result);
			await opening;
		}
		const fixture = {
			session,
			child,
			terminate,
			onNotification,
			write,
			sent,
			receive,
			reply,
			next,
			allocation,
			ready,
		};
		fixtures.push(fixture);
		return fixture;
	}
	async function usageReady(h: ReturnType<typeof harness>) {
		const opening = h.session.open();
		h.reply(await h.next('initialize'), {
			protocolVersion: 1,
			_meta: { grokShell: true, agentVersion: 'fixture-version' },
		});
		h.reply(await h.next('session/new'), { sessionId: 'native-1' });
		await opening;
	}
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		for (const { session, child } of fixtures.splice(0)) {
			session.close();
			child.emit('close', 0, null);
		}
		try {
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});

	it('allocates once, serializes turns, ignores stale replies and loads the confirmed native ID', async () => {
		const h = harness({ model: 'fixture-model' });
		const opening = h.session.open();
		expect(h.session.open()).toBe(opening);
		const allocation = await h.allocation();
		expect(allocation.params).toEqual({
			cwd: '/synthetic/project',
			mcpServers: [],
			_meta: { modelId: 'fixture-model' },
		});
		h.reply(allocation, { sessionId: 'native-1', models: { currentModelId: 'fixture-model' } });
		await opening;
		const first = h.session.prompt('first');
		const request = await h.next('session/prompt');
		expect(request.params).toEqual({
			sessionId: 'native-1',
			prompt: [{ type: 'text', text: 'first' }],
		});
		await expect(h.session.prompt('overlap')).rejects.toMatchObject({
			reason: 'busy',
			dispatchMayHaveOccurred: false,
		});
		h.receive({ method: 'session/update', params: { sessionId: 'native-1' } });
		expect(h.onNotification.mock.lastCall?.[1]).toEqual({ replay: false, turn: 1 });
		h.reply(request, { stopReason: 'end_turn' });
		await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
		const settled = vi.fn();
		const second = h.session.prompt('second').then(settled);
		const secondRequest = await h.next('session/prompt', 2);
		expect(secondRequest.params).toMatchObject({ sessionId: 'native-1' });
		h.reply(request, { stopReason: 'end_turn', stale: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).not.toHaveBeenCalled();
		h.receive({ method: 'session/update' });
		expect(h.onNotification.mock.lastCall?.[1]).toEqual({ replay: false, turn: 2 });
		h.reply(secondRequest, { stopReason: 'end_turn' });
		await second;
		expect(settled).toHaveBeenCalledExactlyOnceWith({ stopReason: 'end_turn' });
		expect(h.sent('initialize')).toHaveLength(1);
		expect(h.sent('session/new')).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		h.session.close();
		h.child.emit('close');

		const resumed = harness({ resumeSessionId: h.session.sessionId, model: 'fixture-model' });
		const turn = resumed.session.prompt('continue');
		const load = await resumed.allocation();
		expect(load.params).toEqual({
			cwd: '/synthetic/project',
			mcpServers: [],
			sessionId: 'native-1',
		});
		resumed.receive({ method: 'session/update', params: { history: true } });
		expect(resumed.onNotification.mock.lastCall?.[1]).toEqual({ replay: true, turn: null });
		// ACP load confirms its input ID without echoing it in the response.
		resumed.reply(load, {
			configOptions: [{ id: 'model', type: 'select', currentValue: 'fixture-model' }],
		});
		resumed.reply(await resumed.next('session/prompt'), { stopReason: 'end_turn' });
		await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
		expect(resumed.session.sessionId).toBe('native-1');
		expect(resumed.sent('session/new')).toHaveLength(0);
	});

	it.each(['unsupported', 'rejected'] as const)(
		'never replaces an %s load with a new session',
		async (mode) => {
			const h = harness({ resumeSessionId: 'native-1' });
			const failed = h.session.prompt('continue').catch((error: unknown) => error);
			h.reply(await h.next('initialize'), {
				protocolVersion: 1,
				agentCapabilities: { loadSession: mode !== 'unsupported' },
			});
			if (mode === 'rejected')
				h.receive({
					id: (await h.next('session/load')).id,
					error: { code: -32602, message: 'unavailable' },
				});
			expect(await failed).toMatchObject({
				reason: mode === 'unsupported' ? 'load-unsupported' : 'transport-lost',
				dispatchMayHaveOccurred: false,
			});
			expect(h.session.sessionId).toBeUndefined();
			expect(h.sent('session/new')).toHaveLength(0);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.terminate).toHaveBeenCalledTimes(1);
		}
	);

	it('does no work for a pre-aborted signal and permits a later explicit turn', async () => {
		const h = harness();
		await expect(h.session.prompt('unsent', AbortSignal.abort())).rejects.toMatchObject({
			reason: 'cancelled',
			dispatchMayHaveOccurred: false,
		});
		expect(h.write).not.toHaveBeenCalled();
		expect(h.session.isClosed).toBe(false);
		await h.ready();
		const turn = h.session.prompt('explicit');
		h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
		await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it.each(['before-initialize', 'during-initialize'] as const)(
		'cancels %s without allocating or dispatching',
		async (stage) => {
			const h = harness();
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, 'removeEventListener');
			const failed = h.session.prompt('unsent', controller.signal).catch((error: unknown) => error);
			const request = stage === 'during-initialize' ? await h.next('initialize') : undefined;
			controller.abort();
			if (request) h.reply(request, { protocolVersion: 1 });
			expect(await failed).toMatchObject({ reason: 'cancelled', dispatchMayHaveOccurred: false });
			expect(h.sent('initialize')).toHaveLength(request ? 1 : 0);
			expect(h.sent('session/new')).toHaveLength(0);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('retains allocation after cancellation without dispatch, then accepts an explicit next turn', async () => {
		const h = harness();
		const failed = h.session.prompt('cancelled before dispatch').catch((error: unknown) => error);
		const allocation = await h.allocation();
		h.session.cancel();
		h.session.cancel();
		h.reply(allocation, { sessionId: 'native-1' });
		expect(await failed).toMatchObject({ reason: 'cancelled', dispatchMayHaveOccurred: false });
		expect(h.session.sessionId).toBe('native-1');
		expect(h.session.isClosed).toBe(false);
		expect(h.sent('session/prompt')).toHaveLength(0);
		expect(h.sent('session/cancel')).toHaveLength(0);
		const next = h.session.prompt('explicit next turn');
		h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
		await next;
		expect(h.sent('session/new')).toHaveLength(1);
	});

	it.each(
		['none', 'model', 'effort', 'model-and-effort'].flatMap((selection) =>
			(selection === 'none' ? [true] : [false, true]).flatMap((resume) =>
				[false, true].map((replyFirst) => ({ selection, resume, replyFirst }))
			)
		)
	)(
		'reuses cancelled allocation with acknowledged $selection (resume: $resume, reply first: $replyFirst)',
		async ({ selection, resume, replyFirst }) => {
			const h = harness({
				model: selection.includes('model') ? 'first' : undefined,
				effort: selection.includes('effort') ? 'high' : undefined,
				resumeSessionId: resume ? 'native-1' : undefined,
			});
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, 'removeEventListener');
			const success = vi.fn();
			const failure = vi.fn();
			const cancelled = h.session
				.prompt('never dispatch', controller.signal)
				.then(success, failure);
			const opening = h.session.open();
			const allocation = await h.allocation();
			const response = {
				...(resume ? {} : { sessionId: 'native-1' }),
				...(selection === 'none' ? {} : { models: { currentModelId: 'first' } }),
				configOptions: selection.includes('effort')
					? [{ id: 'reasoning_effort', type: 'select', currentValue: 'high' }]
					: [],
			};
			if (replyFirst) h.reply(allocation, response);
			controller.abort();
			h.session.cancel();
			await expect(h.session.prompt('overlap')).rejects.toMatchObject({ reason: 'busy' });
			if (!replyFirst) {
				await vi.advanceTimersByTimeAsync(39);
				expect(failure).not.toHaveBeenCalled();
				h.reply(allocation, response);
			}
			await cancelled;
			await expect(opening).resolves.toMatchObject(response);
			expect(h.session.open()).toBe(opening);
			expect(success).not.toHaveBeenCalled();
			expect(failure).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ reason: 'cancelled', dispatchMayHaveOccurred: false })
			);
			expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
			expect(h.session.sessionId).toBe('native-1');
			expect(h.session.isClosed).toBe(false);
			expect(h.session.error).toBeUndefined();
			expect(h.session.promptDispatched).toBe(false);
			expect(h.sent('session/set_config_option')).toHaveLength(0);
			expect(h.sent('session/cancel')).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			// Stale allocation replies and elapsed budgets cannot replay the cancelled text.
			h.reply(allocation, response);
			await vi.advanceTimersByTimeAsync(500);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.terminate).not.toHaveBeenCalled();
			const next = h.session.prompt('explicit next turn');
			const request = await h.next('session/prompt');
			expect(request.params).toEqual({
				sessionId: 'native-1',
				prompt: [{ type: 'text', text: 'explicit next turn' }],
			});
			h.receive({ method: 'session/update', params: { sessionId: 'native-1' } });
			expect(h.onNotification.mock.lastCall?.[1]).toEqual({ replay: false, turn: 2 });
			h.reply(request, { stopReason: 'end_turn' });
			await expect(next).resolves.toEqual({ stopReason: 'end_turn' });
			expect(h.sent('initialize')).toHaveLength(1);
			expect(h.sent('session/new')).toHaveLength(resume ? 0 : 1);
			expect(h.sent('session/load')).toHaveLength(resume ? 1 : 0);
			expect(h.sent('session/prompt')).toHaveLength(1);
			expect(h.terminate).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('keeps the native claim after allocation cancellation until the owning pipes close', async () => {
		const h = harness();
		const cancelled = h.session.prompt('unsent').catch((error: unknown) => error);
		const allocation = await h.allocation();
		h.session.cancel();
		h.reply(allocation, { sessionId: 'native-1' });
		expect(await cancelled).toMatchObject({ reason: 'cancelled', dispatchMayHaveOccurred: false });
		const duplicate = harness({ resumeSessionId: 'native-1' });
		const blocked = duplicate.session.prompt('different owner').catch((error: unknown) => error);
		duplicate.reply(await duplicate.next('initialize'), {
			protocolVersion: 1,
			agentCapabilities: { loadSession: true },
		});
		expect(await blocked).toMatchObject({ reason: 'busy', dispatchMayHaveOccurred: false });
		expect(duplicate.sent('session/load')).toHaveLength(0);
		expect(duplicate.sent('session/prompt')).toHaveLength(0);
		expect(h.terminate).not.toHaveBeenCalled();
		expect(h.sent('session/prompt')).toHaveLength(0);
		h.session.close();
		h.child.emit('close');
		const replacement = harness({ resumeSessionId: 'native-1' });
		await replacement.ready({});
		expect(replacement.session.sessionId).toBe('native-1');
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(
		[
			'model-missing',
			'model-refused',
			'effort-missing',
			'effort-refused',
			'conflicting-observation',
		].flatMap((state) => [false, true].map((resume) => ({ state, resume })))
	)(
		'keeps $state allocation fatal after cancellation (resume: $resume)',
		async ({ state, resume }) => {
			const h = harness({
				model: 'first',
				effort: 'high',
				resumeSessionId: resume ? 'native-1' : undefined,
			});
			const failed = h.session.prompt('unsent').catch((error: unknown) => error);
			const allocation = await h.allocation();
			h.session.cancel();
			if (state === 'conflicting-observation')
				h.receive({
					method: 'session/update',
					params: {
						sessionId: 'native-1',
						update: { sessionUpdate: 'model_changed', model_id: 'other' },
					},
				});
			h.reply(allocation, {
				...(resume ? {} : { sessionId: 'native-1' }),
				models:
					state === 'model-missing'
						? undefined
						: { currentModelId: state === 'model-refused' ? 'other' : 'first' },
				configOptions:
					state === 'effort-missing'
						? []
						: [
								{
									id: 'reasoning_effort',
									type: 'select',
									currentValue: state === 'effort-refused' ? 'low' : 'high',
									options: [{ value: 'high', name: 'High' }],
								},
							],
			});
			expect(await failed).toMatchObject({
				reason:
					state === 'conflicting-observation'
						? 'invalid-response'
						: state.startsWith('model')
							? 'model-unacknowledged'
							: 'effort-unacknowledged',
				dispatchMayHaveOccurred: false,
			});
			expect(await failed).toBe(h.session.error);
			expect(h.session.sessionId).toBe('native-1');
			expect(h.session.isClosed).toBe(true);
			await expect(h.session.open()).rejects.toBe(h.session.error);
			await expect(h.session.prompt('no replay')).rejects.toBe(h.session.error);
			expect(h.sent('initialize')).toHaveLength(1);
			expect(h.sent('session/new')).toHaveLength(resume ? 0 : 1);
			expect(h.sent('session/load')).toHaveLength(resume ? 1 : 0);
			expect(h.sent('session/set_config_option')).toHaveLength(0);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.sent('session/cancel')).toHaveLength(0);
			expect(h.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each(
		['pending-success', 'reply-first', 'refused', 'unresolved'].flatMap((state) =>
			[false, true].map((resume) => ({ state, resume }))
		)
	)(
		'cannot reuse cancelled allocation with $state in-flight configuration (resume: $resume)',
		async ({ state, resume }) => {
			const h = harness({
				model: 'first',
				effort: 'high',
				resumeSessionId: resume ? 'native-1' : undefined,
			});
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, 'removeEventListener');
			const failed = h.session.prompt('unsent', controller.signal).catch((error: unknown) => error);
			h.reply(await h.allocation(), {
				...(resume ? {} : { sessionId: 'native-1' }),
				configOptions: selectableConfig,
			});
			const config = await h.next('session/set_config_option');
			expect(config.params).toEqual({
				sessionId: 'native-1',
				configId: 'reasoning_effort',
				value: 'high',
			});
			const acknowledgement = {
				configOptions: selectableConfig.map((option) =>
					option.id === 'reasoning_effort' ? { ...option, currentValue: 'high' } : option
				),
			};
			if (state === 'reply-first') h.reply(config, acknowledgement);
			controller.abort();
			if (state === 'pending-success') h.reply(config, acknowledgement);
			if (state === 'refused')
				h.receive({ id: config.id, error: { code: -32602, message: 'refused' } });
			if (state === 'unresolved') await vi.advanceTimersByTimeAsync(40);
			expect(await failed).toMatchObject({
				reason:
					state === 'unresolved'
						? 'cancel-timeout'
						: state === 'refused'
							? 'config-unsupported'
							: 'cancelled',
				dispatchMayHaveOccurred: false,
			});
			expect(await failed).toBe(h.session.error);
			expect(h.session.sessionId).toBe('native-1');
			expect(h.session.isClosed).toBe(true);
			expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
			h.reply(config, acknowledgement);
			await vi.advanceTimersByTimeAsync(500);
			await expect(h.session.open()).rejects.toBe(h.session.error);
			await expect(h.session.prompt('no automatic retry')).rejects.toBe(h.session.error);
			expect(h.session.configuration).toMatchObject({ model: undefined, configOptions: [] });
			expect(h.sent('initialize')).toHaveLength(1);
			expect(h.sent('session/new')).toHaveLength(resume ? 0 : 1);
			expect(h.sent('session/load')).toHaveLength(resume ? 1 : 0);
			expect(h.sent('session/set_config_option')).toHaveLength(1);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.sent('session/cancel')).toHaveLength(0);
			expect(h.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each(['end_turn', 'cancelled'])(
		'waits for the original %s reply after cancellation and never reports success',
		async (stopReason) => {
			const h = harness();
			await h.ready();
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, 'removeEventListener');
			const success = vi.fn();
			const failure = vi.fn();
			const turn = h.session.prompt('once', controller.signal).then(success, failure);
			const request = await h.next('session/prompt');
			controller.abort();
			h.session.cancel();
			await vi.advanceTimersByTimeAsync(0);
			expect(failure).not.toHaveBeenCalled();
			expect(h.sent('session/cancel')).toEqual([
				{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'native-1' } },
			]);
			await expect(h.session.prompt('too early')).rejects.toMatchObject({ reason: 'busy' });
			const response = { stopReason, usage: { inputTokens: 12 } };
			h.reply(request, response);
			await turn;
			expect(success).not.toHaveBeenCalled();
			expect(failure).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ reason: 'cancelled', dispatchMayHaveOccurred: true, response })
			);
			expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
			expect(h.session.isClosed).toBe(false);
			expect(h.terminate).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			const next = h.session.prompt('explicit retry');
			h.reply(await h.next('session/prompt', 2), { stopReason: 'end_turn' });
			await next;
		}
	);

	it.each(
		(['exit', 'error', 'close', 'transport', 'explicit-close'] as const).flatMap((loss) =>
			[false, true].map((replyFirst) => ({ loss, replyFirst }))
		)
	)(
		'rejects on $loss (reply already received: $replyFirst) and ignores later replies/retries',
		async ({ loss, replyFirst }) => {
			const h = harness();
			await h.ready();
			const success = vi.fn();
			const failure = vi.fn();
			const turn = h.session.prompt('side effect').then(success, failure);
			const request = await h.next('session/prompt');
			if (replyFirst) h.reply(request, { stopReason: 'end_turn' });
			if (loss === 'transport') h.session.transportLost();
			else if (loss === 'explicit-close') h.session.close();
			else h.child.emit(loss, new Error('synthetic-private-error'));
			await turn;
			const error = failure.mock.calls[0][0];
			expect(error).toMatchObject({
				reason:
					loss === 'transport'
						? 'transport-lost'
						: loss === 'explicit-close'
							? 'closed'
							: 'process-lost',
				dispatchMayHaveOccurred: true,
			});
			expect(String(error) + JSON.stringify(error)).not.toContain('synthetic-private-error');
			h.reply(request, { stopReason: 'end_turn' });
			await expect(h.session.prompt('retry')).rejects.toBe(error);
			await expect(h.session.open()).rejects.toBe(error);
			expect(success).not.toHaveBeenCalled();
			expect(failure).toHaveBeenCalledTimes(1);
			expect(h.sent('session/prompt')).toHaveLength(1);
			expect(h.session.sessionId).toBe('native-1');
			expect(h.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('preserves a received allocation ID across immediate process loss without sending its prompt', async () => {
		const h = harness();
		const failed = h.session.prompt('unsent').catch((error: unknown) => error);
		h.reply(await h.allocation(), { sessionId: 'native-1' });
		h.child.emit('close');
		expect(await failed).toMatchObject({ reason: 'process-lost', dispatchMayHaveOccurred: false });
		expect(h.session.sessionId).toBe('native-1');
		expect(h.sent('session/prompt')).toHaveLength(0);
		const replacement = harness({ resumeSessionId: 'native-1' });
		await replacement.ready({});
		expect(replacement.session.sessionId).toBe('native-1');
	});

	it.each([undefined, '', '   ', 123])(
		'rejects missing/invalid native identity %s before prompt dispatch',
		async (sessionId) => {
			const h = harness();
			const failed = h.session.prompt('unsent').catch((error: unknown) => error);
			h.reply(await h.allocation(), { sessionId });
			expect(await failed).toMatchObject({
				reason: 'missing-session-id',
				dispatchMayHaveOccurred: false,
			});
			expect(h.session.sessionId).toBeUndefined();
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.terminate).toHaveBeenCalledTimes(1);
		}
	);

	it.each([
		{},
		{ models: { currentModelId: 'other' } },
		{
			models: { currentModelId: 'selected' },
			configOptions: [{ id: 'model', type: 'select', currentValue: 'other' }],
		},
	])('refuses unacknowledged model state %j while retaining identity', async (state) => {
		const h = harness({ model: 'selected' });
		const failed = h.session.prompt('unsent').catch((error: unknown) => error);
		h.reply(await h.allocation(), { sessionId: 'native-1', ...state });
		expect(await failed).toMatchObject({
			reason: 'model-unacknowledged',
			dispatchMayHaveOccurred: false,
		});
		expect(h.session.sessionId).toBe('native-1');
		expect(h.sent('session/prompt')).toHaveLength(0);
		expect(h.sent('session/set_config_option')).toHaveLength(0);
		expect(h.terminate).toHaveBeenCalledTimes(1);
	});

	it.each(['outer-error', 'inner-error', 'method-not-found'] as const)(
		'treats %s model discovery as unavailable without retry or session allocation',
		async (mode) => {
			const h = harness({ extensions: { agentVersion: 'fixture-version', modelsList: true } });
			const discovery = h.session.discoverModels();
			h.reply(await h.next('initialize'), {
				protocolVersion: 1,
				_meta: { grokShell: true, agentVersion: 'fixture-version' },
			});
			const request = await h.next('_x.ai/models/list');
			const result = { currentModelId: 'hidden', availableModels: [] };
			const error = { code: -32601, message: 'synthetic-private-diagnostic' };
			if (mode === 'method-not-found') h.receive({ id: request.id, error });
			else
				h.reply(
					request,
					mode === 'outer-error' ? { result, error } : { result: { ...result, error } }
				);
			await expect(discovery).resolves.toBeUndefined();
			await expect(h.session.discoverModels()).resolves.toBeUndefined();
			expect(h.sent('_x.ai/models/list')).toHaveLength(1);
			expect(h.sent('session/new')).toHaveLength(0);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.session.error).toBeUndefined();
			expect(h.terminate).not.toHaveBeenCalled();
		}
	);

	it.each([
		{ availableModels: [] },
		{ availableModels: [{ modelId: 'offered', name: 'Offered' }] },
	])(
		'preserves an authoritative catalog $availableModels without promoting its hidden current model',
		async ({ availableModels }) => {
			const h = harness({ extensions: { agentVersion: 'fixture-version', modelsList: true } });
			const discovery = h.session.discoverModels();
			h.reply(await h.next('initialize'), {
				protocolVersion: 1,
				_meta: { grokShell: true, agentVersion: 'fixture-version' },
			});
			const result = { currentModelId: 'hidden', availableModels };
			h.reply(await h.next('_x.ai/models/list'), { result });
			await expect(discovery).resolves.toEqual(result);
			expect(h.session.sessionId).toBeUndefined();
			expect(h.sent('session/prompt')).toHaveLength(0);
		}
	);

	it.each([
		'acknowledged',
		'unchanged',
		'nested-error',
		'method-not-found',
		'already-current',
	] as const)(
		'requires selected effort acknowledgement before dispatch (%s), even with a hidden model',
		async (mode) => {
			const h = harness({ model: 'hidden', effort: 'high' });
			const configOptions = [
				{
					id: 'reasoning_effort',
					type: 'select',
					currentValue: mode === 'already-current' ? 'high' : 'low',
					options: [{ value: 'high', name: 'High' }],
				},
			];
			const turn = h.session.prompt('once').catch((error: unknown) => error);
			h.reply(await h.allocation(), {
				sessionId: 'native-1',
				models: { currentModelId: 'hidden' },
				configOptions,
			});
			if (mode !== 'already-current') {
				const request = await h.next('session/set_config_option');
				expect(request.params).toEqual({
					sessionId: 'native-1',
					configId: 'reasoning_effort',
					value: 'high',
				});
				expect(h.sent('session/prompt')).toHaveLength(0);
				const error = { code: -32601, message: 'synthetic-private-diagnostic' };
				if (mode === 'method-not-found') h.receive({ id: request.id, error });
				else
					h.reply(request, {
						configOptions: [
							{ ...configOptions[0], currentValue: mode === 'unchanged' ? 'low' : 'high' },
						],
						...(mode === 'nested-error' ? { error } : {}),
					});
			}
			if (mode === 'acknowledged' || mode === 'already-current') {
				h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
				expect(await turn).toEqual({ stopReason: 'end_turn' });
				expect(h.session.configuration.model).toBe('hidden');
				expect(h.sent('session/set_config_option')).toHaveLength(
					mode === 'already-current' ? 0 : 1
				);
			} else {
				expect(await turn).toMatchObject({
					reason: mode === 'unchanged' ? 'effort-unacknowledged' : 'config-unsupported',
					dispatchMayHaveOccurred: false,
				});
				expect(h.sent('session/prompt')).toHaveLength(0);
				expect(h.session.sessionId).toBe('native-1');
				expect(String(h.session.error)).not.toContain('synthetic-private-diagnostic');
			}
		}
	);

	it.each([false, true])(
		'drops old effort support after changing model (new effort requested: %s)',
		async (requestEffort) => {
			const h = harness({ model: 'first', effort: 'high' });
			await h.ready({
				sessionId: 'native-1',
				configOptions: [
					{
						id: 'model',
						type: 'select',
						currentValue: 'first',
						options: [{ value: 'second', name: 'Second' }],
					},
					{
						id: 'reasoning_effort',
						type: 'select',
						currentValue: 'high',
						options: [{ value: 'high', name: 'High' }],
					},
				],
			});
			const change = h.session
				.setConfiguration({ model: 'second', ...(requestEffort ? { effort: 'high' } : {}) })
				.catch((error: unknown) => error);
			const request = await h.next('session/set_config_option');
			expect(request.params).toEqual({ sessionId: 'native-1', configId: 'model', value: 'second' });
			expect(h.session.configuration).toMatchObject({ model: undefined, configOptions: [] });
			h.reply(request, { models: { currentModelId: 'second' }, configOptions: [] });
			if (requestEffort) {
				expect(await change).toMatchObject({
					reason: 'config-unsupported',
					dispatchMayHaveOccurred: false,
				});
				await expect(h.session.prompt('unsent')).rejects.toBe(h.session.error);
				expect(h.sent('session/prompt')).toHaveLength(0);
			} else {
				await expect(change).resolves.toBeUndefined();
				expect(h.session.configuration).toMatchObject({ model: 'second', configOptions: [] });
				const turn = h.session.prompt('after model change');
				h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
				await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
			}
			expect(h.sent('session/set_config_option')).toHaveLength(1);
		}
	);

	it.each(['no-contract', 'no-method', 'wrong-version', 'no-version', 'no-marker'] as const)(
		'withholds model discovery for %s qualification',
		async (mode) => {
			const h = harness({
				extensions:
					mode === 'no-contract'
						? undefined
						: { agentVersion: 'fixture-version', modelsList: mode !== 'no-method' },
			});
			const discovery = h.session.discoverModels();
			h.reply(await h.next('initialize'), {
				protocolVersion: 1,
				_meta: {
					grokShell: mode !== 'no-marker',
					agentVersion:
						mode === 'no-version'
							? undefined
							: mode === 'wrong-version'
								? 'other'
								: 'fixture-version',
				},
			});
			await expect(discovery).resolves.toBeUndefined();
			expect(h.sent('_x.ai/models/list')).toHaveLength(0);
			expect(h.sent('session/new')).toHaveLength(0);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.session.error).toBeUndefined();
		}
	);

	it.each(
		['matching', 'model-conflict', 'effort-conflict', 'ambiguous'].flatMap((state) =>
			[false, true].flatMap((resume) =>
				[false, true].map((replyFirst) => ({ state, resume, replyFirst }))
			)
		)
	)(
		'checks $state allocation observations (resume: $resume, reply first: $replyFirst)',
		async ({ state, resume, replyFirst }) => {
			const h = harness({
				model: 'selected',
				effort: 'high',
				resumeSessionId: resume ? 'native-1' : undefined,
			});
			const turn = h.session.prompt('after allocation').catch((error: unknown) => error);
			const allocation = await h.allocation();
			const update = {
				method: '_x.ai/session_notification',
				params: {
					sessionId: 'native-1',
					update: {
						sessionUpdate: state === 'ambiguous' ? 'config_option_update' : 'model_changed',
						model_id: state === 'model-conflict' ? 'foreign' : 'selected',
						reasoning_effort: state === 'effort-conflict' ? 'low' : 'high',
					},
				},
			};
			const response = {
				id: allocation.id,
				result: {
					sessionId: 'native-1',
					models: { currentModelId: 'selected' },
					configOptions: [
						{ id: 'reasoning_effort', type: 'select', currentValue: 'high', options: [] },
					],
				},
			};
			h.receive(...(replyFirst ? [response, update] : [update, response]));
			if (state === 'matching') {
				h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
				expect(await turn).toEqual({ stopReason: 'end_turn' });
			} else {
				expect(await turn).toMatchObject({
					reason: 'invalid-response',
					dispatchMayHaveOccurred: false,
				});
				expect(h.sent('session/prompt')).toHaveLength(0);
				expect(h.terminate).toHaveBeenCalledTimes(1);
			}
			expect(h.session.sessionId).toBe('native-1');
			expect(h.sent('session/set_config_option')).toHaveLength(0);
		}
	);

	it.each(
		['sessions', 'sessionId', 'model', 'effort'].flatMap((field) =>
			[false, true].map((overflow) => ({ field, overflow }))
		)
	)('bounds allocation $field (overflow: $overflow)', async ({ field, overflow }) => {
		const value = 'x'.repeat(1024 + Number(overflow));
		const sessionId = field === 'sessionId' ? value : 'native-1';
		const model = field === 'model' ? value : 'selected';
		const effort = field === 'effort' ? value : 'high';
		const h = harness({ model, effort });
		const turn = h.session.prompt('bounded').catch((error: unknown) => error);
		const allocation = await h.allocation();
		const count = field === 'sessions' ? 16 + Number(overflow) : 1;
		for (let i = 0; i < count; i++)
			h.receive({
				method: 'session/update',
				params: {
					sessionId: i === 0 ? sessionId : `foreign-${i}`,
					update: { sessionUpdate: 'model_changed', model_id: model, reasoning_effort: effort },
				},
			});
		h.reply(allocation, {
			sessionId,
			models: { currentModelId: model },
			configOptions: [
				{ id: 'reasoning_effort', type: 'select', currentValue: effort, options: [] },
			],
		});
		if (overflow) {
			expect(await turn).toMatchObject({
				reason: 'invalid-response',
				dispatchMayHaveOccurred: false,
			});
			expect(h.sent('session/prompt')).toHaveLength(0);
		} else {
			h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
			expect(await turn).toEqual({ stopReason: 'end_turn' });
		}
	});

	const selectableConfig = [
		{
			id: 'model',
			type: 'select',
			currentValue: 'first',
			options: [{ value: 'second', name: 'Second' }],
		},
		{
			id: 'reasoning_effort',
			type: 'select',
			currentValue: 'low',
			options: [{ value: 'high', name: 'High' }],
		},
	];
	it.each(
		['matching', 'conflicting', 'foreign'].flatMap((state) =>
			[false, true].map((replyFirst) => ({ state, replyFirst }))
		)
	)(
		'checks $state setter notification (reply first: $replyFirst)',
		async ({ state, replyFirst }) => {
			const h = harness();
			await h.ready({ sessionId: 'native-1', configOptions: selectableConfig });
			const setting = h.session
				.setConfiguration({ model: 'second' })
				.catch((error: unknown) => error);
			const request = await h.next('session/set_config_option');
			const result = { models: { currentModelId: 'second' }, configOptions: [] };
			const update = {
				method: 'session/update',
				params: {
					sessionId: state === 'foreign' ? 'foreign-session' : 'native-1',
					update: {
						sessionUpdate: 'config_option_update',
						...result,
						models: { currentModelId: state === 'matching' ? 'second' : 'conflicting' },
					},
				},
			};
			const response = { id: request.id, result };
			h.receive(...(replyFirst ? [response, update] : [update, response]));
			if (state === 'conflicting') {
				expect(await setting).toMatchObject({
					reason: 'invalid-response',
					dispatchMayHaveOccurred: false,
				});
				await expect(h.session.prompt('unsent')).rejects.toBe(h.session.error);
				expect(h.sent('session/prompt')).toHaveLength(0);
			} else {
				await expect(setting).resolves.toBeUndefined();
				expect(h.session.configuration).toMatchObject({ model: 'second', configOptions: [] });
				const turn = h.session.prompt('after setter');
				h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
				await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
			}
		}
	);

	it('ignores foreign replay and detaches configuration snapshots and allocation results', async () => {
		const h = harness({ resumeSessionId: 'native-1', model: 'first' });
		const opening = h.session.open();
		const allocation = await h.allocation();
		h.receive({
			method: 'session/update',
			params: {
				sessionId: 'foreign',
				update: {
					sessionUpdate: 'config_option_update',
					configOptions: [],
					models: { currentModelId: 'foreign' },
				},
			},
		});
		h.reply(allocation, { configOptions: selectableConfig });
		const allocated = await opening;
		const expected = h.session.configuration;
		const snapshot = h.session.configuration;
		snapshot.model = 'mutated';
		snapshot.configOptions[0].currentValue = 'mutated';
		snapshot.configOptions[0].options[0].name = 'Mutated';
		snapshot.configOptions.pop();
		(allocated.configOptions as typeof selectableConfig)[0].options.length = 0;
		h.receive({
			method: 'session/update',
			params: {
				sessionId: 'foreign',
				update: {
					sessionUpdate: 'model_changed',
					model_id: 'foreign',
				},
			},
		});
		expect(h.session.configuration).toEqual(expected);
		const turn = h.session.prompt('owned selection');
		h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
		await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it.each(
		['setter', 'discovery', 'usage'].flatMap((operation) =>
			[
				'pre-aborted',
				'pending',
				'reply-first',
				'process-lost',
				'idle-timeout',
				'transport-lost',
			].map((stage) => ({ operation, stage }))
		)
	)(
		'preserves $operation cancellation/failure at $stage and excludes overlapping work',
		async ({ operation, stage }) => {
			const h = harness({
				extensions: { agentVersion: 'fixture-version', modelsList: true, sessionUsage: true },
			});
			if (operation === 'setter')
				await h.ready({ sessionId: 'native-1', configOptions: selectableConfig });
			if (operation === 'usage') await usageReady(h);
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, 'removeEventListener');
			if (stage === 'pre-aborted') controller.abort();
			const operationResult = (
				operation === 'setter'
					? h.session.setConfiguration({ effort: 'high' }, controller.signal)
					: operation === 'usage'
						? h.session.processUsage(controller.signal)
						: h.session.discoverModels(controller.signal)
			).catch((error: unknown) => error);
			if (stage !== 'pre-aborted') {
				if (operation === 'discovery')
					h.reply(await h.next('initialize'), {
						protocolVersion: 1,
						_meta: { grokShell: true, agentVersion: 'fixture-version' },
					});
				const request = await h.next(
					operation === 'setter'
						? 'session/set_config_option'
						: operation === 'usage'
							? '_x.ai/session/usage'
							: '_x.ai/models/list'
				);
				await expect(h.session.prompt('overlap')).rejects.toMatchObject({ reason: 'busy' });
				await expect(h.session.discoverModels()).rejects.toMatchObject({ reason: 'busy' });
				await expect(h.session.processUsage()).rejects.toMatchObject({ reason: 'busy' });
				if (operation === 'setter')
					await expect(h.session.setConfiguration({ effort: 'high' })).rejects.toMatchObject({
						reason: 'busy',
					});
				else if (operation === 'discovery')
					await expect(h.session.open()).rejects.toMatchObject({ reason: 'busy' });
				if (stage === 'reply-first')
					h.reply(
						request,
						operation === 'setter'
							? {
									configOptions: selectableConfig.map((o) =>
										o.id === 'reasoning_effort' ? { ...o, currentValue: 'high' } : o
									),
								}
							: operation === 'usage'
								? { usage: { inputTokens: 4, outputTokens: 1 } }
								: { result: { currentModelId: 'first', availableModels: [] } }
					);
				if (stage === 'process-lost') h.child.emit('exit');
				if (stage === 'idle-timeout') await vi.advanceTimersByTimeAsync(100);
				if (stage === 'transport-lost') h.session.transportLost();
				const original = h.session.error;
				controller.abort();
				h.session.cancel();
				if (original) expect(await operationResult).toBe(original);
				h.reply(request, {});
				await operationResult;
				expect(h.terminate).toHaveBeenCalledTimes(1);
				expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
			} else {
				expect(h.session.isClosed).toBe(false);
				expect(h.terminate).not.toHaveBeenCalled();
			}
			expect(await operationResult).toMatchObject({
				reason: stage.endsWith('lost') || stage === 'idle-timeout' ? stage : 'cancelled',
				dispatchMayHaveOccurred: false,
			});
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.sent('session/cancel')).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each([
		'direct',
		'nested',
		'outer-error',
		'inner-error',
		'method-not-found',
		'null',
		'nested-null',
		'malformed',
		'nested-malformed',
		'foreign-session',
	])('reads optional usage %s without inventing a ledger or replaying prompts', async (mode) => {
		const h = harness({ extensions: { agentVersion: 'fixture-version', sessionUsage: true } });
		await expect(h.session.processUsage()).rejects.toMatchObject({ reason: 'missing-session-id' });
		await usageReady(h);
		const pending = h.session.processUsage().catch((error: unknown) => error);
		const request = await h.next('_x.ai/session/usage');
		expect(request.params).toEqual({ sessionId: 'native-1' });
		const usage = { usage: { inputTokens: 4, outputTokens: 1 } };
		const error = { code: 'unavailable', message: 'synthetic-private-diagnostic' };
		const responses: Record<string, unknown> = {
			direct: usage,
			nested: { result: usage },
			'outer-error': { result: usage, error },
			'inner-error': { result: { ...usage, error } },
			null: null,
			'nested-null': { result: null },
			malformed: [],
			'nested-malformed': { result: [] },
			'foreign-session': { ...usage, sessionId: 'foreign' },
		};
		if (mode === 'method-not-found')
			h.receive({ id: request.id, error: { code: -32601, message: error.message } });
		else h.reply(request, responses[mode]);
		const result = await pending;
		if (mode.includes('malformed') || mode === 'foreign-session') {
			expect(result).toMatchObject({ reason: 'invalid-response', dispatchMayHaveOccurred: false });
			await expect(h.session.processUsage()).rejects.toBe(result);
		} else if (mode === 'direct' || mode === 'nested') expect(result).toEqual(usage);
		else {
			expect(result).toBeUndefined();
			if (!mode.includes('null')) await expect(h.session.processUsage()).resolves.toBeUndefined();
			expect(h.session.error).toBeUndefined();
			expect(h.terminate).not.toHaveBeenCalled();
		}
		expect(String(result)).not.toContain(error.message);
		expect(h.sent('_x.ai/session/usage')).toHaveLength(1);
		expect(h.sent('session/prompt')).toHaveLength(0);
	});

	it('excludes prompts and other queries during sampling, and sampling during a prompt', async () => {
		const h = harness({ extensions: { agentVersion: 'fixture-version', sessionUsage: true } });
		await usageReady(h);
		const sampling = h.session.processUsage();
		const request = await h.next('_x.ai/session/usage');
		await expect(h.session.processUsage()).rejects.toMatchObject({ reason: 'busy' });
		await expect(h.session.discoverModels()).rejects.toMatchObject({ reason: 'busy' });
		await expect(h.session.setConfiguration({ model: 'other' })).rejects.toMatchObject({
			reason: 'busy',
		});
		await expect(h.session.prompt('overlap')).rejects.toMatchObject({ reason: 'busy' });
		h.reply(request, { usage: { inputTokens: 0, outputTokens: 0 } });
		await sampling;
		const turn = h.session.prompt('once');
		const prompt = await h.next('session/prompt');
		await expect(h.session.processUsage()).rejects.toMatchObject({ reason: 'busy' });
		expect(h.sent('_x.ai/session/usage')).toHaveLength(1);
		h.reply(prompt, { stopReason: 'end_turn' });
		await turn;
		expect(h.sent('session/prompt')).toHaveLength(1);
	});

	it('excludes discovery and setters during allocation and an active turn', async () => {
		const h = harness();
		const turn = h.session.prompt('exclusive');
		const allocation = await h.allocation();
		await expect(h.session.discoverModels()).rejects.toMatchObject({ reason: 'busy' });
		h.reply(allocation, { sessionId: 'native-1', configOptions: selectableConfig });
		const prompt = await h.next('session/prompt');
		await expect(h.session.discoverModels()).rejects.toMatchObject({ reason: 'busy' });
		await expect(h.session.setConfiguration({ effort: 'high' })).rejects.toMatchObject({
			reason: 'busy',
		});
		expect(h.sent('_x.ai/models/list')).toHaveLength(0);
		expect(h.sent('session/set_config_option')).toHaveLength(0);
		h.reply(prompt, { stopReason: 'end_turn' });
		await turn;
	});

	it.each(['setup', 'turn'] as const)(
		'enforces silence during %s with stdout/stderr activity and empty chunks',
		async (stage) => {
			const h = harness();
			if (stage === 'turn') await h.ready();
			const failed = h.session.prompt('silent').catch((error: unknown) => error);
			const request = await h.next(stage === 'setup' ? 'initialize' : 'session/prompt');
			await vi.advanceTimersByTimeAsync(90);
			h.receive({ method: 'session/update' });
			await vi.advanceTimersByTimeAsync(90);
			h.session.feedStderr(new TextEncoder().encode('progress'));
			await vi.advanceTimersByTimeAsync(90);
			h.session.feedStdout(new Uint8Array());
			h.session.feedStderr(new Uint8Array());
			expect(h.session.isClosed).toBe(false);
			await vi.advanceTimersByTimeAsync(10);
			expect(await failed).toMatchObject({
				reason: 'idle-timeout',
				dispatchMayHaveOccurred: stage === 'turn',
			});
			h.reply(request, stage === 'setup' ? { protocolVersion: 1 } : { stopReason: 'end_turn' });
			expect(h.sent('session/prompt')).toHaveLength(stage === 'turn' ? 1 : 0);
			expect(h.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('keeps the hard turn deadline fixed despite output', async () => {
		const h = harness();
		await h.ready();
		const failed = h.session.prompt('chatty').catch((error: unknown) => error);
		await h.next('session/prompt');
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(90);
			h.receive({ method: 'session/update' });
		}
		expect(h.session.isClosed).toBe(false);
		await vi.advanceTimersByTimeAsync(30);
		expect(await failed).toMatchObject({ reason: 'turn-timeout', dispatchMayHaveOccurred: true });
		expect(h.sent('session/prompt')).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['allocation', 'turn'] as const)(
		'bounds cancellation during %s even with continued output',
		async (stage) => {
			const h = harness();
			if (stage === 'turn') await h.ready();
			const failed = h.session.prompt('cancel').catch((error: unknown) => error);
			const request = stage === 'turn' ? await h.next('session/prompt') : await h.allocation();
			h.session.cancel();
			await vi.advanceTimersByTimeAsync(30);
			h.receive({ method: 'session/update' });
			h.session.cancel();
			await vi.advanceTimersByTimeAsync(10);
			expect(await failed).toMatchObject({
				reason: 'cancel-timeout',
				dispatchMayHaveOccurred: stage === 'turn',
			});
			h.reply(request, stage === 'turn' ? { stopReason: 'end_turn' } : { sessionId: 'too-late' });
			expect(h.session.sessionId).toBe(stage === 'turn' ? 'native-1' : undefined);
			expect(h.sent('session/cancel')).toHaveLength(stage === 'turn' ? 1 : 0);
			expect(h.sent('session/prompt')).toHaveLength(stage === 'turn' ? 1 : 0);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('holds resident identity and error listeners until pipe close, then permits explicit load', async () => {
		const h = harness();
		await h.ready();
		h.session.close();
		h.session.close();
		h.child.emit('exit', 1, null);
		h.child.emit('error', new Error('late error'));
		expect(h.terminate).toHaveBeenCalledTimes(1);
		expect(h.child.listenerCount('exit')).toBe(0);
		expect(h.child.listenerCount('error')).toBe(1);
		const duplicate = harness({
			resumeSessionId: 'native-1',
			cwd: path.resolve('synthetic-other-project'),
		});
		const failed = duplicate.session.open().catch((error: unknown) => error);
		duplicate.reply(await duplicate.next('initialize'), {
			protocolVersion: 1,
			agentCapabilities: { loadSession: true },
		});
		expect(await failed).toMatchObject({ reason: 'busy', dispatchMayHaveOccurred: false });
		expect(duplicate.sent('session/load')).toHaveLength(0);
		h.child.emit('close');
		expect(h.child.eventNames()).toEqual([]);
		const replacement = harness({ resumeSessionId: 'native-1' });
		await replacement.ready({});
		expect(replacement.session.sessionId).toBe('native-1');
	});

	it.each(['write', 'remote', 'disconnect'] as const)(
		'never retries an uncertain prompt after %s failure',
		async (mode) => {
			const h = harness();
			await h.ready();
			if (mode === 'write')
				h.write.mockImplementationOnce(() => {
					throw new Error('private writer error');
				});
			const failed = h.session.prompt('side effect').catch((error: unknown) => error);
			const request = await h.next('session/prompt');
			if (mode === 'remote')
				h.receive({ id: request.id, error: { code: -32603, message: 'private remote error' } });
			if (mode === 'disconnect') h.session.transportLost();
			const error = await failed;
			// A JSON-RPC answer is Grok's own failure of a delivered prompt, not a lost peer.
			expect(error).toMatchObject({
				reason: mode === 'remote' ? 'provider-error' : 'transport-lost',
				dispatchMayHaveOccurred: true,
			});
			h.reply(request, { stopReason: 'end_turn' });
			await expect(h.session.prompt('retry')).rejects.toBe(error);
			expect(h.sent('session/prompt')).toHaveLength(1);
			expect(h.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it.each([
		[
			'rate-limit',
			-32603,
			'Rate limit exceeded: too many requests PRIVATE-PROVIDER-TEXT',
			'rate_limited',
		],
		['auth', -32000, 'PRIVATE-PROVIDER-TEXT', 'auth_expired'],
		['unclassified', -32603, 'PRIVATE-PROVIDER-TEXT', undefined],
	] as const)(
		'classifies a %s JSON-RPC answer to the prompt by its content and keeps only the type',
		async (_name, code, message, errorType) => {
			const h = harness();
			await h.ready();
			const failed = h.session.prompt('side effect').catch((error: unknown) => error);
			const request = await h.next('session/prompt');
			h.receive({ id: request.id, error: { code, message, data: message } });
			const error = (await failed) as GrokAcpSessionError;
			expect(error).toMatchObject({
				reason: 'provider-error',
				dispatchMayHaveOccurred: true,
				errorType,
			});
			expect((error.cause as GrokAcpRequestError).errorType).toBe(errorType);
			for (const text of [error.message, String(error.cause), JSON.stringify(error)])
				expect(text).not.toContain('PRIVATE-PROVIDER-TEXT');
			expect(h.sent('session/prompt')).toHaveLength(1);
		}
	);
});
