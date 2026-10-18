/**
 * Tests for src/main/process-manager/spawners/CodexAppServerSpawner.ts
 *
 * A fake `codex app-server` child replays the recorded fixtures in
 * `src/__tests__/fixtures/codex-app-server/`: every line the spawner writes is
 * matched against the fixture's next `send` line, and the `recv` lines that
 * follow it are written back on stdout. The real StdoutHandler / ExitHandler /
 * CodexOutputParser run downstream, so a test sees what the renderer would.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { readFileSync } from 'fs';
import { join } from 'path';

const mockSpawn = vi.fn();

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: { ...actual, spawn: (...args: unknown[]) => mockSpawn(...args) },
	};
});

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

const mockStopProcess = vi.fn(() => ({ stage: () => undefined, dispose: () => {} }));
vi.mock('../../../shared/maestro-lib/control/termination', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/control/termination')>();
	return { ...actual, stopProcess: (...args: unknown[]) => mockStopProcess(...(args as [])) };
});

const mockSignalRemoteAgent = vi.fn(() => true);
vi.mock('../../../shared/maestro-lib/control/ssh-remote-signal', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/control/ssh-remote-signal')>();
	return {
		...actual,
		signalRemoteAgent: (...args: unknown[]) => mockSignalRemoteAgent(...(args as [])),
	};
});

import {
	CodexAppServerSpawner,
	CODEX_APP_SERVER_EXIT_GRACE_MS,
} from '../../../main/process-manager/spawners/CodexAppServerSpawner';
import { DataBufferManager } from '../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../../main/process-manager/types';
import type { CodexAppServerMessage } from '../../../main/codex-app-server/protocol';
import { steerCodexAppServerTurn } from '../../../main/codex-app-server/steering';
import { STEERING_MAX_TEXT_BYTES, type SteeringResultFrame } from '../../../shared/chatSteering';

// ── Fixtures ───────────────────────────────────────────────────────────────

interface FixtureLine {
	dir: 'send' | 'recv';
	msg: CodexAppServerMessage;
}

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'codex-app-server');

function loadFixture(name: string): FixtureLine[] {
	return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as FixtureLine);
}

function recvNotifications(fixture: FixtureLine[], method: string) {
	return fixture.filter(
		({ dir, msg }) => dir === 'recv' && msg.method === method && msg.id === undefined
	);
}

/** The params of the fixture's `turn/steer` request. */
function steerParams(fixture: FixtureLine[]) {
	return fixture.find(({ dir, msg }) => dir === 'send' && msg.method === 'turn/steer')!.msg
		.params as {
		threadId: string;
		expectedTurnId: string;
		input: Array<{ type: 'text'; text: string }>;
	};
}

function finalAgentMessage(fixture: FixtureLine[]): string {
	const items = recvNotifications(fixture, 'item/completed')
		.map(({ msg }) => (msg.params as { item: { type: string; text?: string } }).item)
		.filter((item) => item.type === 'agentMessage');
	return items[items.length - 1].text as string;
}

// ── Fake app-server child ─────────────────────────────────────────────────

type ClientMessage = CodexAppServerMessage & { jsonrpc?: string };

class FakeAppServer extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin: Writable;
	/** Every line the spawner wrote, decoded. */
	written: ClientMessage[] = [];
	/** Client lines the script did not expect. */
	unexpected: ClientMessage[] = [];
	/**
	 * Non-JSON stdin lines: an SSH turn's launch script, which the remote bash
	 * reads before it execs the server. `stdinOrder` records where they fell.
	 */
	scriptLines: string[] = [];
	stdinOrder: Array<'script' | 'json'> = [];

	constructor(private onClientMessage: (msg: ClientMessage, server: FakeAppServer) => void) {
		super();
		let pending = '';
		this.stdin = new Writable({
			write: (chunk, _encoding, callback) => {
				pending += chunk.toString();
				let newline = pending.indexOf('\n');
				while (newline !== -1) {
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					if (line.trim() && !line.trim().startsWith('{')) {
						this.scriptLines.push(line);
						this.stdinOrder.push('script');
					} else if (line.trim()) {
						this.stdinOrder.push('json');
						const msg = JSON.parse(line) as ClientMessage;
						this.written.push(msg);
						this.onClientMessage(msg, this);
					}
					newline = pending.indexOf('\n');
				}
				callback();
			},
			final: (callback) => {
				callback();
				this.exit(0);
			},
		});
	}

	send(msg: CodexAppServerMessage): void {
		this.stdout.write(JSON.stringify(msg) + '\n');
	}

	exit(code: number): void {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.stdout.end();
		this.stderr.end();
		setImmediate(() => this.emit('close', code, null));
	}

	sent(method: string): ClientMessage[] {
		return this.written.filter((msg) => msg.method === method);
	}

	responseTo(id: number | string): ClientMessage | undefined {
		return this.written.find((msg) => msg.id === id && msg.method === undefined);
	}
}

