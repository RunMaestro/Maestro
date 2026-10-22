/**
 * System One as Settings > Models > System One and `maestro-cli s1` see it: the
 * engine in force, where its key comes from, the change of either, and the Test.
 *
 * Both transports call these functions, the card through the
 * `localModels:systemOne:*` IPC channels and the CLI through the WS bridge, so a
 * key stored from one is the key the other reports. The questions themselves
 * are asked by `jev-client.ts` (Jev, OpenJev) and `local-judge.ts`; this module
 * is where the stored choice becomes an engine that is ready to call.
 *
 * Three rules hold here, for every caller:
 *
 *   1. **A key never leaves.** `resolveSystemOneKey` is the one function that
 *      opens one, and it hands it to a call. Reports carry where a key comes
 *      from, never the key. Nothing here logs one.
 *   2. **The hosted key has two read-only fallbacks**, in this order after the
 *      key Maestro stores: `TYPESAFE_API_KEY` (Settings > Environment, then the
 *      environment Maestro was started in) and the `jev` CLI's key file. They
 *      are never written and never sent to an OpenJev server, which is somebody
 *      else's machine: an OpenJev uses only the key stored for it.
 *   3. **Nothing falls back.** A stored key that will not open is reported as
 *      that, and the engine has no key; it does not reach for the variable or
 *      the file instead. An engine that cannot answer is never replaced by
 *      another one.
 *   4. **A Test pass belongs to the setup that passed.** `testSystemOne` records
 *      which engine answered and how it was set up; a changed address, model or
 *      key reads as not tested. Agents may ask only after a pass
 *      (`agent-service.ts`), so a setup nobody ever saw answer is never handed
 *      to them.
 */

import { safeStorage } from 'electron';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { isBlankEnvValue } from '../../../shared/agentEnvironment';
import { canonicalJson } from '../../../shared/canonicalJson';
import { normalizeEndpointBaseUrl } from '../../../shared/local-models/endpoints';
import { modelsSettingsLocation } from '../../../shared/local-models/settings-location';
import {
	JEV_CLOUD_BASE_URL,
	JEV_DEFAULT_MODEL,
	isSystemOneEngineCalibrated,
	systemOneEngineHost,
	systemOneEngineLabel,
	type SystemOneEngineId,
	type SystemOneErrorCode,
	type SystemOneFailPolicy,
	type SystemOneQuestions,
	type SystemOneRemoteEngine,
	type SystemOneRemoteEngineId,
	type SystemOneResult,
	type SystemOneState,
} from '../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_ENGINE_DISCLOSURES,
	SYSTEM_ONE_REMOTE_ENGINE_IDS,
	SYSTEM_ONE_TEST_QUESTIONS,
	SYSTEM_ONE_TEST_QUESTION_ID,
	SYSTEM_ONE_TEST_STATE,
	TYPESAFE_API_KEY_ENV_VAR,
	TYPESAFE_API_KEY_FILE,
	TYPESAFE_BASE_URL_ENV_VAR,
	applySystemOneSettingsPatch,
	isSystemOneRemoteEngineId,
	resolveSystemOneFailPolicy,
	systemOneEngineChoiceLabel,
	systemOneFailPolicyRows,
	systemOneKeyProblem,
	systemOneRequestTimeoutMs,
	systemOneUrlProblem,
	type SystemOneAgentSettings,
	type SystemOneKeyInfo,
	type SystemOneReport,
	type SystemOneSettings,
	type SystemOneTestResult,
} from '../../../shared/local-models/system-one-settings';
import {
	LOCAL_JUDGE_TASK_ID,
	formatLocalModelAssignmentSpec,
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
	type LocalModelTaskId,
} from '../../../shared/local-models/tasks';
import { getSettingsStore } from '../../stores/getters';
import { logger } from '../../utils/logger';
import type { SafeSendFn } from '../../utils/safe-send';
import { safeStorageSeal, type SealProvider } from '../../utils/safe-storage-seal';
import { getConfiguredLocalModelEndpoints } from '../endpoint-service';
import { SystemOneError, isSystemOneError } from '../errors';
import { localModelsDataDir } from '../paths';
import { readLocalModelAssignments } from '../sources';
import {
	clearSystemOneKey,
	clearSystemOneTestPass,
	readSystemOneSettings,
	readSystemOneSetup,
	readSystemOneStoredKey,
	storeSystemOneKey,
	storeSystemOneTestPass,
	updateSystemOneSettings,
	type SystemOneTestPass,
} from './config-store';
import { askSystemOne } from './jev-client';
import { askLocalJudge, localJudgeNoModelMessage } from './local-judge';

