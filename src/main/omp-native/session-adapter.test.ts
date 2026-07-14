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
	it('uses the real user runtime and projects RPC activity to native events', async () => {
		const child = new FakeChild();
		const spawn = vi.fn(() => child as never);
		child.stdin.write.mockImplementation((frame: string) => {
			const command = JSON.parse(frame) as { id?: string; type: string };
			if (command.id) {
				const data =
					command.type === 'get_available_commands'
						? [{ name: 'compact' }]
						: command.type === 'get_state'
							? { sessionId: 'omp-session', thinkingLevel: 'high', todoPhases: [] }
							: command.type === 'get_messages'
								? [{ id: 'entry-1', content: 'Root' }]
								: command.type === 'get_subagents'
									? [{ id: 'sub-1', name: 'Scout', status: 'running' }]
									: command.type === 'get_session_stats'
										? { inputTokens: 12 }
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
			expect.objectContaining({ stats: { inputTokens: 12 } })
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
});
