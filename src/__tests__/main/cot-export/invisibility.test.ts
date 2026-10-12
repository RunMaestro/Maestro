/**
 * The invisibility test of the chain of thought export.
 *
 * WHAT IT PROVES
 * Turning export on for an agent changes nothing that agent can observe. It
 * is started with the same command, arguments, working directory,
 * environment, prompt, and system prompt, and nothing it is started with
 * names the log folder or the file the setting is kept in.
 *
 * HOW
 * One AI tab message goes down the REAL spawn path three times:
 *
 *   handleProcessSpawn -> ProcessManager.spawn -> the child process spawner
 *   -> startTurn -> child_process.spawn
 *
 *   unwired   nothing listens to the process manager
 *   off       the export listener is wired the way the app wires it, the
 *             agent has a log folder, and the switch is off
 *   on        the same, and the switch is on
 *
 * The one stand-in is the operating system: `child_process.spawn` hands back a
 * fake child. What that call was given is the whole of what an agent process
 * gets, so that is where the three runs are compared. The argument builder,
 * the launch plan, the process manager, the spawner, the listener, and the
 * resolver are the real ones. The config store and the writer are the APP'S
 * own (`getCotConfigStore`, `getCotWriter`), so a change that made the spawn
 * path ask either of them about the agent would show here as a difference.
 *
 * The "on" run must leave a turn file whose chain verifies. Without that, the
 * runs could be equal because nothing was recorded.
 *
 * The last block reads the source of the CLI and the web server, the two
 * places an agent can drive Maestro from, and fails if either names the
 * feature.
 *
 * `electron` is mocked, and `MAESTRO_USER_DATA` is pointed at a temp folder
 * for the length of each scenario, because agent shells export the real one.
 * Every run writes under a fresh directory in the OS temp dir and builds
 * paths with `path.join`. None of them reads or writes the user's real data.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'child_process';

const mocks = vi.hoisted(() => ({
	/** Where the mocked `electron` says the app keeps its data. Set by each scenario. */
	userDataPath: '',
	/** The agent list the app reads. Set by each run. */
	sessionsStore: null as { get(key: string, fallback?: unknown): unknown } | null,
	osSpawn: vi.fn(),
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	sentry: {
		captureException: vi.fn(async () => undefined),
		captureMessage: vi.fn(async () => undefined),
		addBreadcrumb: vi.fn(async () => undefined),
	},
}));