const LOG_CONTEXT = 'SystemOne';

/** The push channel that says the settings or a key changed. Read the report for the rest. */
export const SYSTEM_ONE_CHANGED_CHANNEL = 'localModels:systemOne:changed';

// ---------------------------------------------------------------------------
// The app's services
// ---------------------------------------------------------------------------

export interface SystemOneDeps {
	/** Maestro's data folder. Defaults to `localModelsDataDir()`. */
	dataDir?: () => string;
	/** The OS seal for the keys. Defaults to Electron's `safeStorage`. */
	osSeal?: () => SealProvider;
	/** Settings > Environment. Defaults to the `shellEnvVars` setting. */
	shellEnvVars?: () => Record<string, string>;
	/** The environment Maestro was started in. Defaults to `process.env`. */
	processEnv?: () => Record<string, string | undefined>;
	/** The home folder the `jev` CLI's key file is under. Defaults to `os.homedir()`. */
	homeDir?: () => string;
	/** Tells every window the settings or a key changed. */
	safeSend?: SafeSendFn;
}

let deps: SystemOneDeps = {};

/** Point System One at the app's services. Reads nothing and sends nothing. */
export function configureSystemOne(next: SystemOneDeps): void {
	deps = next;
}

function dataDir(): string {
	return (deps.dataDir ?? localModelsDataDir)();
}

/** The data folder System One keeps its files in: the settings, and the answer cache. */
export function systemOneDataDir(): string {
	return dataDir();
}

function osSeal(): SealProvider {
	return (deps.osSeal ?? (() => safeStorageSeal(safeStorage)))();
}

function shellEnvVars(): Record<string, string> {
	return (
		deps.shellEnvVars ??
		(() => getSettingsStore().get('shellEnvVars', {}) as Record<string, string>)
	)();
}

function processEnv(): Record<string, string | undefined> {
	return (deps.processEnv ?? (() => process.env))();
}

