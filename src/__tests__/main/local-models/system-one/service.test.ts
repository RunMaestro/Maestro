/**
 * @file service.test.ts
 *
 * System One as Settings and `maestro-cli s1` see it, against a real loopback
 * Jev server (`mockJevServer`) and the in-process model mock. Every test runs
 * in a temp data folder with an injected environment and home folder, so it
 * never reads the developer's own `TYPESAFE_API_KEY` or key file.
 *
 * Properties worth protecting:
 *
 *   - **A key never leaves.** No report, and no test result, carries one.
 *   - **Where a key comes from is an order**: the stored key, then the variable
 *     (Settings > Environment before Maestro's own environment), then the `jev`
 *     CLI's key file. An OpenJev server gets only the key stored for it.
 *   - **Nothing falls back.** A stored key that will not open is not replaced by
 *     the variable, and an engine that gives no answer is not replaced by
 *     another engine.
 *   - **Off sends nothing.**
 *   - **A change is announced**, so every window and the CLI read one state.
 *   - **A Test pass belongs to the setup that passed.** A changed address,
 *     model or key reads as not tested, and a failed Test forgets the pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const settings = vi.hoisted(() => new Map<string, unknown>());
const generate = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));
vi.mock('../../../../main/stats/singleton', () => ({
	getStatsDB: () => ({ isReady: () => true, recordLocalModelRun: vi.fn(() => 'id') }),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(),
}));
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));
vi.mock('../../../../main/local-models/text-gen', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/local-models/text-gen')>()),
	generateText: generate.generateText,
}));
vi.mock('../../../../main/local-models/embeddings', () => ({ embedTexts: vi.fn() }));
vi.mock('../../../../main/local-models/classifier', () => ({ classifyText: vi.fn() }));
vi.mock('../../../../main/local-models/speech-to-text', () => ({ transcribeSpeech: vi.fn() }));

import { SYSTEM_ONE_STATE_FILE } from '../../../../main/local-models/system-one/config-store';
import {
	SYSTEM_ONE_CHANGED_CHANNEL,
	askResolvedSystemOne,
	clearSystemOneKeyRequest,
	configureSystemOne,
	getSystemOneReport,
	resetSystemOneServiceForTests,
	resolveSystemOneEngine,
	resolveSystemOneForAgents,
	resolveSystemOneKey,
	setSystemOneKeyRequest,
	testSystemOne,
	updateSystemOneSettingsRequest,
} from '../../../../main/local-models/system-one/service';
import type { SealProvider } from '../../../../main/utils/safe-storage-seal';
import { QWEN3_1_7B_ID, getLocalModel } from '../../../../shared/local-models/model-catalog';
import {
	JEV_CLOUD_BASE_URL,
	JEV_DEFAULT_MODEL,
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
	noul,
} from '../../../../shared/local-models/system-one';
import {
	DEFAULT_SYSTEM_ONE_AGENT_SETTINGS,
	SYSTEM_ONE_TEST_STATE,
	TYPESAFE_API_KEY_ENV_VAR,
	TYPESAFE_API_KEY_FILE,
	TYPESAFE_BASE_URL_ENV_VAR,
} from '../../../../shared/local-models/system-one-settings';
import { LOCAL_JUDGE_TASK_ID } from '../../../../shared/local-models/tasks';
import { startMockJevServer, type MockJevServer } from '../../../helpers/mockJevServer';

const STORED_KEY = 'sk-stored-0123456789abcdef';
const SETTINGS_ENV_KEY = 'sk-settings-env-0123456789';
const PROCESS_ENV_KEY = 'sk-process-env-0123456789';
const FILE_KEY = 'sk-key-file-0123456789abcd';
const OPENJEV_KEY = 'openjev-key-fedcba98765432';

let dir: string;
let home: string;
let shellEnv: Record<string, string>;
let processEnv: Record<string, string | undefined>;
let sealAvailable: boolean;
let sealOpens: boolean;
let safeSend: ReturnType<typeof vi.fn>;
let server: MockJevServer | null;

/** An OS seal a test can take away (`sealAvailable`) or break (`sealOpens`). */
const osSeal: SealProvider = {
	available: () => sealAvailable,
	seal: (text) => Buffer.from(`os-sealed:${Buffer.from(text).toString('hex')}`),
	unseal: (blob) => {
		if (!sealOpens) throw new Error('The key store was reset.');
		return Buffer.from(blob.toString().slice('os-sealed:'.length), 'hex').toString();
	},
};