vi.mock('electron', () => ({
	app: { getPath: (): string => mocks.userDataPath },
	// The app's store seals its file with this, as it does where the OS has a
	// key to offer. The seal only marks the text.
	safeStorage: {
		isEncryptionAvailable: (): boolean => true,
		encryptString: (plain: string): Buffer => Buffer.from(`sealed:${plain}`, 'utf8'),
		decryptString: (blob: Buffer): string => blob.toString('utf8').slice('sealed:'.length),
	},
}));
vi.mock('../../../main/stores/getters', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/stores/getters')>()),
	// The app's store asks this for every agent's folders.
	getSessionsStore: () => mocks.sessionsStore,
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const overrides = { spawn: mocks.osSpawn };
	// Some modules in the process manager's import graph reach `child_process`
	// through its default export, and vitest throws if the mock leaves it out.
	return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
vi.mock('../../../main/utils/logger', () => ({ logger: mocks.logger }));
vi.mock('../../../main/utils/sentry', () => ({ ...mocks.sentry }));

import { getAgentCapabilities } from '../../../main/agents';
import type { AgentDetector } from '../../../main/agents';
import { getAgentDefinition } from '../../../main/agents/definitions';
import type { AgentConfig } from '../../../main/agents/definitions';
import {
	COT_CONFIG_STORE_NAME,
	__resetCotConfigStoreForTests,
	flushCotConfigStoreSync,
	getCotConfigStore,
} from '../../../main/cot-export/config-store';
import { peekCotAgentId, resolveCotTarget } from '../../../main/cot-export/resolve-agent';
import type { CotResolverDeps, CotResolverSession } from '../../../main/cot-export/resolve-agent';
import { __resetCotWriterForTests, getCotWriter } from '../../../main/cot-export/runtime';
import { verifyAgentChain } from '../../../main/cot-export/verify';
import {
	COWORKING_SESSION_ID_ENV_VAR,
	COWORKING_SOCKET_OVERRIDE_ENV_VAR,
} from '../../../main/coworking/coworking-types';
import { handleProcessSpawn } from '../../../main/ipc/handlers/process/handle-spawn';
import type { SpawnHandlerDependencies } from '../../../main/ipc/handlers/process/handle-spawn';
import type { SpawnProcessConfig } from '../../../main/ipc/handlers/process/spawn-types';
import { setupCotExportListener } from '../../../main/process-listeners/cot-export-listener';
import { ProcessManager } from '../../../main/process-manager';
import type { ProcessConfig } from '../../../main/process-manager/types';
import type { CotRecord } from '../../../shared/cotExport/types';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import { QUERY_SOURCE_ENV_VAR } from '../../../shared/querySource';
import { readTurnFiles } from './helpers';

// ============================================================================
// Fixtures
// ============================================================================

const AGENT = '11111111-2222-4333-8444-555555555555';
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROCESS = `${AGENT}-ai-${TAB}`;
const FAKE_PID = 24680;

/** 14:05:09 on 10 October 2026, on the local clock. */
const START = new Date(2026, 9, 10, 14, 5, 9).getTime();

const USER_PROMPT = 'List the files in this project.';
const SYSTEM_PROMPT =
	'You are Backend, an agent managed by Maestro. Work in the project directory.';

/** The agent's own env vars, and the ones from Settings: the two layers a person edits. */
const SESSION_ENV = { INVISIBILITY_SESSION_VAR: 'set-for-this-agent' };
const GLOBAL_ENV = { INVISIBILITY_GLOBAL_VAR: 'set-in-settings' };

/**
 * The log folder's name. It is unlike anything else on the spawn path, so a
 * mention of the folder anywhere is found by this name alone.
 */
const LOG_FOLDER_NAME = 'turn-log-7f3c91d2';

/** What must never reach an agent: where its log is, and where the setting is kept. */
const SECRETS = [LOG_FOLDER_NAME, COT_CONFIG_STORE_NAME];

const VARIANTS = ['unwired', 'off', 'on'] as const;
type Variant = (typeof VARIANTS)[number];

interface Scenario {
	label: string;
	toolType: 'claude-code' | 'codex';
	model: string;
	/** The lines the provider prints for the turn. */
	stdout: unknown[];
	/** The reply inside those lines. */
	reply: string;
}

const SCENARIOS: Scenario[] = [
	{
		label: 'Claude Code, which takes its system prompt as a flag',
		toolType: 'claude-code',
		model: 'opus',
		reply: 'There are two files.',
		stdout: [
			{
				type: 'assistant',
				session_id: 'sess-1',
				message: {
					role: 'assistant',
					id: 'msg_01',
					content: [{ type: 'text', text: 'There are two files.' }],
				},
			},
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
		],
	},
	{
		label: 'Codex, which takes its system prompt inside the prompt',
		toolType: 'codex',
		model: 'gpt-5-codex',
		reply: 'All good.',
		stdout: [
			{ type: 'item.completed', item: { type: 'agent_message', text: 'All good.' } },
			{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } },
		],
	},
];

/**
 * The fields of the spawn config an agent process is built from. Each gets a
 * test of its own, so a failure names the field that moved.
 */
const SPAWN_FIELDS = [
	'command',
	'args',
	'cwd',
	'prompt',
	'customEnvVars',
	'shellEnvVars',
	'shell',
	'shellArgs',
	'runInShell',
	'sendPromptViaStdin',
	'sendPromptViaStdinRaw',
	'extraPathDirs',
	'sshStdinScript',
	'images',
] as const satisfies ReadonlyArray<keyof ProcessConfig>;

// ============================================================================
// Stand-ins
// ============================================================================

class FakeStream extends EventEmitter {
	setEncoding(): void {}
}