/**
 * Drive a fake server from a fixture: each client line must match the next
 * `send` line (same method, or a response with the same id); the `recv` lines
 * after it are then written back.
 */
function fixtureDriver(fixture: FixtureLine[]) {
	let cursor = 0;
	const matches = (expected: CodexAppServerMessage, actual: ClientMessage) =>
		expected.method !== undefined
			? expected.method === actual.method
			: actual.method === undefined && expected.id === actual.id;

	return {
		/** Method of the `send` line the script is waiting for, if any. */
		waitingFor: () => fixture[cursor]?.msg.method,
		onClientMessage: (msg: ClientMessage, server: FakeAppServer) => {
			const next = fixture[cursor];
			if (!next || next.dir !== 'send' || !matches(next.msg, msg)) {
				server.unexpected.push(msg);
				return;
			}
			cursor++;
			while (cursor < fixture.length && fixture[cursor].dir === 'recv') {
				server.send(fixture[cursor].msg);
				cursor++;
			}
		},
	};
}

// ── Harness ────────────────────────────────────────────────────────────────

const BYPASS_ARGS = [
	'-C',
	'/tmp/codex-project',
	'exec',
	'--json',
	'--dangerously-bypass-approvals-and-sandbox',
	'--skip-git-repo-check',
];
const READ_ONLY_ARGS = [
	'-C',
	'/tmp/codex-project',
	'exec',
	'--json',
	'--sandbox',
	'read-only',
	'--skip-git-repo-check',
];

let sessionCounter = 0;

function createHarness(server: FakeAppServer | (() => FakeAppServer)) {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = new DataBufferManager(processes, emitter);
	const fallbackToCli = vi.fn(() => ({ pid: 999, success: true }));
	const spawner = new CodexAppServerSpawner(processes, emitter, bufferManager, fallbackToCli, {
		clientVersion: '1.2.3',
	});
	mockSpawn.mockImplementation(() => (typeof server === 'function' ? server() : server));

	const data: string[] = [];
	const sessionIds: string[] = [];
	const errors: unknown[] = [];
	emitter.on('data', (_sid: string, text: string) => data.push(text));
	emitter.on('session-id', (_sid: string, id: string) => sessionIds.push(id));
	emitter.on('agent-error', (_sid: string, error: unknown) => errors.push(error));

	const sessionId = `codex-agent-${++sessionCounter}-ai-tab`;
	const exited = new Promise<number>((resolve) => {
		emitter.on('exit', (sid: string, code: number) => {
			if (sid === sessionId) resolve(code);
		});
	});

	const config = (overrides: Partial<ProcessConfig> = {}): ProcessConfig => ({
		sessionId,
		toolType: 'codex',
		cwd: '/tmp/codex-project',
		command: '/usr/local/bin/codex',
		args: BYPASS_ARGS,
		prompt: 'Reply with the word OK',
		tabId: 'tab',
		...overrides,
	});

	return {
		processes,
		emitter,
		spawner,
		fallbackToCli,
		data,
		sessionIds,
		errors,
		sessionId,
		exited,
		config,
	};
}

