import { describe, expect, it, vi } from 'vitest';
import { createManagedProcessBase } from '../../../../main/process-manager/utils/managedProcess';

describe('createManagedProcessBase', () => {
	it('preserves caller-owned transport fields while constructing stable common process metadata', () => {
		const startTime = 1_700_000_000_000;
		const process = createManagedProcessBase(
			{
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/project',
				command: 'claude',
				args: ['--print'],
			},
			{ pid: 42, isTerminal: false, startTime }
		);

		expect(process).toEqual({
			sessionId: 'session-1',
			toolType: 'claude-code',
			cwd: '/project',
			pid: 42,
			isTerminal: false,
			startTime,
			command: 'claude',
			args: ['--print'],
		});
	});

	it('uses the spawn configuration command and arguments without copying their identity', () => {
		const command = 'opencode';
		const args = ['run'];
		const process = createManagedProcessBase(
			{
				sessionId: 'session-2',
				toolType: 'opencode',
				cwd: '/workspace',
				command,
				args,
			},
			{ pid: -1, isTerminal: false, startTime: 123 }
		);

		expect(process.command).toBe(command);
		expect(process.args).toBe(args);
	});

	it('timestamps construction once when a caller does not provide a lifecycle start time', () => {
		vi.spyOn(Date, 'now').mockReturnValue(456);

		const process = createManagedProcessBase(
			{
				sessionId: 'session-3',
				toolType: 'terminal',
				cwd: '/tmp',
				command: 'bash',
				args: [],
			},
			{ pid: 7, isTerminal: true }
		);

		expect(process.startTime).toBe(456);
	});
});