/** The child `child_process.spawn` hands back. It keeps what Maestro did to it. */
class FakeChild extends EventEmitter {
	readonly pid = FAKE_PID;
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	readonly written: string[] = [];
	readonly signals: unknown[] = [];
	inputClosed = false;
	killed = false;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	readonly stdin = Object.assign(new EventEmitter(), {
		write: (data: unknown, done?: (error?: Error | null) => void): boolean => {
			this.written.push(String(data));
			done?.();
			return true;
		},
		end: (): void => {
			this.inputClosed = true;
		},
	});

	kill(signal: unknown = 'SIGTERM'): boolean {
		this.signals.push(signal);
		return true;
	}

	/** The process prints its lines, one JSON object each. */
	print(lines: unknown[]): void {
		this.stdout.emit('data', lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
	}

	/** The process ends, with its streams drained. */
	exit(code: number): void {
		this.exitCode = code;
		this.emit('close', code, null);
	}
}

/** A store as the spawn handler uses one: `get` with a fallback, and `set`. */
function fakeStore(data: Record<string, unknown>) {
	return {
		get: (key: string, fallback?: unknown): unknown => (key in data ? data[key] : fallback),
		set: (key: string, value: unknown): void => {
			data[key] = value;
		},
	};
}

// ============================================================================
// The search for a mention
// ============================================================================

/** Every string inside `value`, keys and values alike, with where it sits. */
function stringsIn(
	value: unknown,
	where = '$',
	seen = new Set<object>()
): Array<[where: string, text: string]> {
	if (typeof value === 'string') return [[where, value]];
	if (value === null || typeof value !== 'object' || seen.has(value)) return [];
	seen.add(value);
	if (value instanceof Error) {
		return [
			[`${where}.message`, value.message],
			[`${where}.stack`, value.stack ?? ''],
		];
	}
	const entries: Array<[string, unknown]> =
		value instanceof Map
			? [...value.entries()].map(([key, child]) => [String(key), child])
			: Object.entries(value);
	return entries.flatMap(([key, child]) => [
		[`${where}.${key}`, key] as [string, string],
		...stringsIn(child, `${where}.${key}`, seen),
	]);
}

/** Where in `value` any of `SECRETS` is named. Empty when none is. */
/**
 * The random part of the temp file a Windows spawn puts the system prompt in
 * (`systemPromptTempFileName`). Every spawn draws a new one, whether or not
 * anything is recorded, so it says nothing about the export and is taken out
 * before two spawns are compared.
 */
const SYSTEM_PROMPT_TEMP_SUFFIX = /(maestro-sysprompt-[A-Za-z0-9_-]+-\d+-)[0-9a-f]{8}(\.txt)/g;

/** `value` with what differs between any two spawns taken out, at any depth. */
function withoutSpawnNoise(value: unknown): unknown {
	if (typeof value === 'string') return value.replace(SYSTEM_PROMPT_TEMP_SUFFIX, '$1<random>$2');
	if (Array.isArray(value)) return value.map(withoutSpawnNoise);
	if (
		value !== null &&
		typeof value === 'object' &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, withoutSpawnNoise(entry)])
		);
	}
	return value;
}

function mentionsIn(value: unknown): string[] {
	const places = stringsIn(value)
		.filter(([, text]) =>
			SECRETS.some((secret) => text.toLowerCase().includes(secret.toLowerCase()))
		)
		.map(([where]) => where);
	return [...new Set(places)];
}

describe('the search for a mention', () => {
	it('finds the log folder and the store file in a value, in a key, and at any depth', () => {
		const folder = path.join(os.tmpdir(), LOG_FOLDER_NAME);
		expect(mentionsIn({ env: { HOME: folder } })).toEqual(['$.env.HOME']);
		expect(mentionsIn({ args: ['--config', `${COT_CONFIG_STORE_NAME}.json`] })).toEqual([
			'$.args.1',
		]);
		expect(mentionsIn({ [`X_${LOG_FOLDER_NAME.toUpperCase()}`]: '1' })).toEqual([
			`$.X_${LOG_FOLDER_NAME.toUpperCase()}`,
		]);
		expect(mentionsIn([new Error(`could not write ${folder}`)])).toContain('$.0.message');
	});

	it('finds nothing in a value that names neither', () => {
		expect(mentionsIn({ env: { HOME: os.tmpdir() }, args: ['--print', USER_PROMPT] })).toEqual([]);
	});
});

