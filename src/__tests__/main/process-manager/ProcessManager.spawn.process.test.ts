/**
 * Desktop chat's process pipeline against a REAL process.
 *
 * `turn-recordings.test.ts` feeds the recordings straight to the handlers.
 * This file starts the fake agent through `ProcessManager.spawn()`, the way a
 * turn is really started, and listens where the renderer listens. What it
 * pins is the contract the renderer depends on: which events arrive, in which
 * order, and that a turn settles exactly once.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { ProcessManager } from '../../../main/process-manager';
import type { ProcessConfig } from '../../../main/process-manager/types';
import { CAPTURED_RECORDINGS, CAPTURED_OPENCODE_SESSION_ID } from './recordings/captured';
import {
	FAKE_AGENT_PATH,
	createScratchDir,
	fakeTurnFromRecording,
	writeFakeTurn,
	type FakeTurn,
} from '../../shared/maestro-lib/run/fakeAgent';

const SESSION_ID = 'agent-1-ai-tab-1';
const posixIt = it.skipIf(process.platform === 'win32');

let scratch: { dir: string; cleanup: () => void };
const managers: ProcessManager[] = [];

beforeAll(() => {
	scratch = createScratchDir('maestro-desktop-spawn');
});

afterAll(() => {
	scratch.cleanup();
});

afterEach(() => {
	for (const manager of managers.splice(0)) manager.killAll({ shutdown: true });
});

interface Heard {
	type: string;
	args: unknown[];
}

/** Everything the renderer would be told about the session, in order. */
function listen(manager: ProcessManager): Heard[] {
	const heard: Heard[] = [];
	for (const type of [
		'raw-stdout',
		'data',
		'session-id',
		'usage',
		'thinking-chunk',
		'tool-execution',
		'agent-error',
		'query-complete',
		'exit',
	]) {
		manager.on(type, (...args: unknown[]) => {
			if (args[0] === SESSION_ID) heard.push({ type, args: args.slice(1) });
		});
	}
	return heard;
}

function spawnFakeAgent(
	manager: ProcessManager,
	turn: FakeTurn,
	options: { hold?: boolean; command?: string; prompt?: string } = {}
) {
	const env: Record<string, string> = { FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, turn) };
	if (options.hold) env.FAKE_AGENT_HOLD = '1';
	const config: ProcessConfig = {
		sessionId: SESSION_ID,
		toolType: 'opencode',
		cwd: scratch.dir,
		command: options.command ?? process.execPath,
		args: options.command ? [] : [FAKE_AGENT_PATH],
		prompt: options.prompt ?? 'What is the capital of France?',
		customEnvVars: env,
	};
	return manager.spawn(config);
}

function untilExit(heard: Heard[], timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const poll = (): void => {
			if (heard.some((entry) => entry.type === 'exit')) return resolve();
			if (Date.now() > deadline) return reject(new Error('no exit event'));
			setTimeout(poll, 20);
		};
		poll();
	});
}

const types = (heard: Heard[]): string[] => heard.map((entry) => entry.type);