beforeEach(async () => {
	settings.clear();
	generate.generateText.mockReset();
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-service-'));
	home = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-home-'));
	shellEnv = {};
	processEnv = {};
	sealAvailable = true;
	sealOpens = true;
	safeSend = vi.fn();
	server = null;
	configureSystemOne({
		dataDir: () => dir,
		osSeal: () => osSeal,
		shellEnvVars: () => shellEnv,
		processEnv: () => processEnv,
		homeDir: () => home,
		safeSend: safeSend as never,
	});
});

afterEach(async () => {
	resetSystemOneServiceForTests();
	await server?.close();
	await fs.rm(dir, { recursive: true, force: true });
	await fs.rm(home, { recursive: true, force: true });
});

async function writeKeyFile(key: string): Promise<string> {
	const file = path.join(home, ...TYPESAFE_API_KEY_FILE);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${key}\n`);
	return file;
}

/** The hosted engine, pointed at the mock server the way the `jev` CLI is. */
async function hostedAt(apiKey?: string): Promise<MockJevServer> {
	server = await startMockJevServer(apiKey ? { apiKey } : {});
	shellEnv[TYPESAFE_BASE_URL_ENV_VAR] = server.baseUrl;
	return server;
}

const rawState = () => fs.readFile(path.join(dir, SYSTEM_ONE_STATE_FILE), 'utf-8');

describe('resolveSystemOneKey', () => {
	it('has no key when nothing holds one', async () => {
		expect(await resolveSystemOneKey('jev-cloud')).toEqual({ info: { source: 'none' } });
		expect(await resolveSystemOneKey('openjev')).toEqual({ info: { source: 'none' } });
	});

	it("reads the jev CLI's key file last, and names the file", async () => {
		const file = await writeKeyFile(FILE_KEY);
		expect(await resolveSystemOneKey('jev-cloud')).toEqual({
			key: FILE_KEY,
			info: { source: 'file', path: file },
		});
	});

	it('prefers the variable to the file, and Settings > Environment to the inherited one', async () => {
		await writeKeyFile(FILE_KEY);
		processEnv[TYPESAFE_API_KEY_ENV_VAR] = PROCESS_ENV_KEY;
		expect(await resolveSystemOneKey('jev-cloud')).toEqual({
			key: PROCESS_ENV_KEY,
			info: { source: 'env', envVar: TYPESAFE_API_KEY_ENV_VAR, from: 'process' },
		});

		shellEnv[TYPESAFE_API_KEY_ENV_VAR] = `  ${SETTINGS_ENV_KEY}  `;
		expect(await resolveSystemOneKey('jev-cloud')).toEqual({
			key: SETTINGS_ENV_KEY,
			info: { source: 'env', envVar: TYPESAFE_API_KEY_ENV_VAR, from: 'settings' },
		});
	});

	it('treats a blank variable, and a file that is not a key, as absent', async () => {
		shellEnv[TYPESAFE_API_KEY_ENV_VAR] = '   ';
		processEnv[TYPESAFE_API_KEY_ENV_VAR] = '';
		await writeKeyFile('not a key\nat all');
		expect(await resolveSystemOneKey('jev-cloud')).toEqual({ info: { source: 'none' } });
	});

	it('prefers the stored key to every fallback', async () => {
		await writeKeyFile(FILE_KEY);
		shellEnv[TYPESAFE_API_KEY_ENV_VAR] = SETTINGS_ENV_KEY;
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		expect(await resolveSystemOneKey('jev-cloud')).toEqual({
			key: STORED_KEY,
			info: { source: 'stored', storage: 'os' },
		});
	});

	it('gives an OpenJev server only the key stored for it, never the TypeSafe key', async () => {
		await writeKeyFile(FILE_KEY);
		shellEnv[TYPESAFE_API_KEY_ENV_VAR] = SETTINGS_ENV_KEY;
		processEnv[TYPESAFE_API_KEY_ENV_VAR] = PROCESS_ENV_KEY;
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		expect(await resolveSystemOneKey('openjev')).toEqual({ info: { source: 'none' } });

		await setSystemOneKeyRequest({ engine: 'openjev', key: OPENJEV_KEY });
		expect(await resolveSystemOneKey('openjev')).toMatchObject({ key: OPENJEV_KEY });
	});

	it('does not fall back when the stored key will not open', async () => {
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		shellEnv[TYPESAFE_API_KEY_ENV_VAR] = SETTINGS_ENV_KEY;
		await writeKeyFile(FILE_KEY);

		sealOpens = false;
		const reset = await resolveSystemOneKey('jev-cloud');
		expect(reset.key).toBeUndefined();
		expect(reset.info).toMatchObject({ source: 'stored', storage: 'os' });
		expect((reset.info as { problem?: string }).problem).toContain('could not be unsealed');

		sealOpens = true;
		sealAvailable = false;
		const gone = await resolveSystemOneKey('jev-cloud');
		expect(gone.key).toBeUndefined();
		expect((gone.info as { problem?: string }).problem).toContain('not available now');
	});
});

describe('getSystemOneReport', () => {
	it('is off, with nothing wrong and nothing sent, before the user chooses', async () => {
		const report = await getSystemOneReport();
		expect(report).toMatchObject({
			engineLabel: 'Off',
			baseUrl: null,
			model: null,
			timeoutMs: null,
			calibrated: null,
			problem: null,
			keys: { 'jev-cloud': { source: 'none' }, openjev: { source: 'none' } },
		});
		expect(report.settings.engine).toBe('off');
		expect(report.failPolicies.map((row) => [row.taskId, row.policy])).toEqual([
			['cue-gate', 'open'],
			['injection-screen', 'closed'],
		]);
		await expect(fs.access(path.join(dir, SYSTEM_ONE_STATE_FILE))).rejects.toThrow();
	});

	it('names what the hosted engine is missing, and where it is called', async () => {
		const report = await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		expect(report).toMatchObject({
			engineLabel: 'Jev (TypeSafe cloud)',
			baseUrl: JEV_CLOUD_BASE_URL,
			model: null,
			timeoutMs: 1500,
			calibrated: true,
		});
		expect(report.disclosure).toContain('TypeSafe');
		expect(report.problem).toContain('has no API key');

		processEnv[TYPESAFE_API_KEY_ENV_VAR] = PROCESS_ENV_KEY;
		expect((await getSystemOneReport()).problem).toBeNull();
	});

	it('reports a TYPESAFE_BASE_URL that is not a URL instead of calling somewhere else', async () => {
		processEnv[TYPESAFE_API_KEY_ENV_VAR] = PROCESS_ENV_KEY;
		processEnv[TYPESAFE_BASE_URL_ENV_VAR] = 'ftp://nope';
		const report = await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		expect(report.problem).toContain(TYPESAFE_BASE_URL_ENV_VAR);
		expect((await testSystemOne()).ok).toBe(false);
	});

	it('names an OpenJev server by its host, and says when it has no URL', async () => {
		expect((await updateSystemOneSettingsRequest({ engine: 'openjev' })).problem).toContain(
			'OpenJev has no URL'
		);
		const report = await updateSystemOneSettingsRequest({
			openJevUrl: 'https://gpu.lan:8000/',
			model: 'openjev-1',
		});
		expect(report).toMatchObject({
			engineLabel: 'OpenJev at gpu.lan:8000',
			baseUrl: 'https://gpu.lan:8000',
			model: 'openjev-1',
			modelLabel: 'openjev-1',
			problem: null,
		});
	});

	it('names the local judge by its model, never as calibrated', async () => {
		const empty = await updateSystemOneSettingsRequest({ engine: 'local-judge' });
		expect(empty.problem).toContain('no model is assigned');
		expect(empty.model).toBeNull();

		settings.set('localModelAssignments', {
			[LOCAL_JUDGE_TASK_ID]: { type: 'local', modelId: QWEN3_1_7B_ID },
		});
		const report = await getSystemOneReport();
		const name = getLocalModel(QWEN3_1_7B_ID)!.displayName;
		expect(report).toMatchObject({
			engineLabel: `Local judge (${name}), not calibrated`,
			model: `local:${QWEN3_1_7B_ID}`,
			modelLabel: name,
			timeoutMs: LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
			calibrated: false,
			baseUrl: null,
			problem: null,
		});
	});

	it('never carries a key, whatever its source', async () => {
		await writeKeyFile(FILE_KEY);
		shellEnv[TYPESAFE_API_KEY_ENV_VAR] = SETTINGS_ENV_KEY;
		await setSystemOneKeyRequest({ engine: 'openjev', key: OPENJEV_KEY });
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		for (const next of [
			await getSystemOneReport(),
			await setSystemOneKeyRequest({ key: STORED_KEY }),
			await clearSystemOneKeyRequest({ engine: 'openjev' }),
		]) {
			const text = JSON.stringify(next);
			for (const key of [STORED_KEY, SETTINGS_ENV_KEY, FILE_KEY, OPENJEV_KEY]) {
				expect(text).not.toContain(key);
			}
		}
	});
});

describe('changes', () => {
	it('stores a change, answers with the report, and announces it', async () => {
		const report = await updateSystemOneSettingsRequest({
			timeoutMs: 800,
			failPolicy: { taskId: 'cue-gate', policy: 'closed' },
		});
		expect(report.settings).toMatchObject({
			timeoutMs: 800,
			failPolicies: { 'cue-gate': 'closed' },
		});
		expect(report.failPolicies[0]).toMatchObject({ policy: 'closed', defaultPolicy: 'open' });
		expect(safeSend).toHaveBeenCalledWith(SYSTEM_ONE_CHANGED_CHANNEL);
		expect((await getSystemOneReport()).settings.timeoutMs).toBe(800);
	});

	it('refuses a bad change with the reason, and writes and announces nothing', async () => {
		await expect(updateSystemOneSettingsRequest({ engine: 'gpt' })).rejects.toThrow(
			'is not an engine'
		);
		await expect(updateSystemOneSettingsRequest({ timeoutMs: 3 })).rejects.toThrow('timeout');
		expect(safeSend).not.toHaveBeenCalled();
		await expect(fs.access(path.join(dir, SYSTEM_ONE_STATE_FILE))).rejects.toThrow();
	});

	it('stores a key for the engine in force, sealed, and announces it', async () => {
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		safeSend.mockClear();
		const report = await setSystemOneKeyRequest({ key: ` ${STORED_KEY}\n` });
		expect(report.keys['jev-cloud']).toEqual({ source: 'stored', storage: 'os' });
		expect(report.problem).toBeNull();
		expect(await rawState()).not.toContain(STORED_KEY);
		expect(safeSend).toHaveBeenCalledWith(SYSTEM_ONE_CHANGED_CHANNEL);
	});

	it('says so when a key could only be obscured', async () => {
		sealAvailable = false;
		const report = await setSystemOneKeyRequest({ engine: 'openjev', key: OPENJEV_KEY });
		expect(report.keys.openjev).toEqual({ source: 'stored', storage: 'obscured' });
		expect(await rawState()).not.toContain(OPENJEV_KEY);
	});

	it('refuses a key with no engine to store it for, or that is not a key', async () => {
		await expect(setSystemOneKeyRequest({ key: STORED_KEY })).rejects.toThrow(
			'Name the engine the key is for'
		);
		await expect(
			setSystemOneKeyRequest({ engine: 'local-judge', key: STORED_KEY })
		).rejects.toThrow('has no key');
		await expect(setSystemOneKeyRequest({ engine: 'jev-cloud', key: '' })).rejects.toThrow(
			'The key is empty.'
		);
		const multiline = setSystemOneKeyRequest({ engine: 'jev-cloud', key: 'sk-one two' });
		await expect(multiline).rejects.toThrow('one line');
		await expect(multiline).rejects.not.toThrow('sk-one');
		expect(safeSend).not.toHaveBeenCalled();
	});

	it('forgets the stored key and falls to the next source, which it never touches', async () => {
		const file = await writeKeyFile(FILE_KEY);
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		const report = await clearSystemOneKeyRequest({ engine: 'jev-cloud' });
		expect(report.keys['jev-cloud']).toEqual({ source: 'file', path: file });
		expect(await fs.readFile(file, 'utf-8')).toBe(`${FILE_KEY}\n`);
	});
});

describe('resolveSystemOneEngine', () => {
	it('hands the client the key, the pin and the budget of the engine in force', async () => {
		expect(await resolveSystemOneEngine()).toEqual({ id: 'off' });

		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		await updateSystemOneSettingsRequest({
			engine: 'jev-cloud',
			model: 'jev-1.13.0',
			timeoutMs: 900,
		});
		expect(await resolveSystemOneEngine()).toEqual({
			id: 'jev-cloud',
			engine: { id: 'jev-cloud', baseUrl: JEV_CLOUD_BASE_URL, apiKey: STORED_KEY },
			model: 'jev-1.13.0',
			timeoutMs: 900,
			key: { source: 'stored', storage: 'os' },
			refusal: null,
		});
	});
});

describe('askResolvedSystemOne', () => {
	it('holds a request to the stored budget, unless its caller states one for that request', async () => {
		const jev = await hostedAt();
		jev.setDelayMs(300);
		processEnv[TYPESAFE_API_KEY_ENV_VAR] = PROCESS_ENV_KEY;
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud', timeoutMs: 100 });
		const engine = await resolveSystemOneEngine();
		if (engine.id === 'off') throw new Error('expected an engine');
		const questions = { q: noul('Is it Thursday?') };

		await expect(
			askResolvedSystemOne(engine, SYSTEM_ONE_TEST_STATE, questions)
		).rejects.toMatchObject({ code: 'timeout' });
		const result = await askResolvedSystemOne(engine, SYSTEM_ONE_TEST_STATE, questions, {
			timeoutMs: 5_000,
		});
		expect(result.answers.q).toMatchObject({ type: 'noul' });
	});
});

describe('resolveSystemOneForAgents', () => {
	it('is off, with the default agent settings and no pass, before the user chooses', async () => {
		expect(await resolveSystemOneForAgents()).toEqual({
			resolved: { id: 'off' },
			engineLabel: 'Off',
			agents: DEFAULT_SYSTEM_ONE_AGENT_SETTINGS,
			keepInputs: false,
			testPassedAt: null,
			cacheScope: { baseUrl: null, model: null },
		});
	});

	it('scopes the cache by where the engine is called and the model that is asked', async () => {
		const jev = await hostedAt();
		processEnv[TYPESAFE_API_KEY_ENV_VAR] = PROCESS_ENV_KEY;
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		// With no pin the hosted engine is asked for its moving alias.
		expect((await resolveSystemOneForAgents()).cacheScope).toEqual({
			baseUrl: jev.baseUrl,
			model: JEV_DEFAULT_MODEL,
		});
		await updateSystemOneSettingsRequest({ model: 'jev-1.13.0' });
		expect((await resolveSystemOneForAgents()).cacheScope.model).toBe('jev-1.13.0');

		// An OpenJev serves the one model it was started with: none is asked for.
		await updateSystemOneSettingsRequest({ engine: 'openjev', openJevUrl: 'https://gpu.lan:8000' });
		expect((await resolveSystemOneForAgents()).cacheScope).toEqual({
			baseUrl: 'https://gpu.lan:8000',
			model: null,
		});

		settings.set('localModelAssignments', {
			[LOCAL_JUDGE_TASK_ID]: { type: 'local', modelId: QWEN3_1_7B_ID },
		});
		await updateSystemOneSettingsRequest({ engine: 'local-judge' });
		expect((await resolveSystemOneForAgents()).cacheScope).toEqual({
			baseUrl: null,
			model: `local:${QWEN3_1_7B_ID}`,
		});
	});

	it('carries what agents may do and whether inputs are kept', async () => {
		await updateSystemOneSettingsRequest({
			keepInputs: true,
			agents: { enabled: false, dailyBudgetUsd: 2, perAgentBudgetUsd: 0.5 },
		});

		expect(await resolveSystemOneForAgents()).toMatchObject({
			keepInputs: true,
			agents: { enabled: false, dailyBudgetUsd: 2, perAgentBudgetUsd: 0.5 },
		});
	});
});

describe('the Test pass', () => {
	const passedAt = async () => (await getSystemOneReport()).testPassedAt;

	async function hostedReady(): Promise<MockJevServer> {
		const jev = await hostedAt(STORED_KEY);
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		return jev;
	}

	it('is absent until the engine in force has answered its Test, and is announced when it does', async () => {
		await hostedReady();
		expect(await passedAt()).toBeNull();
		safeSend.mockClear();
		const before = Date.now();

		expect((await testSystemOne()).ok).toBe(true);

		expect(await passedAt()).toBeGreaterThanOrEqual(before);
		expect((await resolveSystemOneForAgents()).testPassedAt).toBe(await passedAt());
		expect(safeSend).toHaveBeenCalledWith(SYSTEM_ONE_CHANGED_CHANNEL);
	});

	it('stays null while System One is off', async () => {
		expect(await passedAt()).toBeNull();
		await testSystemOne();
		expect(await passedAt()).toBeNull();
	});

	it('is forgotten when the Test fails, and announced', async () => {
		const jev = await hostedReady();
		await testSystemOne();
		expect(await passedAt()).not.toBeNull();
		safeSend.mockClear();
		jev.replyOnce({ status: 503, body: { error: { message: 'Overloaded.' } } });

		expect((await testSystemOne()).ok).toBe(false);

		expect(await passedAt()).toBeNull();
		expect(safeSend).toHaveBeenCalledWith(SYSTEM_ONE_CHANGED_CHANNEL);
	});

	it('belongs to the setup that passed: another model or address reads as not tested', async () => {
		await hostedReady();
		await testSystemOne();
		const passed = await passedAt();

		await updateSystemOneSettingsRequest({ model: 'jev-1.12.0' });
		expect(await passedAt()).toBeNull();
		// Back to the setup that passed, which nobody has changed since.
		await updateSystemOneSettingsRequest({ model: null });
		expect(await passedAt()).toBe(passed);

		// A setting that is not part of how the engine is reached keeps the pass.
		await updateSystemOneSettingsRequest({ timeoutMs: 900, keepInputs: true });
		expect(await passedAt()).toBe(passed);

		const elsewhere = await startMockJevServer({ apiKey: STORED_KEY });
		try {
			shellEnv[TYPESAFE_BASE_URL_ENV_VAR] = elsewhere.baseUrl;
			expect(await passedAt()).toBeNull();
		} finally {
			await elsewhere.close();
		}
	});

	it('does not carry over to another engine, and the first engine keeps its own', async () => {
		await hostedReady();
		await testSystemOne();
		const passed = await passedAt();

		await updateSystemOneSettingsRequest({ engine: 'local-judge' });
		expect(await passedAt()).toBeNull();
		// The judge has no model, so its Test fails: that forgets nothing of Jev's.
		expect((await testSystemOne()).ok).toBe(false);

		await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		expect(await passedAt()).toBe(passed);
	});

	it('is dropped when the key of the engine that passed is replaced or cleared', async () => {
		await hostedReady();
		await testSystemOne();
		expect(await passedAt()).not.toBeNull();

		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		expect(await passedAt()).toBeNull();

		await testSystemOne();
		expect(await passedAt()).not.toBeNull();
		await clearSystemOneKeyRequest({ engine: 'jev-cloud' });
		expect(await passedAt()).toBeNull();
	});

	it("follows the local judge's model: another assignment reads as not tested", async () => {
		settings.set('localModelAssignments', {
			[LOCAL_JUDGE_TASK_ID]: { type: 'local', modelId: QWEN3_1_7B_ID },
		});
		generate.generateText.mockImplementation(async (request: { source: unknown }) => ({
			text: '{"answer":"yes","confidence":0.8}',
			json: { answer: 'yes', confidence: 0.8 },
			source: request.source,
			durationMs: 30,
		}));
		await updateSystemOneSettingsRequest({ engine: 'local-judge' });
		await testSystemOne();
		expect(await passedAt()).not.toBeNull();

		settings.set('localModelAssignments', {
			[LOCAL_JUDGE_TASK_ID]: { type: 'endpoint', endpointId: 'lab', model: 'qwen3:8b' },
		});

		expect(await passedAt()).toBeNull();
	});

	it('never appears in the stored settings a surface reads, and holds no key', async () => {
		await hostedReady();
		await testSystemOne();

		const report = await getSystemOneReport();

		expect(report.settings).not.toHaveProperty('testPass');
		const stored = JSON.parse(await rawState()) as { testPass: Record<string, unknown> };
		expect(Object.keys(stored.testPass).sort()).toEqual(['at', 'engine', 'signature']);
		expect(JSON.stringify(stored.testPass)).not.toContain(STORED_KEY);
	});
});

describe('testSystemOne', () => {
	it('asks nothing when System One is off', async () => {
		const jev = await hostedAt();
		expect(await testSystemOne()).toMatchObject({ ok: false, engine: 'off', code: 'off' });
		expect(jev.requests).toHaveLength(0);
	});

	it('asks the hosted engine the fixed question with the stored key and the pin', async () => {
		const jev = await hostedAt(STORED_KEY);
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud', model: 'jev-1.13.0' });

		const result = await testSystemOne();
		expect(result).toMatchObject({
			ok: true,
			engine: 'jev-cloud',
			probability: 0.91,
			calibrated: true,
		});
		expect(result.ok && result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(result)).not.toContain(STORED_KEY);

		expect(jev.requests).toHaveLength(1);
		expect(jev.requests[0].headers.authorization).toBe(`Bearer ${STORED_KEY}`);
		expect(jev.requests[0].body).toMatchObject({
			state: SYSTEM_ONE_TEST_STATE,
			model: 'jev-1.13.0',
		});
	});

	it('reports a rejected key as a result that names the engine asked', async () => {
		await hostedAt('the-right-key');
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		const result = await testSystemOne();
		expect(result).toMatchObject({ ok: false, engine: 'jev-cloud', code: 'auth' });
		expect(!result.ok && result.error).toContain('rejected the API key');
	});

	it('sends nothing when the hosted engine has no key', async () => {
		const jev = await hostedAt();
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		expect(await testSystemOne()).toMatchObject({ ok: false, engine: 'jev-cloud', code: 'auth' });
		expect(jev.requests).toHaveLength(0);
	});

	it('sends nothing when the stored key will not open, and says that is why', async () => {
		const jev = await hostedAt();
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
		shellEnv[TYPESAFE_API_KEY_ENV_VAR] = SETTINGS_ENV_KEY;
		sealOpens = false;

		const result = await testSystemOne();
		expect(result).toMatchObject({ ok: false, code: 'auth' });
		expect(!result.ok && result.error).toContain('could not be unsealed');
		expect(jev.requests).toHaveLength(0);
	});

	it('asks an OpenJev server with its own key or none, and never the TypeSafe key', async () => {
		server = await startMockJevServer();
		shellEnv[TYPESAFE_API_KEY_ENV_VAR] = SETTINGS_ENV_KEY;
		await setSystemOneKeyRequest({ engine: 'jev-cloud', key: STORED_KEY });
		await updateSystemOneSettingsRequest({ engine: 'openjev', openJevUrl: server.baseUrl });

		expect(await testSystemOne()).toMatchObject({ ok: true, engine: 'openjev', costUsd: 0 });
		expect(server.requests[0].headers.authorization).toBeUndefined();
		// An OpenJev serves the model it was started with: none is sent unless pinned.
		expect(server.requests[0].body).not.toHaveProperty('model');

		await setSystemOneKeyRequest({ key: OPENJEV_KEY });
		await testSystemOne();
		expect(server.requests[1].headers.authorization).toBe(`Bearer ${OPENJEV_KEY}`);
	});

	it('reports an engine that is too slow as a timeout, inside the stored budget', async () => {
		const jev = await hostedAt();
		jev.setDelayMs(400);
		processEnv[TYPESAFE_API_KEY_ENV_VAR] = PROCESS_ENV_KEY;
		await updateSystemOneSettingsRequest({ engine: 'jev-cloud', timeoutMs: 100 });
		expect(await testSystemOne()).toMatchObject({
			ok: false,
			engine: 'jev-cloud',
			code: 'timeout',
		});
	});

	it('asks the local judge on its assigned model, and marks the answer not calibrated', async () => {
		const jev = await hostedAt();
		settings.set('localModelAssignments', {
			[LOCAL_JUDGE_TASK_ID]: { type: 'local', modelId: QWEN3_1_7B_ID },
		});
		generate.generateText.mockImplementation(async (request: { source: unknown }) => ({
			text: '{"answer":"yes","confidence":0.8}',
			json: { answer: 'yes', confidence: 0.8 },
			source: request.source,
			durationMs: 30,
			tokensIn: 60,
			tokensOut: 8,
		}));
		await updateSystemOneSettingsRequest({ engine: 'local-judge' });

		const result = await testSystemOne();
		expect(result).toMatchObject({
			ok: true,
			engine: 'local-judge',
			probability: 0.8,
			calibrated: false,
			model: `local:${QWEN3_1_7B_ID}`,
		});
		expect(result.engineLabel).toContain('not calibrated');
		expect(jev.requests).toHaveLength(0);
	});

	it('never asks another engine when the one in force cannot answer', async () => {
		const jev = await hostedAt();
		processEnv[TYPESAFE_API_KEY_ENV_VAR] = PROCESS_ENV_KEY;
		await updateSystemOneSettingsRequest({ engine: 'local-judge' });

		const result = await testSystemOne();
		expect(result).toMatchObject({ ok: false, engine: 'local-judge', code: 'unavailable' });
		expect(jev.requests).toHaveLength(0);
		expect(generate.generateText).not.toHaveBeenCalled();
	});
});