// ============================================================================
// The spawn path, with export unwired, off, and on
// ============================================================================

/** Everything an agent could notice about one spawn. It must be the same in every run. */
interface Observed {
	/** The config `handleProcessSpawn` handed to `ProcessManager.spawn`. */
	managerConfig: ProcessConfig;
	/** What reached the operating system: the process as it is really started. */
	started: { command: string; args: readonly string[]; options: SpawnOptions };
	/** What Maestro wrote to the process, and whether it closed its input or signalled it. */
	input: { written: string[]; closed: boolean; signals: unknown[] };
	/** What the handler answered the renderer with. */
	result: unknown;
	/** Every push to a window, as `[channel, ...args]`. */
	sent: unknown[][];
	/** The three stores an agent can read, as the spawn left them. */
	stores: unknown;
	/** What was handed to crash reporting as context. */
	breadcrumbs: unknown[][];
}

interface Run {
	observed: Observed;
	/** Everything that went to Maestro's log or to crash reporting during the run. */
	said: unknown[][];
	/** The turn files in the log folder after the run, each as its records. */
	turns: CotRecord[][];
	/** Whether the chain in the log folder verifies against the head the store holds. */
	chainOk: boolean | null;
	/** The last failure the feature kept for the person, if it had one. */
	exportError: unknown;
}

