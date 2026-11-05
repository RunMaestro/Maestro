import { EventEmitter, once } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnPty } = vi.hoisted(() => ({ spawnPty: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: spawnPty }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/unused-retirement-test.sock',
}));
// Deleting a registry entry must not be mistaken for OS termination.
vi.mock('../../../shared/maestro-lib/control/termination', async (original) => ({
	...(await original<typeof import('../../../shared/maestro-lib/control/termination')>()),
	stopProcess: vi.fn(),
}));

import { ProcessManager } from '../../../main/process-manager';
import { worktreeRetirement } from '../../../main/git/worktreeRetirement';
import type { ProcessConfig } from '../../../main/process-manager/types';

class TerminalPty {
	pid = 12345;
	write = vi.fn();
	resize = vi.fn();
	kill = vi.fn();
	onData = vi.fn();
	private readonly events = new EventEmitter();
	onExit(callback: (event: { exitCode: number }) => void) {
		this.events.on('exit', callback);
		return { dispose: () => this.events.off('exit', callback) };
	}
	exit() {
		this.events.emit('exit', { exitCode: 0 });
	}
}

const checkout = { path: process.cwd(), head: 'spawn-retirement', generation: 1 };
const config = (): ProcessConfig => ({
	sessionId: 'retirement-terminal',
	toolType: 'terminal',
	cwd: checkout.path,
	command: 'unused-shell',
	args: [],
});
const terminals: TerminalPty[] = [];
afterEach(() => {
	for (const terminal of terminals.splice(0)) terminal.exit();
	vi.clearAllMocks();
});
function terminal() {
	const handle = new TerminalPty();
	terminals.push(handle);
	spawnPty.mockReturnValueOnce(handle);
	return handle;
}
function expectBlocked() {
	const reservation = worktreeRetirement.prepare(checkout);
	if (reservation.ok) worktreeRetirement.abort(reservation.token);
	expect(reservation.ok).toBe(false);
}
function expectAvailable() {
	const reservation = worktreeRetirement.prepare(checkout);
	expect(reservation.ok).toBe(true);
	if (reservation.ok) worktreeRetirement.abort(reservation.token);
}

describe('process retirement admission through concrete handle completion', () => {
	it('blocks a reserved checkout before spawn, terminal reuse, or CLI fallback', () => {
		worktreeRetirement.register(checkout);
		const reservation = worktreeRetirement.prepare(checkout);
		if (!reservation.ok) throw new Error(reservation.reason);
		try {
			const manager = new ProcessManager();
			expect(() => manager.spawn(config())).toThrow('preparing');
			expect(() => manager.spawn({ ...config(), reuseTerminal: true })).toThrow('preparing');
			expect(() => manager['fallbackToCli'](config())).toThrow('preparing');
			expect(spawnPty).not.toHaveBeenCalled();
		} finally {
			worktreeRetirement.abort(reservation.token);
		}
	});

	it('holds a killed and superseded PTY even after its successor exits', () => {
		worktreeRetirement.register(checkout);
		const manager = new ProcessManager();
		const first = terminal();
		expect(manager.spawn(config()).success).toBe(true);
		expect(manager.spawn({ ...config(), reuseTerminal: true }).attached).toBe(true);
		expectBlocked();
		manager.kill(config().sessionId);
		expect(manager.get(config().sessionId)).toBeUndefined();
		expectBlocked();
		const second = terminal();
		manager.spawn(config());
		second.exit();
		expectBlocked();
		first.exit();
		expectAvailable();
	});

	it('admits synchronously before creating a handle and releases failed starts', () => {
		worktreeRetirement.register(checkout);
		spawnPty.mockImplementationOnce(() => {
			expectBlocked();
			throw new Error('spawn failed');
		});
		expect(new ProcessManager().spawn(config()).success).toBe(false);
		expectAvailable();
	});

	it('retains a created PTY when later spawn setup fails', () => {
		worktreeRetirement.register(checkout);
		const handle = terminal();
		handle.onData.mockImplementationOnce(() => {
			throw new Error('post-spawn setup failed');
		});
		expect(new ProcessManager().spawn(config()).success).toBe(false);
		expectBlocked();
		handle.exit();
		expectAvailable();
	});

	it.each(['spawn', 'fallbackToCli'] as const)(
		'holds a real CLI child from %s after kill removes its registry entry, until close',
		async (entry) => {
			worktreeRetirement.register(checkout);
			const manager = new ProcessManager();
			expect(
				manager[entry]({
					...config(),
					toolType: 'test-agent',
					command: process.execPath,
					args: ['-e', 'setInterval(() => {}, 1000)'],
				}).success
			).toBe(true);
			const child = manager.get(config().sessionId)!.childProcess!;
			// exit precedes close and is insufficient while streams still drain.
			child.once('exit', expectBlocked);
			try {
				manager.kill(config().sessionId);
				expect(manager.get(config().sessionId)).toBeUndefined();
				expectBlocked();
			} finally {
				const closed = once(child, 'close');
				child.kill();
				await closed;
			}
			expectAvailable();
		}
	);
});
