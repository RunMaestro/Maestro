/**
 * @file agent-use-e2e.test.ts
 *
 * Does an agent that is TOLD about System One use it? A real Claude Code turn,
 * started the way the main process starts an unattended agent turn, with the
 * System One section (L0) in its Maestro system prompt, on a job that suits
 * System One and has a known answer (`helpers/systemOneAgentTask.ts`):
 *
 *   "Here are 40 one-line commit messages in `commits.txt`. Which ones describe
 *    a security fix? Write the line numbers to `security.txt`."
 *
 * The same job is then run by an agent with System One switched off in its own
 * settings (`systemOneOptOut`), so the prompt has no section, and the two are
 * compared.
 *
 * Nothing between the agent and the engine is a mock:
 * - the system prompt is `buildMaestroSystemPromptForSession` over the real
 *   prompt files, gated by the real `getSystemOneAgentAccess`;
 * - the launch is `executeCuePrompt` (the stored agent, `buildSpawnSpec`,
 *   `buildAgentLaunchPlan`, the real `claude` on PATH), with the caller
 *   identity in the agent's environment the way a tab spawn stamps it;
 * - the agent's `maestro-cli s1 ...` is the built CLI of this checkout, talking
 *   over a loopback WebSocket to the product's own message handler
 *   (`helpers/cliBridge.ts`), which calls `runAgentSystemOneRequest`;
 * - the engine is the hosted Jev, the cache is the real one in a new folder,
 *   and the ledger is the real `s1_decisions` SQL.
 *
 * What is ASSERTED is the wiring: the section is there for one agent and gone
 * for the other, both turns complete, and every ledger row an agent caused
 * names that agent and its tab. What the agent DID with System One is RECORDED,
 * never asserted, the same as a model qualification: whether it ran `s1 guide`
 * first, which verbs it used, whether it keyed the items or asked about places
 * in a list, the ledger rows, its accuracy against the labels, and the tokens
 * and cost of each turn. The numbers go into `docs/architecture/local-models.md`.
 *
 * Opt-in only, under its own flag. It starts a real agent with full permissions
 * in a scratch directory and SPENDS REAL TOKENS on the account `claude` is
 * logged in to (two turns), plus a fraction of a cent at TypeSafe. SKIPPED unless
 *   MAESTRO_S1_AGENT_E2E=1
 * Build the CLI the agent will call first, then run:
 *   npm run build:cli
 *   MAESTRO_S1_AGENT_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/system-one/agent-use-e2e.test.ts
 *
 * Options:
 *   MAESTRO_S1_AGENT_E2E_MODEL=<model>   the model `claude` runs (default: its own)
 *   MAESTRO_S1_AGENT_E2E_ITEMS=<n>       lines in the list: 40 (default) or a multiple up to 400
 *   MAESTRO_S1_AGENT_E2E_ATTEMPTS=<n>    turns per arm (default 1)
 *   MAESTRO_S1_AGENT_E2E_LABEL=<text>    a name for this run in the results file
 *   MAESTRO_S1_AGENT_E2E_DIR=<dir>       where runs and results are kept
 *
 * The key is whatever `resolveSystemOneKey` finds from a test process:
 * `TYPESAFE_API_KEY`, then the `jev` CLI's key file. It is never stored, sealed
 * or printed here. With no key the suite skips and says so.
 *
 * The harness is run with `--setting-sources local`: the user's own hooks,
 * skills (a `jev` skill among them, on the machine this was written on),
 * plugins and memory are left out, so the only thing that tells the agent about
 * System One is the section under test. Its login is the user's own.
 *
 * Every run is appended to `agent-use-e2e-results.json` in the results folder
 * (`$TMPDIR/maestro-s1-agent-e2e`). Each run gets a new data folder, so no
 * answer comes from an earlier run's cache.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.MAESTRO_S1_AGENT_E2E === '1';
const MODEL = (process.env.MAESTRO_S1_AGENT_E2E_MODEL ?? '').trim();
const LABEL = (process.env.MAESTRO_S1_AGENT_E2E_LABEL ?? '').trim();
const ATTEMPTS_ENV = Number(process.env.MAESTRO_S1_AGENT_E2E_ATTEMPTS);
const ATTEMPTS = Number.isInteger(ATTEMPTS_ENV) && ATTEMPTS_ENV > 0 ? ATTEMPTS_ENV : 1;
const ITEMS_ENV = (process.env.MAESTRO_S1_AGENT_E2E_ITEMS ?? '').trim();
const RESULTS_DIR =
	process.env.MAESTRO_S1_AGENT_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-s1-agent-e2e');
const RESULTS_FILE = path.join(RESULTS_DIR, 'agent-use-e2e-results.json');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli', 'maestro-cli.js');

/** This run's own folder: Maestro's data in `data`, each agent's directory beside it. */
const RUN_DIR = RUN
	? (mkdirSync(RESULTS_DIR, { recursive: true }), mkdtempSync(path.join(RESULTS_DIR, 'run-')))
	: RESULTS_DIR;