describe.each(SCENARIOS)('a turn of $label', (scenario) => {
	let previousUserData: string | undefined;
	let root: string;
	let workspace: string;
	let folder: string;
	let agent: AgentConfig;
	let runs: Record<Variant, Run>;

	/** Whether this provider gets its system prompt inside the first prompt. */
	const embedsSystemPrompt = !getAgentCapabilities(scenario.toolType).supportsAppendSystemPrompt;

	/** The `process:spawn` payload of an AI tab message, as the renderer builds it. */
	const payload = (): SpawnProcessConfig => ({
		sessionId: PROCESS,
		toolType: scenario.toolType,
		cwd: workspace,
		command: agent.path ?? agent.command,
		args: [...agent.args],
		prompt: USER_PROMPT,
		appendSystemPrompt: SYSTEM_PROMPT,
		readOnlyMode: false,
		permissionMode: 'full',
		sessionCustomEnvVars: { ...SESSION_ENV },
		sessionCustomModel: scenario.model,
		querySource: 'user',
		tabId: TAB,
	});

	/** Sends the message once and keeps everything an agent could notice about it. */
	const spawnOnce = async (variant: Variant): Promise<Run> => {
		for (const spy of [
			mocks.osSpawn,
			...Object.values(mocks.logger),
			...Object.values(mocks.sentry),
		]) {
			spy.mockClear();
		}
		const child = new FakeChild();
		mocks.osSpawn.mockImplementation(() => child as unknown as ChildProcess);

		const sessions = {
			sessions: [
				{
					id: AGENT,
					name: 'Backend',
					toolType: scenario.toolType,
					cwd: workspace,
					projectRoot: workspace,
					aiTabs: [{ id: TAB }],
				},
			],
		};
		const agentConfigs = { configs: {} };
		const settings = { shellEnvVars: { ...GLOBAL_ENV } };
		const sessionsStore = fakeStore(sessions);
		mocks.sessionsStore = sessionsStore;

		const processManager = new ProcessManager();
		const spawnSpy = vi.spyOn(processManager, 'spawn');

		// The feature, bound the way `wireProcessListeners` binds it: the APP'S
		// store and the APP'S writer, not ones made for the test. Anything on the
		// spawn path that asked either one about this agent would get the real
		// answer. Each run starts them again over the file the last run left, as
		// a restart of the app would.
		__resetCotConfigStoreForTests();
		__resetCotWriterForTests();
		const wired =
			variant === 'unwired'
				? null
				: (() => {
						const store = getCotConfigStore();
						const resolverDeps: CotResolverDeps = {
							getSessions: () => sessionsStore.get('sessions', []) as CotResolverSession[],
							getGroupChatParticipant: () => undefined,
						};
						const assembler = setupCotExportListener(processManager, {
							store,
							writer: getCotWriter(),
							resolver: {
								peekAgentId: (id) => peekCotAgentId(id, resolverDeps),
								resolveTarget: (id) => resolveCotTarget(id, resolverDeps),
							},
						});
						return { store, assembler };
					})();
		if (wired) {
			// "off" is an agent with a log folder and the switch off, so a write
			// that should not happen has somewhere to land and be seen.
			expect(
				wired.store.setAgentConfig(AGENT, { enabled: variant === 'on', folder })
			).toMatchObject({ ok: true });
			expect(wired.store.isEnabled(AGENT)).toBe(variant === 'on');
		}

		const sent: unknown[][] = [];
		const window = {
			isDestroyed: (): boolean => false,
			webContents: {
				isDestroyed: (): boolean => false,
				send: (channel: string, ...args: unknown[]): void => {
					sent.push([channel, ...args]);
				},
			},
		};
		const deps: SpawnHandlerDependencies = {
			getProcessManager: () => processManager,
			getAgentDetector: () =>
				({
					getAgent: async (id: string) => (id === agent.id ? agent : null),
				}) as unknown as AgentDetector,
			agentConfigsStore: fakeStore(
				agentConfigs
			) as unknown as SpawnHandlerDependencies['agentConfigsStore'],
			settingsStore: fakeStore(settings) as unknown as SpawnHandlerDependencies['settingsStore'],
			sessionsStore: sessionsStore as unknown as SpawnHandlerDependencies['sessionsStore'],
			getMainWindow: () =>
				window as unknown as ReturnType<SpawnHandlerDependencies['getMainWindow']>,
			safeSend: (channel, ...args) => {
				sent.push([channel, ...args]);
			},
		};

		// The whole turn: the spawn, the reply, the exit. A run must be over
		// before the next one starts under the same process id.
		const exited = new Promise<void>((resolve) => processManager.once('exit', () => resolve()));
		const result = await handleProcessSpawn(payload(), deps);
		child.print(scenario.stdout);
		child.exit(0);
		await exited;
		await wired?.assembler.whenIdle();
		wired?.store.flushSync();

		expect(spawnSpy).toHaveBeenCalledOnce();
		expect(mocks.osSpawn).toHaveBeenCalledOnce();
		const managerConfig = spawnSpy.mock.calls[0][0];
		const [command, args, options] = mocks.osSpawn.mock.calls[0] as unknown as [
			string,
			readonly string[],
			SpawnOptions,
		];

		// On Windows the handler puts the system prompt in a temp file and
		// removes it half a minute later. Remove it now.
		const fileFlag = managerConfig.args.indexOf('--append-system-prompt-file');
		if (fileFlag !== -1) fs.rmSync(managerConfig.args[fileFlag + 1], { force: true });

		return {
			observed: {
				managerConfig,
				started: { command, args, options },
				input: { written: child.written, closed: child.inputClosed, signals: child.signals },
				result,
				sent,
				stores: structuredClone({ sessions, agentConfigs, settings }),
				breadcrumbs: mocks.sentry.addBreadcrumb.mock.calls.map((call) => [...call]),
			},
			said: [
				...Object.entries(mocks.logger).flatMap(([level, spy]) =>
					spy.mock.calls.map((call) => [level, ...call])
				),
				...Object.entries(mocks.sentry).flatMap(([name, spy]) =>
					spy.mock.calls.map((call) => [name, ...call])
				),
			],
			turns: fs.existsSync(folder) ? await readTurnFiles(folder) : [],
			chainOk: wired
				? (await verifyAgentChain(folder, wired.store.getChainState(AGENT, folder)?.head ?? null))
						.ok
				: null,
			exportError: wired ? (await wired.store.getStatus(AGENT)).lastError : undefined,
		};
	};

	/** Asserts that `pick` gives the same thing for every run. */
	const expectSame = (pick: (observed: Observed) => unknown): void => {
		const [first, ...rest] = VARIANTS.map((variant) =>
			withoutSpawnNoise(pick(runs[variant].observed))
		);
		for (const other of rest) expect(other).toStrictEqual(first);
	};

	beforeAll(async () => {
		// The real path, so a folder the store resolves compares equal on macOS,
		// where the temp dir is reached through a symlink.
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-parity-')));
		workspace = path.join(root, 'workspace');
		folder = path.join(root, LOG_FOLDER_NAME);
		const userData = path.join(root, 'user-data');
		for (const dir of [workspace, userData]) fs.mkdirSync(dir);

		mocks.userDataPath = userData;
		previousUserData = process.env.MAESTRO_USER_DATA;
		process.env.MAESTRO_USER_DATA = userData;
		vi.stubEnv(COWORKING_SESSION_ID_ENV_VAR, undefined);

		// One instant for all three runs. On Windows the handler names a temp
		// file after the clock, and that name is one of the arguments.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(START);

		const definition = getAgentDefinition(scenario.toolType);
		if (!definition) throw new Error(`No agent definition for ${scenario.toolType}`);
		// What the agent detector returns for an installed agent.
		agent = {
			...definition,
			available: true,
			path: path.join(root, 'bin', definition.binaryName),
			capabilities: getAgentCapabilities(scenario.toolType),
		};

		// "on" last: the two runs before it must find the log folder empty.
		const unwired = await spawnOnce('unwired');
		const off = await spawnOnce('off');
		const on = await spawnOnce('on');
		runs = { unwired, off, on };
	});

	afterAll(() => {
		// Nothing may be left waiting on a timer that fires after the temp dir
		// is gone: the save would bring the directory back.
		flushCotConfigStoreSync();
		__resetCotConfigStoreForTests();
		__resetCotWriterForTests();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = previousUserData;
		fs.rmSync(root, { recursive: true, force: true });
	});

	// ========================================================================
	// The runs are what they claim to be
	// ========================================================================

	it('records the turn with export on, and nothing with it off or unwired', () => {
		expect(runs.unwired.turns).toEqual([]);
		expect(runs.off.turns).toEqual([]);
		expect(runs.off.exportError).toBeUndefined();

		// The setting is kept where the app keeps it: in the data folder an
		// agent can find from its environment, under the store's own file name.
		expect(fs.existsSync(path.join(mocks.userDataPath, `${COT_CONFIG_STORE_NAME}.json`))).toBe(
			true
		);

		expect(runs.on.exportError).toBeUndefined();
		expect(runs.on.chainOk).toBe(true);
		expect(runs.on.turns).toHaveLength(1);
		const [records] = runs.on.turns;
		expect(records[0]).toMatchObject({
			kind: 'turn-start',
			agentId: AGENT,
			toolType: scenario.toolType,
			origin: 'interactive',
			tabId: TAB,
			cwd: workspace,
			// The person's own words, with no system prompt in front of them.
			prompt: USER_PROMPT,
		});
		expect('systemPromptSha256' in records[0]).toBe(embedsSystemPrompt);
		expect(records).toContainEqual(expect.objectContaining({ kind: 'text', text: scenario.reply }));
		expect(records[records.length - 1]).toMatchObject({ kind: 'turn-end', exitCode: 0 });
	});

	it('builds the spawn with the real builder, from every layer a person can set', () => {
		const { managerConfig, started, input } = runs.on.observed;

		expect(managerConfig).toMatchObject({
			sessionId: PROCESS,
			toolType: scenario.toolType,
			cwd: workspace,
			command: agent.path,
			shellEnvVars: GLOBAL_ENV,
			customEnvVars: SESSION_ENV,
		});
		expect(managerConfig.args.some((arg) => arg.includes(scenario.model))).toBe(true);
		if (embedsSystemPrompt) {
			expect(managerConfig.prompt).toBe(embedSystemPromptInPrompt(SYSTEM_PROMPT, USER_PROMPT));
		} else {
			expect(managerConfig.prompt).toBe(USER_PROMPT);
			expect(managerConfig.args.some((arg) => arg.startsWith('--append-system-prompt'))).toBe(true);
		}

		// The process itself: its real directory and its real environment. The
		// two coworking variables are added inside `ProcessManager.spawn`, after
		// the config above was captured, so they show this is the environment of
		// the process and not a copy of the config.
		expect(started.options.cwd).toBe(workspace);
		expect(started.options.env).toMatchObject({
			...GLOBAL_ENV,
			...SESSION_ENV,
			[QUERY_SOURCE_ENV_VAR]: 'user',
			[COWORKING_SESSION_ID_ENV_VAR]: AGENT,
			[COWORKING_SOCKET_OVERRIDE_ENV_VAR]: expect.any(String),
		});
		// The prompt reached the process, on its command line or on its input.
		expect([...started.args, ...input.written].join('\n')).toContain(USER_PROMPT);
	});

	// ========================================================================
	// Nothing an agent can observe moves
	// ========================================================================

	it.each(SPAWN_FIELDS)('hands the process manager the same %s', (field) => {
		expectSame((observed) => observed.managerConfig[field]);
	});

	it('hands the process manager the same config in every other field too', () => {
		expectSame((observed) => observed.managerConfig);
	});

	it('starts the process with the same command, arguments, directory, and environment', () => {
		expectSame((observed) => observed.started.command);
		expectSame((observed) => observed.started.args);
		expectSame((observed) => observed.started.options.cwd);
		expectSame((observed) => observed.started.options.env);
		expectSame((observed) => observed.started);
	});

	it('writes the same input to the process, and never signals it', () => {
		expectSame((observed) => observed.input);
		expect(runs.on.observed.input.signals).toEqual([]);
	});

	it('answers the renderer, pushes to the window, and leaves the stores the same', () => {
		expectSame((observed) => observed.result);
		expectSame((observed) => observed.sent);
		expectSame((observed) => observed.stores);
		expectSame((observed) => observed.breadcrumbs);
	});

	// ========================================================================
	// Nothing names the log folder or the store file
	// ========================================================================

	it('has a full process environment that names neither the log folder nor the store file', () => {
		const env = runs.on.observed.started.options.env ?? {};
		// The whole inherited environment, not just what Maestro adds to it.
		expect(Object.keys(env).length).toBeGreaterThan(Object.keys(GLOBAL_ENV).length + 4);
		expect(mentionsIn(env)).toEqual([]);
	});

	it.each(VARIANTS)('names neither in anything the %s run handed over', (variant) => {
		expect(mentionsIn(runs[variant].observed)).toEqual([]);
	});

	it.each(VARIANTS)('names neither in the log or in a crash report of the %s run', (variant) => {
		expect(runs[variant].said.length).toBeGreaterThan(0);
		expect(mentionsIn(runs[variant].said)).toEqual([]);
	});
});