function announceChange(): void {
	deps.safeSend?.(SYSTEM_ONE_CHANGED_CHANNEL);
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/** An engine's key with where it came from. `key` is absent when there is none to use. */
export interface ResolvedSystemOneKey {
	key?: string;
	info: SystemOneKeyInfo;
}

/** A variable's value and which environment holds it, Settings > Environment first. */
function readEnvVar(name: string): { value: string; from: 'settings' | 'process' } | null {
	const configured = shellEnvVars()[name];
	if (typeof configured === 'string' && !isBlankEnvValue(configured)) {
		return { value: configured.trim(), from: 'settings' };
	}
	const inherited = processEnv()[name];
	if (typeof inherited === 'string' && !isBlankEnvValue(inherited)) {
		return { value: inherited.trim(), from: 'process' };
	}
	return null;
}

/** The `jev` CLI's key file. A file that is missing, unreadable or not a key reads as no key. */
async function readJevKeyFile(): Promise<{ key: string; path: string } | null> {
	const file = path.join((deps.homeDir ?? os.homedir)(), ...TYPESAFE_API_KEY_FILE);
	let text: string;
	try {
		text = await fs.readFile(file, 'utf-8');
	} catch {
		return null;
	}
	const key = text.trim();
	return systemOneKeyProblem(key) === null ? { key, path: file } : null;
}

function unreadableKeyMessage(engine: SystemOneRemoteEngineId, reason: string): string {
	const why =
		reason === 'store-unavailable'
			? "is sealed with this system's key store, which is not available now"
			: 'could not be unsealed';
	return `The stored key for ${systemOneEngineLabel(engine)} ${why}. Replace it or clear it in ${modelsSettingsLocation('system-one')}.`;
}

/**
 * The key a remote engine is called with, and its source.
 *
 * The stored key wins. The hosted engine then reads `TYPESAFE_API_KEY` and the
 * `jev` CLI's key file; an OpenJev reads nothing else. A stored key that does
 * not open answers with no key and the reason: it does not fall through.
 */
export async function resolveSystemOneKey(
	engine: SystemOneRemoteEngineId
): Promise<ResolvedSystemOneKey> {
	const stored = await readSystemOneStoredKey(dataDir(), engine, osSeal());
	if (stored.state === 'ok') {
		return { key: stored.key, info: { source: 'stored', storage: stored.storage } };
	}
	if (stored.state === 'unreadable') {
		return {
			info: {
				source: 'stored',
				storage: stored.storage,
				problem: unreadableKeyMessage(engine, stored.reason),
			},
		};
	}
	if (engine !== 'jev-cloud') return { info: { source: 'none' } };

	const variable = readEnvVar(TYPESAFE_API_KEY_ENV_VAR);
	if (variable) {
		return {
			key: variable.value,
			info: { source: 'env', envVar: TYPESAFE_API_KEY_ENV_VAR, from: variable.from },
		};
	}
	const file = await readJevKeyFile();
	if (file) return { key: file.key, info: { source: 'file', path: file.path } };
	return { info: { source: 'none' } };
}

// ---------------------------------------------------------------------------
// The engine in force
// ---------------------------------------------------------------------------

/** Why an engine cannot be asked as it is set up. Found from the settings; nothing is sent. */
interface Refusal {
	code: SystemOneErrorCode;
	message: string;
}

/** The stored choice, turned into something that can be called. */
export type ResolvedSystemOneEngine =
	| { id: 'off' }
	| { id: 'local-judge'; timeoutMs: number; refusal: Refusal | null }
	| {
			id: SystemOneRemoteEngineId;
			engine: SystemOneRemoteEngine;
			/** The pinned model, when there is one. */
			model?: string;
			timeoutMs: number;
			key: SystemOneKeyInfo;
			refusal: Refusal | null;
	  };

/** The hosted API's address: `TYPESAFE_BASE_URL` when it is set, as the `jev` CLI reads it. */
function jevCloudBaseUrl(): { baseUrl: string; problem: string | null } {
	const override = readEnvVar(TYPESAFE_BASE_URL_ENV_VAR);
	if (!override) return { baseUrl: JEV_CLOUD_BASE_URL, problem: null };
	const problem = systemOneUrlProblem(override.value);
	if (problem) {
		return {
			baseUrl: JEV_CLOUD_BASE_URL,
			problem: `${TYPESAFE_BASE_URL_ENV_VAR} is set and is not a usable URL: ${problem}`,
		};
	}
	return { baseUrl: normalizeEndpointBaseUrl(override.value), problem: null };
}

function judgeHasModel(): boolean {
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), LOCAL_JUDGE_TASK_ID);
	return assignment.type === 'local' || assignment.type === 'endpoint';
}

async function resolveEngine(settings: SystemOneSettings): Promise<ResolvedSystemOneEngine> {
	const id = settings.engine;
	if (id === 'off') return { id };
	const timeoutMs = systemOneRequestTimeoutMs(settings, id);
	if (id === 'local-judge') {
		return {
			id,
			timeoutMs,
			refusal: judgeHasModel()
				? null
				: { code: 'unavailable', message: localJudgeNoModelMessage() },
		};
	}

	const where = modelsSettingsLocation('system-one');
	const { key, info } = await resolveSystemOneKey(id);
	const hosted = id === 'jev-cloud' ? jevCloudBaseUrl() : null;
	const baseUrl = hosted ? hosted.baseUrl : (settings.openJevUrl ?? '');
	const label = systemOneEngineLabel(id, { host: systemOneEngineHost(baseUrl) });

	let refusal: Refusal | null = null;
	if (hosted?.problem) refusal = { code: 'unavailable', message: hosted.problem };
	else if (id === 'openjev' && !settings.openJevUrl) {
		refusal = { code: 'unavailable', message: `OpenJev has no URL. Set it in ${where}.` };
	} else if (info.source === 'stored' && info.problem) {
		refusal = { code: 'auth', message: info.problem };
	} else if (id === 'jev-cloud' && !key) {
		refusal = { code: 'auth', message: `${label} has no API key. Add one in ${where}.` };
	}

	const model = settings.models[id];
	return {
		id,
		engine: { id, baseUrl, ...(key ? { apiKey: key } : {}) },
		...(model ? { model } : {}),
		timeoutMs,
		key: info,
		refusal,
	};
}

/** The engine in force, ready to call. Reads the settings and the key; sends nothing. */
export async function resolveSystemOneEngine(): Promise<ResolvedSystemOneEngine> {
	return resolveEngine(await readSystemOneSettings(dataDir()));
}

