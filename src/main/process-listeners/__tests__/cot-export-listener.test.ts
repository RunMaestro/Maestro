/**
 * Tests for the chain of thought export process listener.
 *
 * The listener is wired the way the app wires it: the REAL config store (over
 * a file in a fresh temp directory), the REAL writer, the REAL resolver, and
 * the real turn assembler. The one stand-in is the process manager, which is
 * an event emitter the tests drive by hand. Claude lines go through the real
 * parser first, so what reaches the listener is what a live turn sends.
 *
 * `electron` is mocked: the store only needs something to seal its file with.
 * Every test writes to its own directory under the OS temp dir and builds
 * paths with `path.join`. None of them reads or writes the user's real data.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
}));

vi.mock('electron', () => ({
	app: { getPath: (): string => '' },
	safeStorage: { isEncryptionAvailable: (): boolean => false },
}));
vi.mock('../../stores/getters', () => ({ getSessionsStore: () => ({ get: () => [] }) }));
vi.mock('../../utils/logger', () => ({ logger: loggerMock }));
vi.mock('../../utils/sentry', () => ({ captureException: vi.fn() }));

import { setupCotExportListener } from '../cot-export-listener';
import type { CotExportListenerDeps } from '../cot-export-listener';
import { createCotConfigStore } from '../../cot-export/config-store';
import type { CotConfigStore } from '../../cot-export/config-store';
import { listTurnFiles } from '../../cot-export/layout';
import { peekCotAgentId, resolveCotTarget } from '../../cot-export/resolve-agent';
import type { CotResolverDeps, CotResolverSession } from '../../cot-export/resolve-agent';
import type { CotTurnAssembler } from '../../cot-export/turn-assembler';
import { verifyAgentChain } from '../../cot-export/verify';
import { createCotWriter } from '../../cot-export/writer';
import type { CotWriter } from '../../cot-export/writer';
import type { ParsedEvent } from '../../parsers/agent-output-parser';
import { ClaudeOutputParser } from '../../parsers/claude-output-parser';
import type { ProcessManager } from '../../process-manager';
import type { ProcessConfig } from '../../process-manager/types';
import type { SealProvider } from '../../utils/safe-storage-seal';
import type { CotRecord } from '../../../shared/cotExport/types';

// ============================================================================
// Fixtures
// ============================================================================

const AGENT = '11111111-2222-4333-8444-555555555555';
const OTHER_AGENT = '66666666-7777-4888-8999-000000000000';
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHAT = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const PROCESS = `${AGENT}-ai-${TAB}`;

/** 14:05:09 on 10 October 2026, on the local clock. */
const START = new Date(2026, 9, 10, 14, 5, 9).getTime();

const SESSIONS: CotResolverSession[] = [
	{ id: AGENT, name: 'Backend', toolType: 'claude-code' },
	{ id: OTHER_AGENT, name: 'Reviewer', toolType: 'codex' },
];

function assistant(block: unknown) {
	return {
		type: 'assistant',
		session_id: 'sess-1',
		message: { role: 'assistant', id: 'msg_01', content: [block] },
	};
}

const CLAUDE_LINES = [
	assistant({ type: 'thinking', thinking: 'The user wants a listing.', signature: 'sig-1' }),
	assistant({ type: 'text', text: 'I will list the files.' }),
	assistant({ type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } }),
	{
		type: 'user',
		session_id: 'sess-1',
		message: {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'toolu_ls', content: 'a.txt\nb.txt' }],
		},
	},
	assistant({ type: 'text', text: 'There are two files.' }),
	{
		type: 'result',
		session_id: 'sess-1',
		result: 'There are two files.',
		modelUsage: {
			'claude-opus-5': {
				inputTokens: 7,
				outputTokens: 142,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				contextWindow: 1000000,
			},
		},
		total_cost_usd: 0.5,
	},
];

const CLAUDE_KINDS = [
	'turn-start',
	'thinking',
	'text',
	'tool-call',
	'tool-result',
	'text',
	'usage',
	'turn-end',
];

/** The lines as the real parser turns them into events. One parser for each turn. */
function claudeEvents(): ParsedEvent[] {
	const parser = new ClaudeOutputParser();
	const events: ParsedEvent[] = [];
	for (const line of CLAUDE_LINES) {
		const event = parser.parseJsonLine(JSON.stringify(line));
		if (event) events.push(event);
	}
	return events;
}

function spawnConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: PROCESS,
		toolType: 'claude-code',
		cwd: '/work/project',
		command: 'claude',
		args: ['--print', '--output-format', 'stream-json'],
		prompt: 'List the files.',
		querySource: 'user',
		tabId: TAB,
		customEnvVars: { ANTHROPIC_MODEL: 'claude-opus-5' },
		...overrides,
	};
}

/**
 * The process manager as the listener sees it: an emitter, and a way to ask
 * whether a process is running. `spawn` and `exit` do what the real one does
 * around its events: the process is in the table before `spawn` is emitted and
 * out of it before `exit` is.
 */
class FakeProcessManager extends EventEmitter {
	private running = new Set<string>();

	get(sessionId: string): { sessionId: string } | undefined {
		return this.running.has(sessionId) ? { sessionId } : undefined;
	}

	spawn(config: ProcessConfig, started = true): void {
		if (started) this.running.add(config.sessionId);
		this.emit('spawn', config);
	}

	line(sessionId: string, event: ParsedEvent): void {
		// The real emitter is asked for its listeners first, and emits to none.
		if (this.listenerCount('parsed-event') > 0) this.emit('parsed-event', sessionId, event);
	}

	exit(sessionId: string, code: number, outcome?: string): void {
		this.running.delete(sessionId);
		this.emit(
			'exit',
			sessionId,
			code,
			undefined,
			outcome ? { outcome, answerCaptured: true } : undefined
		);
	}
}

/** A seal that only marks the text, so the store can run with no OS key. */
const testSeal: SealProvider = {
	available: () => true,
	seal: (plaintext) => Buffer.from(`sealed:${plaintext}`, 'utf8'),
	unseal: (blob) => blob.toString('utf8').slice('sealed:'.length),
};

// ============================================================================
// Harness
// ============================================================================

