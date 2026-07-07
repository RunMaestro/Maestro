/**
 * Tests for cwd tilde expansion in ProcessManager.spawn() (issue #1173).
 *
 * node-pty / child_process pass `cwd` straight to the OS, which does not expand
 * `~`. A session whose cwd is persisted as `~/project` (or bare `~`) would make
 * the child's chdir() fail and the shell would start in an unreadable directory,
 * surfacing on macOS as Homebrew's "current working directory must be readable"
 * error on every shell startup. spawn() must expand the leading `~` first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPtySpawn = vi.fn();
const mockPtyProcess = {
	pid: 4242,
	onData: vi.fn(),
	onExit: vi.fn(),
	write: vi.fn(),
	resize: vi.fn(),
	kill: vi.fn(),
};

vi.mock('node-pty', () => ({
	spawn: (...args: unknown[]) => {
		mockPtySpawn(...args);
		return mockPtyProcess;
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { ProcessManager } from '../../../main/process-manager/ProcessManager';
import type { ProcessConfig } from '../../../main/process-manager/types';

// ── Helpers ────────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'sess-1',
		toolType: 'terminal',
		cwd: '/tmp/project',
		command: 'zsh',
		args: [],
		shell: 'zsh',
		...overrides,
	};
}

/** The cwd option passed to the most recent node-pty spawn call. */
function lastSpawnCwd(): string {
	const call = mockPtySpawn.mock.calls.at(-1);
	return (call?.[2] as { cwd: string }).cwd;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProcessManager.spawn - cwd tilde expansion (issue #1173)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPtyProcess.onData.mockImplementation(() => {});
		mockPtyProcess.onExit.mockImplementation(() => {});
	});

	it('expands a leading ~/ in cwd to the home directory before spawning', () => {
		const pm = new ProcessManager();
		pm.spawn(baseConfig({ cwd: '~/Documents/VibeworkV2', sessionId: 's-tilde-path' }));

		expect(lastSpawnCwd()).toBe(`${os.homedir()}/Documents/VibeworkV2`);
	});

	it('expands a bare ~ to the home directory', () => {
		const pm = new ProcessManager();
		pm.spawn(baseConfig({ cwd: '~', sessionId: 's-bare-tilde' }));

		expect(lastSpawnCwd()).toBe(os.homedir());
	});

	it('leaves an already-absolute cwd unchanged', () => {
		const pm = new ProcessManager();
		pm.spawn(baseConfig({ cwd: '/Users/someone/abs/path', sessionId: 's-abs' }));

		expect(lastSpawnCwd()).toBe('/Users/someone/abs/path');
	});

	it('records the expanded cwd on the tracked managed process', () => {
		const pm = new ProcessManager();
		pm.spawn(baseConfig({ cwd: '~/proj', sessionId: 's-tracked' }));

		expect(pm.get('s-tracked')?.cwd).toBe(`${os.homedir()}/proj`);
	});
});