const DATA_DIR = path.join(RUN_DIR, 'data');

const settings = vi.hoisted(() => new Map<string, unknown>());
const stored = vi.hoisted(() => ({ agents: [] as Array<Record<string, unknown>> }));
const ledger = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('electron', () => ({
	app: {
		getPath: () => DATA_DIR,
		// Where `resolveBundledCliPathSync` looks for `dist/cli/maestro-cli.js`.
		getAppPath: () => REPO_ROOT,
		getVersion: () => '0.0.0-e2e',
		isPackaged: false,
	},
	safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../../../main/stores/getters', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/stores/getters')>()),
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
	getSessionsStore: () => ({
		get: (key: string, fallback?: unknown) => (key === 'sessions' ? stored.agents : fallback),
	}),
}));
// The ledger is real: the real `s1_decisions` SQL over an in-memory SQLite.
vi.mock('../../../../main/stats/singleton', async () => {
	const decisions = await import('../../../../main/stats/s1-decisions');
	const db = (): Database.Database => ledger.db as Database.Database;
	return {
		getStatsDB: () => ({
			isReady: () => ledger.db !== null,
			recordLocalModelRun: vi.fn(() => 'id'),
			recordSystemOneDecision: (decision: never) =>
				decisions.insertSystemOneDecision(db(), decision),
			getSystemOneDecisions: (read: never) => decisions.getSystemOneDecisions(db(), read),
			getSystemOneAgentSpend: (since: number) => decisions.getSystemOneAgentSpend(db(), since),
			pruneSystemOneDecisions: (cutoffMs: number) =>
				decisions.pruneSystemOneDecisions(db(), cutoffMs),
		}),
	};
});
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		cue: vi.fn(),
		toast: vi.fn(),
		autorun: vi.fn(),
	},
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(),
	addBreadcrumb: vi.fn(),
}));
// The hosted engine needs no local runtime; keep the native ones out of the process.
vi.mock('../../../../main/local-models/text-gen', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/local-models/text-gen')>()),
	generateText: vi.fn(),
}));
vi.mock('../../../../main/local-models/embeddings', () => ({ embedTexts: vi.fn() }));
vi.mock('../../../../main/local-models/classifier', () => ({ classifyText: vi.fn() }));
vi.mock('../../../../main/local-models/speech-to-text', () => ({ transcribeSpeech: vi.fn() }));

