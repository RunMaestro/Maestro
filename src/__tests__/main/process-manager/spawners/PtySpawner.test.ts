import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const mockPtySpawn = vi.fn();

vi.mock('node-pty', () => ({
	spawn: (...args: unknown[]) => mockPtySpawn(...args),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/process-manager/utils/envBuilder', () => ({
	buildPtyTerminalEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
	buildChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => true),
}));

import { PtySpawner } from '../../../../main/process-manager/spawners/PtySpawner';

function createMockPtyProcess() {
	return {
		pid: 12345,
		onData: vi.fn(),
		onExit: vi.fn(),
		write: vi.fn(),
		resize: vi.fn(),
	};
}

describe('PtySpawner', () => {
	const originalComSpec = process.env.ComSpec;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
		mockPtySpawn.mockReturnValue(createMockPtyProcess());
	});

	afterEach(() => {
		if (originalComSpec === undefined) {
			delete process.env.ComSpec;
		} else {
			process.env.ComSpec = originalComSpec;
		}
	});

	it('wraps Windows .cmd agents in cmd.exe for PTY launches', () => {
		const processes = new Map();
		const emitter = new EventEmitter();
		const bufferManager = {
			emitDataBuffered: vi.fn(),
			flushDataBuffer: vi.fn(),
		};
		const spawner = new PtySpawner(processes as any, emitter, bufferManager as any);

		spawner.spawn({
			sessionId: 'copilot-session',
			toolType: 'copilot',
			cwd: 'C:\\repo',
			command: 'C:\\Users\\nolan\\AppData\\Roaming\\npm\\copilot.cmd',
			args: ['--resume', 'session-123'],
			requiresPty: true,
		});

		expect(mockPtySpawn).toHaveBeenCalledWith(
			'C:\\Windows\\System32\\cmd.exe',
			[
				'/d',
				'/s',
				'/c',
				expect.stringContaining(
					'C:\\Users\\nolan\\AppData\\Roaming\\npm\\copilot.cmd --resume session-123'
				),
			],
			expect.objectContaining({
				cwd: 'C:\\repo',
			})
		);
	});
});