/** What a task needs before it asks: the engine in force, its name, and the task's fail policy. */
export interface SystemOneForTask {
	resolved: ResolvedSystemOneEngine;
	/** The engine as a person reads it. "Off" when none is chosen. */
	engineLabel: string;
	/** What the task does with no answer. Null for a task that has no fail policy. */
	failPolicy: SystemOneFailPolicy | null;
	/** "Keep inputs in the ledger": whether the run's record keeps what was asked. */
	keepInputs: boolean;
}

/**
 * The engine in force and a task's fail policy, from ONE read of the settings,
 * so the policy applied is the one stored beside the engine that was asked.
 * Reads the settings and the key; sends nothing.
 */
export async function resolveSystemOneForTask(taskId: LocalModelTaskId): Promise<SystemOneForTask> {
	const settings = await readSystemOneSettings(dataDir());
	const resolved = await resolveEngine(settings);
	return {
		resolved,
		engineLabel: engineLabelFor(settings, resolved),
		failPolicy: resolveSystemOneFailPolicy(settings.failPolicies, taskId),
		keepInputs: settings.keepInputs,
	};
}

/**
 * "Keep inputs in the ledger", for a producer that records a decision no engine
 * made (the embedding router, a task's own local judge). One setting decides
 * what every record keeps, whoever wrote it.
 */
export async function systemOneKeepsInputs(): Promise<boolean> {
	return (await readSystemOneSettings(dataDir())).keepInputs;
}

/**
 * Ask the engine in force. Rejects with a `SystemOneError` that names that
 * engine; it never asks another. `off` is not an engine: a caller decides what
 * no engine means for it before calling this.
 *
 * `timeoutMs` replaces the engine's stored budget for this one request. The
 * stored budget is sized for a gate (one question, about a second); a caller
 * that packs hundreds of questions into a request states its own.
 */
export async function askResolvedSystemOne(
	resolved: Exclude<ResolvedSystemOneEngine, { id: 'off' }>,
	state: SystemOneState,
	questions: SystemOneQuestions,
	options: { signal?: AbortSignal; timeoutMs?: number; agentId?: string } = {}
): Promise<SystemOneResult> {
	if (resolved.refusal) {
		throw new SystemOneError(resolved.refusal.message, {
			code: resolved.refusal.code,
			engine: resolved.id,
		});
	}
	const call = { timeoutMs: options.timeoutMs ?? resolved.timeoutMs, signal: options.signal };
	if (resolved.id === 'local-judge') {
		// The judge's generations are runs of their own; they carry the agent.
		return askLocalJudge(state, questions, {
			...call,
			...(options.agentId ? { agentId: options.agentId } : {}),
		});
	}
	return askSystemOne(resolved.engine, state, questions, {
		...call,
		...(resolved.model ? { model: resolved.model } : {}),
	});
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** The local judge's model: the Local judge task's assignment, spelled and named. */
function judgeModel(): { spec: string; label: string } | null {
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), LOCAL_JUDGE_TASK_ID);
	const label = localModelAssignmentSourceLabel(assignment, getConfiguredLocalModelEndpoints());
	return label === null ? null : { spec: formatLocalModelAssignmentSpec(assignment), label };
}

type ResolvedRemoteEngine = Extract<ResolvedSystemOneEngine, { engine: SystemOneRemoteEngine }>;

function remoteOf(resolved: ResolvedSystemOneEngine): ResolvedRemoteEngine | null {
	return resolved.id === 'jev-cloud' || resolved.id === 'openjev' ? resolved : null;
}

/** The engine in force as a person reads it: "OpenJev at host", "Local judge (model), not calibrated". */
function engineLabelFor(settings: SystemOneSettings, resolved: ResolvedSystemOneEngine): string {
	const baseUrl = remoteOf(resolved)?.engine.baseUrl;
	return systemOneEngineChoiceLabel(settings.engine, {
		host: baseUrl ? systemOneEngineHost(baseUrl) : null,
		model: resolved.id === 'local-judge' ? (judgeModel()?.label ?? null) : null,
	});
}

/**
 * How an engine is set up, as one comparable string: which engine, where it is
 * called, and which model answers. No key is in it and nothing is derived from
 * one; a key that changes drops the pass in the config store instead.
 */
function setupSignature(resolved: Exclude<ResolvedSystemOneEngine, { id: 'off' }>): string {
	const remote = remoteOf(resolved);
	return canonicalJson({
		engine: resolved.id,
		baseUrl: remote?.engine.baseUrl ?? null,
		model: remote ? (remote.model ?? null) : (judgeModel()?.spec ?? null),
	});
}