import { executeCuePrompt } from '../../../../main/cue/cue-executor';
import {
	configureAgentSystemOne,
	getSystemOneAgentAccess,
	resetAgentSystemOneForTests,
} from '../../../../main/local-models/system-one/agent-service';
import { resetSystemOneAnswerCacheForTests } from '../../../../main/local-models/system-one/answer-cache';
import { resetSystemOneLedgerForTests } from '../../../../main/local-models/system-one/decisions';
import {
	configureSystemOne,
	resetSystemOneServiceForTests,
	resolveSystemOneEngine,
	testSystemOne,
	updateSystemOneSettingsRequest,
} from '../../../../main/local-models/system-one/service';
import { initializePrompts } from '../../../../main/prompt-manager';
import { runMigrations } from '../../../../main/stats/migrations';
import { getSystemOneDecisions } from '../../../../main/stats/s1-decisions';
import type { StoredSession } from '../../../../main/stores/types';
import { buildMaestroSystemPromptForSession } from '../../../../main/utils/maestro-system-prompt';
import { obscuringSeal } from '../../../../main/utils/safe-storage-seal';
import { buildCallerIdentityEnv } from '../../../../shared/agentDelegation';
import type { SystemOneLedgerEntry } from '../../../../shared/local-models/system-one-ledger';
import {
	TYPESAFE_API_KEY_ENV_VAR,
	TYPESAFE_API_KEY_FILE,
	describeSystemOneKey,
} from '../../../../shared/local-models/system-one-settings';
import { startCliBridge, type TestCliBridge } from '../../../helpers/cliBridge';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../../helpers/nodeSqlite';
import { isOnPath, providerCliEnv, runProviderCli } from '../../../helpers/providerCli';
import {
	SECURITY_TASK_ANSWER_FILE,
	SECURITY_TASK_DEFAULT_ITEMS,
	SECURITY_TASK_INPUT_FILE,
	readClaudeRun,
	readSecurityAnswer,
	readSystemOneUse,
	scoreSecurityAnswer,
	securityTaskCommits,
	securityTaskInput,
	securityTaskLabels,
	securityTaskPrompt,
	type SecurityTaskScore,
	type SystemOneKeying,
} from '../../../helpers/systemOneAgentTask';

if (RUN) {
	// The launch plan builds the agent's environment from this process's, as the
	// desktop app does from its own. An agent shell is not that environment: its
	// `CLAUDE_CODE_*` and Maestro variables would reach the harness.
	const clean = providerCliEnv({});
	for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
	// The CLI the agent runs finds the desktop through the discovery file in this
	// folder, and `paths.ts` prefers the variable over Electron. An agent the app
	// spawns inherits it the same way.
	process.env.MAESTRO_USER_DATA = DATA_DIR;
}

/** The list for this run, and the job that names its size. Throws on a size the list cannot be built at. */
const COMMITS = securityTaskCommits(
	ITEMS_ENV === '' ? SECURITY_TASK_DEFAULT_ITEMS : Number(ITEMS_ENV)
);
const PROMPT = securityTaskPrompt(COMMITS.length);

/** One agent turn. A turn still going at this point is stopped and recorded as such. */
const TURN_TIMEOUT_MS = 12 * 60_000;
const SECTION_HEADING = '## System One';

type Arm = 'on' | 'off';

interface ArmRecord {
	arm: Arm;
	attempt: number;
	agentId: string;
	/** Whether the agent's system prompt held the System One section. */
	sectionPresent: boolean;
	systemPromptChars: number;
	status: string;
	exitCode: number | null;
	durationMs: number;
	error?: string;
	model: string;
	/** What else the harness loaded that the agent could have reached for. */
	skills: number;
	mcpServers: string[];
	turns: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	toolCalls: number;
	ranGuide: boolean;
	guideBeforeFirstAsk: boolean | null;
	verbs: Record<string, number>;
	keying: SystemOneKeying;
	readList: boolean;
	usedJevCli: boolean;
	/** Every command that ran a System One verb, cut to a line, for a person to check `keying`. */
	systemOneCommands: string[];
	/** Bridge messages the agent's CLI sent, by type. */
	bridgeMessages: Record<string, number>;
	ledger: {
		rows: number;
		cachedRows: number;
		byTask: Record<string, number>;
		questions: number;
		inputTokens: number;
		costUsd: number;
		meanLatencyMs: number | null;
	};
	answerWritten: boolean;
	score: SecurityTaskScore | null;
}

const records: ArmRecord[] = [];
/** Numbers and names only: never the key. */
const setup: Record<string, string | number | boolean> = {};

