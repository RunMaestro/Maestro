import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { OmpNativeSessionAdapter } from './session-adapter';

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
							? { sessionId: 'omp-session', thinkingLevel: 'high', todoPhases: [] }
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
				]),
				tree: [{ id: 'entry-1', label: 'Root' }],
				subagents: [{ id: 'sub-1', label: 'Scout', status: 'running', detail: undefined }],
				stats: { inputTokens: 12 },
			})
		);
		emit(child, { type: 'message_update', sequence: 1, content: 'partial' });
		emit(child, { type: 'prompt_result', agentInvoked: true, text: 'final' });
		expect(send).toHaveBeenCalledWith('process:data', 'tab-1', 'partial');
		expect(send).toHaveBeenCalledWith('process:data', 'tab-1', 'final');
		void adapter.interrupt();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(child.stdin.write).toHaveBeenLastCalledWith(expect.stringContaining('"type":"abort"'));
		emit(child, {
			type: 'extension_ui_request',
			id: 'approval-1',
			method: 'select',
			title: 'Approve tool?',
			options: [{ id: 'yes', label: 'Yes', kind: 'approve' }],
		});
		expect(send).toHaveBeenCalledWith(
			'process:approval-request',
			expect.objectContaining({ id: 'approval-1', sessionId: 'tab-1' })
		);
		await expect(adapter.respondApproval('approval-1', 'yes')).resolves.toBe(true);
		await expect(adapter.branch('entry-1')).resolves.toBe(true);
		expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"type":"branch"'));
		expect(child.kill).not.toHaveBeenCalled();
	});

	it('signals each completed RPC turn without terminating the long-lived child', async () => {
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
			cwd: 'C:/work/project',
			command: 'omp',
			send,
			spawn: vi.fn(() => child as never),
		});

		emit(child, { type: 'ready', version: '16.4.8' });
		await adapter.ready;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await adapter.prompt('first prompt');
		emit(child, { type: 'prompt_result', text: 'first result' });
		emit(child, { type: 'turn_end' });

		expect(send).toHaveBeenCalledWith('process:data', 'tab-2', 'first result');
		expect(send).toHaveBeenCalledWith('process:command-exit', 'tab-2', 0);
		expect(child.kill).not.toHaveBeenCalled();

		await adapter.prompt('second prompt');
		emit(child, { type: 'prompt_result', text: 'second result' });
		emit(child, { type: 'agent_end' });

		expect(promptMessages).toEqual(['first prompt', 'second prompt']);
		expect(send).toHaveBeenCalledWith('process:data', 'tab-2', 'second result');
		const firstResultIndex = send.mock.calls.findIndex(
			([channel, sessionId, value]) =>
				channel === 'process:data' && sessionId === 'tab-2' && value === 'first result'
		);
		const firstCompletionIndex = send.mock.calls.findIndex(
			([channel, sessionId]) => channel === 'process:command-exit' && sessionId === 'tab-2'
		);
		expect(firstResultIndex).toBeLessThan(firstCompletionIndex);
		expect(
			send.mock.calls.filter(
				([channel, sessionId]) => channel === 'process:command-exit' && sessionId === 'tab-2'
			)
		).toHaveLength(2);
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
			images: [{ image: { mimeType: 'image/png', data: 'cG5nLWJ5dGVz' } }],
		});
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
		expect(send).toHaveBeenCalledWith('process:command-exit', 'tab-callback-safety', 0);
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
			options: [{ id: 'option:deny/opaque', label: 'Decline', kind: 'deny' }],
		});

		expect(send).toHaveBeenCalledWith('process:approval-request', {
			id: 'approval-opaque',
			sessionId: 'tab-approval',
			toolType: 'omp',
			title: 'Continue?',
			detail: undefined,
			options: [{ id: 'option:deny/opaque', label: 'Decline', kind: 'deny' }],
			createdAt: expect.any(String),
		});
		await expect(adapter.respondApproval('approval-opaque', 'unknown-option')).resolves.toBe(false);
		expect(extensionResponses(child)).toEqual([]);

		await expect(adapter.respondApproval('approval-opaque', 'option:deny/opaque')).resolves.toBe(
			true
		);
		expect(extensionResponses(child)).toEqual([
			{ type: 'extension_ui_response', id: 'approval-opaque', confirmed: false },
		]);
		await expect(adapter.respondApproval('approval-opaque', 'option:deny/opaque')).resolves.toBe(
			false
		);

		emit(child, {
			type: 'extension_ui_request',
			id: 'approval-opaque',
			method: 'select',
			title: 'Continue?',
			options: [{ id: 'option:deny/opaque', label: 'Decline', kind: 'deny' }],
		});
		expect(
			send.mock.calls.filter(([channel]) => channel === 'process:approval-request')
		).toHaveLength(1);
	});

	it('acknowledges noninteractive extension UI callbacks without creating pending approvals', async () => {
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
		for (const method of [
			'notify',
			'setStatus',
			'setWidget',
			'setTitle',
			'set_editor_text',
			'open_url',
			'input',
			'editor',
		]) {
			emit(child, {
				type: 'extension_ui_request',
				id: `noninteractive-${method}`,
				method,
				title: 'Extension request',
			});
		}
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(
			send.mock.calls.filter(([channel]) => channel === 'process:approval-request')
		).toHaveLength(0);
		expect(extensionResponses(child)).toEqual(
			expect.arrayContaining([
				{ type: 'extension_ui_response', id: 'noninteractive-notify', cancelled: true },
				{ type: 'extension_ui_response', id: 'noninteractive-open_url', cancelled: true },
				{ type: 'extension_ui_response', id: 'noninteractive-input', cancelled: true },
				{ type: 'extension_ui_response', id: 'noninteractive-editor', cancelled: true },
			])
		);
		await expect(adapter.respondApproval('noninteractive-notify', 'approve')).resolves.toBe(false);
	});

	function extensionResponses(child: FakeChild): unknown[] {
		return child.stdin.write.mock.calls
			.map(([frame]) => JSON.parse(frame as string))
			.filter((frame) => frame.type === 'extension_ui_response');
	}
});
