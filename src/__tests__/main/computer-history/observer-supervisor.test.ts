import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as path from 'path';
import {
	ObserverSupervisor,
	observerBinaryCandidates,
} from '../../../main/computer-history/observer-supervisor';

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = new PassThrough();
	pid = 4321;
	exitCode: number | null = null;
	signalCode: string | null = null;
	written: string[] = [];
	constructor() {
		super();
		this.stdin.on('data', (d) => this.written.push(String(d)));
	}
	kill = vi.fn((signal?: string) => {
		this.signalCode = signal ?? 'SIGTERM';
		this.emit('exit', null, this.signalCode);
		return true;
	});
	exit(code: number) {
		this.exitCode = code;
		this.emit('exit', code, null);
	}
}

let children: FakeChild[];
let spawnChild: ReturnType<typeof vi.fn>;

function makeSupervisor(
	overrides: Partial<ConstructorParameters<typeof ObserverSupervisor>[0]> = {}
) {
	const messages: unknown[] = [];
	const supervisor = new ObserverSupervisor({
		resolveBinary: () => '/bin/maestro-observer',
		onMessage: (m) => messages.push(m),
		spawnChild: spawnChild as never,
		...overrides,
	});
	return { supervisor, messages };
}

beforeEach(() => {
	vi.useFakeTimers();
	children = [];
	spawnChild = vi.fn(() => {
		const child = new FakeChild();
		children.push(child);
		return child;
	});
});
afterEach(() => {
	vi.useRealTimers();
});

describe('ObserverSupervisor', () => {
	it('spawns with fixed argv and parses NDJSON across chunk boundaries', () => {
		const onSpawned = vi.fn();
		const { supervisor, messages } = makeSupervisor({ onSpawned });
		supervisor.start();
		expect(spawnChild).toHaveBeenCalledWith('/bin/maestro-observer', [], expect.any(Object));
		expect(onSpawned).toHaveBeenCalledTimes(1);
		const out = children[0].stdout;
		out.write('{"kind":"helper.status","a":');
		out.write('1}\n{"kind":"app.activated"}\nnot json\n');
		expect(messages).toEqual([{ kind: 'helper.status', a: 1 }, { kind: 'app.activated' }]);
		expect(supervisor.status()).toMatchObject({ state: 'running', pid: 4321, restarts: 0 });
	});

	it('discards an over-long line up to its newline and keeps parsing', () => {
		const { supervisor, messages } = makeSupervisor({ maxLineBytes: 32 });
		supervisor.start();
		const out = children[0].stdout;
		out.write('{"kind":"x","pad":"' + 'y'.repeat(100));
		out.write('still the same line"}\n{"ok":1}\n');
		expect(messages).toEqual([{ ok: 1 }]);
	});

	it('writes commands to stdin as NDJSON', () => {
		const { supervisor } = makeSupervisor();
		supervisor.start();
		expect(supervisor.send({ cmd: 'pause' })).toBe(true);
		expect(children[0].written.join('')).toBe('{"cmd":"pause"}\n');
	});

	it('restarts with exponential backoff and gives up after the cap', () => {
		const { supervisor } = makeSupervisor();
		supervisor.start();
		children[0].exit(1);
		expect(supervisor.status().state).toBe('backing-off');
		vi.advanceTimersByTime(999);
		expect(spawnChild).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(spawnChild).toHaveBeenCalledTimes(2);
		// Second failure waits 2 s.
		children[1].exit(1);
		vi.advanceTimersByTime(1999);
		expect(spawnChild).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(1);
		expect(spawnChild).toHaveBeenCalledTimes(3);
		for (let i = 2; i < 6; i++) {
			children[i].exit(1);
			vi.advanceTimersByTime(30_000);
		}
		expect(supervisor.status().state).toBe('failed');
		expect(supervisor.status().lastError).toMatch(/exited with code 1/);
	});

	it('reports a missing binary as a state, not an exception', () => {
		const { supervisor } = makeSupervisor({ resolveBinary: () => null });
		expect(() => supervisor.start()).not.toThrow();
		expect(spawnChild).not.toHaveBeenCalled();
		expect(supervisor.status()).toMatchObject({ state: 'binary-missing', binaryPath: null });
		expect(supervisor.send({ cmd: 'status' })).toBe(false);
	});

	it('stop() sends shutdown, does not restart, and stays stopped', () => {
		const onStateChange = vi.fn();
		const { supervisor } = makeSupervisor({ onStateChange });
		supervisor.start();
		const child = children[0];
		supervisor.stop();
		expect(child.written.join('')).toContain('"cmd":"shutdown"');
		child.exit(0);
		vi.advanceTimersByTime(60_000);
		expect(spawnChild).toHaveBeenCalledTimes(1);
		expect(supervisor.status().state).toBe('stopped');
		expect(onStateChange).toHaveBeenCalled();
	});

	it('keeps a bounded stderr tail', () => {
		const { supervisor } = makeSupervisor();
		supervisor.start();
		for (let i = 0; i < 80; i++) children[0].stderr.write(`line ${i}\n`);
		const tail = supervisor.status().recentStderr;
		expect(tail).toHaveLength(50);
		expect(tail[49]).toBe('line 79');
	});
});

describe('observerBinaryCandidates', () => {
	it('lists packaged resources first, then the dev build output', () => {
		const list = observerBinaryCandidates({
			resourcesPath: '/App/Resources',
			moduleDir: '/repo/dist/main/computer-history',
			cwd: '/repo',
			platform: 'win32',
			arch: 'x64',
		});
		expect(list[0]).toBe(path.join('/App/Resources', 'native', 'maestro-observer.exe'));
		expect(list[1]).toBe(path.resolve('/repo/dist/native/win32-x64/maestro-observer.exe'));
		expect(list).toContain(path.resolve('/repo/dist/native/win32-x64/maestro-observer.exe'));
	});
});