function tally(values: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

function ledgerRows(agentId: string): SystemOneLedgerEntry[] {
	return getSystemOneDecisions(ledger.db as Database.Database, {
		since: 0,
		limit: 10_000,
	}).entries.filter((entry) => entry.agentId === agentId);
}

describe.skipIf(!RUN || !canLoadNodeSqlite())(
	'An agent told about System One (MAESTRO_S1_AGENT_E2E=1)',
	() => {
		let bridge: TestCliBridge | null = null;
		let skipReason: string | null = null;

		beforeAll(async () => {
			mkdirSync(DATA_DIR, { recursive: true });
			const Shim = nodeSqliteBetterSqlite3Mock().default;
			ledger.db = new Shim(':memory:');
			runMigrations(ledger.db as Database.Database);
			resetSystemOneLedgerForTests();
			resetSystemOneAnswerCacheForTests();
			await initializePrompts();

			// The real environment and the real home folder, an empty data folder and
			// no Settings > Environment: the key sources a test process can read.
			configureSystemOne({
				dataDir: () => DATA_DIR,
				osSeal: obscuringSeal,
				shellEnvVars: () => ({}),
			});
			configureAgentSystemOne({ sessions: () => stored.agents });
			await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });

			const resolved = await resolveSystemOneEngine();
			if (resolved.id !== 'jev-cloud') {
				throw new Error(`Expected the hosted Jev to be the engine in force, got ${resolved.id}.`);
			}
			if (resolved.key.source === 'none') {
				skipReason = `no API key found. Set ${TYPESAFE_API_KEY_ENV_VAR} or write the key to ~/${TYPESAFE_API_KEY_FILE.join('/')}.`;
				console.warn(`[s1-agent-e2e] skipped: ${skipReason}`);
				return;
			}
			setup.keySource = describeSystemOneKey(resolved.key);
			setup.engine = resolved.id;

			bridge = await startCliBridge(DATA_DIR);
		}, 60_000);

		afterAll(async () => {
			await bridge?.close();
			resetAgentSystemOneForTests();
			resetSystemOneServiceForTests();
			if (records.length === 0) return;

			const previous = existsSync(RESULTS_FILE)
				? (JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as { runs?: unknown[] })
				: {};
			const run = {
				label: LABEL || undefined,
				checkedAt: new Date().toISOString(),
				runDir: RUN_DIR,
				task: {
					prompt: PROMPT,
					items: COMMITS.length,
					securityFixes: securityTaskLabels(COMMITS).length,
				},
				...setup,
				arms: records,
			};
			const report = JSON.stringify({ runs: [...(previous.runs ?? []), run] }, null, 2);
			writeFileSync(RESULTS_FILE, `${report}\n`);
			console.log(`[s1-agent-e2e] results\n${JSON.stringify(run, null, 2)}`);
		});

		/** One agent, one turn on the job, and what it did. */
		async function runArm(arm: Arm, attempt: number): Promise<ArmRecord> {
			const agentId = `s1-agent-e2e-${arm}-${attempt}`;
			const tabId = `${agentId}-tab`;
			const cwd = path.join(RUN_DIR, `${arm}-${attempt}`);
			mkdirSync(cwd, { recursive: true });
			writeFileSync(path.join(cwd, SECURITY_TASK_INPUT_FILE), securityTaskInput(COMMITS));

			// The stored agent, as the sessions store would hold it. Off is the
			// agent's own switch: the same record with `systemOneOptOut`.
			const agent = {
				id: agentId,
				name: `System One e2e (${arm})`,
				toolType: 'claude-code',
				cwd,
				projectRoot: cwd,
				isGitRepo: false,
				...(arm === 'off' ? { systemOneOptOut: true } : {}),
			};
			stored.agents.push(agent);

			const systemPrompt = await buildMaestroSystemPromptForSession(
				agent as unknown as StoredSession,
				{ activeTabId: tabId }
			);
			expect(systemPrompt, 'the Maestro system prompt was not built').toBeTruthy();
			const sectionPresent = systemPrompt!.includes(SECTION_HEADING);

			const messagesBefore = bridge!.messages.length;
			const runId = `${agentId}-${Date.now()}`;
			let rawStdout = '';
			const result = await executeCuePrompt({
				runId,
				session: { id: agentId, name: agent.name, toolType: 'claude-code', cwd, projectRoot: cwd },
				subscription: {
					name: 's1-agent-e2e',
					event: 'cli.trigger',
					enabled: true,
					prompt: PROMPT,
				},
				event: {
					id: runId,
					type: 'cli.trigger',
					timestamp: new Date().toISOString(),
					triggerName: 's1-agent-e2e',
					payload: {},
				},
				promptPath: PROMPT,
				toolType: 'claude-code',
				projectRoot: cwd,
				templateContext: {
					session: { id: agentId, name: agent.name, toolType: 'claude-code', cwd },
				},
				timeoutMs: TURN_TIMEOUT_MS,
				// No user hooks, skills, plugins or memory: the section is the only
				// thing that tells this agent about System One.
				customArgs: '--setting-sources local',
				// Who is asking, the way a tab spawn stamps it (`process:spawn`). A Cue
				// run does not stamp it today.
				customEnvVars: buildCallerIdentityEnv(agentId, tabId),
				customModel: MODEL || undefined,
				onLog: (level, message) => {
					if (level === 'error' || level === 'warn') console.warn(`[s1-agent-e2e] ${message}`);
				},
				agentConfigValues: {},
				onRunTranscript: (run) => {
					rawStdout = run.rawStdout;
				},
				appendSystemPrompt: systemPrompt,
			});
			writeFileSync(path.join(cwd, 'turn.stream.jsonl'), rawStdout);

			const harness = readClaudeRun(rawStdout);
			const use = readSystemOneUse(rawStdout);
			const rows = ledgerRows(agentId);
			const answerPath = path.join(cwd, SECURITY_TASK_ANSWER_FILE);
			const answerWritten = existsSync(answerPath);
			const answered = rows.filter((row) => !row.cached && row.usage);
			const record: ArmRecord = {
				arm,
				attempt,
				agentId,
				sectionPresent,
				systemPromptChars: systemPrompt!.length,
				status: result.status,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				...(harness.error ? { error: harness.error } : {}),
				model: harness.model,
				skills: harness.skills.length,
				mcpServers: harness.mcpServers,
				turns: harness.turns,
				costUsd: harness.costUsd,
				inputTokens: harness.inputTokens,
				outputTokens: harness.outputTokens,
				cacheReadTokens: harness.cacheReadTokens,
				cacheWriteTokens: harness.cacheWriteTokens,
				toolCalls: use.toolCalls,
				ranGuide: use.ranGuide,
				guideBeforeFirstAsk: use.guideBeforeFirstAsk,
				verbs: use.verbs,
				keying: use.keying,
				readList: use.readList,
				usedJevCli: use.usedJevCli,
				systemOneCommands: [...new Set(use.invocations.map(({ command }) => command))].map(
					(command) => command.replace(/\s+/g, ' ').slice(0, 400)
				),
				bridgeMessages: tally(
					bridge!.messages.slice(messagesBefore).map((message) => message.type)
				),
				ledger: {
					rows: rows.length,
					cachedRows: rows.filter((row) => row.cached).length,
					byTask: tally(rows.map((row) => row.taskId)),
					questions: rows.reduce((sum, row) => sum + row.questionIds.length, 0),
					inputTokens: rows.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0), 0),
					costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
					meanLatencyMs:
						answered.length === 0
							? null
							: Math.round(answered.reduce((sum, row) => sum + row.latencyMs, 0) / answered.length),
				},
				answerWritten,
				score: answerWritten
					? scoreSecurityAnswer(
							readSecurityAnswer(readFileSync(answerPath, 'utf8'), COMMITS.length),
							COMMITS
						)
					: null,
			};
			records.push(record);

			// The wiring, which is the same whatever the agent chose to do.
			expect(result.status, `${result.stderr.slice(-500)} ${harness.error ?? ''}`).toBe(
				'completed'
			);
			expect(harness.error).toBeUndefined();
			for (const message of bridge!.messages.slice(messagesBefore)) {
				if (message.type !== 'system_one_agent_request') continue;
				expect(message.fromSessionId).toBe(agentId);
				expect(message.fromTabId).toBe(tabId);
			}
			for (const row of rows) {
				expect(row.taskId.startsWith('agent:'), row.taskId).toBe(true);
				expect(row.tabId).toBe(tabId);
			}
			return record;
		}

		it('has the harness, a built CLI with the s1 verbs, and an engine that passed its Test', async (ctx) => {
			if (skipReason) ctx.skip(skipReason);
			expect(isOnPath('claude'), '`claude` is not on PATH').toBe(true);
			expect(existsSync(CLI_PATH), `${CLI_PATH} is missing: run \`npm run build:cli\``).toBe(true);

			const guide = await runProviderCli(process.execPath, [CLI_PATH, 's1', 'guide', '--list'], {
				cwd: RUN_DIR,
				env: providerCliEnv({ MAESTRO_USER_DATA: DATA_DIR }),
				timeoutMs: 30_000,
			});
			expect(guide.code, `the built CLI is stale: run \`npm run build:cli\`. ${guide.stderr}`).toBe(
				0
			);
			expect(guide.stdout).toContain('when');

			const tested = await testSystemOne();
			expect(tested.ok, tested.ok ? '' : tested.error).toBe(true);
			const access = await getSystemOneAgentAccess('s1-agent-e2e-preflight');
			expect(access.allowed, access.reason ?? '').toBe(true);
			expect(access.engine).toBe('jev-cloud');
			expect(access.calibrated).toBe(true);

			const version = await runProviderCli('claude', ['--version'], {
				cwd: RUN_DIR,
				env: providerCliEnv({}),
				timeoutMs: 30_000,
			});
			setup.claude = version.stdout.trim().split('\n')[0] ?? '';
		}, 120_000);

		it('answers the built CLI over the bridge, under the caller it names', async (ctx) => {
			if (skipReason) ctx.skip(skipReason);
			const agentId = 's1-agent-e2e-preflight';
			stored.agents.push({ id: agentId, name: 'Preflight', toolType: 'claude-code' });
			const asked = await runProviderCli(
				process.execPath,
				[
					CLI_PATH,
					's1',
					'yes',
					'Does this commit message describe a security fix?',
					'-s',
					'Escape user-supplied HTML in the comment preview to stop stored XSS',
					'--json',
				],
				{
					cwd: RUN_DIR,
					env: providerCliEnv({
						MAESTRO_USER_DATA: DATA_DIR,
						...buildCallerIdentityEnv(agentId, 'preflight-tab'),
					}),
					timeoutMs: 60_000,
				}
			);
			expect(asked.code, `${asked.stdout}\n${asked.stderr}`).toBe(0);
			const reply = JSON.parse(asked.stdout) as { engine?: string; calibrated?: boolean };
			expect(reply.engine).toBe('jev-cloud');
			expect(reply.calibrated).toBe(true);

			const rows = ledgerRows(agentId);
			expect(rows).toHaveLength(1);
			expect(rows[0].taskId).toBe('agent:yes');
			expect(rows[0].tabId).toBe('preflight-tab');
			setup.preflightLatencyMs = rows[0].latencyMs;
			setup.preflightInputTokens = rows[0].usage?.inputTokens ?? 0;
		}, 120_000);

		const attempts = Array.from({ length: ATTEMPTS }, (_, index) => index + 1);

		it.for(attempts)(
			'runs the job with the System One section in the prompt (attempt %i)',
			{ timeout: TURN_TIMEOUT_MS + 60_000 },
			async (attempt, { skip }) => {
				skip(skipReason !== null, skipReason ?? '');
				const record = await runArm('on', attempt);
				expect(record.sectionPresent).toBe(true);
			}
		);

		it.for(attempts)(
			'runs the same job with System One switched off for the agent (attempt %i)',
			{ timeout: TURN_TIMEOUT_MS + 60_000 },
			async (attempt, { skip }) => {
				skip(skipReason !== null, skipReason ?? '');
				const record = await runArm('off', attempt);
				// Off is off: no section, and nothing asked under this agent.
				expect(record.sectionPresent).toBe(false);
				expect(record.ledger.rows).toBe(0);
			}
		);
	}
);
