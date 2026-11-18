// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import * as childProcess from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as processTree from '../../../../shared/maestro-lib/control/process-tree';
import * as platform from '../../../../shared/platformDetection';
import {
	startGrokAcpTurn,
	TurnNotStartedError,
	type GrokAcpTurnOptions,
	type GrokAcpTurnHandlers,
	type GrokAcpRunningTurn,
} from '../../../../shared/maestro-lib';
import type { AcpCall, AcpMessage } from '../../../../shared/maestro-lib/grok/acp-protocol';
import type { GrokEffectAuthority } from '../../../../shared/maestro-lib/grok/host-seams';

// Reuse the runner suite's mutable OS facades. All protocol/lifecycle layers stay real.
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
}));
vi.mock('../../../../shared/maestro-lib/control/process-tree', async (original) => ({
	...(await original<typeof import('../../../../shared/maestro-lib/control/process-tree')>()),
}));
vi.mock('../../../../shared/platformDetection', async (original) => ({
	...(await original<typeof import('../../../../shared/platformDetection')>()),
}));
vi.mock('electron', () => {
	throw new Error('The public ACP port must load without Electron');
});

// Synthetic wire-1/schema-0.11.4 traffic, not native qualification.
describe('public Grok ACP turn composition', () => {
	// Structural on purpose: ReturnType<typeof fixture> would make the fixture infer its own type.
	const fixtures: Array<{
		run?: GrokAcpRunningTurn;
		close(): void;
		child: { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
	}> = [];
	function fixture(
		overrides: Partial<GrokAcpTurnOptions> = {},
		handlers: GrokAcpTurnHandlers = {}
	) {
		const child = Object.assign(new EventEmitter(), {
			pid: 4242 + fixtures.length,
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => true),
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const messages: AcpMessage[] = [];
		child.stdin.on('data', (bytes) => messages.push(JSON.parse(bytes.toString())));
		const onEvent = vi.fn<NonNullable<GrokAcpTurnHandlers['onEvent']>>();
		const onRequestSettlement = vi.fn<NonNullable<GrokAcpTurnHandlers['onRequestSettlement']>>();
		const decide = vi.fn<GrokEffectAuthority['decide']>(() => ({ decision: 'allow' }));
		const options: GrokAcpTurnOptions = {
			cwd: path.resolve('synthetic-project'),
			account: 'fixture-account',
			host: 'fixture-host',
			turnId: `host-${fixtures.length}`,
			processGeneration: `process-${fixtures.length}`,
			prompt: 'Synthetic prompt',
			idleTimeoutMs: 100,
			maxTurnMs: 300,
			cancelGraceMs: 40,
			stopGraceMs: 20,
			requestTimeoutMs: 80,
			permission: {
				authority: { authorityId: 'test-effects', decide },
				binding: { actor: { kind: 'human', id: 'fixture-actor' }, leaseId: 'lease' },
			},
			...overrides,
		};
		const spec = { command: 'synthetic-grok', args: ['agent', 'stdio'], cwd: options.cwd, env: {} };
		let run: GrokAcpRunningTurn | undefined;
		const calls = (method: string) =>
			messages.filter((m): m is AcpCall => 'method' in m && m.method === method);
		const receive = (message: object) =>
			child.stdout.write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'));
		const reply = (call: AcpCall, result: unknown) => receive({ id: call.id, result });
		const next = async (method: string, count = 1) => {
			await vi.advanceTimersByTimeAsync(0);
			expect(calls(method)).toHaveLength(count);
			return calls(method)[count - 1];
		};
		const update = (value: object, meta?: object) =>
			receive({
				method: 'session/update',
				params: { sessionId: 'native-1', update: value, _meta: meta },
			});
		const h = {
			child,
			options,
			spec,
			messages,
			calls,
			receive,
			reply,
			next,
			update,
			onEvent,
			onRequestSettlement,
			decide,
			/** The ACP session let go of the child: none of its own pipe listeners is left. */
			detached() {
				return child.stdout.listenerCount('end') === 0 && child.stderr.listenerCount('error') === 0;
			},
			get run() {
				return run!;
			},
			start() {
				vi.mocked(childProcess.spawn).mockImplementationOnce(
					() => child as unknown as childProcess.ChildProcess
				);
				run = startGrokAcpTurn(spec, options, { onEvent, onRequestSettlement, ...handlers });
				return run;
			},
			async allocation(meta?: object) {
				reply(await next('initialize'), {
					protocolVersion: 1,
					agentCapabilities: { loadSession: true },
					_meta: meta,
				});
				return next(options.resumeSessionId ? 'session/load' : 'session/new');
			},
			async ready(meta?: object) {
				reply(await h.allocation(meta), options.resumeSessionId ? {} : { sessionId: 'native-1' });
				return next('session/prompt');
			},
			close() {
				Object.assign(child, { signalCode: 'SIGTERM' });
				child.emit('exit', null, 'SIGTERM');
				child.emit('close', null, 'SIGTERM');
			},
			async finish() {
				await vi.advanceTimersByTimeAsync(0);
				h.close();
				return run!.completed;
			},
			permission(id = 'permission', meta?: object) {
				receive({
					id,
					method: 'session/request_permission',
					params: {
						sessionId: 'native-1',
						_meta: meta,
						toolCall: { toolCallId: id, title: 'Read', rawInput: { path: 'README.md' } },
						options: [
							{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
							{ optionId: 'no', name: 'Deny', kind: 'reject_once' },
						],
					},
				});
			},
		};
		fixtures.push(h);
		return h;
	}
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
			throw new Error('Unexpected real process');
		});
		vi.spyOn(platform, 'isWindows').mockReturnValue(false);
		vi.spyOn(processTree, 'snapshotProcessTree').mockReturnValue({ owned: false, descendants: [] });
		vi.spyOn(processTree, 'killProcessTreeNow').mockImplementation(() => {});
		vi.spyOn(process, 'kill').mockReturnValue(true);
	});
	afterEach(async () => {
		try {
			for (const h of fixtures.splice(0)) {
				h.run?.cancel();
				h.close();
				await h.run?.completed;
				h.child.stdin.destroy();
				h.child.stdout.destroy();
				h.child.stderr.destroy();
			}
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});

	it('spawns without a shell, streams raw Unicode, and preserves success through owned shutdown', async () => {
		const h = fixture();
		h.start();
		expect(childProcess.spawn).toHaveBeenCalledWith(h.spec.command, h.spec.args, {
			cwd: h.spec.cwd,
			env: {},
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const prompt = await h.ready();
		expect(prompt.params).toEqual({
			sessionId: 'native-1',
			prompt: [{ type: 'text', text: h.options.prompt }],
		});
		const frame = Buffer.from(
			JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'native-1',
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: { type: 'text', text: 'Answer 🦊' },
					},
				},
			}) + '\n'
		);
		const split = frame.indexOf(Buffer.from('🦊')) + 2;
		h.child.stdout.write(frame.subarray(0, split));
		h.child.stdout.write(frame.subarray(split));
		h.child.stderr.write('private diagnostic');
		expect(h.run.answerSoFar()).toBe('Answer 🦊');
		h.reply(prompt, { stopReason: 'end_turn' });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
		const settled = vi.fn();
		void h.run.completed.then(settled);
		h.child.emit('exit', null, 'SIGTERM');
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).not.toHaveBeenCalled();
		expect(h.detached()).toBe(false);
		h.child.emit('close', null, 'SIGTERM');
		expect(await h.run.completed).toMatchObject({
			outcome: 'completed',
			terminal: { status: 'success' },
			answerText: 'Answer 🦊',
			sessionId: 'native-1',
			exit: { signal: 'SIGTERM', stdoutText: '', stderrText: '' },
		});
		expect(settled).toHaveBeenCalledTimes(1);
		expect(h.detached()).toBe(true);
		expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
		expect(h.onEvent.mock.calls.every(([, line]) => line === '')).toBe(true);
	});

	it('resumes repeated public calls without replaying load history or an old final', async () => {
		const first = fixture();
		first.start();
		const old = await first.ready();
		first.reply(old, { stopReason: 'end_turn' });
		const result = await first.finish();
		const h = fixture({ resumeSessionId: result.sessionId });
		h.start();
		const load = await h.allocation();
		expect(load.params).toMatchObject({ sessionId: result.sessionId, cwd: h.options.cwd });
		h.update({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'old history' },
		});
		h.reply(load, {});
		const prompt = await h.next('session/prompt');
		first.reply(old, { stopReason: 'end_turn' });
		expect(h.run.answerSoFar()).toBeUndefined();
		h.update({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'New answer' },
		});
		h.reply(prompt, { stopReason: 'end_turn' });
		h.reply(prompt, { stopReason: 'end_turn' });
		expect(await h.finish()).toMatchObject({
			answerText: 'New answer',
			sessionId: 'native-1',
			outcome: 'completed',
		});
		expect(h.calls('session/new')).toHaveLength(0);
		expect(h.calls('session/prompt')).toHaveLength(1);
		expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
	});

	it.each(['acknowledged', 'unacknowledged'] as const)(
		'waits for %s effort through the public port before dispatch',
		async (result) => {
			const onConfiguration = vi.fn<NonNullable<GrokAcpTurnHandlers['onConfiguration']>>();
			const h = fixture({ model: 'fixture-model', effort: 'high' }, { onConfiguration });
			h.start();
			const configOptions = [
				{ id: 'model', type: 'select', currentValue: 'fixture-model' },
				{
					id: 'reasoning_effort',
					type: 'select',
					currentValue: 'low',
					options: [{ value: 'high', name: 'High' }],
				},
			];
			const allocation = await h.allocation();
			expect(allocation.params).toMatchObject({ _meta: { modelId: 'fixture-model' } });
			h.reply(allocation, { sessionId: 'native-1', configOptions });
			const set = await h.next('session/set_config_option');
			expect(set.params).toEqual({
				sessionId: 'native-1',
				configId: 'reasoning_effort',
				value: 'high',
			});
			expect(h.calls('session/prompt')).toHaveLength(0);
			expect(h.run.configuration()).toBeUndefined();
			expect(onConfiguration).not.toHaveBeenCalled();
			if (result === 'acknowledged') configOptions[1].currentValue = 'high';
			h.reply(set, { configOptions });
			if (result === 'acknowledged') {
				const prompt = await h.next('session/prompt');
				expect(h.run.configuration()?.configuration.configOptions[1].currentValue).toBe('high');
				expect(onConfiguration).toHaveBeenCalledTimes(1);
				h.reply(prompt, { stopReason: 'end_turn' });
				expect((await h.finish()).terminal.status).toBe('success');
			} else {
				expect((await h.finish()).terminal).toMatchObject({
					status: 'failed',
					reason: 'effort-unacknowledged',
					dispatchState: 'not-dispatched',
				});
				expect(h.calls('session/prompt')).toHaveLength(0);
				expect(onConfiguration).not.toHaveBeenCalled();
			}
		}
	);

	it.each([
		'not-requested',
		'no-extensions',
		'disabled-extension',
		'account',
		'host',
		'qualified-version',
		'extension-version',
		'peer-version',
		'unidentified-peer',
	])('skips optional discovery with %s qualification', async (mismatch) => {
		const h = fixture({
			extensions: { agentVersion: 'fixture-version', modelsList: true },
			modelDiscovery: {
				account: 'fixture-account',
				host: 'fixture-host',
				agentVersion: 'fixture-version',
			},
		});
		if (mismatch === 'not-requested') h.options.modelDiscovery = undefined;
		if (mismatch === 'no-extensions') h.options.extensions = undefined;
		if (mismatch === 'disabled-extension') h.options.extensions!.modelsList = false;
		if (mismatch === 'account') h.options.modelDiscovery!.account = 'another-account';
		if (mismatch === 'host') h.options.modelDiscovery!.host = 'another-host';
		if (mismatch === 'qualified-version')
			h.options.modelDiscovery!.agentVersion = 'another-version';
		if (mismatch === 'extension-version') h.options.extensions!.agentVersion = 'another-version';
		h.start();
		const prompt = await h.ready({
			grokShell: mismatch !== 'unidentified-peer',
			agentVersion: mismatch === 'peer-version' ? 'another-version' : 'fixture-version',
		});
		expect(h.calls('_x.ai/models/list')).toHaveLength(0);
		expect(h.run.configuration()?.models).toBeUndefined();
		expect(childProcess.spawn).toHaveBeenCalledTimes(1);
		h.reply(prompt, { stopReason: 'end_turn' });
		expect((await h.finish()).terminal.status).toBe('success');
	});

	it.each(['mutate', 'throw', 'reject'] as const)(
		'retains detached pre-dispatch configuration when an observer chooses to %s',
		async (behavior) => {
			let promptCountAtObservation: number | undefined;
			const onConfiguration = vi.fn<NonNullable<GrokAcpTurnHandlers['onConfiguration']>>(
				(value) => {
					promptCountAtObservation = h.calls('session/prompt').length;
					value.account = 'mutated-account';
					value.configuration.configOptions[0].options[0].name = 'Mutated';
					value.models!.availableModels[0].modelId = 'mutated-model';
					if (behavior === 'throw') throw new Error('Fixture observer failure');
					if (behavior === 'reject') return Promise.reject(new Error('Fixture observer rejection'));
				}
			);
			const h = fixture(
				{
					model: 'fixture-model',
					extensions: { agentVersion: 'fixture-version', modelsList: true },
					modelDiscovery: {
						account: 'fixture-account',
						host: 'fixture-host',
						agentVersion: 'fixture-version',
					},
				},
				{ onConfiguration }
			);
			h.start();
			// Async setup cannot read later mutations to the caller's qualification.
			h.options.modelDiscovery!.account = 'changed-after-start';
			h.options.extensions!.modelsList = false;
			expect(h.run.configuration()).toBeUndefined();
			h.reply(await h.allocation({ grokShell: true, agentVersion: 'fixture-version' }), {
				sessionId: 'native-1',
				configOptions: [
					{
						id: 'model',
						type: 'select',
						currentValue: 'fixture-model',
						options: [{ value: 'fixture-model', name: 'Fixture' }],
					},
				],
			});
			const discovery = await h.next('_x.ai/models/list');
			expect(discovery.params).toEqual({});
			expect(h.calls('session/prompt')).toHaveLength(0);
			expect(onConfiguration).not.toHaveBeenCalled();
			h.reply(discovery, {
				result: {
					currentModelId: 'fixture-model',
					availableModels: [{ modelId: 'fixture-model', name: 'Fixture' }],
				},
			});
			const prompt = await h.next('session/prompt');
			expect(promptCountAtObservation).toBe(0);
			expect(onConfiguration).toHaveBeenCalledTimes(1);
			expect(onConfiguration.mock.calls[0][0].account).toBe('mutated-account');
			expect(onConfiguration.mock.calls[0][0].models?.availableModels[0].modelId).toBe(
				'mutated-model'
			);
			const retained = h.run.configuration()!;
			expect(retained).toMatchObject({
				account: 'fixture-account',
				host: 'fixture-host',
				cwd: h.options.cwd,
				processGeneration: h.options.processGeneration,
				sessionId: 'native-1',
				observedAt: expect.any(Number),
				configuration: {
					agentVersion: 'fixture-version',
					model: 'fixture-model',
					configOptions: [{ options: [{ value: 'fixture-model', name: 'Fixture' }] }],
				},
				models: { availableModels: [{ modelId: 'fixture-model', name: 'Fixture' }] },
			});
			const callerCopy = h.run.configuration()!;
			expect(callerCopy).not.toBe(retained);
			callerCopy.configuration.configOptions[0].options.length = 0;
			callerCopy.models!.availableModels.length = 0;
			expect(h.run.configuration()).toEqual(retained);
			h.reply(prompt, { stopReason: 'end_turn' });
			expect((await h.finish()).terminal.status).toBe('success');
			expect(h.run.configuration()).toEqual(retained);
			expect(childProcess.spawn).toHaveBeenCalledTimes(1);
			expect(h.calls('_x.ai/models/list')).toHaveLength(1);
		}
	);

	it.each(['empty', 'unavailable'] as const)(
		'retains an %s owned catalog distinctly',
		async (state) => {
			const h = fixture({
				extensions: { agentVersion: 'fixture-version', modelsList: true },
				modelDiscovery: {
					account: 'fixture-account',
					host: 'fixture-host',
					agentVersion: 'fixture-version',
				},
			});
			h.start();
			h.reply(await h.allocation({ grokShell: true, agentVersion: 'fixture-version' }), {
				sessionId: 'native-1',
			});
			const models = { currentModelId: 'hidden-model', availableModels: [] };
			h.reply(
				await h.next('_x.ai/models/list'),
				state === 'empty' ? { result: models } : { error: {} }
			);
			const prompt = await h.next('session/prompt');
			expect(h.run.configuration()?.models).toEqual(state === 'empty' ? models : undefined);
			h.reply(prompt, { stopReason: 'end_turn' });
			expect((await h.finish()).terminal.status).toBe('success');
		}
	);

	it.each(['allow', 'deny'] as const)(
		'routes tools, plans and %s permission through transmitted native identity',
		async (decision) => {
			const h = fixture({ extensions: { agentVersion: 'fixture-version', promptId: true } });
			h.decide.mockReturnValue(
				decision === 'allow' ? { decision } : { decision, reason: 'Fixture denial' }
			);
			h.start();
			const prompt = await h.ready({ grokShell: true, agentVersion: 'fixture-version' });
			const meta = (prompt.params as Record<string, unknown>)._meta as { promptId: string };
			expect(meta.promptId).toBeTypeOf('string');
			expect(meta.promptId).not.toBe(h.options.turnId);
			h.update(
				{
					sessionUpdate: 'plan',
					entries: [{ content: 'Inspect', priority: 'high', status: 'in_progress' }],
				},
				meta
			);
			h.update(
				{
					sessionUpdate: 'tool_call',
					toolCallId: 'tool',
					title: 'Read',
					kind: 'read',
					status: 'in_progress',
				},
				meta
			);
			expect(h.decide).not.toHaveBeenCalled();
			h.permission('tool', meta);
			await vi.advanceTimersByTimeAsync(0);
			expect(h.decide.mock.calls[0][1]).toMatchObject({
				threadId: 'native-1',
				turnId: meta.promptId,
				provider: 'grok',
			});
			expect(h.messages.filter((m) => m.id === 'tool')).toEqual([
				{
					jsonrpc: '2.0',
					id: 'tool',
					result: {
						outcome: { outcome: 'selected', optionId: decision === 'allow' ? 'yes' : 'no' },
					},
				},
			]);
			h.update(
				{ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' },
				meta
			);
			h.reply(prompt, { stopReason: decision === 'allow' ? 'end_turn' : 'cancelled' });
			expect((await h.finish()).terminal.status).toBe(decision === 'allow' ? 'success' : 'refused');
			expect(h.onRequestSettlement).toHaveBeenCalledTimes(1);
			expect(h.onEvent.mock.calls.map(([e]) => e)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ toolCallId: 'tool', type: 'tool_use' }),
					expect.objectContaining({
						toolName: 'update_plan',
						toolState: expect.objectContaining({
							planUpdate: expect.objectContaining({
								promptId: meta.promptId,
								turnId: h.options.turnId,
							}),
						}),
					}),
				])
			);
		}
	);

	it.each(['initialize', 'allocation'] as const)(
		'cancels during %s without dispatch or replay',
		async (stage) => {
			const h = fixture();
			h.start();
			const pending = stage === 'initialize' ? await h.next('initialize') : await h.allocation();
			h.run.cancel();
			h.reply(pending, { sessionId: 'native-1', protocolVersion: 1 });
			expect((await h.finish()).terminal).toMatchObject({
				status: 'cancelled',
				dispatchState: 'not-dispatched',
			});
			expect(h.calls('session/prompt')).toHaveLength(0);
		}
	);

	it.each(['cancel', 'disconnect', 'terminate'] as const)(
		'settles every pending permission on %s, retaining partial output',
		async (cause) => {
			const h = fixture();
			const pending: Array<{
				signal: AbortSignal;
				resolve: (value: { decision: 'allow' }) => void;
			}> = [];
			h.decide.mockImplementation(
				(_effect, _binding, signal) => new Promise((resolve) => pending.push({ signal, resolve }))
			);
			h.start();
			const prompt = await h.ready();
			h.update({
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Partial' },
			});
			h.permission('a');
			h.permission('b');
			await vi.advanceTimersByTimeAsync(0);
			expect(pending).toHaveLength(2);
			if (cause === 'cancel') h.run.cancel();
			else if (cause === 'disconnect') h.child.stdout.emit('end');
			else h.run.handle.terminate();
			if (cause === 'cancel') {
				expect(h.calls('session/cancel')).toHaveLength(1);
				expect(h.calls('session/cancel')[0].params).toEqual({ sessionId: 'native-1' });
			}
			expect(pending.every((p) => p.signal.aborted)).toBe(true);
			expect(h.onRequestSettlement).toHaveBeenCalledTimes(2);
			const replies = h.messages.filter((m) => m.id === 'a' || m.id === 'b');
			for (const p of pending) p.resolve({ decision: 'allow' });
			h.reply(prompt, { stopReason: 'end_turn' });
			const result = await h.finish();
			expect(result.answerText).toBe('Partial');
			expect(result.terminal.status).toBe(cause === 'disconnect' ? 'failed' : 'cancelled');
			expect(h.messages.filter((m) => m.id === 'a' || m.id === 'b')).toEqual(replies);
			expect(h.onRequestSettlement).toHaveBeenCalledTimes(2);
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.detached()).toBe(true);
		}
	);

	it.each(['process', 'malformed-bytes', 'idle'] as const)(
		'does not turn %s loss into a successful answer',
		async (cause) => {
			const h = fixture();
			h.start();
			const prompt = await h.ready();
			h.update({
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Partial' },
			});
			if (cause === 'process') h.child.emit('exit', 1, null);
			else if (cause === 'malformed-bytes') h.child.stdout.write(Buffer.from([0xff, 0x0a]));
			else await vi.advanceTimersByTimeAsync(100);
			h.reply(prompt, { stopReason: 'end_turn' });
			const result = await h.finish();
			expect(result).toMatchObject({
				answerText: 'Partial',
				terminal: { status: cause === 'idle' ? 'timeout' : 'failed', dispatchState: 'unknown' },
			});
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
		}
	);

	it.each([
		['rate-limit', 'rate_limited'],
		['auth', 'auth_expired'],
		['unclassified', 'unknown'],
		['peer-loss', 'agent_crashed'],
	] as const)(
		'reads a %s on session/prompt by its own content, keeping a JSON-RPC answer apart from a lost peer',
		async (cause, type) => {
			const h = fixture();
			h.start();
			const prompt = await h.ready();
			if (cause === 'peer-loss') h.child.emit('exit', 1, null);
			else
				h.receive({
					id: prompt.id,
					error: {
						code: cause === 'auth' ? -32000 : -32603,
						message:
							cause === 'rate-limit'
								? 'Rate limit exceeded: too many requests PRIVATE-PROVIDER-TEXT'
								: 'PRIVATE-PROVIDER-TEXT',
					},
				});
			const result = await h.finish();
			expect(result.outcome).toBe('crashed');
			expect(result.error).toMatchObject({ type, agentId: 'grok', recoverable: true });
			expect(result.terminal).toMatchObject(
				cause === 'peer-loss'
					? { status: 'failed', kind: 'process', dispatchState: 'unknown' }
					: {
							status: 'failed',
							kind: 'provider',
							reason: 'provider-error',
							dispatchState: 'dispatched',
						}
			);
			expect(JSON.stringify([result.error, result.terminal, h.onEvent.mock.calls])).not.toContain(
				'PRIVATE-PROVIDER-TEXT'
			);
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.detached()).toBe(true);
		}
	);

	it('settles unavailable questions without granting effects or fabricating an answer', async () => {
		const onQuestion = vi.fn<NonNullable<GrokAcpTurnHandlers['onQuestion']>>();
		const h = fixture({}, { onQuestion });
		h.start();
		const prompt = await h.ready();
		h.receive({
			id: 'question',
			method: '_x.ai/ask_user_question',
			params: { sessionId: 'native-1', question: 'Choose?' },
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.run.questionSupport).toEqual({ status: 'unsupported', reason: 'not-advertised' });
		const event = onQuestion.mock.calls[0][0];
		expect(event.state).toBe('settled');
		if (event.state !== 'settled') throw new Error('Question unexpectedly pending');
		expect(h.run.answerQuestion(event.settlement.identity, 'yes')).toBe('unavailable');
		expect(h.messages.filter((m) => m.id === 'question')).toEqual([
			{ jsonrpc: '2.0', id: 'question', result: { outcome: 'cancelled' } },
		]);
		expect(h.decide).not.toHaveBeenCalled();
		h.reply(prompt, { stopReason: 'end_turn' });
		expect((await h.finish()).terminal.status).toBe('cancelled');
		expect(onQuestion).toHaveBeenCalledTimes(1);
		expect(h.onRequestSettlement).toHaveBeenCalledTimes(1);
	});

	// The unattended contract. maestro-cli host, Cue, runtime and Auto Run turns
	// all run this driver. A question the turn owns settles at once with its method's own
	// cancel outcome, and the turn reads the capability gap the desktop tab shows: never an
	// interruption the caller asked for, never an approval. No answer (first, duplicate,
	// forged or from another turn) reaches the wire or the effect authority.
	describe('unattended questions and plans', () => {
		const ASK = '_x.ai/ask_user_question';
		const ELICIT = '_x.ai/mcp/elicit';
		const ask = (
			h: { receive(message: object): void },
			method = ASK,
			sessionId = 'native-1',
			id = 'question'
		) =>
			h.receive({
				id,
				method,
				params: {
					sessionId,
					...(method === ASK
						? { mode: 'default', questions: [{ question: 'Pick', options: [{ label: 'One' }] }] }
						: { mode: 'form', message: 'Choose', requestedSchema: { type: 'object' } }),
				},
			});
		const plansOf = (h: {
			onEvent: { mock: { calls: Array<[{ toolName?: string }, ...unknown[]]> } };
		}) => h.onEvent.mock.calls.map(([e]) => e).filter((e) => e.toolName === 'update_plan');
		const settledQuestion = (onQuestion: ReturnType<typeof vi.fn>, index = 0) => {
			const event = onQuestion.mock.calls[index][0] as Parameters<
				NonNullable<GrokAcpTurnHandlers['onQuestion']>
			>[0];
			if (event.state !== 'settled') throw new Error('Question unexpectedly pending');
			return event.settlement;
		};

		it.each([
			[ASK, 'cancelled', 'a question for you'],
			[ELICIT, 'cancel', 'an MCP elicitation'],
		] as const)(
			'settles a %s the turn owns as a capability gap, not an interruption',
			async (method, outcome, kind) => {
				const onQuestion = vi.fn<NonNullable<GrokAcpTurnHandlers['onQuestion']>>();
				const h = fixture({}, { onQuestion });
				h.start();
				const prompt = await h.ready();
				ask(h, method);
				await vi.advanceTimersByTimeAsync(0);
				const wire = () => h.messages.filter((m: AcpMessage) => m.id === 'question');
				expect(wire()).toEqual([{ jsonrpc: '2.0', id: 'question', result: { outcome } }]);
				const settlement = settledQuestion(onQuestion);
				expect(settlement).toMatchObject({ turnId: h.options.turnId, reason: 'unavailable' });
				// First, duplicate and forged answers are refused with no second wire write.
				expect(h.run.answerQuestion(settlement.identity, 'One')).toBe('unavailable');
				expect(h.run.answerQuestion(settlement.identity, 'One')).toBe('unavailable');
				expect(h.run.answerQuestion({ ...settlement.identity, questionId: 'forged' }, 'One')).toBe(
					'unavailable'
				);
				expect(wire()).toHaveLength(1);
				h.reply(prompt, { stopReason: 'end_turn' });
				const done = await h.finish();
				expect(done.outcome).toBe('crashed');
				expect(done.terminal).toMatchObject({
					status: 'cancelled',
					reason: 'user-input-unavailable',
				});
				expect(done.error).toMatchObject({
					type: 'unknown',
					recoverable: false,
					agentId: 'grok',
					sessionId: 'native-1',
				});
				expect(done.error?.message).toContain(`${kind} (${method})`);
				expect(done.error?.message).toContain('advertises no ask-back capability');
				expect(done.error?.message).toContain(
					'no tool was authorized and no permission or policy changed'
				);
				expect(h.decide).not.toHaveBeenCalled();
				expect(onQuestion).toHaveBeenCalledTimes(1);
			}
		);

		it('ignores a stale question for another session: the turn keeps its own outcome', async () => {
			const onQuestion = vi.fn<NonNullable<GrokAcpTurnHandlers['onQuestion']>>();
			const h = fixture({}, { onQuestion });
			h.start();
			const prompt = await h.ready();
			ask(h, ASK, 'native-other', 'stale');
			await vi.advanceTimersByTimeAsync(0);
			for (const [event] of onQuestion.mock.calls) {
				if (event.state === 'settled') expect(event.settlement.turnId).toBeNull();
			}
			h.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } });
			h.reply(prompt, { stopReason: 'end_turn' });
			const done = await h.finish();
			expect(done).toMatchObject({ outcome: 'completed', answerText: 'Done' });
			expect(done.terminal.status).toBe('success');
			expect(done.error).toBeUndefined();
			expect(h.decide).not.toHaveBeenCalled();
		});

		it('keeps a user Stop after a settled question an interruption with no question error', async () => {
			const onQuestion = vi.fn<NonNullable<GrokAcpTurnHandlers['onQuestion']>>();
			const h = fixture({}, { onQuestion });
			h.start();
			const prompt = await h.ready();
			ask(h);
			await vi.advanceTimersByTimeAsync(0);
			expect(settledQuestion(onQuestion).reason).toBe('unavailable');
			h.run.cancel();
			expect(h.calls('session/cancel')).toHaveLength(1);
			h.reply(prompt, { stopReason: 'cancelled' });
			const done = await h.finish();
			expect(done.outcome).toBe('interrupted');
			expect(done.terminal).toMatchObject({ status: 'cancelled', reason: 'host-cancelled' });
			expect(done.error?.message ?? '').not.toContain('ask-back');
			expect(h.decide).not.toHaveBeenCalled();
		});

		it('keeps two concurrent turns apart: the question, its gap and the plan stay with their owner', async () => {
			const onQuestionA = vi.fn<NonNullable<GrokAcpTurnHandlers['onQuestion']>>();
			const onQuestionB = vi.fn<NonNullable<GrokAcpTurnHandlers['onQuestion']>>();
			const a = fixture({}, { onQuestion: onQuestionA });
			// One account cannot hold the same native session twice, so tab B is another account.
			const b = fixture({ account: 'fixture-account-b' }, { onQuestion: onQuestionB });
			a.start();
			const promptA = await a.ready();
			b.start();
			const promptB = await b.ready();
			// Both peers reuse request id `question` and native session id `native-1`.
			ask(a);
			b.update({
				sessionUpdate: 'plan',
				entries: [{ content: 'Plan B', priority: 'low', status: 'pending' }],
			});
			await vi.advanceTimersByTimeAsync(0);
			const settlement = settledQuestion(onQuestionA);
			expect(b.run.answerQuestion(settlement.identity, 'One')).toBe('unavailable');
			expect(onQuestionB).not.toHaveBeenCalled();
			expect(b.messages.filter((m: AcpMessage) => m.id === 'question')).toEqual([]);
			b.reply(promptB, { stopReason: 'end_turn' });
			a.reply(promptA, { stopReason: 'end_turn' });
			const [doneA, doneB] = [await a.finish(), await b.finish()];
			expect(doneA.outcome).toBe('crashed');
			expect(doneB.outcome).toBe('completed');
			expect(doneB.error).toBeUndefined();
			expect(plansOf(a)).toEqual([]);
			expect(plansOf(b)).toEqual([
				expect.objectContaining({
					toolState: expect.objectContaining({
						planUpdate: expect.objectContaining({ turnId: b.options.turnId }),
					}),
				}),
			]);
			expect(a.decide).not.toHaveBeenCalled();
			expect(b.decide).not.toHaveBeenCalled();
		});
	});

	it.each(['aborted', 'blank-turn', 'stdin'])(
		'rejects %s preflight before spawning or allocating lifecycle work',
		(kind) => {
			const h = fixture();
			if (kind === 'aborted') h.options.signal = AbortSignal.abort();
			if (kind === 'blank-turn') h.options.turnId = ' ';
			const spec = kind === 'stdin' ? { ...h.spec, stdin: 'wrong route' } : h.spec;
			expect(() => startGrokAcpTurn(spec, h.options)).toThrow(
				kind === 'aborted' ? 'cancelled' : 'invalid-options'
			);
			expect(childProcess.spawn).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('leaves no turn work after synchronous spawn failure', () => {
		const h = fixture();
		const error = new Error('Synthetic spawn failure');
		vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
			throw error;
		});
		// Upstream start-turn reports a spawn that never started as TurnNotStartedError.
		let thrown: unknown;
		try {
			startGrokAcpTurn(h.spec, h.options);
		} catch (caught) {
			thrown = caught;
		}
		expect(thrown).toBeInstanceOf(TurnNotStartedError);
		expect((thrown as Error).message).toBe(error.message);
		expect(childProcess.spawn).toHaveBeenCalledOnce();
		expect(h.messages).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['options', 'started-observer', 'spawn-error', 'missing-id', 'model'])(
		'cleans owned setup after %s failure without dispatch or success',
		async (cause) => {
			const h = fixture(
				cause === 'options' ? { idleTimeoutMs: 0 } : cause === 'model' ? { model: 'wanted' } : {},
				cause === 'started-observer'
					? {
							onStarted: () => {
								throw new Error('Observer');
							},
						}
					: {}
			);
			if (cause === 'spawn-error') Object.assign(h.child, { pid: undefined });
			h.start();
			if (cause === 'spawn-error') h.child.emit('error', new Error('Synthetic ENOENT'));
			if (cause === 'missing-id' || cause === 'model') {
				const allocation = await h.allocation();
				h.reply(
					allocation,
					cause === 'missing-id'
						? {}
						: {
								sessionId: 'native-1',
								models: { currentModelId: 'other', availableModels: [] },
							}
				);
			}
			await vi.advanceTimersByTimeAsync(0);
			const result = await h.finish();
			expect(result.terminal).toMatchObject({
				status: 'failed',
				dispatchState: 'not-dispatched',
				reason:
					cause === 'options'
						? 'invalid-options'
						: cause === 'missing-id'
							? 'missing-session-id'
							: cause === 'model'
								? 'model-unacknowledged'
								: cause === 'spawn-error'
									? 'process-lost'
									: 'transport-lost',
			});
			expect(h.calls('session/prompt')).toHaveLength(0);
			expect(h.onEvent.mock.calls.filter(([event]) => event.terminal)).toHaveLength(1);
			expect(h.detached()).toBe(true);
		}
	);

	it.each(['success', 'durable-failure'])(
		'binds %s durable updates to the dispatched native prompt and settles once',
		async (outcome) => {
			const h = fixture({ extensions: { agentVersion: 'fixture-version', promptId: true } });
			h.start();
			const prompt = await h.ready({ grokShell: true, agentVersion: 'fixture-version' });
			const { promptId } = (prompt.params as { _meta: { promptId: string } })._meta;
			expect(promptId).not.toBe(h.options.turnId);
			const durable = {
				method: '_x.ai/session/update',
				params: {
					sessionId: 'native-1',
					update: {
						sessionUpdate: 'turn_completed',
						prompt_id: promptId,
						stop_reason: 'end_turn',
						agent_result: 'Owned answer',
						...(outcome === 'durable-failure' ? { error_kind: 'provider_fault' } : {}),
					},
				},
			};
			for (const foreign of ['session', 'prompt', 'host-turn']) {
				const frame = structuredClone(durable);
				if (foreign === 'session') frame.params.sessionId = 'foreign-session';
				else frame.params.update.prompt_id = foreign === 'prompt' ? 'old-prompt' : h.options.turnId;
				frame.params.update.error_kind = 'foreign_fault';
				frame.params.update.agent_result = 'Foreign answer';
				h.receive(frame);
			}
			h.permission('foreign', { promptId: 'old-prompt' });
			h.receive(durable);
			h.receive({
				...durable,
				params: {
					...durable.params,
					update: {
						...durable.params.update,
						agent_result: 'Duplicate rewrite',
						error_kind: 'duplicate_fault',
					},
				},
			});
			expect(h.decide).not.toHaveBeenCalled();
			expect(h.onEvent.mock.calls.filter(([event]) => event.terminal)).toHaveLength(0);
			const record = vi.fn();
			void h.run.completed.then(record);
			h.reply(prompt, { stopReason: 'end_turn' });
			h.reply(prompt, { stopReason: 'end_turn' });
			const result = await h.finish();
			expect(result.terminal).toMatchObject({
				status: outcome === 'success' ? 'success' : 'failed',
				dispatchState: 'dispatched',
			});
			expect(result.answerText).toBe('Owned answer');
			const count = h.onEvent.mock.calls.length;
			h.receive(durable);
			h.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Late' } });
			h.run.cancel();
			expect(await h.run.completed).toBe(result);
			expect(record).toHaveBeenCalledExactlyOnceWith(result);
			expect(h.onEvent).toHaveBeenCalledTimes(count);
			expect(h.onEvent.mock.calls.filter(([event]) => event.terminal)).toHaveLength(1);
			expect(h.calls('session/prompt')).toHaveLength(1);
		}
	);

	it.each(['sessionId', 'promptId'])(
		'refuses mismatched response %s without losing the owned partial answer',
		async (field) => {
			const h = fixture({ extensions: { agentVersion: 'fixture-version', promptId: true } });
			h.start();
			const prompt = await h.ready({ grokShell: true, agentVersion: 'fixture-version' });
			h.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Owned' } });
			h.reply(prompt, { stopReason: 'end_turn', _meta: { [field]: 'foreign' } });
			expect(await h.finish()).toMatchObject({
				answerText: 'Owned',
				terminal: { status: 'failed', kind: 'protocol' },
			});
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.onEvent.mock.calls.filter(([event]) => event.terminal)).toHaveLength(1);
		}
	);

	it.each(['mutate', 'throw'])(
		'preserves captured text and terminal ownership when an event observer chooses to %s',
		async (behavior) => {
			const observer = vi.fn<NonNullable<GrokAcpTurnHandlers['onEvent']>>((event) => {
				if (event.type === 'text') {
					event.text = 'Observer rewrite';
					if (behavior === 'throw') throw new Error('Observer fault');
				}
				if (event.terminal) event.terminal.status = 'success';
			});
			const h = fixture({}, { onEvent: observer });
			h.start();
			const prompt = await h.ready();
			h.update({
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Original' },
			});
			h.reply(prompt, { stopReason: 'cancelled' });
			expect(await h.finish()).toMatchObject({
				answerText: 'Original',
				terminal: { status: behavior === 'throw' ? 'failed' : 'cancelled' },
			});
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(observer.mock.calls.filter(([event]) => event.terminal)).toHaveLength(1);
		}
	);

	it.each(['mutate', 'throw'])(
		'keeps permission refusal when its settlement observer chooses to %s',
		async (behavior) => {
			const observer = vi.fn<NonNullable<GrokAcpTurnHandlers['onRequestSettlement']>>((value) => {
				if (value.terminal) Object.assign(value.terminal, { status: 'success' });
				if (behavior === 'throw') throw new Error('Settlement observer');
			});
			const h = fixture({}, { onRequestSettlement: observer });
			h.decide.mockReturnValue({ decision: 'deny', reason: 'fixture-deny' });
			h.start();
			const prompt = await h.ready();
			h.permission();
			await vi.advanceTimersByTimeAsync(0);
			h.reply(prompt, { stopReason: 'cancelled' });
			expect((await h.finish()).terminal).toMatchObject({
				status: behavior === 'throw' ? 'failed' : 'refused',
				reason: behavior === 'throw' ? 'acp-transport-fault' : 'permission-denied',
			});
			expect(observer).toHaveBeenCalledTimes(1);
			expect(h.messages.filter((message) => message.id === 'permission')).toHaveLength(1);
		}
	);

	it.each(['cancel', 'terminate'])(
		'aborts authority before a failing cancellation write or OS signal on %s',
		async (cause) => {
			const h = fixture();
			let signal: AbortSignal;
			let grant: (value: { decision: 'allow' }) => void;
			h.decide.mockImplementation((_effect, _binding, pending) => {
				signal = pending;
				return new Promise((resolve) => {
					grant = resolve;
				});
			});
			h.start();
			const prompt = await h.ready();
			h.permission();
			await vi.advanceTimersByTimeAsync(0);
			const atSignal: boolean[] = [];
			const atWrite: boolean[] = [];
			h.child.kill.mockImplementation(() => {
				atSignal.push(signal.aborted);
				return true;
			});
			const write = vi.spyOn(h.child.stdin, 'write').mockImplementation(() => {
				atWrite.push(signal.aborted);
				throw new Error('Synthetic cancellation write failure');
			});
			if (cause === 'cancel') h.run.cancel();
			else h.run.handle.terminate();
			expect(signal!.aborted).toBe(true);
			expect(atWrite).toEqual([true]);
			expect(atSignal).toEqual([true]);
			expect(write).toHaveBeenCalledTimes(1);
			expect(h.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
			grant!({ decision: 'allow' });
			h.reply(prompt, { stopReason: 'end_turn' });
			const result = await h.finish();
			expect(result.terminal).toMatchObject({
				status: 'cancelled',
				reason: cause === 'cancel' ? 'host-cancelled' : 'process-stopped',
			});
			expect(h.onRequestSettlement).toHaveBeenCalledTimes(1);
			expect(h.onEvent.mock.calls.filter(([event]) => event.terminal)).toHaveLength(1);
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.detached()).toBe(true);
		}
	);

	it.each(['hard', 'cancel'])(
		'enforces the %s deadline without overwriting the original failure or replaying',
		async (deadline) => {
			const h = fixture({ idleTimeoutMs: 1000 });
			h.start();
			const prompt = await h.ready();
			if (deadline === 'cancel') h.run.cancel();
			const budget = deadline === 'cancel' ? h.options.cancelGraceMs! : h.options.maxTurnMs;
			await vi.advanceTimersByTimeAsync(budget - 1);
			expect(h.child.kill).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(h.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
			h.run.cancel();
			h.reply(prompt, { stopReason: 'end_turn' });
			expect((await h.finish()).terminal).toMatchObject({
				status: deadline === 'hard' ? 'timeout' : 'cancelled',
				reason: deadline === 'hard' ? 'turn-timeout' : 'host-cancelled',
				dispatchState: 'unknown',
			});
			expect(h.calls('session/cancel')).toHaveLength(deadline === 'cancel' ? 1 : 0);
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.onEvent.mock.calls.filter(([event]) => event.terminal)).toHaveLength(1);
		}
	);

	it('preserves a permission deadline after provider cancellation and a late grant', async () => {
		const h = fixture();
		let grant: (value: { decision: 'allow' }) => void;
		h.decide.mockImplementation(
			() =>
				new Promise((resolve) => {
					grant = resolve;
				})
		);
		h.start();
		const prompt = await h.ready();
		h.permission();
		await vi.advanceTimersByTimeAsync(h.options.requestTimeoutMs!);
		expect(h.decide.mock.calls[0][2].aborted).toBe(true);
		expect(h.onRequestSettlement).toHaveBeenCalledTimes(1);
		h.reply(prompt, { stopReason: 'cancelled' });
		grant!({ decision: 'allow' });
		expect((await h.finish()).terminal).toMatchObject({
			status: 'timeout',
			kind: 'deadline',
			reason: 'permission-timeout',
			dispatchState: 'dispatched',
		});
		expect(h.messages.filter((message) => message.id === 'permission')).toEqual([
			{ jsonrpc: '2.0', id: 'permission', result: { outcome: { outcome: 'cancelled' } } },
		]);
		expect(h.onRequestSettlement).toHaveBeenCalledTimes(1);
		expect(h.calls('session/prompt')).toHaveLength(1);
	});

	// The ACP route delivers no MCP server of its own, never drives a
	// login, and a stalled native handshake or a stop leaves nothing behind.
	describe('native MCP and auth boundary', () => {
		it('allocates fresh and resumed sessions with no ACP-delivered MCP server', async () => {
			const fresh = fixture();
			fresh.start();
			expect((await fresh.allocation()).params).toEqual({
				cwd: fresh.options.cwd,
				mcpServers: [],
			});
			const resumed = fixture({ resumeSessionId: 'native-1' });
			resumed.start();
			expect((await resumed.allocation()).params).toEqual({
				cwd: resumed.options.cwd,
				mcpServers: [],
				sessionId: 'native-1',
			});
		});

		it('fails a handshake that never answers, with no login, allocation, prompt or retry', async () => {
			const h = fixture();
			h.start();
			await h.next('initialize');
			await vi.advanceTimersByTimeAsync(h.options.requestTimeoutMs!);
			const result = await h.finish();
			expect(result.outcome).not.toBe('completed');
			expect(result.terminal).toMatchObject({ status: 'failed', dispatchState: 'not-dispatched' });
			expect(h.calls('initialize')).toHaveLength(1);
			for (const method of ['authenticate', 'session/new', 'session/prompt']) {
				expect(h.calls(method)).toHaveLength(0);
			}
			expect(childProcess.spawn).toHaveBeenCalledOnce();
			expect(h.detached()).toBe(true);
		});

		it.each(['required', 'pending', 'denied', 'expired'])(
			'refuses an allocation whose auth is %s without authenticate or a relaunch',
			async (state) => {
				const h = fixture();
				h.start();
				h.reply(await h.next('initialize'), {
					protocolVersion: 1,
					agentCapabilities: { loadSession: true },
					authMethods: [{ id: 'oauth', name: 'Sign in with X' }],
				});
				const allocation = await h.next('session/new');
				h.receive({
					id: allocation.id,
					error: { code: -32000, message: `Authentication ${state}`, data: { state } },
				});
				const result = await h.finish();
				expect(result.terminal).toMatchObject({
					status: 'failed',
					dispatchState: 'not-dispatched',
				});
				expect(h.calls('authenticate')).toHaveLength(0);
				expect(h.calls('session/prompt')).toHaveLength(0);
				expect(childProcess.spawn).toHaveBeenCalledOnce();
				expect(h.detached()).toBe(true);
			}
		);

		it.each(['cancel', 'terminate'] as const)(
			'a %s while the handshake is pending leaves no process, timer or listener',
			async (stop) => {
				const h = fixture();
				h.start();
				await h.next('initialize');
				if (stop === 'cancel') h.run.cancel();
				else h.run.handle.terminate();
				const result = await h.finish();
				expect(result.terminal).toMatchObject({
					status: 'cancelled',
					dispatchState: 'not-dispatched',
				});
				expect(h.calls('session/new')).toHaveLength(0);
				expect(h.calls('session/prompt')).toHaveLength(0);
				expect(h.detached()).toBe(true);
				expect(vi.getTimerCount()).toBe(0);
			}
		);
	});

	describe('qualified process accounting', () => {
		const extensions = { agentVersion: 'fixture-version', sessionUsage: true, promptId: true };
		const meta = { grokShell: true, agentVersion: extensions.agentVersion };
		const baseline = {
			inputTokens: 100,
			outputTokens: 20,
			cachedReadTokens: 30,
			cacheCreationTokens: 10,
			reasoningTokens: 5,
			costUsdTicks: '9007199254740993',
		};
		const finalLedger = {
			inputTokens: 160,
			outputTokens: 50,
			cachedReadTokens: 40,
			cacheCreationTokens: 15,
			reasoningTokens: 10,
			costUsdTicks: '9007199254741006',
		};
		async function allocated(overrides: Partial<GrokAcpTurnOptions> = {}) {
			const h = fixture({ extensions, ...overrides });
			h.start();
			const allocation = await h.allocation(meta);
			expect(h.calls('_x.ai/session/usage')).toHaveLength(0);
			expect(h.calls('session/prompt')).toHaveLength(0);
			h.reply(allocation, { sessionId: 'native-1' });
			return h;
		}

		it.each(['absent', 'disabled', 'version', 'peer', 'unidentified', 'no-version'])(
			'keeps accounting and native prompt binding gated with %s qualification',
			async (kind) => {
				const h = fixture({ extensions: { ...extensions } });
				if (kind === 'absent') h.options.extensions = undefined;
				if (kind === 'disabled') {
					h.options.extensions!.sessionUsage = false;
					h.options.extensions!.promptId = false;
				}
				if (kind === 'version') h.options.extensions!.agentVersion = 'other-version';
				h.start();
				const prompt = await h.ready({
					...meta,
					grokShell: kind !== 'unidentified',
					agentVersion:
						kind === 'no-version' ? undefined : kind === 'peer' ? 'other' : meta.agentVersion,
				});
				expect(prompt.params).not.toHaveProperty('_meta');
				h.reply(prompt, { stopReason: 'end_turn' });
				expect((await h.finish()).usage).toBeUndefined();
				expect(h.calls('_x.ai/session/usage')).toHaveLength(0);
				expect(h.calls('session/prompt')).toHaveLength(1);
			}
		);

		it.each(['nonzero', 'zero', 'partial', 'missing', 'missing-cache', 'unknown-cost'])(
			'attributes only proven %s baselines and keeps ledger observations separate',
			async (kind) => {
				const h = await allocated();
				const before = {
					...baseline,
					...(kind === 'zero'
						? {
								inputTokens: 0,
								outputTokens: 0,
								cachedReadTokens: 0,
								cacheCreationTokens: 0,
								reasoningTokens: 0,
								costUsdTicks: '0',
							}
						: {}),
					usageIsIncomplete: kind === 'partial',
					...(kind === 'missing-cache' ? { cachedReadTokens: undefined } : {}),
					...(kind === 'unknown-cost' ? { costUsdTicks: undefined } : {}),
				};
				const query = await h.next('_x.ai/session/usage');
				expect(query.params).toEqual({ sessionId: 'native-1' });
				expect(h.calls('session/prompt')).toHaveLength(0);
				h.reply(query, {
					usage:
						kind === 'missing' ? undefined : { ...before, modelUsage: { 'grok-fixture': before } },
				});
				const prompt = await h.next('session/prompt');
				expect(prompt.params).toHaveProperty('_meta.promptId', expect.any(String));
				expect((prompt.params as { _meta: { promptId: string } })._meta.promptId).not.toBe(
					h.options.turnId
				);
				await vi.advanceTimersByTimeAsync(10);
				expect(h.calls('_x.ai/session/usage')).toHaveLength(1);
				h.reply(prompt, { stopReason: 'end_turn' });
				const after = await h.next('_x.ai/session/usage', 2);
				const sampled = {
					result: { usage: { ...finalLedger, modelUsage: { 'grok-fixture': finalLedger } } },
				};
				h.reply(after, sampled);
				h.reply(after, sampled);
				const result = await h.finish();
				expect(result.terminal.status).toBe('success');
				if (['partial', 'missing', 'missing-cache'].includes(kind)) {
					expect(result.usage).toBeUndefined();
				} else {
					expect(result.usage).toMatchObject({
						inputTokens: kind === 'zero' ? 105 : 45,
						outputTokens: kind === 'zero' ? 50 : 30,
						cacheReadInputTokens: kind === 'zero' ? 40 : 10,
						cacheCreationInputTokens: kind === 'zero' ? 15 : 5,
						reasoningTokens: kind === 'zero' ? 10 : 5,
						accounting: {
							final: false,
							completeness: 'partial',
							cost:
								kind === 'unknown-cost'
									? { status: 'unknown' }
									: {
											status: 'partial',
											costUsdTicks: kind === 'zero' ? finalLedger.costUsdTicks : '13',
										},
						},
					});
					expect(result.usage?.accounting?.models).toMatchObject([
						{
							model: 'grok-fixture',
							inputTokens: kind === 'zero' ? 105 : 45,
							cacheReadInputTokens: kind === 'zero' ? 40 : 10,
							cacheCreationInputTokens: kind === 'zero' ? 15 : 5,
							cost: { status: kind === 'unknown-cost' ? 'unknown' : 'exact' },
						},
					]);
				}
				expect(result.usageReports).toHaveLength(1);
				expect(result.usageReports[0]).toMatchObject({
					inputTokens: 105,
					accounting: {
						scope: 'process-session',
						providerSessionId: 'native-1',
						turnId: h.options.turnId,
						processGeneration: h.options.processGeneration,
						cost: { status: 'exact', costUsdTicks: finalLedger.costUsdTicks },
					},
				});
				expect(JSON.parse(result.usageReports[0].accounting!.scopeId!)).toEqual([
					h.options.account,
					h.options.host,
				]);
				expect(h.calls('session/prompt')).toHaveLength(1);
				expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
			}
		);

		it.each(['exact', 'unknown'])(
			'replaces provisional spend once with %s final cost through raw byte frames',
			async (cost) => {
				for (const resumeSessionId of [undefined, 'native-1']) {
					const h = await allocated({ resumeSessionId });
					h.reply(await h.next('_x.ai/session/usage'), { usage: baseline });
					const prompt = await h.next('session/prompt');
					const row = {
						inputTokens: 20,
						outputTokens: 10,
						cachedReadTokens: 6,
						cacheCreationTokens: 2,
						reasoningTokens: 1,
						...(cost === 'exact' ? { costUsdTicks: '9223372036854775807' } : {}),
					};
					const usage = { ...row, modelUsage: { 'grok-fixture': row } };
					const frame =
						JSON.stringify({
							jsonrpc: '2.0',
							id: prompt.id,
							result: { stopReason: 'end_turn', _meta: { usage } },
						}).replace(/"costUsdTicks":"(\d+)"/g, '"costUsdTicks":$1') + '\n';
					h.child.stdout.write(Buffer.from(frame + frame));
					const query = await h.next('_x.ai/session/usage', 2);
					h.child.stdout.write(
						Buffer.from(
							JSON.stringify({
								jsonrpc: '2.0',
								id: query.id,
								result: { usage: finalLedger },
							}).replace(/"costUsdTicks":"(\d+)"/g, '"costUsdTicks":$1') + '\n'
						)
					);
					const result = await h.finish();
					const expectedCost =
						cost === 'exact'
							? { status: 'exact', costUsdTicks: '9223372036854775807' }
							: { status: 'unknown' };
					expect(result.usage).toMatchObject({
						inputTokens: 12,
						outputTokens: 10,
						cacheReadInputTokens: 6,
						cacheCreationInputTokens: 2,
						reasoningTokens: 1,
						accounting: {
							final: true,
							completeness: 'complete',
							cost: cost === 'exact' ? expectedCost : { status: 'partial', costUsdTicks: '13' },
							models: [{ model: 'grok-fixture', inputTokens: 12, cost: expectedCost }],
						},
					});
					expect(result.usageReports).toHaveLength(2);
					expect(result.usageReports[0].accounting?.cost).toMatchObject({
						status: 'exact',
						costUsdTicks: finalLedger.costUsdTicks,
					});
					expect(
						result.usageReports.every(
							(r) => r.accounting?.processGeneration === h.options.processGeneration
						)
					).toBe(true);
					expect(h.calls('session/prompt')).toHaveLength(1);
					expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
				}
			}
		);

		it('claims the native session before sampling even when a competing owner uses another cwd', async () => {
			const owner = await allocated();
			const baselineQuery = await owner.next('_x.ai/session/usage');
			const duplicate = await allocated({ cwd: path.resolve('synthetic-other-project') });
			expect((await duplicate.finish()).terminal).toMatchObject({
				status: 'failed',
				reason: 'busy',
				dispatchState: 'not-dispatched',
			});
			expect(duplicate.calls('_x.ai/session/usage')).toHaveLength(0);
			expect(duplicate.calls('session/prompt')).toHaveLength(0);
			expect(owner.calls('session/prompt')).toHaveLength(0);
			owner.reply(baselineQuery, { usage: baseline });
			owner.reply(await owner.next('session/prompt'), { stopReason: 'end_turn' });
			owner.reply(await owner.next('_x.ai/session/usage', 2), { usage: finalLedger });
			expect((await owner.finish()).terminal.status).toBe('success');
			expect(owner.calls('session/prompt')).toHaveLength(1);
		});

		it('does not retry unavailable accounting or replay the prompt', async () => {
			const h = await allocated();
			h.receive({
				id: (await h.next('_x.ai/session/usage')).id,
				error: { code: -32601, message: 'Method not found' },
			});
			const prompt = await h.next('session/prompt');
			h.reply(prompt, { stopReason: 'end_turn' });
			expect((await h.finish()).usage).toBeUndefined();
			expect(h.calls('_x.ai/session/usage')).toHaveLength(1);
			expect(h.calls('session/prompt')).toHaveLength(1);
		});

		it.each(['cancel', 'idle', 'process'])(
			'preserves %s failure during baseline collection before dispatch',
			async (cause) => {
				const h = await allocated({ requestTimeoutMs: 200 });
				const query = await h.next('_x.ai/session/usage');
				if (cause === 'idle') await vi.advanceTimersByTimeAsync(100);
				if (cause === 'process') h.child.emit('exit', 1, null);
				h.run.cancel();
				h.reply(query, { usage: baseline });
				expect((await h.finish()).terminal).toMatchObject({
					status: cause === 'idle' ? 'timeout' : cause === 'process' ? 'failed' : 'cancelled',
					reason:
						cause === 'idle'
							? 'idle-timeout'
							: cause === 'process'
								? 'process-lost'
								: 'host-cancelled',
					dispatchState: 'not-dispatched',
				});
				expect(h.calls('session/prompt')).toHaveLength(0);
				expect(h.calls('_x.ai/session/usage')).toHaveLength(1);
			}
		);

		it.each(
			['success', 'refused', 'cancelled', 'durable'].flatMap((status) =>
				['cancel', 'idle', 'process', 'unavailable'].map((loss) => ({ status, loss }))
			)
		)('retains $status after $loss during final accounting', async ({ status, loss }) => {
			const h = await allocated({ requestTimeoutMs: 200 });
			h.reply(await h.next('_x.ai/session/usage'), { usage: baseline });
			const prompt = await h.next('session/prompt');
			h.update({
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Partial answer' },
			});
			if (status === 'durable')
				h.receive({
					method: '_x.ai/session/update',
					params: {
						sessionId: 'native-1',
						update: {
							sessionUpdate: 'turn_completed',
							prompt_id: (prompt.params as { _meta: { promptId: string } })._meta.promptId,
							stop_reason: 'end_turn',
							error_kind: 'provider_fault',
						},
					},
				});
			h.reply(prompt, {
				stopReason: status === 'cancelled' ? 'cancelled' : 'end_turn',
				_meta: {
					usage: baseline,
					...(status === 'refused' ? { cancellationCategory: 'PermissionRejected' } : {}),
				},
			});
			const query = await h.next('_x.ai/session/usage', 2);
			if (loss === 'cancel') h.run.cancel();
			if (loss === 'idle') await vi.advanceTimersByTimeAsync(100);
			if (loss === 'process') h.child.emit('exit', 1, null);
			if (loss === 'unavailable')
				h.reply(query, { result: { usage: finalLedger }, error: { code: 'unavailable' } });
			else h.reply(query, { usage: finalLedger });
			const result = await h.finish();
			expect(result).toMatchObject({
				answerText: 'Partial answer',
				terminal: {
					status: status === 'durable' ? 'failed' : status,
					dispatchState: 'dispatched',
				},
				usage: { inputTokens: 60, outputTokens: 20 },
			});
			expect(h.calls('_x.ai/session/usage')).toHaveLength(2);
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
		});
	});
});
