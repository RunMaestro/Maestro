import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/paseo', () => ({
	createPaseoSchedule: vi.fn(),
	listPaseoSchedules: vi.fn(),
	getPaseoScheduleLogs: vi.fn(),
	runPaseoAgent: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((message: string) => `Error: ${message}`),
}));

import {
	paseoRun,
	paseoScheduleCreate,
	paseoScheduleList,
	paseoScheduleLogs,
} from '../../../cli/commands/paseo';
import {
	createPaseoSchedule,
	getPaseoScheduleLogs,
	listPaseoSchedules,
	runPaseoAgent,
} from '../../../cli/services/paseo';

describe('paseo command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((code?: string | number | null | undefined) => {
				throw new Error(`process.exit(${code})`);
			});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it('creates a Paseo schedule and prints stdout', async () => {
		vi.mocked(createPaseoSchedule).mockResolvedValue({
			stdout: 'ID NAME\nabc demo\n',
			stderr: '',
		});

		await paseoScheduleCreate('do work', {
			every: '2m',
			name: 'demo',
			provider: 'codex',
			cwd: '/repo',
			maxRuns: '2',
			expiresIn: '10m',
		});

		expect(createPaseoSchedule).toHaveBeenCalledWith('do work', {
			every: '2m',
			name: 'demo',
			provider: 'codex',
			cwd: '/repo',
			maxRuns: '2',
			expiresIn: '10m',
		});
		expect(consoleSpy).toHaveBeenCalledWith('ID NAME\nabc demo');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('runs a titled Paseo agent and prints stdout', async () => {
		vi.mocked(runPaseoAgent).mockResolvedValue({
			stdout: 'agent-123\n',
			stderr: '',
		});

		await paseoRun('do visible work', {
			title: 'Visible Work',
			provider: 'codex',
			cwd: '/repo',
			detach: true,
		});

		expect(runPaseoAgent).toHaveBeenCalledWith('do visible work', {
			title: 'Visible Work',
			provider: 'codex',
			cwd: '/repo',
			detach: true,
		});
		expect(consoleSpy).toHaveBeenCalledWith('agent-123');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('lists schedules', async () => {
		vi.mocked(listPaseoSchedules).mockResolvedValue({ stdout: 'schedules\n', stderr: '' });

		await paseoScheduleList({ json: true, host: '127.0.0.1:6767' });

		expect(listPaseoSchedules).toHaveBeenCalledWith({
			json: true,
			host: '127.0.0.1:6767',
		});
		expect(consoleSpy).toHaveBeenCalledWith('schedules');
	});

	it('shows schedule logs', async () => {
		vi.mocked(getPaseoScheduleLogs).mockResolvedValue({ stdout: 'logs\n', stderr: '' });

		await paseoScheduleLogs('abc123', { cliPath: '/bin/paseo' });

		expect(getPaseoScheduleLogs).toHaveBeenCalledWith('abc123', { cliPath: '/bin/paseo' });
		expect(consoleSpy).toHaveBeenCalledWith('logs');
	});

	it('prints JSON errors when json mode is enabled', async () => {
		vi.mocked(listPaseoSchedules).mockRejectedValue(new Error('daemon unavailable'));

		await expect(paseoScheduleList({ json: true })).rejects.toThrow('process.exit(1)');

		const output = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
		expect(output).toEqual({ success: false, error: 'daemon unavailable' });
	});

	it('prints human-readable errors otherwise', async () => {
		vi.mocked(listPaseoSchedules).mockRejectedValue(new Error('daemon unavailable'));

		await expect(paseoScheduleList({})).rejects.toThrow('process.exit(1)');

		expect(consoleErrorSpy).toHaveBeenCalledWith('Error: daemon unavailable');
	});
});
