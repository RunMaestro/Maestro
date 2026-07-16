import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { OmpNativeSessionAdapter } from './session-adapter';
import capturedRpcTurn from './fixtures/real-rpc-turn.json';
import { OMP_NATIVE_TURN_COMPLETION } from '../../shared/omp-native-session';
import capturedThinkingLevel from './fixtures/real-rpc-thinking-level.json';

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
				stats: { inputTokens: 12 },
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
										{ provider: 'fixture', id: 'fixture-initial', label: 'Initial' },
										{ provider: 'fixture', id: 'fixture-reconciled', label: 'Reconciled' },
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
			model: 'fixture:fixture-initial',
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
				model: 'fixture:fixture-reconciled',
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

	function extensionResponses(child: FakeChild): Array<Record<string, unknown>> {
		return child.stdin.write.mock.calls
			.map(([frame]) => JSON.parse(frame as string) as Record<string, unknown>)
			.filter((frame) => frame.type === 'extension_ui_response');
	}
});