/** When the engine in force passed its Test as it is set up now, or null. */
function testPassedAt(
	resolved: ResolvedSystemOneEngine,
	pass: SystemOneTestPass | null
): number | null {
	if (resolved.id === 'off' || !pass || pass.engine !== resolved.id) return null;
	return pass.signature === setupSignature(resolved) ? pass.at : null;
}

/** What the agent service needs before it answers an agent: one read of the file. */
export interface SystemOneForAgents {
	resolved: ResolvedSystemOneEngine;
	/** The engine as a person reads it. "Off" when none is chosen. */
	engineLabel: string;
	/** "Let agents use System One", and the daily budgets. */
	agents: SystemOneAgentSettings;
	/** "Keep inputs in the ledger". */
	keepInputs: boolean;
	/** When the engine in force passed its Test as it is set up now, or null. */
	testPassedAt: number | null;
	/**
	 * What separates one engine's cached answers from another's, beside the
	 * request itself: where the engine is called, and the model that is ASKED
	 * (the pin, the hosted engine's moving alias, or the local judge's source).
	 */
	cacheScope: { baseUrl: string | null; model: string | null };
}

/**
 * The engine in force, what agents may do with it, and whether it has passed
 * its Test, from ONE read of the settings. Reads the settings and the key;
 * sends nothing.
 */
export async function resolveSystemOneForAgents(): Promise<SystemOneForAgents> {
	const { settings, testPass } = await readSystemOneSetup(dataDir());
	const resolved = await resolveEngine(settings);
	const remote = remoteOf(resolved);
	const model = remote
		? (remote.model ?? (remote.id === 'jev-cloud' ? JEV_DEFAULT_MODEL : null))
		: resolved.id === 'local-judge'
			? (judgeModel()?.spec ?? null)
			: null;
	return {
		resolved,
		engineLabel: engineLabelFor(settings, resolved),
		agents: settings.agents,
		keepInputs: settings.keepInputs,
		testPassedAt: testPassedAt(resolved, testPass),
		cacheScope: { baseUrl: remote?.engine.baseUrl ?? null, model },
	};
}

async function buildReport(
	settings: SystemOneSettings,
	testPass: SystemOneTestPass | null
): Promise<SystemOneReport> {
	const resolved = await resolveEngine(settings);
	const remote = remoteOf(resolved);
	const keys = {} as Record<SystemOneRemoteEngineId, SystemOneKeyInfo>;
	for (const engine of SYSTEM_ONE_REMOTE_ENGINE_IDS) {
		keys[engine] = remote?.id === engine ? remote.key : (await resolveSystemOneKey(engine)).info;
	}

	const judge = resolved.id === 'local-judge' ? judgeModel() : null;
	const pinned = remote?.model ?? null;

	return {
		settings,
		engineLabel: engineLabelFor(settings, resolved),
		disclosure: SYSTEM_ONE_ENGINE_DISCLOSURES[settings.engine],
		baseUrl: remote?.engine.baseUrl || null,
		model: judge?.spec ?? pinned,
		modelLabel: judge?.label ?? pinned,
		timeoutMs: resolved.id === 'off' ? null : resolved.timeoutMs,
		calibrated: resolved.id === 'off' ? null : isSystemOneEngineCalibrated(resolved.id),
		keys,
		problem: resolved.id === 'off' ? null : (resolved.refusal?.message ?? null),
		testPassedAt: testPassedAt(resolved, testPass),
		failPolicies: systemOneFailPolicyRows(settings.failPolicies),
	};
}

