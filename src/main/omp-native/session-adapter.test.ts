import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
	contextWindowFromOmpRuntime,
	normalizeOmpModelSelector,
	OmpNativeSessionAdapter,
} from './session-adapter';
import capturedRpcTurn from './fixtures/real-rpc-turn.json';
import { OMP_NATIVE_TURN_COMPLETION } from '../../shared/omp-native-session';
import capturedThinkingLevel from './fixtures/real-rpc-thinking-level.json';
import { logger } from '../utils/logger';

class FakeChild extends EventEmitter {
	stdin = { write: vi.fn() };
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	pid = 4242;
	kill = vi.fn();
}

function emit(child: FakeChild, frame: unknown): void {
	child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
}

describe('OmpNativeSessionAdapter', () => {
	it('projects envelope-shaped RPC catalog and runtime features to native events', async () => {
		const child = new FakeChild();
		const spawn = vi.fn(() => child as never);
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id) {
				const data =
					command.type === 'get_available_commands'
						? { commands: [{ name: 'compact' }] }
						: command.type === 'get_state'
							? {
									sessionId: 'omp-session',
									sessionFile: 'C:/work/.omp/sessions/omp-session.jsonl',
									model: {
										provider: 'anthropic',
										id: 'claude-sonnet-4-5',
										label: 'Sonnet',
									},
									thinkingLevel: 'high',
									todoPhases: [],
								}
							: command.type === 'get_available_models'
								? {
										models: [{ provider: 'anthropic', id: 'claude-sonnet-4-5', label: 'Sonnet' }],
									}
								: command.type === 'get_messages'
									? { messages: [{ id: 'entry-1', content: 'Root' }] }
									: command.type === 'get_subagents'
										? { subagents: [{ id: 'sub-1', name: 'Scout', status: 'running' }] }
										: command.type === 'get_session_stats'
											? { stats: { inputTokens: 12 } }
											: command.type === 'get_login_providers'
												? { providers: [{ id: 'fixture-login', name: 'Fixture Login' }] }
												: [];
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data,
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = await OmpNativeSessionAdapter.create({
			sessionId: 'tab-1',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn,
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		expect(spawn).toHaveBeenCalledWith(
			'omp',
			['--mode', 'rpc'],
			expect.objectContaining({ cwd: 'C:/work/project' })
		);
		expect((spawn.mock.calls[0] as unknown as [string, string[]])[1]).not.toContain('--no-session');
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(send).toHaveBeenCalledWith('process:slash-commands', 'tab-1', ['compact']);
		expect(send).toHaveBeenCalledWith(
			'process:runtime-features',
			'tab-1',
			expect.objectContaining({
				controls: expect.arrayContaining([
					expect.objectContaining({
						id: 'model',
						options: [{ id: 'anthropic:claude-sonnet-4-5', label: 'Sonnet' }],
					}),
					expect.objectContaining({
						id: 'model',
						value: 'anthropic:claude-sonnet-4-5',
					}),
				]),
				tree: [{ id: 'entry-1', label: 'Root' }],
				subagents: [{ id: 'sub-1', label: 'Scout', status: 'running', detail: undefined }],
				stats: { inputTokens: 12, contextWindow: 200_000 },
				loginProviders: [{ id: 'fixture-login', label: 'Fixture Login' }],
			})
		);
		expect(send).toHaveBeenCalledWith(
			'process:session-id',
			'tab-1',
			'C:/work/.omp/sessions/omp-session.jsonl'
		);
		emit(child, { type: 'message_update', sequence: 1, content: 'partial' });
		emit(child, { type: 'prompt_result', agentInvoked: false, text: 'final' });
		expect(send).toHaveBeenCalledWith('process:data', 'tab-1', 'partial');
		expect(send).not.toHaveBeenCalledWith('process:data', 'tab-1', 'final');
		void adapter.interrupt();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(child.stdin.write).toHaveBeenLastCalledWith(expect.stringContaining('"type":"abort"'));
		emit(child, {
			type: 'extension_ui_request',
			id: 'approval-1',
			method: 'select',
			title: 'Approve tool?',
			options: ['yes'],
		});
		expect(send).toHaveBeenCalledWith(
			'process:approval-request',
			expect.objectContaining({
				id: 'approval-1',
				sessionId: 'tab-1',
				options: [{ id: 'yes', label: 'yes', kind: 'custom' }],
			})
		);
		await expect(adapter.respondApproval('approval-1', { optionId: 'yes' })).resolves.toBe(true);
		expect(extensionResponses(child)).toContainEqual({
			type: 'extension_ui_response',
			id: 'approval-1',
			value: 'yes',
		});
		await expect(adapter.branch('entry-1')).resolves.toBe(true);
		expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"type":"branch"'));
		expect(child.kill).not.toHaveBeenCalled();
	});

	it('suppresses only the benign host-tool startup diagnostic and forwards genuine stderr once', () => {
		const child = new FakeChild();
		const send = vi.fn();
		const debug = vi.spyOn(logger, 'debug');
		OmpNativeSessionAdapter.create({
			sessionId: 'diagnostic-tab',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		const benignDiagnostic = 'OMP xd://: mounted maestro.session.status';
		child.stderr.emit('data', Buffer.from(`${benignDiagnostic}\n`));
		child.stderr.emit('data', Buffer.from('OMP genuine runtime failure\n'));

		expect(child.stderr.listenerCount('data')).toBe(1);
		expect(debug).toHaveBeenCalledWith(benignDiagnostic, 'OmpNativeSessionAdapter');
		expect(send).not.toHaveBeenCalledWith(
			'process:stderr',
			'diagnostic-tab',
			`${benignDiagnostic}\n`
		);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			'process:stderr',
			'diagnostic-tab',
			'OMP genuine runtime failure\n'
		);
	});

	it('routes the exact host-tool mount notice to debug without affecting RPC assistant text', () => {
		const child = new FakeChild();
		const send = vi.fn();
		const debug = vi.spyOn(logger, 'debug');
		OmpNativeSessionAdapter.create({
			sessionId: 'mount-notice-tab',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'notice', message: 'xd://: mounted maestro.session.status' });
		emit(child, {
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'Hello! How can I help?' },
		});

		expect(debug).toHaveBeenCalledWith(
			'OMP xd://: mounted maestro.session.status',
			'OmpNativeSessionAdapter'
		);
		expect(send).toHaveBeenCalledWith('process:data', 'mount-notice-tab', 'Hello! How can I help?');
		expect(send).not.toHaveBeenCalledWith('process:stderr', 'mount-notice-tab', expect.anything());
	});

	it('preserves an unterminated mount-like stderr prefix with a later continuation', () => {
		const child = new FakeChild();
		const send = vi.fn();
		const debug = vi.spyOn(logger, 'debug');
		const debugCallCount = debug.mock.calls.length;
		OmpNativeSessionAdapter.create({
			sessionId: 'continued-diagnostic-tab',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		child.stderr.emit('data', Buffer.from('OMP xd://: mounted maestro.session.status'));
		child.stderr.emit('data', Buffer.from(' additional genuine failure\n'));

		expect(debug).toHaveBeenCalledTimes(debugCallCount);
		expect(send).toHaveBeenCalledWith(
			'process:stderr',
			'continued-diagnostic-tab',
			'OMP xd://: mounted maestro.session.status additional genuine failure\n'
		);
	});

	it('filters a split benign diagnostic while preserving coalesced genuine lines', () => {
		const child = new FakeChild();
		const send = vi.fn();
		const debug = vi.spyOn(logger, 'debug');
		OmpNativeSessionAdapter.create({
			sessionId: 'split-diagnostic-tab',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		child.stderr.emit('data', Buffer.from('OMP xd://: mounted maestro.'));
		child.stderr.emit(
			'data',
			Buffer.from('session.status\nOMP first genuine error\nOMP second genuine error\n')
		);

		expect(debug).toHaveBeenCalledWith(
			'OMP xd://: mounted maestro.session.status',
			'OmpNativeSessionAdapter'
		);
		expect(send).toHaveBeenNthCalledWith(
			1,
			'process:stderr',
			'split-diagnostic-tab',
			'OMP first genuine error\n'
		);
		expect(send).toHaveBeenNthCalledWith(
			2,
			'process:stderr',
			'split-diagnostic-tab',
			'OMP second genuine error\n'
		);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('flushes a genuine residual diagnostic on child close', () => {
		const child = new FakeChild();
		const send = vi.fn();
		OmpNativeSessionAdapter.create({
			sessionId: 'residual-diagnostic-tab',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		child.stderr.emit('data', Buffer.from('OMP residual genuine error'));
		child.emit('close', 0, null);

		expect(send).toHaveBeenCalledWith(
			'process:stderr',
			'residual-diagnostic-tab',
			'OMP residual genuine error'
		);
	});

	it('clears projected runtime features when plugin activation revokes native sessions', async () => {
		const child = new FakeChild();
		const send = vi.fn();
		await OmpNativeSessionAdapter.acquire({
			sessionId: 'tab-plugin-disabled',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		OmpNativeSessionAdapter.disposeAll();

		expect(send).toHaveBeenCalledWith('process:runtime-features', 'tab-plugin-disabled', null);
		expect(child.kill).toHaveBeenCalledOnce();
	});

	it('coalesces self-emitted refresh callbacks while detail requests still resolve', async () => {
		const child = new FakeChild();
		const counts = new Map<string, number>();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (!command.id) return true;
			counts.set(command.type, (counts.get(command.type) ?? 0) + 1);
			if (command.type === 'get_available_models') {
				queueMicrotask(() => emit(child, { type: 'config_update', sequence: Date.now() }));
			}
			const data =
				command.type === 'get_subagent_messages'
					? { messages: [{ text: 'detail complete' }] }
					: command.type === 'get_state'
						? { sessionId: 'omp-session', todoPhases: [] }
						: command.type === 'get_available_commands'
							? { commands: [] }
							: command.type === 'get_available_models'
								? { models: [] }
								: command.type === 'get_messages'
									? { messages: [] }
									: command.type === 'get_subagents'
										? { subagents: [] }
										: command.type === 'get_session_stats'
											? { stats: {} }
											: { providers: [] };
			queueMicrotask(() =>
				emit(child, {
					type: 'response',
					id: command.id,
					command: command.type,
					success: true,
					data,
				})
			);
			return true;
		});
		const adapter = await OmpNativeSessionAdapter.create({
			sessionId: 'refresh-tab',
			cwd: 'C:/work/project',
			command: 'omp',
			send: vi.fn(),
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		counts.clear();
		emit(child, { type: 'config_update', sequence: Date.now() + 1 });
		await expect(adapter.subagentMessages('subagent-1')).resolves.toEqual(['detail complete']);
		await new Promise<void>((resolve) => setImmediate(resolve));
		for (const command of [
			'get_state',
			'get_messages',
			'get_subagents',
			'get_session_stats',
			'get_available_models',
			'get_login_providers',
		]) {
			expect(counts.get(command)).toBe(1);
		}
		expect(counts.get('get_subagent_messages')).toBe(1);
	});

	it('resolves a base native session to every tab and a decorated session to one tab', async () => {
		const firstChild = new FakeChild();
		const secondChild = new FakeChild();
		const first = await OmpNativeSessionAdapter.acquire({
			sessionId: 'session-base-ai-tab-a',
			cwd: 'C:/work/project',
			command: 'omp',
			send: vi.fn(),
			spawn: vi.fn(() => firstChild as never),
		});
		const second = await OmpNativeSessionAdapter.acquire({
			sessionId: 'session-base-ai-tab-b',
			cwd: 'C:/work/project',
			command: 'omp',
			send: vi.fn(),
			spawn: vi.fn(() => secondChild as never),
		});

		expect(OmpNativeSessionAdapter.forAssociatedSessions('session-base-ai')).toEqual([
			first,
			second,
		]);
		expect(OmpNativeSessionAdapter.forAssociatedSessions('session-base-ai-tab-a')).toEqual([first]);

		first.dispose();
		second.dispose();
		expect(OmpNativeSessionAdapter.forAssociatedSessions('session-base-ai')).toEqual([]);
	});

	it('settles local-only prompt responses without manufacturing an agent lifecycle', async () => {
		const child = new FakeChild();
		const promptResponses = [{ agentInvoked: false }, {}];
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id) {
				const data = command.type === 'prompt' ? promptResponses.shift() : {};
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data,
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-local-only',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('/local');
		expect(send).toHaveBeenCalledWith(
			'process:command-exit',
			'tab-local-only',
			0,
			OMP_NATIVE_TURN_COMPLETION
		);
		emit(child, { type: 'prompt_result', agentInvoked: false, text: 'local output' });
		expect(send).toHaveBeenCalledWith('process:data', 'tab-local-only', 'local output');
		expect(send.mock.calls.filter(([channel]) => channel === 'process:command-exit')).toHaveLength(
			1
		);

		await adapter.prompt('/callback-local');
		emit(child, { type: 'prompt_result', agentInvoked: false, text: 'callback output' });
		expect(send).toHaveBeenCalledWith('process:data', 'tab-local-only', 'callback output');
		expect(send.mock.calls.filter(([channel]) => channel === 'process:command-exit')).toHaveLength(
			2
		);
	});

	it('settles each RPC turn and uses prompt results only when no assistant deltas streamed', async () => {
		const child = new FakeChild();
		const promptMessages: string[] = [];
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string; message?: string };
			if (command.type === 'prompt' && command.message) promptMessages.push(command.message);
			if (command.id) {
				const data =
					command.type === 'get_available_commands'
						? { commands: [] }
						: command.type === 'get_available_models'
							? { models: [] }
							: command.type === 'get_messages'
								? { messages: [] }
								: command.type === 'get_subagents'
									? { subagents: [] }
									: command.type === 'get_session_stats'
										? { stats: {} }
										: command.type === 'get_state'
											? { todoPhases: [] }
											: {};
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data,
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-2',
			agentSessionId: 'omp-provider-session-2',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('first prompt');
		emit(child, {
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'o' },
		});
		emit(child, {
			type: 'message_update',
			assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning' },
		});
		emit(child, { type: 'prompt_result', text: 'ok' });
		emit(child, { type: 'turn_end' });

		expect(send).not.toHaveBeenCalledWith('process:data', 'tab-2', 'ok');
		expect(send).toHaveBeenCalledWith('process:data', 'tab-2', 'o');
		expect(send).toHaveBeenCalledWith('process:thinking-chunk', 'tab-2', 'reasoning');
		expect(
			send.mock.calls.filter(
				([channel, sessionId, value]) =>
					channel === 'process:data' && sessionId === 'tab-2' && value === 'reasoning'
			)
		).toHaveLength(0);
		expect(send).toHaveBeenCalledWith(
			'process:command-exit',
			'tab-2',
			0,
			OMP_NATIVE_TURN_COMPLETION
		);
		expect(send).not.toHaveBeenCalledWith('process:exit', 'tab-2', 0);
		expect(child.kill).not.toHaveBeenCalled();

		await adapter.prompt('second prompt');
		emit(child, { type: 'prompt_result', text: 'second result' });
		emit(child, { type: 'agent_end' });

		expect(promptMessages).toEqual(['first prompt', 'second prompt']);
		expect(send).toHaveBeenCalledWith('process:data', 'tab-2', 'second result');
		const partialResultIndex = send.mock.calls.findIndex(
			([channel, sessionId, value]) =>
				channel === 'process:data' && sessionId === 'tab-2' && value === 'o'
		);
		const firstCompletionIndex = send.mock.calls.findIndex(
			([channel, sessionId]) => channel === 'process:command-exit' && sessionId === 'tab-2'
		);
		expect(partialResultIndex).toBeLessThan(firstCompletionIndex);
		expect(
			send.mock.calls
				.filter(([channel, sessionId]) => channel === 'process:data' && sessionId === 'tab-2')
				.map(([, , value]) => value)
		).toEqual(['o', 'second result']);
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) => channel === 'process:command-exit' && sessionId === 'tab-2'
			)
		).toHaveLength(2);
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) => channel === 'process:exit' && sessionId === 'tab-2'
			)
		).toHaveLength(0);
		expect(child.kill).not.toHaveBeenCalled();
	});
	it('applies the configured model before prompting and preserves staged image payloads', async () => {
		const child = new FakeChild();
		const frames: Array<Record<string, unknown>> = [];
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			frames.push(command);
			if (command.id) {
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data:
							command.type === 'get_available_models'
								? { models: [] }
								: command.type === 'get_available_commands'
									? { commands: [] }
									: command.type === 'get_messages'
										? { messages: [] }
										: command.type === 'get_subagents'
											? { subagents: [] }
											: command.type === 'get_session_stats'
												? { stats: {} }
												: { todoPhases: [] },
					})
				);
			}
			return true;
		});
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-input-parity',
			cwd: 'C:/work/project',
			command: 'omp',
			model: 'fixture:fixture-fast',
			send: vi.fn(),
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('describe the image', ['data:image/png;base64,cG5nLWJ5dGVz']);

		const modelIndex = frames.findIndex((frame) => frame.type === 'set_model');
		const promptIndex = frames.findIndex((frame) => frame.type === 'prompt');
		expect(modelIndex).toBeGreaterThanOrEqual(0);
		expect(modelIndex).toBeLessThan(promptIndex);
		expect(frames[promptIndex]).toMatchObject({
			type: 'prompt',
			message: 'describe the image',
			streamingBehavior: 'steer',
			images: [{ image: { mimeType: 'image/png', data: 'cG5nLWJ5dGVz' } }],
		});
	});
	it.each([
		['native discovery selector', 'openai-codex/gpt-5.6-sol'],
		['RPC selector', 'openai-codex:gpt-5.6-sol'],
	])('maps the %s to the native set_model payload before prompting', async (_name, model) => {
		const child = new FakeChild();
		const frames: Array<Record<string, unknown>> = [];
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			frames.push(command);
			if (command.id) {
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data:
							command.type === 'get_available_models'
								? { models: [] }
								: command.type === 'get_available_commands'
									? { commands: [] }
									: command.type === 'get_messages'
										? { messages: [] }
										: command.type === 'get_subagents'
											? { subagents: [] }
											: command.type === 'get_session_stats'
												? { stats: {} }
												: { todoPhases: [] },
					})
				);
			}
			return true;
		});
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: `tab-model-${model}`,
			cwd: 'C:/work/project',
			command: 'omp',
			model,
			send: vi.fn(),
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		expect(normalizeOmpModelSelector(model)).toBe('openai-codex:gpt-5.6-sol');
		await adapter.prompt('run native OMP');

		const modelIndex = frames.findIndex((frame) => frame.type === 'set_model');
		const promptIndex = frames.findIndex((frame) => frame.type === 'prompt');
		expect(frames[modelIndex]).toMatchObject({
			type: 'set_model',
			provider: 'openai-codex',
			modelId: 'gpt-5.6-sol',
		});
		expect(modelIndex).toBeLessThan(promptIndex);
	});

	it('rejects malformed OMP model selectors explicitly', () => {
		expect(() => normalizeOmpModelSelector('gpt-5.6-sol')).toThrow(
			'OMP model selection must use the provider:modelId format'
		);
	});
	it('reconciles an acquired session model before its next prompt and refreshes the model control', async () => {
		const child = new FakeChild();
		const frames: Array<Record<string, unknown>> = [];
		let selectedModel = 'fixture-initial';
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as {
				id?: string;
				modelId?: string;
				type: string;
			};
			frames.push(command);
			if (command.type === 'set_model' && command.modelId) selectedModel = command.modelId;
			if (command.id) {
				const data =
					command.type === 'get_available_commands'
						? { commands: [] }
						: command.type === 'get_available_models'
							? {
									models: [
										{
											provider: 'fixture',
											id: 'fixture-initial',
											label: 'Initial',
											contextWindow: 200_000,
										},
										{
											provider: 'fixture',
											id: 'fixture-reconciled',
											label: 'Reconciled',
											contextWindow: 1_000_000,
										},
									],
								}
							: command.type === 'get_messages'
								? { messages: [] }
								: command.type === 'get_subagents'
									? { subagents: [] }
									: command.type === 'get_session_stats'
										? { stats: {} }
										: command.type === 'get_state'
											? { model: { id: selectedModel }, todoPhases: [] }
											: {};
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data,
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const options = {
			sessionId: 'tab-model-reconcile',
			cwd: 'C:/work/project',
			command: 'omp',
			model: 'fixture/fixture-initial',
			send,
			spawn: vi.fn(() => child as never),
		};
		const adapter = await OmpNativeSessionAdapter.acquire(options);
		try {
			emit(child, { type: 'ready', version: '16.4.8' });
			await adapter.prompt('first prompt');
			frames.length = 0;

			const unchanged = await OmpNativeSessionAdapter.acquire(options);
			expect(unchanged).toBe(adapter);
			expect(frames.filter((frame) => frame.type === 'set_model')).toHaveLength(0);

			send.mockClear();
			const reconfigured = await OmpNativeSessionAdapter.acquire({
				...options,
				model: 'fixture/fixture-reconciled',
			});
			await reconfigured.prompt('prompt after model change');

			const modelFrames = frames.filter((frame) => frame.type === 'set_model');
			expect(modelFrames).toEqual([
				expect.objectContaining({
					type: 'set_model',
					provider: 'fixture',
					modelId: 'fixture-reconciled',
				}),
			]);
			expect(frames.findIndex((frame) => frame.type === 'set_model')).toBeLessThan(
				frames.findIndex((frame) => frame.type === 'prompt')
			);
			expect(send).toHaveBeenCalledWith(
				'process:runtime-features',
				'tab-model-reconcile',
				expect.objectContaining({
					controls: expect.arrayContaining([
						expect.objectContaining({ id: 'model', value: 'fixture-reconciled' }),
					]),
					stats: expect.objectContaining({ contextWindow: 1_000_000 }),
				})
			);
		} finally {
			adapter.dispose();
		}
	});

	it('projects confirm callbacks as approvals and fails closed for unknown interactive callbacks', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id) {
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: {},
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-callback-safety',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		emit(child, {
			type: 'extension_ui_request',
			id: 'confirm-without-options',
			method: 'confirm',
			title: 'Approve fixture tool?',
		});
		expect(send).toHaveBeenCalledWith(
			'process:approval-request',
			expect.objectContaining({
				id: 'confirm-without-options',
				options: [
					{ id: 'approve', label: 'Approve', kind: 'approve' },
					{ id: 'deny', label: 'Deny', kind: 'deny' },
				],
			})
		);

		await adapter.prompt('a turn that can finish');
		emit(child, {
			type: 'extension_ui_request',
			id: 'unknown-interactive',
			method: 'form',
			title: 'Unsupported interactive request',
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(extensionResponses(child)).toContainEqual({
			type: 'extension_ui_response',
			id: 'unknown-interactive',
			cancelled: true,
		});
		emit(child, { type: 'turn_end' });
		expect(send).toHaveBeenCalledWith(
			'process:command-exit',
			'tab-callback-safety',
			0,
			OMP_NATIVE_TURN_COMPLETION
		);
	});

	it('does not expose or mutate a composer control without a matching RPC command', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id) {
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: {},
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-no-composer-mode',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const features = send.mock.calls.find(
			([channel]) => channel === 'process:runtime-features'
		)?.[2] as { controls: Array<{ id: string }> } | undefined;
		expect(features?.controls).not.toContainEqual(expect.objectContaining({ id: 'composer-mode' }));
		await expect(adapter.setControl('composer-mode', 'plan')).resolves.toBe(false);
		expect(child.stdin.write).not.toHaveBeenCalledWith(
			expect.stringContaining('"type":"set_follow_up_mode"')
		);
	});

	it('preserves callback option IDs, rejects mismatches without consuming approval, and ignores resolved replays', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id) {
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: {},
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-approval',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		emit(child, {
			type: 'extension_ui_request',
			id: 'approval-opaque',
			method: 'select',
			title: 'Continue?',
			options: ['option:deny/opaque'],
		});

		expect(send).toHaveBeenCalledWith('process:approval-request', {
			id: 'approval-opaque',
			sessionId: 'tab-approval',
			toolType: 'omp',
			title: 'Continue?',
			detail: undefined,
			options: [{ id: 'option:deny/opaque', label: 'option:deny/opaque', kind: 'custom' }],
			createdAt: expect.any(String),
		});
		await expect(
			adapter.respondApproval('approval-opaque', { optionId: 'unknown-option' })
		).resolves.toBe(false);
		expect(extensionResponses(child)).toEqual([]);

		await expect(
			adapter.respondApproval('approval-opaque', { optionId: 'option:deny/opaque' })
		).resolves.toBe(true);
		expect(extensionResponses(child)).toEqual([
			{ type: 'extension_ui_response', id: 'approval-opaque', value: 'option:deny/opaque' },
		]);
		await expect(
			adapter.respondApproval('approval-opaque', { optionId: 'option:deny/opaque' })
		).resolves.toBe(false);

		emit(child, {
			type: 'extension_ui_request',
			id: 'approval-race',
			method: 'select',
			title: 'Race?',
			options: ['continue'],
		});
		await expect(
			Promise.all([
				adapter.respondApproval('approval-race', { optionId: 'continue' }),
				adapter.respondApproval('approval-race', { optionId: 'continue' }),
			])
		).resolves.toEqual([true, false]);
		expect(extensionResponses(child).filter((response) => response.id === 'approval-race')).toEqual(
			[{ type: 'extension_ui_response', id: 'approval-race', value: 'continue' }]
		);

		emit(child, {
			type: 'extension_ui_request',
			id: 'approval-cancel-race',
			method: 'select',
			title: 'Cancel race?',
			options: ['continue'],
		});
		const claimedResponse = adapter.respondApproval('approval-cancel-race', {
			optionId: 'continue',
		});
		await Promise.resolve();
		emit(child, {
			type: 'extension_ui_request',
			id: 'cancel-race',
			method: 'cancel',
			targetId: 'approval-cancel-race',
		});
		await expect(claimedResponse).resolves.toBe(true);
		expect(send).not.toHaveBeenCalledWith(
			'process:approval-cancelled',
			'tab-approval',
			'approval-cancel-race'
		);
		emit(child, {
			type: 'extension_ui_request',
			id: 'approval-opaque',
			method: 'select',
			title: 'Continue?',
			options: ['option:deny/opaque'],
		});
		expect(
			send.mock.calls.filter(([channel]) => channel === 'process:approval-request')
		).toHaveLength(3);
	});

	it('projects noninteractive extension UI callbacks into ordinary Maestro surfaces', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id) {
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: {},
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-noninteractive',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		emit(child, {
			type: 'extension_ui_request',
			id: 'noninteractive-notify',
			method: 'notify',
			message: 'Runtime notification',
			notifyType: 'warning',
		});
		emit(child, {
			type: 'extension_ui_request',
			id: 'noninteractive-status',
			method: 'setStatus',
			statusText: 'Indexing workspace',
		});
		emit(child, {
			type: 'extension_ui_request',
			id: 'noninteractive-widget',
			method: 'setWidget',
			widgetLines: ['Build', 'ready'],
		});
		emit(child, {
			type: 'extension_ui_request',
			id: 'noninteractive-title',
			method: 'setTitle',
			title: 'Reviewing changes',
		});
		emit(child, {
			type: 'extension_ui_request',
			id: 'noninteractive-editor',
			method: 'set_editor_text',
			text: 'Follow up on the tests',
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(
			send.mock.calls.filter(([channel]) => channel === 'process:approval-request')
		).toHaveLength(0);
		expect(extensionResponses(child)).toEqual([]);
		expect(send).toHaveBeenCalledWith(
			'remote:notifyToast',
			expect.objectContaining({ message: 'Runtime notification', color: 'yellow' })
		);
		expect(send).toHaveBeenCalledWith('process:data', 'tab-noninteractive', 'Indexing workspace');
		expect(send).toHaveBeenCalledWith('process:data', 'tab-noninteractive', 'Build\nready');
		expect(send).toHaveBeenCalledWith(
			'process:session-title',
			'tab-noninteractive',
			'Reviewing changes'
		);
		expect(send).toHaveBeenCalledWith(
			'process:composer-text',
			'tab-noninteractive',
			'Follow up on the tests'
		);
	});

	it('serves the bounded native host tool and immutable host URI callbacks', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: {},
					})
				);
			return true;
		});
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-host-bridge',
			cwd: 'C:/work/project',
			command: 'omp',
			send: vi.fn(),
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));

		emit(child, {
			type: 'host_tool_call',
			id: 'tool-1',
			toolCallId: 'call-1',
			toolName: 'maestro.session.status',
			arguments: {},
		});
		emit(child, {
			type: 'host_uri_request',
			id: 'uri-1',
			operation: 'read',
			url: 'maestro://session/status',
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		const frames = child.stdin.write.mock.calls.map(([frame]) => JSON.parse(frame as string));
		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'set_host_tools' }),
				expect.objectContaining({ type: 'set_host_uri_schemes' }),
				expect.objectContaining({ type: 'host_tool_update', id: 'tool-1' }),
				expect.objectContaining({ type: 'host_tool_result', id: 'tool-1' }),
				expect.objectContaining({
					type: 'host_uri_result',
					id: 'uri-1',
					contentType: 'application/json',
					immutable: true,
				}),
			])
		);
	});

	it('handles official input and editor requests, targeted cancellation, and login URLs natively', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: {},
					})
				);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-text-requests',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));

		emit(child, {
			type: 'extension_ui_request',
			id: 'input-1',
			method: 'input',
			title: 'Enter OAuth code',
			placeholder: 'code',
		});
		expect(send).toHaveBeenCalledWith(
			'process:approval-request',
			expect.objectContaining({
				id: 'input-1',
				textInput: { kind: 'input', placeholder: 'code', prefill: undefined, promptStyle: false },
			})
		);
		await expect(adapter.respondApproval('input-1', { value: 'oauth-code' })).resolves.toBe(true);
		expect(extensionResponses(child)).toContainEqual({
			type: 'extension_ui_response',
			id: 'input-1',
			value: 'oauth-code',
		});

		emit(child, {
			type: 'extension_ui_request',
			id: 'editor-1',
			method: 'editor',
			title: 'Edit instructions',
			prefill: 'draft',
			promptStyle: true,
		});
		await expect(adapter.respondApproval('editor-1', { value: 'edited' })).resolves.toBe(true);
		expect(extensionResponses(child)).toContainEqual({
			type: 'extension_ui_response',
			id: 'editor-1',
			value: 'edited',
		});

		emit(child, {
			type: 'extension_ui_request',
			id: 'input-2',
			method: 'input',
			title: 'Cancelled input',
		});
		emit(child, {
			type: 'extension_ui_request',
			id: 'cancel-1',
			method: 'cancel',
			targetId: 'input-2',
		});
		expect(send).toHaveBeenCalledWith('process:approval-cancelled', 'tab-text-requests', 'input-2');
		await expect(adapter.respondApproval('input-2', { value: 'late' })).resolves.toBe(false);

		emit(child, {
			type: 'extension_ui_request',
			id: 'open-url-1',
			method: 'open_url',
			url: 'https://login.example.test',
			launchUrl: 'https://login.example.test/launch',
		});
		expect(send).toHaveBeenCalledWith(
			'process:open-external-url',
			'tab-text-requests',
			'https://login.example.test/launch'
		);
		for (const url of [
			'javascript:alert(1)',
			'file:///C:/secret.txt',
			'maestro://session/status',
		]) {
			emit(child, {
				type: 'extension_ui_request',
				id: `invalid-url-${url}`,
				method: 'open_url',
				url,
			});
		}
		expect(send).not.toHaveBeenCalledWith(
			'process:open-external-url',
			'tab-text-requests',
			'javascript:alert(1)'
		);
		expect(send).not.toHaveBeenCalledWith(
			'process:open-external-url',
			'tab-text-requests',
			'file:///C:/secret.txt'
		);
		expect(send).not.toHaveBeenCalledWith(
			'process:open-external-url',
			'tab-text-requests',
			'maestro://session/status'
		);
		expect(
			send.mock.calls.filter(
				([channel, sessionId, message]) =>
					channel === 'process:stderr' &&
					sessionId === 'tab-text-requests' &&
					message === 'OMP open_url request has an invalid URL'
			)
		).toHaveLength(3);
	});

	it('replays the captured RPC turn: nested delta, data-less prompt response, and turn completion', async () => {
		const child = new FakeChild();
		const responses = capturedRpcTurn.filter((frame) => frame.type === 'response') as Array<
			Record<string, unknown>
		>;
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id) {
				const captured = responses.find((response) => response.command === command.type);
				queueMicrotask(() =>
					emit(
						child,
						captured
							? { ...captured, id: command.id }
							: {
									type: 'response',
									id: command.id,
									command: command.type,
									success: true,
									data: {},
								}
					)
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'captured-turn',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		for (const frame of capturedRpcTurn.filter((frame) => frame.type === 'ready'))
			emit(child, frame);
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('say ok');
		for (const frame of capturedRpcTurn.filter(
			(frame) => frame.type !== 'ready' && frame.type !== 'response'
		))
			emit(child, frame);

		expect(send).toHaveBeenCalledWith('process:data', 'captured-turn', 'Ok.');
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) => channel === 'process:data' && sessionId === 'captured-turn'
			)
		).toEqual([['process:data', 'captured-turn', 'Ok.']]);
		expect(send).toHaveBeenCalledWith(
			'process:command-exit',
			'captured-turn',
			0,
			OMP_NATIVE_TURN_COMPLETION
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const features = send.mock.calls
			.filter(([channel]) => channel === 'process:runtime-features')
			.at(-1)?.[2] as { todos: unknown; subagents: unknown; stats: unknown };
		expect(features).toMatchObject({
			todos: [
				{
					name: 'Verify focused tests',
					items: [{ content: 'Verify focused tests', state: 'in_progress' }],
				},
			],
			subagents: [{ id: 'sub-1', label: 'Scout', status: 'complete' }],
			stats: {
				userMessages: 1,
				assistantMessages: 1,
				inputTokens: 12,
				outputTokens: 7,
				totalCostUsd: 0.02,
			},
		});
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) =>
					channel === 'process:command-exit' && sessionId === 'captured-turn'
			)
		).toHaveLength(1);
		const dataIndex = send.mock.calls.findIndex(
			([channel, sessionId, value]) =>
				channel === 'process:data' && sessionId === 'captured-turn' && value === 'Ok.'
		);
		const completionIndex = send.mock.calls.findIndex(
			([channel, sessionId]) => channel === 'process:command-exit' && sessionId === 'captured-turn'
		);
		expect(dataIndex).toBeLessThan(completionIndex);
	});

	it('sends correlated control commands and projects OMP state, subagents, and post-turn stats', async () => {
		const child = new FakeChild();
		const frames: Array<Record<string, unknown>> = [];
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			frames.push(command);
			if (!command.id) return true;
			const data =
				command.type === 'get_available_commands'
					? { commands: [] }
					: command.type === 'get_available_models'
						? { models: [{ provider: 'anthropic', id: 'claude-fable-5', label: 'Claude Fable 5' }] }
						: command.type === 'get_messages'
							? { messages: [] }
							: command.type === 'get_state'
								? {
										model: { id: 'claude-fable-5' },
										thinkingLevel: 'high',
										steeringMode: 'one-at-a-time',
										autoCompactionEnabled: true,
										todoPhases: [
											{ id: 'phase-1', label: 'Build inspector', status: 'in_progress' },
										],
									}
								: command.type === 'get_subagents'
									? { subagents: [{ id: 'sub-1', name: 'Scout', status: 'completed' }] }
									: command.type === 'get_session_stats'
										? {
												sessionId: 'omp-session',
												userMessages: 1,
												assistantMessages: 1,
												tokens: {
													input: 12,
													output: 7,
													reasoning: 3,
													cacheRead: 4,
													cacheWrite: 5,
													total: 31,
												},
												cost: 0.02,
												contextUsage: { tokens: 31, contextWindow: 1000000, percent: 0.0031 },
											}
										: {};
			queueMicrotask(() =>
				emit(child, {
					type: 'response',
					id: command.id,
					command: command.type,
					success: true,
					data,
				})
			);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-controls',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));

		await adapter.setControl('model', 'anthropic:claude-fable-5');
		await adapter.setControl('thinking-level', 'high');
		await adapter.setControl('steering-mode', 'one-at-a-time');
		await adapter.setControl('follow-up-mode', 'one-at-a-time');
		await adapter.setControl('interrupt-mode', 'wait');
		await adapter.setControl('auto-compaction', true);
		await adapter.setControl('auto-retry', true);

		expect(
			frames.filter((frame) =>
				[
					'set_model',
					'set_thinking_level',
					'set_steering_mode',
					'set_follow_up_mode',
					'set_interrupt_mode',
					'set_auto_compaction',
					'set_auto_retry',
				].includes(String(frame.type))
			)
		).toEqual([
			{
				type: 'set_model',
				provider: 'anthropic',
				modelId: 'claude-fable-5',
				id: expect.stringMatching(/^maestro-omp-/),
			},
			{
				type: 'set_thinking_level',
				level: 'high',
				id: expect.stringMatching(/^maestro-omp-/),
			},
			{
				type: 'set_steering_mode',
				mode: 'one-at-a-time',
				id: expect.stringMatching(/^maestro-omp-/),
			},
			{
				type: 'set_follow_up_mode',
				mode: 'one-at-a-time',
				id: expect.stringMatching(/^maestro-omp-/),
			},
			{
				type: 'set_interrupt_mode',
				mode: 'wait',
				id: expect.stringMatching(/^maestro-omp-/),
			},
			{
				type: 'set_auto_compaction',
				enabled: true,
				id: expect.stringMatching(/^maestro-omp-/),
			},
			{
				type: 'set_auto_retry',
				enabled: true,
				id: expect.stringMatching(/^maestro-omp-/),
			},
		]);
		const features = send.mock.calls
			.filter(([channel]) => channel === 'process:runtime-features')
			.at(-1)?.[2] as {
			controls: Array<{ id: string; value: string | boolean }>;
			todos: unknown;
			subagents: unknown;
			stats: unknown;
		};
		expect(features.controls).toContainEqual({
			id: 'auto-retry',
			label: 'Auto-retry',
			kind: 'toggle',
			value: true,
		});
		expect(features).toMatchObject({
			todos: [
				{
					name: 'Build inspector',
					items: [{ content: 'Build inspector', state: 'in_progress' }],
				},
			],
			subagents: [{ id: 'sub-1', label: 'Scout', status: 'complete' }],
			stats: {
				userMessages: 1,
				assistantMessages: 1,
				inputTokens: 12,
				outputTokens: 7,
				reasoningTokens: 3,
				cacheReadInputTokens: 4,
				cacheCreationInputTokens: 5,
				totalTokens: 31,
				totalCostUsd: 0.02,
				contextWindow: 1000000,
			},
		});
		await adapter.setControl('auto-retry', false);
		const postMutationFeatures = send.mock.calls
			.filter(([channel]) => channel === 'process:runtime-features')
			.at(-1)?.[2] as { controls: Array<{ id: string; value: string | boolean }> };
		expect(postMutationFeatures.controls).toContainEqual(
			expect.objectContaining({ id: 'auto-retry', value: false })
		);
	});

	it('uses the captured level payload and projects high after the state refresh', async () => {
		expect(capturedThinkingLevel).toContainEqual(
			expect.objectContaining({
				command: 'set_thinking_level',
				success: true,
			})
		);
		expect(capturedThinkingLevel).toContainEqual(
			expect.objectContaining({
				command: 'get_state',
				data: expect.objectContaining({ thinkingLevel: 'high' }),
			})
		);

		const child = new FakeChild();
		let thinkingLevel = 'medium';
		const frames: Array<{ id?: string; type: string; level?: string }> = [];
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string; level?: string };
			frames.push(command);
			if (!command.id) return true;
			if (command.type === 'set_thinking_level' && command.level) {
				thinkingLevel = command.level;
			}
			const data =
				command.type === 'get_available_commands'
					? { commands: [] }
					: command.type === 'get_available_models'
						? { models: [] }
						: command.type === 'get_messages'
							? { messages: [] }
							: command.type === 'get_subagents'
								? { subagents: [] }
								: command.type === 'get_state'
									? { thinkingLevel, todoPhases: [] }
									: {};
			queueMicrotask(() =>
				emit(child, {
					type: 'response',
					id: command.id,
					command: command.type,
					success: true,
					data,
				})
			);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-thinking',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await adapter.setControl('thinking-level', 'high');

		expect(frames).toContainEqual(
			expect.objectContaining({ type: 'set_thinking_level', level: 'high' })
		);
		const features = send.mock.calls
			.filter(([channel]) => channel === 'process:runtime-features')
			.at(-1)?.[2] as { controls: Array<{ id: string; value: string | boolean }> };
		expect(features.controls).toContainEqual(
			expect.objectContaining({ id: 'thinking-level', value: 'high' })
		);
	});

	it('reports rejected controls and does not refresh the feature state as if they applied', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (!command.id) return true;
			queueMicrotask(() =>
				emit(child, {
					type: 'response',
					id: command.id,
					command: command.type,
					success: command.type !== 'set_auto_retry',
					...(command.type === 'set_auto_retry'
						? { error: 'Unknown callback type: set_auto_retry' }
						: { data: command.type === 'get_state' ? { todoPhases: [] } : {} }),
				})
			);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-rejected-control',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const refreshesBeforeRejection = send.mock.calls.filter(
			([channel]) => channel === 'process:runtime-features'
		).length;

		await expect(adapter.setControl('auto-retry', true)).rejects.toThrow(
			'Unknown callback type: set_auto_retry'
		);

		expect(send).toHaveBeenCalledWith(
			'process:stderr',
			'tab-rejected-control',
			'OMP control auto-retry rejected: Unknown callback type: set_auto_retry'
		);
		expect(
			send.mock.calls.filter(([channel]) => channel === 'process:runtime-features')
		).toHaveLength(refreshesBeforeRejection);
	});

	it('fails closed with a native diagnostic when a pinned RPC process emits an unknown frame', async () => {
		const child = new FakeChild();
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-protocol-drift',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		emit(child, { type: 'unrecognized_16_4_8_extension_frame' });

		expect(send).toHaveBeenCalledWith(
			'process:stderr',
			'tab-protocol-drift',
			'OMP emitted unsupported RPC frame type unrecognized_16_4_8_extension_frame'
		);
		await expect(adapter.prompt('must not be sent')).rejects.toThrow('OMP RPC process is closed');
	});
	it('maps ordinary composer actions to native OMP lifecycle commands', async () => {
		const child = new FakeChild();
		const frames: Array<Record<string, unknown>> = [];
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			frames.push(command);
			if (command.id) {
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			}
			return true;
		});
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-actions',
			cwd: 'C:/work/project',
			command: 'omp',
			send: vi.fn(),
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));

		await adapter.deliver(
			'steer',
			'keep the existing process',
			undefined,
			'00000000-0000-4000-8000-000000000001'
		);
		await adapter.deliver(
			'follow_up',
			'do this after the turn',
			undefined,
			'00000000-0000-4000-8000-000000000002'
		);
		await adapter.deliver(
			'abort_and_prompt',
			'replace the current turn',
			undefined,
			'00000000-0000-4000-8000-000000000003'
		);
		expect(
			frames
				.filter(
					(frame) =>
						frame.type === 'prompt' &&
						['steer', 'follow_up', 'abort_and_prompt'].includes(frame.streamingBehavior as string)
				)
				.map((frame) => ({
					type: frame.type,
					message: frame.message,
					streamingBehavior: frame.streamingBehavior,
				}))
		).toEqual([
			{ type: 'prompt', message: 'keep the existing process', streamingBehavior: 'steer' },
			{ type: 'prompt', message: 'do this after the turn', streamingBehavior: 'follow_up' },
			{
				type: 'prompt',
				message: 'replace the current turn',
				streamingBehavior: 'abort_and_prompt',
			},
		]);

		for (const control of [
			'new-session',
			'compact',
			'handoff',
			'export-html',
			'cycle-model',
			'cycle-thinking-level',
			'abort-retry',
			'abort-bash',
		])
			await expect(adapter.setControl(control, true)).resolves.toBe(true);
		await expect(adapter.setControl('session-name', 'Renamed session')).resolves.toBe(true);
		await expect(adapter.setControl('switch-session', 'C:/work/omp/session.jsonl')).resolves.toBe(
			true
		);
		await expect(adapter.setControl('bash', 'echo native command')).resolves.toBe(true);
		await expect(adapter.setControl('login', 'fixture-login')).resolves.toBe(true);

		expect(frames.map((frame) => frame.type)).toEqual(
			expect.arrayContaining([
				'new_session',
				'compact',
				'handoff',
				'export_html',
				'cycle_model',
				'cycle_thinking_level',
				'abort_retry',
				'abort_bash',
				'set_session_name',
				'switch_session',
				'bash',
				'login',
			])
		);
	});

	it('spends delivery IDs per adapter across pending, consumed, and rejected continuations', async () => {
		const firstChild = new FakeChild();
		const firstFrames: Array<{ type: string; streamingBehavior?: string }> = [];
		firstChild.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as {
				id?: string;
				type: string;
				streamingBehavior?: string;
			};
			firstFrames.push(command);
			if (command.id)
				queueMicrotask(() =>
					emit(firstChild, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const first = OmpNativeSessionAdapter.create({
			sessionId: 'tab-delivery-id-first',
			cwd: 'C:/work/project',
			command: 'omp',
			send: vi.fn(),
			spawn: vi.fn(() => firstChild as never),
		});
		emit(firstChild, { type: 'ready', version: '16.4.8' });
		await first.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await first.prompt('first turn');
		const sharedId = '00000000-0000-4000-8000-000000000010';
		await expect(first.deliver('follow_up', 'one', undefined, sharedId)).resolves.toBe(true);
		await expect(
			first.deliver('follow_up', 'duplicate pending', undefined, sharedId)
		).resolves.toBe(false);
		emit(firstChild, { type: 'turn_end' });
		emit(firstChild, { type: 'agent_start' });
		await expect(
			first.deliver('follow_up', 'duplicate consumed', undefined, sharedId)
		).resolves.toBe(false);
		const failedId = '00000000-0000-4000-8000-000000000012';
		await expect(
			first.deliver('follow_up', 'will fail before start', undefined, failedId)
		).resolves.toBe(true);
		emit(firstChild, { type: 'turn_end' });
		emit(firstChild, { type: 'extension_error', message: 'continuation failed' });
		await expect(first.deliver('follow_up', 'duplicate failed', undefined, failedId)).resolves.toBe(
			false
		);
		expect(
			firstFrames.filter(
				(frame) => frame.type === 'prompt' && frame.streamingBehavior === 'follow_up'
			)
		).toHaveLength(2);

		const rejectedChild = new FakeChild();
		const rejectedFrames: Array<{ type: string; streamingBehavior?: string }> = [];
		rejectedChild.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as {
				id?: string;
				type: string;
				streamingBehavior?: string;
			};
			rejectedFrames.push(command);
			if (command.id)
				queueMicrotask(() =>
					emit(rejectedChild, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: command.streamingBehavior !== 'follow_up',
						error: command.streamingBehavior === 'follow_up' ? 'rejected continuation' : undefined,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const rejected = OmpNativeSessionAdapter.create({
			sessionId: 'tab-delivery-id-rejected',
			cwd: 'C:/work/project',
			command: 'omp',
			send: vi.fn(),
			spawn: vi.fn(() => rejectedChild as never),
		});
		emit(rejectedChild, { type: 'ready', version: '16.4.8' });
		await rejected.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await rejected.prompt('first turn');
		const rejectedId = '00000000-0000-4000-8000-000000000011';
		await expect(rejected.deliver('follow_up', 'rejected', undefined, rejectedId)).rejects.toThrow(
			'rejected continuation'
		);
		await expect(
			rejected.deliver('follow_up', 'duplicate rejected', undefined, rejectedId)
		).resolves.toBe(false);
		expect(
			rejectedFrames.filter(
				(frame) => frame.type === 'prompt' && frame.streamingBehavior === 'follow_up'
			)
		).toHaveLength(1);

		const secondChild = new FakeChild();
		secondChild.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(secondChild, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const second = OmpNativeSessionAdapter.create({
			sessionId: 'tab-delivery-id-second',
			cwd: 'C:/work/project',
			command: 'omp',
			send: vi.fn(),
			spawn: vi.fn(() => secondChild as never),
		});
		emit(secondChild, { type: 'ready', version: '16.4.8' });
		await second.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await second.prompt('second tab turn');
		await expect(
			second.deliver('follow_up', 'same ID other tab', undefined, sharedId)
		).resolves.toBe(true);
	});

	it('consumes a queued follow-up at turn_end before 16.4.8 streams continuation output', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const send = vi.fn();
		const spawn = vi.fn(() => child as never);
		const adapter = await OmpNativeSessionAdapter.acquire({
			sessionId: 'tab-follow-up-chain',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn,
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));

		await adapter.prompt('first turn');
		emit(child, {
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'output A' },
		});
		await adapter.deliver(
			'follow_up',
			'continue after this turn',
			undefined,
			'00000000-0000-4000-8000-000000000004'
		);
		emit(child, {
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'output B' },
		});
		emit(child, { type: 'turn_end' });
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) =>
					channel === 'process:command-exit' && sessionId === 'tab-follow-up-chain'
			)
		).toHaveLength(0);
		emit(child, {
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'output C' },
		});
		emit(child, { type: 'turn_end' });

		expect(spawn).toHaveBeenCalledOnce();
		expect(OmpNativeSessionAdapter.forSession('tab-follow-up-chain')).toBe(adapter);
		expect(send).toHaveBeenCalledWith('process:omp-turn-lifecycle', 'tab-follow-up-chain', {
			phase: 'agent_start',
			continuation: true,
			deliveryIntent: 'follow_up',
			deliveryId: '00000000-0000-4000-8000-000000000004',
		});
		expect(
			send.mock.calls
				.filter(
					([channel, sessionId]) =>
						channel === 'process:data' && sessionId === 'tab-follow-up-chain'
				)
				.map(([, , text]) => text)
		).toEqual(['output A', 'output B', 'output C']);
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) =>
					channel === 'process:command-exit' && sessionId === 'tab-follow-up-chain'
			)
		).toHaveLength(1);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it('consumes an atomic replacement without waiting for an intermediate turn boundary', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-atomic-replacement',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));

		await adapter.prompt('original turn');
		await adapter.deliver(
			'abort_and_prompt',
			'replace the current turn',
			undefined,
			'00000000-0000-4000-8000-000000000010'
		);

		expect(send).toHaveBeenCalledWith('process:omp-turn-lifecycle', 'tab-atomic-replacement', {
			phase: 'agent_start',
			continuation: true,
			deliveryIntent: 'abort_and_prompt',
			deliveryId: '00000000-0000-4000-8000-000000000010',
		});
		emit(child, { type: 'turn_end' });
		emit(child, { type: 'agent_end' });
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) =>
					channel === 'process:command-exit' && sessionId === 'tab-atomic-replacement'
			)
		).toEqual([['process:command-exit', 'tab-atomic-replacement', 0, OMP_NATIVE_TURN_COMPLETION]]);
	});

	it('finalizes a queued continuation once when OMP reports an extension error before restart', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-failed-continuation',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('first turn');
		await adapter.deliver(
			'follow_up',
			'continue after this',
			undefined,
			'00000000-0000-4000-8000-000000000005'
		);
		emit(child, { type: 'turn_end' });
		emit(child, { type: 'extension_error', message: 'continuation failed' });
		child.emit('close', 1, null);

		expect(
			send.mock.calls.filter(
				([channel, sessionId]) =>
					channel === 'process:omp-turn-lifecycle' && sessionId === 'tab-failed-continuation'
			)
		).toContainEqual([
			'process:omp-turn-lifecycle',
			'tab-failed-continuation',
			{
				phase: 'continuation_failed',
				deliveryIntent: 'follow_up',
				deliveryId: '00000000-0000-4000-8000-000000000005',
			},
		]);
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) =>
					channel === 'process:command-exit' && sessionId === 'tab-failed-continuation'
			)
		).toEqual([['process:command-exit', 'tab-failed-continuation', 1, OMP_NATIVE_TURN_COMPLETION]]);
	});

	it('finalizes a queued continuation once when the RPC child closes before restart', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-closed-continuation',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('first turn');
		await adapter.deliver(
			'follow_up',
			'continue after this',
			undefined,
			'00000000-0000-4000-8000-000000000006'
		);
		emit(child, { type: 'turn_end' });
		child.emit('close', 1, null);

		expect(send).toHaveBeenCalledWith('process:omp-turn-lifecycle', 'tab-closed-continuation', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
			deliveryId: '00000000-0000-4000-8000-000000000006',
		});
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) =>
					channel === 'process:command-exit' && sessionId === 'tab-closed-continuation'
			)
		).toEqual([['process:command-exit', 'tab-closed-continuation', 1, OMP_NATIVE_TURN_COMPLETION]]);
	});

	it('reports a rejected continuation while the original turn remains busy until its real end', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as {
				id?: string;
				type: string;
				streamingBehavior?: string;
			};
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: command.streamingBehavior !== 'follow_up',
						error: command.streamingBehavior === 'follow_up' ? 'rejected continuation' : undefined,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-rejected-continuation',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('first turn');
		await expect(
			adapter.deliver(
				'follow_up',
				'continue after this',
				undefined,
				'00000000-0000-4000-8000-000000000009'
			)
		).rejects.toThrow('rejected continuation');

		expect(send).toHaveBeenCalledWith('process:omp-turn-lifecycle', 'tab-rejected-continuation', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
			deliveryId: '00000000-0000-4000-8000-000000000009',
		});
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) =>
					channel === 'process:command-exit' && sessionId === 'tab-rejected-continuation'
			)
		).toHaveLength(0);
		emit(child, {
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'original turn continues' },
		});
		expect(send).toHaveBeenCalledWith(
			'process:data',
			'tab-rejected-continuation',
			'original turn continues'
		);
		emit(child, { type: 'turn_end' });
		expect(send).toHaveBeenCalledWith(
			'process:command-exit',
			'tab-rejected-continuation',
			0,
			OMP_NATIVE_TURN_COMPLETION
		);
	});

	it('finalizes a queued continuation when OMP emits a protocol failure before restart', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-protocol-continuation',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('first turn');
		await adapter.deliver(
			'follow_up',
			'continue after this',
			undefined,
			'00000000-0000-4000-8000-000000000007'
		);
		emit(child, { type: 'turn_end' });
		emit(child, { type: 'unsupported_fixture_frame' });

		expect(send).toHaveBeenCalledWith('process:omp-turn-lifecycle', 'tab-protocol-continuation', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
			deliveryId: '00000000-0000-4000-8000-000000000007',
		});
		expect(send).toHaveBeenCalledWith(
			'process:command-exit',
			'tab-protocol-continuation',
			1,
			OMP_NATIVE_TURN_COMPLETION
		);
	});

	it('finalizes a queued continuation when disposing the adapter before restart', async () => {
		const child = new FakeChild();
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id)
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data: command.type === 'get_state' ? { todoPhases: [] } : {},
					})
				);
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-disposed-continuation',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('first turn');
		await adapter.deliver(
			'follow_up',
			'continue after this',
			undefined,
			'00000000-0000-4000-8000-000000000008'
		);
		emit(child, { type: 'turn_end' });
		adapter.dispose();

		expect(send).toHaveBeenCalledWith('process:omp-turn-lifecycle', 'tab-disposed-continuation', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
			deliveryId: '00000000-0000-4000-8000-000000000008',
		});
		expect(send).toHaveBeenCalledWith(
			'process:command-exit',
			'tab-disposed-continuation',
			1,
			OMP_NATIVE_TURN_COMPLETION
		);
	});

	it('normalizes a tool lifecycle by toolCallId and omits id-less native events', async () => {
		const child = new FakeChild();
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-tool-lifecycle',
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;

		emit(child, {
			type: 'tool_execution_start',
			toolCallId: 'call-1',
			toolName: 'read',
			args: { path: 'a.ts' },
		});
		emit(child, {
			type: 'tool_execution_update',
			toolCallId: 'call-1',
			toolName: 'read',
			partialResult: 'partial',
		});
		emit(child, {
			type: 'tool_execution_end',
			toolCallId: 'call-1',
			toolName: 'read',
			result: 'complete',
		});
		emit(child, { type: 'tool_execution_start', toolName: 'ignored' });

		const toolEvents = send.mock.calls.filter(([channel]) => channel === 'process:tool-execution');
		expect(toolEvents).toEqual([
			[
				'process:tool-execution',
				'tab-tool-lifecycle',
				expect.objectContaining({
					toolCallId: 'call-1',
					state: { status: 'running', input: { path: 'a.ts' } },
				}),
			],
			[
				'process:tool-execution',
				'tab-tool-lifecycle',
				expect.objectContaining({
					toolCallId: 'call-1',
					state: { status: 'running', output: 'partial' },
				}),
			],
			[
				'process:tool-execution',
				'tab-tool-lifecycle',
				expect.objectContaining({
					toolCallId: 'call-1',
					state: { status: 'completed', output: 'complete' },
				}),
			],
		]);
		expect(send).toHaveBeenCalledWith(
			'process:stderr',
			'tab-tool-lifecycle',
			'OMP tool lifecycle ignored without toolCallId'
		);
	});

	it('uses live runtime context metadata before model metadata and only then falls back', () => {
		expect(
			contextWindowFromOmpRuntime({
				state: {
					contextUsage: { contextWindow: 1_000_000 },
					model: { provider: 'anthropic', id: 'claude-sonnet', contextWindow: 200_000 },
				},
				stats: { contextUsage: { contextWindow: 500_000 } },
				models: [{ provider: 'anthropic', id: 'claude-sonnet', contextWindow: 200_000 }],
			})
		).toBe(1_000_000);
		expect(
			contextWindowFromOmpRuntime({
				state: { model: { provider: 'anthropic', id: 'claude-sonnet', contextWindow: 200_000 } },
				stats: {},
				models: [{ provider: 'anthropic', id: 'claude-sonnet', contextWindow: 500_000 }],
			})
		).toBe(200_000);
		expect(
			contextWindowFromOmpRuntime({
				state: { model: { provider: 'ollama', id: 'discovered-model' } },
				stats: {},
				models: [{ provider: 'ollama', id: 'discovered-model', contextWindow: 65_536 }],
			})
		).toBe(65_536);
		expect(
			contextWindowFromOmpRuntime({
				state: { model: { provider: 'unknown', id: 'unknown-model' } },
				stats: {},
				models: [],
			})
		).toBe(200_000);
	});

	it('uses refreshed active-model metadata after model switches and selected-model recovery', () => {
		const models = [
			{ provider: 'anthropic', id: 'claude-sonnet', contextWindow: 200_000 },
			{ provider: 'anthropic', id: 'claude-opus', contextWindow: 1_000_000 },
		];
		expect(
			contextWindowFromOmpRuntime({
				state: { model: { provider: 'anthropic', id: 'claude-sonnet' } },
				stats: {},
				models,
			})
		).toBe(200_000);
		expect(
			contextWindowFromOmpRuntime({
				state: { model: { provider: 'anthropic', id: 'claude-opus' } },
				stats: {},
				models,
			})
		).toBe(1_000_000);
		expect(
			contextWindowFromOmpRuntime({
				state: {},
				stats: {},
				models,
				selectedModel: 'anthropic:claude-opus',
			})
		).toBe(1_000_000);
	});

	it('projects resumed-session model metadata after switch_session', async () => {
		const child = new FakeChild();
		const frames: Array<Record<string, unknown>> = [];
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			frames.push(command);
			if (command.id) {
				const data =
					command.type === 'get_available_models'
						? {
								models: [
									{
										provider: 'openai-codex',
										id: 'gpt-5.6',
										contextWindow: 400_000,
									},
								],
							}
						: command.type === 'get_state'
							? { model: { provider: 'openai-codex', id: 'gpt-5.6' }, todoPhases: [] }
							: {};
				queueMicrotask(() =>
					emit(child, {
						type: 'response',
						id: command.id,
						command: command.type,
						success: true,
						data,
					})
				);
			}
			return true;
		});
		const send = vi.fn();
		const adapter = OmpNativeSessionAdapter.create({
			sessionId: 'tab-resume-metadata',
			cwd: 'C:/work/project',
			command: 'omp',
			agentSessionId: 'C:/work/.omp/sessions/resumed.jsonl',
			send,
			spawn: vi.fn(() => child as never),
		});
		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(frames).toContainEqual(
			expect.objectContaining({
				type: 'switch_session',
				sessionPath: 'C:/work/.omp/sessions/resumed.jsonl',
			})
		);
		expect(send).toHaveBeenCalledWith(
			'process:runtime-features',
			'tab-resume-metadata',
			expect.objectContaining({ stats: expect.objectContaining({ contextWindow: 400_000 }) })
		);
		adapter.dispose();
	});

	function extensionResponses(child: FakeChild): Array<Record<string, unknown>> {
		return child.stdin.write.mock.calls
			.map(([frame]) => JSON.parse(frame as string) as Record<string, unknown>)
			.filter((frame) => frame.type === 'extension_ui_response');
	}
});