beforeEach(() => {
	mockSpawn.mockReset();
	mockStopProcess.mockClear();
	mockSignalRemoteAgent.mockClear();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CodexAppServerSpawner', () => {
	it('runs a plain turn on app-server and exits 0 with the final answer', async () => {
		const fixture = loadFixture('plain-turn');
		const driver = fixtureDriver(fixture);
		const server = new FakeAppServer(driver.onClientMessage);
		const h = createHarness(server);

		const result = h.spawner.spawn(h.config());
		expect(result).toEqual({ pid: 4242, success: true });
		expect(h.processes.get(h.sessionId)?.codexAppServer).toBeDefined();

		expect(await h.exited).toBe(0);
		expect(h.fallbackToCli).not.toHaveBeenCalled();
		expect(server.unexpected).toEqual([]);

		// Same binary as exec, launched as the app-server subcommand, in the spawn cwd.
		const [command, args, options] = mockSpawn.mock.calls[0];
		expect(command).toBe('/usr/local/bin/codex');
		expect(args).toEqual(['app-server']);
		expect(options.cwd).toBe('/tmp/codex-project');

		const initialize = server.sent('initialize')[0];
		expect(initialize.params).toEqual({
			clientInfo: { name: 'maestro', version: '1.2.3' },
			capabilities: { experimentalApi: true },
		});
		expect(server.sent('initialized')).toHaveLength(1);
		expect(server.sent('thread/start')[0].params).toEqual({
			cwd: '/tmp/codex-project',
			approvalPolicy: 'never',
			sandbox: 'danger-full-access',
		});
		expect(server.sent('turn/start')[0].params).toEqual({
			threadId: '01a129a3-ae2d-7a03-a717-b7374d497e31',
			input: [{ type: 'text', text: 'Reply with the word OK' }],
		});

		expect(h.data.join('')).toContain(finalAgentMessage(fixture));
		expect(h.sessionIds).toEqual(['01a129a3-ae2d-7a03-a717-b7374d497e31']);
		expect(h.errors).toEqual([]);
		// The turn closed stdin and the child left on its own: no stop ladder.
		expect(mockStopProcess).not.toHaveBeenCalled();
		expect(h.processes.has(h.sessionId)).toBe(false);
	});

	it('maps model, effort and other -c overrides from the exec args', async () => {
		const server = new FakeAppServer(fixtureDriver(loadFixture('plain-turn')).onClientMessage);
		const h = createHarness(server);

		h.spawner.spawn(
			h.config({
				args: [
					...BYPASS_ARGS,
					'-m',
					'gpt-5.3-codex',
					'-c',
					'model_reasoning_effort="high"',
					'-c',
					'model_reasoning_summary=auto',
				],
			})
		);
		expect(await h.exited).toBe(0);

		expect(mockSpawn.mock.calls[0][1]).toEqual([
			'app-server',
			'-c',
			'model_reasoning_effort="high"',
			'-c',
			'model_reasoning_summary=auto',
		]);
		expect(server.sent('thread/start')[0].params).toMatchObject({ model: 'gpt-5.3-codex' });
		expect(server.sent('turn/start')[0].params).toMatchObject({ effort: 'high', summary: 'auto' });
	});

	it('resumes a thread with thread/resume when the exec args carry a resume id', async () => {
		const fixture = loadFixture('resumed-turn');
		const resumeId = (
			fixture.find(({ msg }) => msg.method === 'thread/resume')!.msg.params as {
				threadId: string;
			}
		).threadId;
		const server = new FakeAppServer(fixtureDriver(fixture).onClientMessage);
		const h = createHarness(server);

		h.spawner.spawn(h.config({ args: [...BYPASS_ARGS, 'resume', resumeId] }));
		expect(await h.exited).toBe(0);

		expect(server.sent('thread/start')).toEqual([]);
		expect(server.sent('thread/resume')[0].params).toEqual({
			cwd: '/tmp/codex-project',
			approvalPolicy: 'never',
			sandbox: 'danger-full-access',
			threadId: resumeId,
			excludeTurns: true,
		});
		// Resume sends no thread/started; the id still reaches the tab.
		expect(h.sessionIds).toEqual([resumeId]);
		expect(h.data.join('')).toContain(finalAgentMessage(fixture));
	});

	it('declines every approval request in read-only mode', async () => {
		const fixture = loadFixture('approval-request');
		const server = new FakeAppServer(fixtureDriver(fixture).onClientMessage);
		const h = createHarness(server);

		h.spawner.spawn(h.config({ args: READ_ONLY_ARGS }));
		expect(await h.exited).toBe(0);

		expect(server.sent('thread/start')[0].params).toEqual({
			cwd: '/tmp/codex-project',
			approvalPolicy: 'never',
			sandbox: 'read-only',
		});
		const requestId = fixture.find(
			({ dir, msg }) => dir === 'recv' && msg.method === 'item/commandExecution/requestApproval'
		)!.msg.id as number;
		expect(server.responseTo(requestId)).toEqual({
			jsonrpc: '2.0',
			id: requestId,
			result: { decision: 'decline' },
		});
		expect(server.unexpected).toEqual([]);
	});

	it('answers every server request, granting approvals with full access and erroring on unknown methods', async () => {
		const threadId = 'thread-1';
		const turnId = 'turn-1';
		const server = new FakeAppServer((msg, s) => {
			if (msg.method === 'initialize') s.send({ id: msg.id, result: {} });
			if (msg.method === 'thread/start')
				s.send({ id: msg.id, result: { thread: { id: threadId } } });
			if (msg.method === 'turn/start') {
				s.send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
				s.send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
				s.send({
					id: 0,
					method: 'item/commandExecution/requestApproval',
					params: { threadId, turnId, itemId: 'call_1' },
				});
				s.send({ id: 1, method: 'attestation/generate', params: {} });
			}
			if (msg.method === undefined && msg.id === 1) {
				s.send({
					method: 'item/completed',
					params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg_1', text: 'done' } },
				});
				s.send({
					method: 'turn/completed',
					params: { threadId, turn: { id: turnId, status: 'completed' } },
				});
			}
		});
		const h = createHarness(server);

		h.spawner.spawn(h.config());
		expect(await h.exited).toBe(0);

		expect(server.responseTo(0)).toMatchObject({ result: { decision: 'accept' } });
		expect(server.responseTo(1)).toMatchObject({ error: { code: -32601 } });
		expect(h.data.join('')).toContain('done');
	});

	it('sends turn/interrupt on Stop and ends the turn cleanly', async () => {
		const fixture = loadFixture('interrupted-turn');
		const driver = fixtureDriver(fixture);
		const server = new FakeAppServer(driver.onClientMessage);
		const h = createHarness(server);

		h.spawner.spawn(h.config());
		await vi.waitFor(() => {
			expect(driver.waitingFor()).toBe('turn/interrupt');
			expect(h.processes.get(h.sessionId)?.codexAppServer?.activeTurnId).toBeTruthy();
		});

		const managed = h.processes.get(h.sessionId)!;
		// What ProcessManager.interrupt() does for a controller-backed process.
		managed.interrupted = true;
		managed.sdkController!.interrupt();

		expect(await h.exited).toBe(0);
		const expected = fixture.find(({ msg }) => msg.method === 'turn/interrupt')!.msg.params;
		expect(server.sent('turn/interrupt')[0].params).toEqual(expected);
		expect(server.unexpected).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it('kill() runs the stop ladder on the child', async () => {
		const driver = fixtureDriver(loadFixture('interrupted-turn'));
		const server = new FakeAppServer(driver.onClientMessage);
		const h = createHarness(server);

		h.spawner.spawn(h.config());
		await vi.waitFor(() => expect(driver.waitingFor()).toBe('turn/interrupt'));

		h.processes.get(h.sessionId)!.sdkController!.kill({ sync: true });
		expect(mockStopProcess).toHaveBeenCalledWith(
			{ child: server },
			expect.objectContaining({ from: 'terminate', upTo: 'kill', blocking: true })
		);
	});

	it('falls back to exec when the handshake fails', async () => {
		const server = new FakeAppServer((msg, s) => {
			if (msg.method === 'initialize') {
				s.send({ id: msg.id, error: { code: -32603, message: 'boom' } });
			}
		});
		const h = createHarness(server);
		const config = h.config();

		h.spawner.spawn(config);
		await vi.waitFor(() => expect(h.fallbackToCli).toHaveBeenCalledWith(config));

		expect(server.sent('turn/start')).toEqual([]);
		expect(h.processes.has(h.sessionId)).toBe(false);
		expect(mockStopProcess).toHaveBeenCalledWith(
			{ child: server },
			expect.objectContaining({ from: 'terminate' })
		);
		expect(h.errors).toEqual([]);
		// The abandoned child's exit reports nothing: exec owns the turn now.
		const exitSpy = vi.fn();
		h.emitter.on('exit', exitSpy);
		server.exit(1);
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('falls back to exec when the binary cannot be started', async () => {
		const server = new FakeAppServer(() => {});
		const h = createHarness(server);

		h.spawner.spawn(h.config());
		server.exitCode = null;
		setImmediate(() =>
			server.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
		);

		await vi.waitFor(() => expect(h.fallbackToCli).toHaveBeenCalledTimes(1));
		expect(h.errors).toEqual([]);
	});

	it('hands turns it cannot carry straight to exec', () => {
		const h = createHarness(new FakeAppServer(() => {}));

		h.spawner.spawn(h.config({ args: [...READ_ONLY_ARGS, '--add-dir', '/tmp/other'] }));
		h.spawner.spawn(h.config({ images: ['data:image/png;base64,AAAA'] }));

		expect(h.fallbackToCli).toHaveBeenCalledTimes(2);
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

const SSH_ARGS = ['-o', 'BatchMode=yes', 'me@box', '/bin/bash', '--norc', '--noprofile', '-s'];

/** An SSH config as the spawn handler hands it over, with its app-server launch. */
function sshOverrides(launch: Partial<NonNullable<ProcessConfig['codexAppServerSsh']>> = {}) {
	return {
		command: '/usr/bin/ssh',
		args: SSH_ARGS,
		cwd: '/Users/me',
		prompt: undefined,
		sshRemoteId: 'remote-1',
		sshRemoteHost: 'box',
		sshStdinScript: 'exec codex exec --json\nReply with the word OK',
		codexAppServerSsh: {
			command: '/usr/bin/ssh',
			args: SSH_ARGS,
			stdinScript: "cd '/home/me/proj' || exit 1\nexec codex app-server\n",
			remoteCommandLine: 'codex app-server',
			execArgs: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
			cwd: '/home/me/proj',
			prompt: 'Reply with the word OK',
			...launch,
		},
	} satisfies Partial<ProcessConfig>;
}

describe('CodexAppServerSpawner on an SSH remote', () => {
	it('runs the ssh client, writes the launch script before any protocol line, and plans from the launch', async () => {
		const fixture = loadFixture('plain-turn');
		const driver = fixtureDriver(fixture);
		const server = new FakeAppServer(driver.onClientMessage);
		const h = createHarness(server);

		h.spawner.spawn(h.config(sshOverrides()));
		const managed = h.processes.get(h.sessionId)!;

		expect(await h.exited).toBe(0);
		expect(h.fallbackToCli).not.toHaveBeenCalled();
		expect(server.unexpected).toEqual([]);

		// The local ssh client, never through a shell, in the local cwd.
		const [command, args, options] = mockSpawn.mock.calls[0];
		expect(command).toBe('/usr/bin/ssh');
		expect(args).toEqual(SSH_ARGS);
		expect(options.cwd).toBe('/Users/me');

		// Script (with the pid record) first, then only protocol lines.
		const firstJson = server.stdinOrder.indexOf('json');
		expect(firstJson).toBeGreaterThan(0);
		expect(server.stdinOrder.slice(firstJson)).not.toContain('script');
		expect(server.scriptLines.at(-1)).toBe('exec codex app-server');
		expect(server.scriptLines.join('\n')).toContain(managed.sshRemotePidFile);
		expect(managed.sshRemotePidFile).toMatch(/^\/tmp\/maestro-agent-.+\.pid$/);
		expect(managed).toMatchObject({
			command: '/usr/bin/ssh',
			args: SSH_ARGS,
			sshRemoteId: 'remote-1',
			sshRemoteCommand: 'codex app-server',
		});

		// The thread runs in the REMOTE cwd, with the prompt from the launch.
		expect(server.sent('thread/start')[0].params).toMatchObject({ cwd: '/home/me/proj' });
		expect(server.sent('turn/start')[0].params).toMatchObject({
			input: [{ type: 'text', text: 'Reply with the word OK' }],
		});
		expect(h.data.join('')).toContain(finalAgentMessage(fixture));
		// Closing stdin ended the server: nothing to signal on the host.
		expect(mockSignalRemoteAgent).not.toHaveBeenCalled();
	});

	it('kill() signals the server on its host as well as the local client', async () => {
		const driver = fixtureDriver(loadFixture('interrupted-turn'));
		const server = new FakeAppServer(driver.onClientMessage);
		const h = createHarness(server);

		h.spawner.spawn(h.config(sshOverrides()));
		await vi.waitFor(() => expect(driver.waitingFor()).toBe('turn/interrupt'));
		const managed = h.processes.get(h.sessionId)!;

		managed.sdkController!.kill({ sync: true });

		expect(mockSignalRemoteAgent).toHaveBeenCalledWith(
			{
				sshCommand: '/usr/bin/ssh',
				sshArgs: SSH_ARGS,
				pidFile: managed.sshRemotePidFile,
				sessionId: h.sessionId,
			},
			'terminate'
		);
		expect(mockStopProcess).toHaveBeenCalledWith(
			{ child: server },
			expect.objectContaining({ from: 'terminate' })
		);
	});

	it('falls back to the exec wrapper, signalling the abandoned server, when setup fails', async () => {
		const server = new FakeAppServer((msg, s) => {
			if (msg.method === 'initialize') {
				s.send({ id: msg.id, error: { code: -32601, message: 'unknown subcommand' } });
			}
		});
		const h = createHarness(server);
		const config = h.config(sshOverrides());

		h.spawner.spawn(config);
		await vi.waitFor(() => expect(h.fallbackToCli).toHaveBeenCalledWith(config));

		expect(mockSignalRemoteAgent).toHaveBeenCalledWith(
			expect.objectContaining({ sshArgs: SSH_ARGS }),
			'terminate'
		);
		expect(h.errors).toEqual([]);
	});

	it('hands an SSH turn with no app-server launch straight to exec', () => {
		const h = createHarness(new FakeAppServer(() => {}));
		const { codexAppServerSsh: _launch, ...noLaunch } = sshOverrides();

		h.spawner.spawn(h.config(noLaunch));

		expect(h.fallbackToCli).toHaveBeenCalledTimes(1);
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

/** Let the fake server's queued writes and closes run. */
async function flushIo(): Promise<void> {
	for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('CodexAppServerSpawner fallback and safety', () => {
	const threadId = 'thread-1';
	const turnId = 'turn-1';

	/** A server that answers the handshake; `onTurnStart` decides what `turn/start` gets. */
	function scriptedServer(
		onTurnStart: (msg: ClientMessage, server: FakeAppServer) => void,
		threadResult: Record<string, unknown> = { thread: { id: threadId } }
	) {
		return new FakeAppServer((msg, s) => {
			if (msg.method === 'initialize') s.send({ id: msg.id, result: {} });
			if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
				s.send({ id: msg.id, result: threadResult });
			}
			if (msg.method === 'turn/start') onTurnStart(msg, s);
		});
	}

	it('falls back to exec when the server answers turn/start with an error, having shown nothing', async () => {
		const server = scriptedServer((msg, s) =>
			s.send({ id: msg.id, error: { code: -32602, message: 'invalid effort' } })
		);
		const h = createHarness(server);
		const exitSpy = vi.fn();
		h.emitter.on('exit', exitSpy);
		const config = h.config();

		h.spawner.spawn(config);
		await vi.waitFor(() => expect(h.fallbackToCli).toHaveBeenCalledWith(config));

		expect(server.sent('turn/start')).toHaveLength(1);
		// The held thread.started never reached the tab: exec's own session id will.
		expect(h.sessionIds).toEqual([]);
		expect(h.data).toEqual([]);
		expect(h.errors).toEqual([]);
		expect(h.processes.has(h.sessionId)).toBe(false);
		expect(mockStopProcess).toHaveBeenCalledWith(
			{ child: server },
			expect.objectContaining({ from: 'terminate', label: 'fallback' })
		);
		// The abandoned child's exit reports nothing: exec owns the turn.
		server.exit(1);
		await flushIo();
		expect(exitSpy).not.toHaveBeenCalled();
		expect(h.fallbackToCli).toHaveBeenCalledTimes(1);
	});

	it('does not fall back when the child dies with turn/start unanswered, and still reports the session', async () => {
		const server = scriptedServer((_msg, s) => s.exit(1));
		const h = createHarness(server);

		h.spawner.spawn(h.config());
		expect(await h.exited).toBe(1);

		expect(h.fallbackToCli).not.toHaveBeenCalled();
		expect(h.sessionIds).toEqual([threadId]);
	});

	it('commits on turn/started even before the turn/start response arrives', async () => {
		const server = scriptedServer((msg, s) => {
			s.send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
			s.send({ id: msg.id, error: { code: -32603, message: 'late refusal' } });
		});
		const h = createHarness(server);

		h.spawner.spawn(h.config());
		expect(await h.exited).toBe(1);

		// The turn had started, so the refusal is an error, never a second send.
		expect(h.fallbackToCli).not.toHaveBeenCalled();
		expect(h.sessionIds).toEqual([threadId]);
		expect(h.errors).toHaveLength(1);
	});

	it('falls back to exec when a resumed read-only thread keeps a wider sandbox', async () => {
		const server = scriptedServer(() => {}, {
			thread: { id: threadId },
			sandbox: { type: 'dangerFullAccess' },
			approvalPolicy: 'never',
		});
		const h = createHarness(server);
		const config = h.config({ args: [...READ_ONLY_ARGS, 'resume', threadId] });

		h.spawner.spawn(config);
		await vi.waitFor(() => expect(h.fallbackToCli).toHaveBeenCalledWith(config));

		expect(server.sent('thread/resume')[0].params).toMatchObject({ sandbox: 'read-only' });
		expect(server.sent('turn/start')).toEqual([]);
		expect(h.sessionIds).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it('runs a resumed read-only thread on app-server when the echo confirms the sandbox', async () => {
		const server = scriptedServer(
			(msg, s) => {
				s.send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
				s.send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
				s.send({
					method: 'turn/completed',
					params: { threadId, turn: { id: turnId, status: 'completed' } },
				});
			},
			{
				thread: { id: threadId },
				sandbox: { type: 'readOnly', networkAccess: false },
				approvalPolicy: 'never',
			}
		);
		const h = createHarness(server);

		h.spawner.spawn(h.config({ args: [...READ_ONLY_ARGS, 'resume', threadId] }));
		expect(await h.exited).toBe(0);
		expect(h.fallbackToCli).not.toHaveBeenCalled();
		expect(server.sent('turn/start')).toHaveLength(1);
	});

	describe('stop ladder start on each platform', () => {
		const originalPlatform = process.platform;
		const setPlatform = (platform: NodeJS.Platform) =>
			Object.defineProperty(process, 'platform', { value: platform, configurable: true });

		afterEach(() => {
			setPlatform(originalPlatform);
			vi.useRealTimers();
		});

		/** Stop a turn whose handshake never finishes: there is no turn to interrupt. */
		async function stopDuringSetup() {
			const server = new FakeAppServer(() => {});
			const h = createHarness(server);
			h.spawner.spawn(h.config());
			await vi.waitFor(() => expect(server.sent('initialize')).toHaveLength(1));
			h.processes.get(h.sessionId)!.sdkController!.interrupt();
			return server;
		}

		it('never writes Ctrl+C into the JSON-RPC stdin on Windows', async () => {
			setPlatform('win32');
			const server = await stopDuringSetup();
			expect(mockStopProcess).toHaveBeenCalledWith(
				{ child: server },
				expect.objectContaining({ from: 'terminate', label: 'interrupt' })
			);
		});

		it('keeps the out-of-band SIGINT stage on POSIX', async () => {
			setPlatform('darwin');
			const server = await stopDuringSetup();
			expect(mockStopProcess).toHaveBeenCalledWith(
				{ child: server },
				expect.objectContaining({ from: 'interrupt', label: 'interrupt' })
			);
		});

		it('starts the post-interrupt grace ladder at terminate on Windows', async () => {
			setPlatform('win32');
			// A server that starts the turn and then ignores turn/interrupt.
			const server = scriptedServer((msg, s) => {
				s.send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
				s.send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
			});
			const h = createHarness(server);
			h.spawner.spawn(h.config());
			await vi.waitFor(() =>
				expect(h.processes.get(h.sessionId)?.codexAppServer?.activeTurnId).toBe(turnId)
			);

			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			h.processes.get(h.sessionId)!.sdkController!.interrupt();
			expect(server.sent('turn/interrupt')).toHaveLength(1);
			expect(mockStopProcess).not.toHaveBeenCalled();

			vi.advanceTimersByTime(CODEX_APP_SERVER_EXIT_GRACE_MS);
			expect(mockStopProcess).toHaveBeenCalledWith(
				{ child: server },
				expect.objectContaining({ from: 'terminate', label: 'codex-app-server' })
			);
		});
	});
});

describe('CodexAppServerSpawner steering (turn/steer)', () => {
	/** Spawn a turn and steer it once the fixture is waiting for `turn/steer`. */
	async function steerWhenReady(fixture: FixtureLine[], text = steerParams(fixture).input[0].text) {
		const driver = fixtureDriver(fixture);
		const server = new FakeAppServer(driver.onClientMessage);
		const h = createHarness(server);
		const events: string[] = [];
		const verdicts: SteeringResultFrame[] = [];
		h.emitter.on('exit', () => events.push('exit'));

		h.spawner.spawn(h.config());
		await vi.waitFor(() => {
			expect(driver.waitingFor()).toBe('turn/steer');
			expect(h.processes.get(h.sessionId)?.codexAppServer?.activeTurnId).toBeTruthy();
		});
		const handle = h.processes.get(h.sessionId)!.codexAppServer!;
		const result = await steerCodexAppServerTurn(handle, { id: 'steer-1', text }, (verdict) => {
			verdicts.push(verdict);
			events.push(verdict.verdict);
		});
		return { h, server, handle, result, verdicts, events };
	}

	it('steered-turn: delivered, then absorbed when the userMessage echo arrives', async () => {
		const fixture = loadFixture('steered-turn');
		const { h, server, result, verdicts, events } = await steerWhenReady(fixture);

		expect(result).toEqual({ type: 'steering', id: 'steer-1', verdict: 'delivered' });
		expect(server.sent('turn/steer')[0].params).toEqual(steerParams(fixture));
		expect(await h.exited).toBe(0);
		await vi.waitFor(() =>
			expect(verdicts).toEqual([{ type: 'steering', id: 'steer-1', verdict: 'absorbed' }])
		);
		expect(events.filter((e) => e !== 'exit')).toEqual(['absorbed']);
		expect(server.unexpected).toEqual([]);
		expect(h.data.join('')).toContain('PINEAPPLE');
	});

	it('late-steer: a steer the server rejects as "no active turn" is refused, never settled', async () => {
		// Replay the race: the server has finished the turn and answers the steer
		// with -32600 before its `turn/completed` notification reaches us.
		const recorded = loadFixture('late-steer');
		const completed = recorded.findIndex(({ msg }) => msg.method === 'turn/completed');
		const fixture = [...recorded];
		const [turnCompleted] = fixture.splice(completed, 1);
		fixture.push(turnCompleted);

		const { h, server, handle, result, verdicts } = await steerWhenReady(fixture);

		expect(result).toEqual({
			type: 'steering',
			id: 'steer-1',
			verdict: 'refused',
			refusal: 'not-running',
			detail: 'that turn has already finished, so there is nothing to steer',
		});
		expect(server.sent('turn/steer')[0].params).toEqual(steerParams(recorded));
		expect(await h.exited).toBe(0);
		expect(verdicts).toEqual([]);

		// After the turn, there is no turn id to steer: refused without a request.
		const late = await steerCodexAppServerTurn(handle, { id: 'steer-2', text: 'again' }, () => {});
		expect(late).toMatchObject({ verdict: 'refused', refusal: 'not-running' });
		expect(server.sent('turn/steer')).toHaveLength(1);
	});

	/** steered-turn without the steer's `userMessage` echo: the turn never takes it. */
	function steeredTurnWithoutEcho(): FixtureLine[] {
		const recorded = loadFixture('steered-turn');
		const steerText = steerParams(recorded).input[0].text;
		return recorded.filter(({ dir, msg }) => {
			if (dir !== 'recv') return true;
			const item = (msg.params as { item?: { type?: string; content?: Array<{ text?: string }> } })
				?.item;
			return !(item?.type === 'userMessage' && item.content?.[0]?.text === steerText);
		});
	}

	it('a delivered steer with no matching userMessage before turn/completed is dropped, ahead of the exit', async () => {
		// Hold `turn/completed` back so it lands after the steer is delivered, as
		// it does live (the turn runs on for seconds after the RPC answers).
		const fixture = steeredTurnWithoutEcho();
		const completedAt = fixture.findIndex(({ msg }) => msg.method === 'turn/completed');
		const [turnCompleted] = fixture.splice(completedAt, 1);

		const { h, server, result, verdicts, events } = await steerWhenReady(fixture);
		expect(result).toEqual({ type: 'steering', id: 'steer-1', verdict: 'delivered' });
		expect(verdicts).toEqual([]);

		server.send(turnCompleted.msg);
		expect(await h.exited).toBe(0);
		expect(verdicts).toEqual([{ type: 'steering', id: 'steer-1', verdict: 'dropped' }]);
		expect(events).toEqual(['dropped', 'exit']);
	});

	it('a turn that ends before the steer is confirmed refuses it rather than racing the exit', async () => {
		// The RPC answer and `turn/completed` arrive in one read.
		const { h, result, verdicts } = await steerWhenReady(steeredTurnWithoutEcho());

		expect(result).toMatchObject({ id: 'steer-1', verdict: 'refused', refusal: 'not-running' });
		expect(await h.exited).toBe(0);
		expect(verdicts).toEqual([]);
	});

	it('any other RPC error is unknown, and so is a timeout', async () => {
		const threadId = 'thread-1';
		const turnId = 'turn-1';
		let answerSteer = true;
		const server = new FakeAppServer((msg, s) => {
			if (msg.method === 'initialize') s.send({ id: msg.id, result: {} });
			if (msg.method === 'thread/start')
				s.send({ id: msg.id, result: { thread: { id: threadId } } });
			if (msg.method === 'turn/start') {
				s.send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
				s.send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
			}
			if (msg.method === 'turn/steer' && answerSteer) {
				s.send({ id: msg.id, error: { code: -32603, message: 'internal error' } });
			}
		});
		const h = createHarness(server);
		h.spawner.spawn(h.config());
		await vi.waitFor(() =>
			expect(h.processes.get(h.sessionId)?.codexAppServer?.activeTurnId).toBe(turnId)
		);
		const handle = h.processes.get(h.sessionId)!.codexAppServer!;
		const verdicts: SteeringResultFrame[] = [];

		const failed = await steerCodexAppServerTurn(handle, { id: 'a', text: 'x' }, (v) =>
			verdicts.push(v)
		);
		expect(failed).toMatchObject({ id: 'a', verdict: 'unknown' });
		expect(failed.refusal).toBeUndefined();

		answerSteer = false;
		const timedOut = await steerCodexAppServerTurn(
			handle,
			{ id: 'b', text: 'y' },
			(v) => verdicts.push(v),
			{ timeoutMs: 20 }
		);
		expect(timedOut).toMatchObject({ id: 'b', verdict: 'unknown' });

		// Neither was delivered, so the turn's end settles nothing.
		server.exit(0);
		expect(await h.exited).toBe(0);
		expect(verdicts).toEqual([]);
	});

	it('refuses over-long text without sending it', async () => {
		const fixture = loadFixture('steered-turn');
		const { server, result } = await steerWhenReady(
			fixture,
			'x'.repeat(STEERING_MAX_TEXT_BYTES + 1)
		);
		expect(result).toMatchObject({ verdict: 'refused', refusal: 'too-long' });
		expect(server.sent('turn/steer')).toEqual([]);
	});
});