// ============================================================================
// The code an agent can drive
// ============================================================================

describe('the code an agent can drive', () => {
	const SRC = path.resolve(__dirname, '..', '..', '..');

	/** Whether a text names the feature, in any of the ways its code spells it. */
	const namesTheFeature = (text: string): boolean =>
		text.includes(COT_CONFIG_STORE_NAME) || /cot[-_ ]?export/i.test(text);

	/** Every file under `dir`, at any depth. */
	const filesUnder = (dir: string): string[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? filesUnder(full) : [full];
		});

	it('is searched for the name the store file really has', () => {
		expect(COT_CONFIG_STORE_NAME).toBe('maestro-device-state');
		expect(namesTheFeature("import { x } from '../cot-export/runtime';")).toBe(true);
		expect(namesTheFeature("import type { Y } from '../../shared/cotExport/types';")).toBe(true);
		expect(namesTheFeature(`new Store({ name: '${COT_CONFIG_STORE_NAME}' })`)).toBe(true);
		expect(namesTheFeature("import { logger } from '../utils/logger';")).toBe(false);
	});

	it.each([['cli'], [path.join('main', 'web-server')]])(
		'never names the feature or its store file under src/%s',
		(dir) => {
			const files = filesUnder(path.join(SRC, dir));
			expect(files.length).toBeGreaterThan(0);

			const naming = files
				.filter((file) => namesTheFeature(fs.readFileSync(file, 'utf8')))
				.map((file) => path.relative(SRC, file));
			expect(naming).toEqual([]);
		}
	);
});