describe('cot-export listener', () => {
	let root: string;
	let folder: string;
	let clock: number;
	let store: CotConfigStore;
	let writer: CotWriter;
	let manager: FakeProcessManager;
	let participants: Map<string, { agentId: string }>;

	const resolverDeps: CotResolverDeps = {
		getSessions: () => SESSIONS,
		getGroupChatParticipant: async (_chat, name) => participants.get(name),
	};

	const setup = (overrides: Partial<CotExportListenerDeps> = {}): CotTurnAssembler =>
		setupCotExportListener(manager as unknown as ProcessManager, {
			store,
			writer,
			resolver: {
				peekAgentId: (id) => peekCotAgentId(id, resolverDeps),
				resolveTarget: (id) => resolveCotTarget(id, resolverDeps),
			},
			now: () => clock,
			...overrides,
		});

	const enable = (agentId: string = AGENT, dir: string = folder): void => {
		expect(store.setAgentConfig(agentId, { enabled: true, folder: dir })).toMatchObject({
			ok: true,
		});
	};

	/** Drives one whole turn through the emitter and waits for the disk. */
	const runTurn = async (
		assembler: CotTurnAssembler,
		config: ProcessConfig = spawnConfig(),
		exitCode = 0
	): Promise<void> => {
		manager.spawn(config);
		for (const event of claudeEvents()) {
			clock += 1000;
			manager.line(config.sessionId, event);
		}
		clock += 1000;
		manager.exit(config.sessionId, exitCode);
		await assembler.whenIdle();
	};

	const readTurns = async (dir: string = folder): Promise<CotRecord[][]> => {
		const files = (await listTurnFiles(dir)).reverse();
		return files.map((file) =>
			fs
				.readFileSync(file, 'utf8')
				.split('\n')
				.filter((line) => line.trim() !== '')
				.map((line) => JSON.parse(line) as CotRecord)
		);
	};

	const kindsOf = (records: CotRecord[]): string[] => records.map((record) => record.kind);

	const verify = async (agentId: string = AGENT, dir: string = folder) =>
		verifyAgentChain(dir, store.getChainState(agentId, dir)?.head ?? null);

	beforeEach(() => {
		vi.clearAllMocks();
		// The real path, so a folder the store resolves compares equal on macOS,
		// where the temp dir is reached through a symlink.
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-listener-')));
		const dataDir = path.join(root, 'data');
		const workspace = path.join(root, 'workspace');
		const homeDir = path.join(root, 'home');
		for (const dir of [dataDir, workspace, homeDir]) fs.mkdirSync(dir);
		folder = path.join(root, 'log');
		clock = START;
		participants = new Map();
		manager = new FakeProcessManager();

		store = createCotConfigStore({
			cwd: dataDir,
			seal: testSeal,
			getFolderContext: () => ({ agentDirs: [workspace], userDataPath: dataDir, homeDir }),
			now: () => clock,
		});
		writer = createCotWriter({
			getChainState: (agentId, dir) => store.getChainState(agentId, dir),
			onHeadAdvanced: (agentId, state) => {
				store.setChainHead(agentId, state);
				store.recordWrite(agentId, clock);
			},
			onError: (agentId, error) => store.recordError(agentId, error.message, clock),
			now: () => clock,
		});
	});

	afterEach(() => {
		// Nothing may be left waiting on a timer that fires after the temp dir
		// is gone: the save would bring the directory back.
		store.flushSync();
		fs.rmSync(root, { recursive: true, force: true });
	});

	// ========================================================================
	// Recording
	// ========================================================================

	describe('an agent with export on', () => {
		it('gets one turn file whose chain verifies against the head the store holds', async () => {
			enable();
			await runTurn(setup());

			const turns = await readTurns();
			expect(turns).toHaveLength(1);
			expect(kindsOf(turns[0])).toEqual(CLAUDE_KINDS);
			expect(turns[0][0]).toMatchObject({
				agentId: AGENT,
				toolType: 'claude-code',
				origin: 'interactive',
				tabId: TAB,
				cwd: '/work/project',
				prompt: 'List the files.',
				querySource: 'user',
			});

			await expect(verify()).resolves.toMatchObject({
				ok: true,
				headMatches: true,
				filesChecked: 1,
				recordsChecked: CLAUDE_KINDS.length,
			});
		});

		it('shows the write in what the person is told about the agent', async () => {
			enable();
			await runTurn(setup());

			const status = await store.getStatus(AGENT);
			expect(status).toMatchObject({ enabled: true, folder, turnsToday: 1 });
			expect(status.lastWriteAt).toBe(clock);
			expect(status.lastError).toBeUndefined();
		});

		it('records how Maestro judged the end of the turn', async () => {
			enable();
			const assembler = setup();
			manager.spawn(spawnConfig());
			manager.exit(PROCESS, 0, 'interrupted');
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(records[records.length - 1]).toMatchObject({
				kind: 'turn-end',
				exitCode: 0,
				outcome: 'interrupted',
			});
		});

		it('records an Auto Run task under the same agent', async () => {
			enable();
			await runTurn(setup(), spawnConfig({ sessionId: `${AGENT}-batch-1767225600000` }));

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({ origin: 'auto-run', agentId: AGENT });
			expect(records[0]).not.toHaveProperty('tabId');
		});

		it('records a group chat turn under the agent the participant runs as', async () => {
			enable();
			participants.set('Backend', { agentId: 'claude-code' });
			await runTurn(
				setup(),
				spawnConfig({ sessionId: `group-chat-${CHAT}-participant-Backend-1767225600000` })
			);

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(CLAUDE_KINDS);
			expect(records[0]).toMatchObject({ origin: 'group-chat', agentId: AGENT });
			await expect(verify()).resolves.toMatchObject({ ok: true });
		});

		it('closes at once a turn whose process could not be started', async () => {
			enable();
			const assembler = setup();
			manager.spawn(spawnConfig(), false);
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'turn-end']);
			expect(records[1]).toMatchObject({ exitCode: null });
			expect(manager.listenerCount('parsed-event')).toBe(0);
		});

		it('keeps two agents in two folders and two chains', async () => {
			const otherFolder = path.join(root, 'log-other');
			enable();
			enable(OTHER_AGENT, otherFolder);
			const assembler = setup();
			await runTurn(assembler);
			await runTurn(assembler, spawnConfig({ sessionId: `${OTHER_AGENT}-ai-${TAB}` }));

			expect(await readTurns(folder)).toHaveLength(1);
			expect(await readTurns(otherFolder)).toHaveLength(1);
			await expect(verify(AGENT, folder)).resolves.toMatchObject({ ok: true });
			await expect(verify(OTHER_AGENT, otherFolder)).resolves.toMatchObject({ ok: true });
		});
	});

	// ========================================================================
	// Not recording
	// ========================================================================

	describe('what is not recorded', () => {
		it('writes nothing for an agent with export off', async () => {
			await runTurn(setup());

			expect(fs.existsSync(folder)).toBe(false);
			expect(fs.readdirSync(root).sort()).toEqual(['data', 'home', 'workspace']);
		});

		it('writes nothing for an agent that had export on and has it off now', async () => {
			enable();
			expect(store.setAgentConfig(AGENT, { enabled: false, folder })).toMatchObject({ ok: true });
			await runTurn(setup());

			expect(await readTurns()).toEqual([]);
		});

		it('does not pick up a turn when export is turned on after it started', async () => {
			const assembler = setup();
			manager.spawn(spawnConfig());
			enable();
			for (const event of claudeEvents()) manager.line(PROCESS, event);
			manager.exit(PROCESS, 0);
			await assembler.whenIdle();

			expect(await readTurns()).toEqual([]);

			// The next turn is the first one the change applies to.
			clock += 60_000;
			await runTurn(assembler);
			expect(await readTurns()).toHaveLength(1);
		});

		it('finishes a turn that was running when export was turned off', async () => {
			enable();
			const assembler = setup();
			manager.spawn(spawnConfig());
			expect(store.setAgentConfig(AGENT, { enabled: false, folder })).toMatchObject({ ok: true });
			for (const event of claudeEvents()) manager.line(PROCESS, event);
			manager.exit(PROCESS, 0);
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(CLAUDE_KINDS);
			await expect(verify()).resolves.toMatchObject({ ok: true });
		});

		it.each([
			['an exit synopsis', `${AGENT}-synopsis-1767225600000`],
			['a terminal tab', `${AGENT}-terminal-${TAB}`],
			['a group chat moderator', `group-chat-${CHAT}-moderator-1767225600000`],
			['a tab naming run', 'tab-naming-12345678-1234-4234-8234-123456789abc'],
			['a consult', 'cross-agent-12345678-1234-4234-8234-123456789abc'],
			['an agent Maestro does not have', `deadbeef-0000-4000-8000-000000000000-ai-${TAB}`],
		])('writes nothing for %s', async (_name, sessionId) => {
			enable();
			const assembler = setup();
			manager.spawn(spawnConfig({ sessionId }));
			expect(manager.listenerCount('parsed-event')).toBe(0);
			for (const event of claudeEvents()) manager.line(sessionId, event);
			manager.exit(sessionId, 0);
			await assembler.whenIdle();

			expect(await readTurns()).toEqual([]);
		});

		it('writes nothing for a group chat participant whose provider is not its agent', async () => {
			enable();
			participants.set('Backend', { agentId: 'codex' });
			await runTurn(
				setup(),
				spawnConfig({ sessionId: `group-chat-${CHAT}-participant-Backend-1767225600000` })
			);

			expect(await readTurns()).toEqual([]);
			expect(manager.listenerCount('parsed-event')).toBe(0);
		});

		it('ignores a spawn that names no process', () => {
			enable();
			setup();

			expect(() => manager.emit('spawn', { toolType: 'claude-code' })).not.toThrow();
			expect(() => manager.emit('spawn', undefined)).not.toThrow();
			expect(manager.listenerCount('parsed-event')).toBe(0);
		});
	});

	// ========================================================================
	// Cost and invisibility
	// ========================================================================

	describe('what a turn costs and shows', () => {
		it('hears parsed events only while a turn is being recorded', async () => {
			enable();
			const assembler = setup();
			expect(manager.listenerCount('parsed-event')).toBe(0);

			// Listening before the spawn call returns, so no first line is missed.
			manager.spawn(spawnConfig());
			expect(manager.listenerCount('parsed-event')).toBe(1);
			await assembler.whenIdle();
			for (const event of claudeEvents()) manager.line(PROCESS, event);
			manager.exit(PROCESS, 0);
			expect(manager.listenerCount('parsed-event')).toBe(0);
			await assembler.whenIdle();
		});

		it('goes on listening until a turn that ended while it was being looked up is written', async () => {
			enable();
			const assembler = setup();
			manager.spawn(spawnConfig());
			manager.exit(PROCESS, 0);
			// The agent of the process is not confirmed yet, so its end is held.
			expect(manager.listenerCount('parsed-event')).toBe(1);
			await assembler.whenIdle();

			expect(manager.listenerCount('parsed-event')).toBe(0);
			expect(kindsOf((await readTurns())[0])).toEqual(['turn-start', 'turn-end']);
		});

		it('never hears a parsed event when export is off for every agent', async () => {
			const assembler = setup();
			const emit = vi.spyOn(manager, 'emit');
			manager.spawn(spawnConfig());
			expect(manager.listenerCount('parsed-event')).toBe(0);
			for (const event of claudeEvents()) manager.line(PROCESS, event);
			manager.exit(PROCESS, 0);
			await assembler.whenIdle();

			expect(emit.mock.calls.filter((call) => call[0] === 'parsed-event')).toEqual([]);
		});

		it('keeps listening while another turn is still being recorded', async () => {
			enable();
			const assembler = setup();
			const second = `${AGENT}-ai-second-tab`;
			manager.spawn(spawnConfig());
			manager.spawn(spawnConfig({ sessionId: second }));
			await assembler.whenIdle();
			manager.exit(PROCESS, 0);
			expect(manager.listenerCount('parsed-event')).toBe(1);
			manager.exit(second, 0);
			expect(manager.listenerCount('parsed-event')).toBe(0);
			await assembler.whenIdle();
		});

		it('leaves the spawn config exactly as it was handed over', async () => {
			enable();
			const config = spawnConfig({ images: ['a.png'], shellEnvVars: { PATH: '/usr/bin' } });
			const before = structuredClone(config);
			Object.freeze(config);
			Object.freeze(config.args);
			Object.freeze(config.customEnvVars);

			await runTurn(setup(), config);

			expect(config).toStrictEqual(before);
			expect(await readTurns()).toHaveLength(1);
		});

		it('writes into the log nothing of the spawn but what turn-start names', async () => {
			enable();
			await runTurn(
				setup(),
				spawnConfig({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-secret-value' } })
			);

			const text = JSON.stringify(await readTurns());
			expect(text).not.toContain('sk-secret-value');
			expect(text).not.toContain('stream-json');
		});

		it('has no way to reach the renderer, the web server, the CLI, or crash reporting', () => {
			// The listener and the assembler are given a store, a writer, and a
			// resolver, and nothing else. This reads their imports, so that a later
			// change which hands either one a channel out of the main process fails
			// here.
			const sources = [
				path.join(__dirname, '..', 'cot-export-listener.ts'),
				path.join(__dirname, '..', '..', 'cot-export', 'turn-assembler.ts'),
				path.join(__dirname, '..', '..', 'cot-export', 'runtime.ts'),
			];
			const forbidden = [
				'safe-send',
				'safeSend',
				'web-server',
				'webContents',
				'ipcMain',
				"from 'electron'",
				'utils/sentry',
				'captureException',
				'/cli/',
			];
			for (const file of sources) {
				const imports = fs
					.readFileSync(file, 'utf8')
					.split('\n')
					// The line that names the module, which for an import spread over
					// several lines is its last one.
					.filter((line) => /\bfrom\s+['"]|\brequire\(|\bimport\(/.test(line))
					.join('\n');
				expect(imports).not.toBe('');
				for (const word of forbidden) expect(imports).not.toContain(word);
			}
		});
	});

	// ========================================================================
	// Order
	// ========================================================================

	describe('when another listener starts the next process from inside the exit', () => {
		it('gives the exit to the turn it ended, not to the turn that took its place', async () => {
			enable();
			// Registered before the listener under test, as most are in the app.
			let replayed = false;
			manager.on('exit', (sessionId: string) => {
				if (replayed) return;
				replayed = true;
				clock += 1000;
				manager.spawn(spawnConfig({ sessionId, prompt: 'Again.' }));
			});
			const assembler = setup();

			manager.spawn(spawnConfig({ prompt: 'First.' }));
			manager.line(PROCESS, claudeEvents()[0]);
			clock += 1000;
			manager.exit(PROCESS, 2);
			// The second process is running now, and its lines are its own.
			for (const event of claudeEvents()) manager.line(PROCESS, event);
			clock += 1000;
			manager.exit(PROCESS, 0);
			await assembler.whenIdle();

			const turns = await readTurns();
			expect(turns).toHaveLength(2);
			expect(turns[0][0]).toMatchObject({ prompt: 'First.' });
			expect(kindsOf(turns[0])).toEqual(['turn-start', 'thinking', 'turn-end']);
			expect(turns[0][2]).toMatchObject({ exitCode: 2 });
			expect(turns[1][0]).toMatchObject({ prompt: 'Again.' });
			expect(kindsOf(turns[1])).toEqual(CLAUDE_KINDS);
			expect(turns[1][turns[1].length - 1]).toMatchObject({ exitCode: 0 });
			await expect(verify()).resolves.toMatchObject({ ok: true, filesChecked: 2 });
		});
	});

	// ========================================================================
	// Failures
	// ========================================================================

	describe('when something fails', () => {
		it('never throws into the process manager', async () => {
			enable();
			const boom = (): never => {
				throw new Error('boom');
			};
			const assembler = setup({
				resolver: { peekAgentId: boom, resolveTarget: boom },
				store: { isEnabled: boom, getAgentConfig: boom, recordError: boom },
			});

			expect(() => manager.spawn(spawnConfig())).not.toThrow();
			expect(() => manager.exit(PROCESS, 0)).not.toThrow();
			await expect(assembler.whenIdle()).resolves.toBeUndefined();
		});

		it('keeps a failure in the store, where the person is shown it', async () => {
			enable();
			const assembler = setup({
				resolver: {
					peekAgentId: (id) => peekCotAgentId(id, resolverDeps),
					resolveTarget: async () => {
						throw new Error('The chat file could not be read.');
					},
				},
			});
			manager.spawn(spawnConfig());
			manager.exit(PROCESS, 0);
			await assembler.whenIdle();

			const status = await store.getStatus(AGENT);
			expect(status.lastError).toEqual({ message: 'The chat file could not be read.', at: clock });
			expect(loggerMock.warn).not.toHaveBeenCalled();
		});

		it('keeps a failed write in the store too, through the writer', async () => {
			enable();
			const assembler = setup();
			const appendFile = vi
				.spyOn(fs.promises, 'appendFile')
				.mockRejectedValue(
					Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
				);
			manager.spawn(spawnConfig());
			manager.exit(PROCESS, 0);
			await assembler.whenIdle();
			appendFile.mockRestore();

			const status = await store.getStatus(AGENT);
			expect(status.lastError?.message).toContain('EACCES');
			expect(await readTurns()).toEqual([]);
		});

		it('never writes the reason of a failure into a log an agent can read', async () => {
			enable();
			const secretFolder = path.join(root, 'log');
			const assembler = setup({
				resolver: {
					peekAgentId: () => {
						throw new Error(`EACCES: permission denied, open '${secretFolder}'`);
					},
					resolveTarget: async () => null,
				},
			});
			manager.spawn(spawnConfig());
			await assembler.whenIdle();

			// No agent is known for this failure, so the store cannot take it, and
			// the one line that is logged says only what kind of error it was.
			expect(loggerMock.warn).toHaveBeenCalledTimes(1);
			const logged = JSON.stringify(loggerMock.warn.mock.calls);
			expect(logged).not.toContain(secretFolder);
			expect(logged).not.toContain('EACCES');
			expect(loggerMock.warn.mock.calls[0][2]).toEqual({ error: 'Error' });
			for (const level of [loggerMock.info, loggerMock.error, loggerMock.debug]) {
				expect(level).not.toHaveBeenCalled();
			}
		});

		it('logs nothing at all for a turn that is recorded without a fault', async () => {
			enable();
			await runTurn(setup());

			for (const level of Object.values(loggerMock)) expect(level).not.toHaveBeenCalled();
		});
	});
});