describe('ProcessManager.spawn against a real process', () => {
	it('streams a real OpenCode turn to the renderer and settles it as completed', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);

		const result = spawnFakeAgent(
			manager,
			fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
		);
		expect(result.success).toBe(true);
		expect(result.pid).toBeGreaterThan(0);
		expect(manager.get(SESSION_ID)?.childProcess?.pid).toBe(result.pid);

		await untilExit(heard);

		const order = types(heard);
		// The renderer hears the raw stream before anything is made of it.
		expect(order[0]).toBe('raw-stdout');
		expect(order.indexOf('session-id')).toBeLessThan(order.indexOf('exit'));
		expect(order.indexOf('data')).toBeLessThan(order.indexOf('exit'));
		expect(order.filter((type) => type === 'exit')).toHaveLength(1);

		expect(heard.find((entry) => entry.type === 'session-id')?.args[0]).toBe(
			CAPTURED_OPENCODE_SESSION_ID
		);
		const dataText = heard
			.filter((entry) => entry.type === 'data')
			.map((entry) => String(entry.args[0]))
			.join('');
		expect(dataText).toContain('The capital of France is Paris.');

		const exit = heard.find((entry) => entry.type === 'exit')!;
		expect(exit.args[0]).toBe(0);
		expect(exit.args[2]).toMatchObject({ outcome: 'completed' });
		expect(manager.get(SESSION_ID)).toBeUndefined();
	});

	it('reports a provider that could not be started exactly once', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);

		const result = spawnFakeAgent(
			manager,
			{ chunks: [], close: { code: 0, signal: null } },
			{ command: path.join(scratch.dir, 'no-such-provider') }
		);
		expect(result.success).toBe(true);

		await untilExit(heard);
		// Node follows ENOENT's `error` with a `close`; the turn still settles once.
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(types(heard).filter((type) => type === 'exit')).toHaveLength(1);
		expect(types(heard).filter((type) => type === 'agent-error')).toHaveLength(1);
		const error = heard.find((entry) => entry.type === 'agent-error')!;
		expect(error.args[0]).toMatchObject({ type: 'agent_crashed' });
		expect(manager.get(SESSION_ID)).toBeUndefined();
	});

	it('leaves stdin open for an interactive process and closes it for a batch turn', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const stdinOut = path.join(scratch.dir, 'desktop-stdin.txt');
		const recording = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);

		// Batch: a prompt, so stdin is closed at once and the agent can finish.
		const heard = listen(manager);
		manager.spawn({
			sessionId: SESSION_ID,
			toolType: 'opencode',
			cwd: scratch.dir,
			command: process.execPath,
			args: [FAKE_AGENT_PATH],
			prompt: 'batch',
			customEnvVars: {
				FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, recording),
				FAKE_AGENT_STDIN_OUT: stdinOut,
			},
		});
		await untilExit(heard);
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('');

		// Interactive: no prompt, so stdin stays open for ProcessManager.write().
		const interactive = new ProcessManager();
		managers.push(interactive);
		interactive.spawn({
			sessionId: SESSION_ID,
			toolType: 'opencode',
			cwd: scratch.dir,
			command: process.execPath,
			args: [FAKE_AGENT_PATH],
			customEnvVars: { FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, recording) },
		});
		const child = interactive.get(SESSION_ID)!.childProcess!;
		expect(child.stdin?.writableEnded).toBe(false);
		expect(interactive.write(SESSION_ID, 'hello\n')).toBe(true);
	});

	it('writes an SSH script to stdin and closes it, though the turn has no local prompt', async () => {
		// A remote turn carries its prompt inside the script, so `prompt` is
		// empty here. The remote shell and the agent both wait for the end of
		// input: the fake agent reads stdin to its end before it replays, so it
		// only finishes if stdin was closed behind the script.
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);
		const stdinOut = path.join(scratch.dir, 'desktop-ssh-stdin.txt');
		const script = '#!/bin/bash\ncd /project || exit 1\nexec opencode run --format json\n';

		manager.spawn({
			sessionId: SESSION_ID,
			toolType: 'opencode',
			cwd: scratch.dir,
			command: process.execPath,
			args: [FAKE_AGENT_PATH],
			sshStdinScript: script,
			customEnvVars: {
				FAKE_AGENT_RECORDING: writeFakeTurn(
					scratch.dir,
					fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
				),
				FAKE_AGENT_STDIN_OUT: stdinOut,
			},
		});
		await untilExit(heard);

		expect(fs.readFileSync(stdinOut, 'utf8')).toBe(script);
		expect(heard.find((entry) => entry.type === 'exit')?.args[0]).toBe(0);
	});

	posixIt('Stop interrupts a running turn and settles it as interrupted', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);

		spawnFakeAgent(
			manager,
			fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']),
			{ hold: true }
		);
		await new Promise<void>((resolve) => {
			const poll = (): void => {
				if (heard.some((entry) => entry.type === 'data')) resolve();
				else setTimeout(poll, 20);
			};
			poll();
		});

		expect(manager.interrupt(SESSION_ID)).toBe(true);
		await untilExit(heard);

		const exit = heard.find((entry) => entry.type === 'exit')!;
		expect(exit.args[2]).toMatchObject({ outcome: 'interrupted' });
		expect(types(heard)).not.toContain('agent-error');
	});
});
