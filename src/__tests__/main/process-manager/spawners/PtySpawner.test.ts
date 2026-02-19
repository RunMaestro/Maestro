import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mockPtySpawn = vi.fn();
const mockStripControlSequences = vi.fn();

let mockPtyProcess: {
	pid: number;
	onData: ReturnType<typeof vi.fn>;
	onExit: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
};

let onDataHandler: ((data: string) => void) | undefined;

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

vi.mock('../../../../main/utils/terminalFilter', () => ({
	stripControlSequences: (...args: unknown[]) => mockStripControlSequences(...args),
}));

vi.mock('../../../../main/process-manager/utils/envBuilder', () => ({
	buildPtyTerminalEnv: vi.fn(() => ({ TERM: 'xterm-256color' })),
	buildChildProcessEnv: vi.fn(() => ({ TERM: 'xterm-256color' })),
}));

import { PtySpawner } from '../../../../main/process-manager/spawners/PtySpawner';
import type { ManagedProcess, ProcessConfig } from '../../../../main/process-manager/types';
import { logger } from '../../../../main/utils/logger';

function createMockPtyProcess() {
	onDataHandler = undefined;

	return {
		pid: 4242,
		onData: vi.fn((handler: (data: string) => void) => {
			onDataHandler = handler;
		}),
		onExit: vi.fn(),
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(),
	};
}

function createBaseConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'test-session',
		toolType: 'terminal',
		cwd: '/tmp',
		command: 'zsh',
		args: [],
		...overrides,
	};
}

function createTestContext() {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = {
		emitDataBuffered: vi.fn(),
		flushDataBuffer: vi.fn(),
	};

	const spawner = new PtySpawner(processes, emitter, bufferManager as any);

	return { processes, emitter, bufferManager, spawner };
}

describe('PtySpawner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPtySpawn.mockImplementation(() => {
			mockPtyProcess = createMockPtyProcess();
			return mockPtyProcess;
		});
		mockStripControlSequences.mockImplementation((data: string) => `filtered:${data}`);
	});

	it('emits raw terminal PTY data without filtering', () => {
		const { emitter, bufferManager, spawner } = createTestContext();
		const emitted: Array<{ sessionId: string; data: string }> = [];

		emitter.on('data', (sessionId: string, data: string) => {
			emitted.push({ sessionId, data });
		});

		spawner.spawn(
			createBaseConfig({
				sessionId: 'abc123-terminal-def456',
				toolType: 'terminal',
			})
		);

		expect(onDataHandler).toBeDefined();
		onDataHandler?.('\u001b[32mhello\u001b[0m\r\n');

		expect(mockStripControlSequences).not.toHaveBeenCalled();
		expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		expect(emitted).toEqual([
			{
				sessionId: 'abc123-terminal-def456',
				data: '\u001b[32mhello\u001b[0m\r\n',
			},
		]);
	});

	it('continues filtering and buffered emission for non-terminal PTY sessions', () => {
		const { emitter, bufferManager, spawner } = createTestContext();
		const emitted: Array<{ sessionId: string; data: string }> = [];

		emitter.on('data', (sessionId: string, data: string) => {
			emitted.push({ sessionId, data });
		});

		spawner.spawn(
			createBaseConfig({
				sessionId: 'agent-session',
				toolType: 'claude-code',
				command: 'claude',
				args: ['--print'],
			})
		);

		expect(onDataHandler).toBeDefined();
		onDataHandler?.('agent output');

		expect(mockStripControlSequences).toHaveBeenCalledWith('agent output', undefined, false);
		expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(
			'agent-session',
			'filtered:agent output'
		);
		expect(emitted).toEqual([]);
	});

	it('normalizes invalid PTY dimensions before spawning', () => {
		const { spawner } = createTestContext();

		spawner.spawn(
			createBaseConfig({
				shell: 'zsh',
				cols: Number.NaN,
				rows: -10,
			})
		);

		expect(mockPtySpawn).toHaveBeenCalledWith(
			'zsh',
			['-l', '-i'],
			expect.objectContaining({ cols: 100, rows: 30 })
		);
	});

	it('uses explicit terminal command args without appending login flags', () => {
		const { spawner } = createTestContext();

		spawner.spawn(
			createBaseConfig({
				command: 'ssh',
				args: ['-tt', 'user@host', "zsh '-l' '-i'"],
			})
		);

		expect(mockPtySpawn).toHaveBeenCalledWith(
			'ssh',
			['-tt', 'user@host', "zsh '-l' '-i'"],
			expect.any(Object)
		);
	});

	it('logs only terminal data metadata in PTY onData events', () => {
		const { spawner } = createTestContext();

		spawner.spawn(createBaseConfig({ sessionId: 'metadata-session' }));
		onDataHandler?.('terminal output');

		expect(logger.debug).toHaveBeenCalledWith('[ProcessManager] PTY onData', 'ProcessManager', {
			sessionId: 'metadata-session',
			pid: 4242,
			dataLength: 'terminal output'.length,
		});
	});
});
