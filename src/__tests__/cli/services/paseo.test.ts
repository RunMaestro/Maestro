import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
	statSync: vi.fn(),
	accessSync: vi.fn(),
	constants: { X_OK: 1 },
}));

vi.mock('os', () => ({
	platform: vi.fn(() => 'darwin'),
}));

vi.mock('child_process', () => ({
	spawn: vi.fn(),
}));

import { EventEmitter } from 'events';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import {
	createPaseoSchedule,
	getPaseoScheduleLogs,
	listPaseoSchedules,
	resolvePaseoCliPath,
	runPaseoCommand,
} from '../../../cli/services/paseo';

function mockSpawnChild(): EventEmitter & {
	stdout: Readable;
	stderr: Readable;
} {
	const child = new EventEmitter() as EventEmitter & {
		stdout: Readable;
		stderr: Readable;
	};
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });

	vi.mocked(spawn).mockReturnValue(child as any);

	return child;
}

function mockSpawnResult(code: number | null, stdout = '', stderr = ''): void {
	const child = mockSpawnChild();

	setImmediate(() => {
		if (stdout) child.stdout.emit('data', Buffer.from(stdout));
		if (stderr) child.stderr.emit('data', Buffer.from(stderr));
		child.emit('close', code);
	});
}

describe('paseo service', () => {
	const originalEnv = process.env.PASEO_CLI_PATH;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PASEO_CLI_PATH;
		vi.mocked(os.platform).mockReturnValue('darwin');
		vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any);
		vi.mocked(fs.accessSync).mockReturnValue(undefined);
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PASEO_CLI_PATH;
		} else {
			process.env.PASEO_CLI_PATH = originalEnv;
		}
	});

	it('prefers an explicit CLI path', () => {
		expect(resolvePaseoCliPath('/tmp/paseo')).toBe('/tmp/paseo');
	});

	it('uses PASEO_CLI_PATH before bundled defaults', () => {
		process.env.PASEO_CLI_PATH = '/env/paseo';
		expect(resolvePaseoCliPath()).toBe('/env/paseo');
	});

	it('uses the macOS bundled Paseo CLI when executable', () => {
		expect(resolvePaseoCliPath()).toBe('/Applications/Paseo.app/Contents/Resources/bin/paseo');
	});

	it('falls back to PATH command when bundled CLI is unavailable', () => {
		vi.mocked(fs.statSync).mockImplementation(() => {
			throw new Error('missing');
		});
		expect(resolvePaseoCliPath()).toBe('paseo');
	});

	it('runs Paseo commands and returns output', async () => {
		mockSpawnResult(0, 'ok\n', 'warn\n');

		const result = await runPaseoCommand(['schedule', 'ls'], { cliPath: '/bin/paseo' });

		expect(spawn).toHaveBeenCalledWith('/bin/paseo', ['schedule', 'ls'], {
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		expect(result).toEqual({ stdout: 'ok\n', stderr: 'warn\n' });
	});

	it('rejects failed Paseo commands with stderr and exit code', async () => {
		mockSpawnResult(2, '', 'bad option\n');

		await expect(runPaseoCommand(['bad'], { cliPath: '/bin/paseo' })).rejects.toThrow('bad option');
	});

	it('rejects failed Paseo commands that close without an exit code', async () => {
		mockSpawnResult(null);

		await expect(runPaseoCommand(['bad'], { cliPath: '/bin/paseo' })).rejects.toThrow(
			'Paseo exited without an exit code'
		);
	});

	it('rejects when the Paseo process fails to spawn', async () => {
		const child = mockSpawnChild();

		setImmediate(() => {
			child.emit('error', new Error('ENOENT'));
		});

		await expect(
			runPaseoCommand(['schedule', 'ls'], { cliPath: '/missing/paseo' })
		).rejects.toThrow('Failed to run Paseo CLI (/missing/paseo): ENOENT');
	});

	it('builds schedule create arguments', async () => {
		mockSpawnResult(0, 'created\n');

		await createPaseoSchedule('do work', {
			cliPath: '/bin/paseo',
			every: '2m',
			name: 'demo',
			provider: 'codex',
			cwd: '/repo',
			maxRuns: '2',
			expiresIn: '10m',
			json: true,
		});

		expect(spawn).toHaveBeenCalledWith(
			'/bin/paseo',
			[
				'schedule',
				'create',
				'--every',
				'2m',
				'--name',
				'demo',
				'--provider',
				'codex',
				'--cwd',
				'/repo',
				'--max-runs',
				'2',
				'--expires-in',
				'10m',
				'--json',
				'do work',
			],
			expect.any(Object)
		);
	});

	it('builds schedule create arguments with explicit immediate run control', async () => {
		mockSpawnResult(0, 'created\n');

		await createPaseoSchedule('do work now', {
			cliPath: '/bin/paseo',
			every: '2m',
			runNow: true,
		});

		expect(spawn).toHaveBeenLastCalledWith(
			'/bin/paseo',
			['schedule', 'create', '--every', '2m', '--run-now', 'do work now'],
			expect.any(Object)
		);

		mockSpawnResult(0, 'created\n');

		await createPaseoSchedule('do work later', {
			cliPath: '/bin/paseo',
			every: '2m',
			runNow: false,
		});

		expect(spawn).toHaveBeenLastCalledWith(
			'/bin/paseo',
			['schedule', 'create', '--every', '2m', '--no-run-now', 'do work later'],
			expect.any(Object)
		);
	});

	it('builds schedule list and logs arguments', async () => {
		mockSpawnResult(0, '');
		await listPaseoSchedules({ cliPath: '/bin/paseo', host: '127.0.0.1:6767' });

		expect(spawn).toHaveBeenLastCalledWith(
			'/bin/paseo',
			['schedule', 'ls', '--host', '127.0.0.1:6767'],
			expect.any(Object)
		);

		mockSpawnResult(0, '');
		await getPaseoScheduleLogs('abc123', { cliPath: '/bin/paseo', json: true });

		expect(spawn).toHaveBeenLastCalledWith(
			'/bin/paseo',
			['schedule', 'logs', '--json', 'abc123'],
			expect.any(Object)
		);
	});
});