/** Everything a surface shows about System One. It carries no key and sends nothing. */
export async function getSystemOneReport(): Promise<SystemOneReport> {
	const { settings, testPass } = await readSystemOneSetup(dataDir());
	return buildReport(settings, testPass);
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/**
 * Change the engine, the OpenJev URL, a pinned model, the timeout, one task's
 * fail policy, "Keep inputs in the ledger" or what agents may do: what the
 * card's controls, the ledger's toggle and `maestro-cli s1 set` send. A change
 * that is refused rejects with the reason and writes nothing.
 */
export async function updateSystemOneSettingsRequest(raw: unknown): Promise<SystemOneReport> {
	await updateSystemOneSettings(dataDir(), (current) => {
		const change = applySystemOneSettingsPatch(current, raw);
		if (!change.ok) throw new Error(change.message);
		return change.settings;
	});
	announceChange();
	return getSystemOneReport();
}

/** The engine a key request is for: the one it names, else the one in force. */
async function keyEngine(raw: unknown): Promise<SystemOneRemoteEngineId> {
	const named = (raw as { engine?: unknown } | null)?.engine;
	if (named !== undefined) {
		if (!isSystemOneRemoteEngineId(named)) {
			throw new Error(
				`"${String(named)}" has no key. A key belongs to ${SYSTEM_ONE_REMOTE_ENGINE_IDS.join(' or ')}.`
			);
		}
		return named;
	}
	const { engine } = await readSystemOneSettings(dataDir());
	if (!isSystemOneRemoteEngineId(engine)) {
		throw new Error(
			`Name the engine the key is for: ${SYSTEM_ONE_REMOTE_ENGINE_IDS.join(' or ')}. The engine in force (${systemOneEngineChoiceLabel(engine)}) has no key.`
		);
	}
	return engine;
}

/**
 * Seal and store a key for a remote engine, replacing the one it had. The key
 * is not echoed back, in the report or anywhere else.
 */
export async function setSystemOneKeyRequest(raw: unknown): Promise<SystemOneReport> {
	const engine = await keyEngine(raw);
	const key = (raw as { key?: unknown } | null)?.key;
	const problem = systemOneKeyProblem(key);
	if (problem) throw new Error(problem);
	const storage = await storeSystemOneKey(dataDir(), engine, (key as string).trim(), osSeal());
	if (storage === 'obscured') {
		logger.warn(
			`This system offers no encryption for stored secrets, so the ${systemOneEngineLabel(engine)} key is stored obscured, not encrypted`,
			LOG_CONTEXT
		);
	}
	announceChange();
	return getSystemOneReport();
}

/** Forget the key Maestro stores for a remote engine. A fallback source is not touched. */
export async function clearSystemOneKeyRequest(raw: unknown): Promise<SystemOneReport> {
	const engine = await keyEngine(raw);
	await clearSystemOneKey(dataDir(), engine);
	announceChange();
	return getSystemOneReport();
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

/**
 * Ask the engine in force one fixed question and report the answer, the latency
 * and which engine gave it. The state is fixed text, so a test sends nothing of
 * the user's. An engine that gives no answer is a result, not a thrown error.
 *
 * The verdict is kept: an answer records the setup as having passed, and no
 * answer forgets an earlier pass. That record is what lets agents ask.
 */
export async function testSystemOne(): Promise<SystemOneTestResult> {
	const settings = await readSystemOneSettings(dataDir());
	const resolved = await resolveEngine(settings);
	const engineLabel = engineLabelFor(settings, resolved);
	if (resolved.id === 'off') {
		return {
			ok: false,
			engine: 'off',
			engineLabel,
			code: 'off',
			error: `System One is off. Choose an engine in ${modelsSettingsLocation('system-one')} first.`,
		};
	}
	const engine: SystemOneEngineId = resolved.id;
	try {
		const result = await askResolvedSystemOne(
			resolved,
			SYSTEM_ONE_TEST_STATE,
			SYSTEM_ONE_TEST_QUESTIONS
		);
		const answer = result.answers[SYSTEM_ONE_TEST_QUESTION_ID];
		if (answer?.type !== 'noul') {
			throw new SystemOneError(`${engineLabel} did not answer the test question.`, {
				code: 'unavailable',
				engine,
			});
		}
		await storeSystemOneTestPass(dataDir(), {
			engine,
			signature: setupSignature(resolved),
			at: Date.now(),
		});
		announceChange();
		return {
			ok: true,
			engine: result.engine,
			engineLabel,
			model: result.model,
			probability: answer.probability,
			latencyMs: result.latencyMs,
			calibrated: result.calibrated,
			usage: result.usage,
			costUsd: result.costUsd,
		};
	} catch (error) {
		if (!isSystemOneError(error)) throw error;
		// A Test that was cancelled says nothing about the engine.
		if (error.code !== 'cancelled' && (await clearSystemOneTestPass(dataDir(), engine))) {
			announceChange();
		}
		return { ok: false, engine, engineLabel, code: error.code, error: error.message };
	}
}

/** Forget the configured services, so each test starts from a process that set none. */
export function resetSystemOneServiceForTests(): void {
	deps = {};
}
