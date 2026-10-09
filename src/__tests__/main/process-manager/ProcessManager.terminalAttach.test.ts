import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnPty } = vi.hoisted(() => ({ spawnPty: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: spawnPty }));
vi.mock('../../../shared/platformDetection', () => ({ isWindows: () => true }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-terminal-test.sock',
}));
import { ProcessManager } from '../../../main/process-manager';

class TerminalPty {
	pid = 0;
	write = vi.fn();
	resize = vi.fn();
	kill = vi.fn();
	private readonly exits: Array<(event: { exitCode: number; signal?: number }) => void> = [];
	onData = vi.fn();
	onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
		this.exits.push(callback);
		return { dispose() {} };
	}
	exit() {
		for (const listener of this.exits) listener({ exitCode: 0 });
	}
}
let manager: ProcessManager;
let pty: TerminalPty;
const id = 'host-session-terminal-shared-tab';
const terminalConfig = () => ({ sessionId: id, cwd: os.tmpdir(), shell: 'powershell' });
beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	pty = new TerminalPty();
	spawnPty.mockReturnValue(pty);
	manager = new ProcessManager();
});
afterEach(() => {
	manager.killAll({ shutdown: true });
	vi.useRealTimers();
});

describe('canonical terminal creation attaches to the host registry', () => {
	it('does not publish a running capture for a failed host process start', () => {
		const capture = vi.fn();
		manager.on('spawn', capture);
		spawnPty.mockImplementationOnce(() => {
			throw new Error('spawn ENOENT');
		});
		expect(manager.spawnTerminalTab(terminalConfig()).success).toBe(false);
		expect(capture).not.toHaveBeenCalled();
		expect(manager.get(id)).toBeUndefined();
	});
	it('publishes one running capture for a new zero-PID shell, not repeated attachments', () => {
		const capture = vi.fn();
		manager.on('spawn', capture);
		expect(manager.spawnTerminalTab(terminalConfig()).success).toBe(true);
		expect(manager.spawnTerminalTab(terminalConfig()).attached).toBe(true);
		expect(capture).toHaveBeenCalledTimes(1);
	});
	it('keeps one zero-PID ConPTY through repeated client initialization and delivers typed commands to it', () => {
		const first = manager.spawnTerminalTab(terminalConfig());
		expect(first).toEqual({ success: true, pid: 0 });
		const original = manager.get(id);
		for (let client = 0; client < 100; client++) {
			expect(manager.spawnTerminalTab(terminalConfig())).toEqual({
				success: true,
				pid: 0,
				attached: true,
			});
		}
		expect(manager.get(id)).toBe(original);
		expect(spawnPty).toHaveBeenCalledTimes(1);
		expect(pty.kill).not.toHaveBeenCalled();
		expect(manager.write(id, 'Write-Output shared-terminal\r')).toBe(true);
		expect(pty.write).toHaveBeenCalledWith('Write-Output shared-terminal\r');
	});
	it('reuses the same host-owned SSH terminal rather than restarting its interactive connection', () => {
		const config = {
			sessionId: id,
			toolType: 'terminal',
			command: 'ssh',
			args: ['-t', 'host'],
			cwd: os.tmpdir(),
			reuseTerminal: true,
		};
		manager.spawn(config);
		expect(manager.spawn(config).attached).toBe(true);
		expect(spawnPty).toHaveBeenCalledTimes(1);
		expect(pty.kill).not.toHaveBeenCalled();
	});
	it('still creates a fresh shell after explicit kill and ignores the predecessor exit', () => {
		manager.spawnTerminalTab(terminalConfig());
		manager.kill(id);
		const next = new TerminalPty();
		spawnPty.mockReturnValue(next);
		expect(manager.spawnTerminalTab(terminalConfig()).attached).toBeUndefined();
		expect(spawnPty).toHaveBeenCalledTimes(2);
		pty.exit();
		expect(manager.get(id)?.ptyProcess).toBe(next);
		expect(manager.write(id, 'echo restarted\r')).toBe(true);
		expect(next.write).toHaveBeenCalledWith('echo restarted\r');
	});
	it('creates a shell again after the prior handle has genuinely exited', () => {
		manager.spawnTerminalTab(terminalConfig());
		pty.exit();
		expect(manager.get(id)).toBeUndefined();
		const next = new TerminalPty();
		spawnPty.mockReturnValue(next);
		expect(manager.spawnTerminalTab(terminalConfig()).attached).toBeUndefined();
		expect(manager.get(id)?.ptyProcess).toBe(next);
	});
});
