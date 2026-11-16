/**
 * Federation settings sync: keep a lifted agent's local pointer and its host agent the same.
 *
 * After a lift the host owns the agent, but its local pointer keeps every setting a person can
 * still change here: Edit Agent, the composer chips, the Left Bar bookmark, `maestro-cli
 * update-agent`. This module compares the two records field by field against the last state both
 * sides agreed on (the baseline), a three-way merge:
 *
 * - equal on both sides: agreed, nothing to do.
 * - only the local side moved off the baseline: send it to the host (`update-agent` /
 *   `update-tab` / `rename-tab` / `star-tab`).
 * - only the host side moved: write the host's value onto the local pointer.
 * - both moved: the local value wins, since the person is changing it here.
 *
 * A field never compared before has the host's value as its baseline, so a local difference is
 * sent (a setting changed here before this sync existed reaches the host) and nothing is pulled.
 *
 * What crosses follows the lift (`planAgentLift()`): the provider's working directory on the
 * remote (`liftRemoteCwd()`), a playbook folder only inside it (`liftedAutoRunFolder()`), and env
 * vars the person set on the agent. A secret env var crosses only when the host already holds it
 * (a lift `--with-env` sent it); one the lift withheld stays here. A host env var this agent never
 * set (a provider-level default the lift folded in) is never pulled or removed. Not synced: the
 * Left Bar group (each machine has its own groups), the SSH settings (the host agent runs there),
 * and the maestro-p binary path (a path on this machine).
 *
 * Pure: no I/O, no clock. The caller runs the actions, applies the pull, and keeps the baseline.
 */

import { isSecretEnvKey, isBlankEnvKey, isBlankEnvValue } from '../../agentEnvironment';
import { isCodexTransport } from '../../codexTransport';
import { asThinkingMode } from '../../types';
import type { PeerAgentAction } from '../client/peer-actions';
import type { AgentPatch, AgentPatchField, TabPatch } from '../client/types';
import { isHarnessControlMode } from '../providers/native-control';
import { visibleAiTabsOf } from '../store/read-stores';
import type { AgentRecord, AITabRecord } from '../store/records';
import { liftedAutoRunFolder, liftRemoteCwd } from './lift-plan';

/** A setting's value, normalized so "unset" has one spelling on both sides. */
export type SyncValue = string | number | boolean | undefined;

/** The last state both sides agreed on, per field id. Stored as JSON, so unset is `null`. */
export interface LiftSyncBaseline {
	/** A missing id was never compared; `null` means both sides agreed it is unset. */
	values: Record<string, string | number | boolean | null>;
	/** The env var names this agent holds that the sync follows; one that leaves was removed here. */
	envKeys: string[];
}

/**
 * A field sent to the host whose new value has not come back in the host's record yet. Until it
 * does (or `until` passes), the host's old value is not read as a change made there.
 */
export interface LiftSyncEcho {
	before: SyncValue;
	until: number;
}

export interface LiftSyncInput {
	local: AgentRecord;
	host: AgentRecord;
	baseline?: LiftSyncBaseline;
	awaiting?: Readonly<Record<string, LiftSyncEcho>>;
	now: number;
}

/** One host call, and the field ids it settles. */
export interface LiftSyncPush {
	action: PeerAgentAction;
	ids: string[];
	/** `update-agent` only: the ids each patch field carries, for a partly applied update. */
	fieldIds?: Partial<Record<AgentPatchField, string[]>>;
}

/** The host's values to write onto the local pointer. */
export interface LiftSyncPull {
	agent: Record<string, SyncValue>;
	env: Record<string, string | undefined>;
	tabs: Record<string, Record<string, SyncValue>>;
}

export interface LiftSyncPlan {
	pushes: LiftSyncPush[];
	pull: LiftSyncPull;
	/** True when `pull` changes anything. */
	pulls: boolean;
	/** The baseline after this plan, every pushed field still at its old agreed value. */
	baseline: LiftSyncBaseline;
	/** Each pushed field's local value (what the host should end at) and the host's value now. */
	pushed: Record<string, { local: SyncValue; host: SyncValue }>;
}

// ---------------------------------------------------------------------------
// Field specs
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function flag(value: unknown): true | undefined {
	return value === true ? true : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

interface AgentFieldSpec {
	/** The record key, also the field id. */
	key: string;
	/** The patch field that carries it. */
	field: AgentPatchField;
	read(record: AgentRecord): SyncValue;
	/** The patch for a value, or undefined when that value cannot be sent. */
	toPatch(value: SyncValue): AgentPatch | undefined;
}

/** A field cleared with `null` on the host. */
function nullable(
	key: string,
	field: AgentPatchField,
	read: (value: unknown) => SyncValue = str
): AgentFieldSpec {
	return {
		key,
		field,
		read: (record) => read(record[key]),
		toPatch: (value) => ({ [field]: value ?? null }) as AgentPatch,
	};
}

const AGENT_FIELDS: readonly AgentFieldSpec[] = [
	{
		key: 'name',
		field: 'name',
		read: (record) => str(record.name),
		toPatch: (value) => (typeof value === 'string' ? { name: value } : undefined),
	},
	{
		key: 'toolType',
		field: 'provider',
		read: (record) => str(record.toolType),
		toPatch: (value) => (typeof value === 'string' ? { provider: value } : undefined),
	},
	{
		key: 'cwd',
		field: 'cwd',
		read: (record) => liftRemoteCwd(record) || undefined,
		toPatch: (value) => (typeof value === 'string' ? { cwd: value } : undefined),
	},
	{
		key: 'autoRunFolderPath',
		field: 'autoRunFolderPath',
		read: (record) => liftedAutoRunFolder(record, liftRemoteCwd(record)),
		// An empty folder is the host's default, `.maestro/playbooks` under the working directory.
		toPatch: (value) => ({ autoRunFolderPath: typeof value === 'string' ? value : '' }),
	},
	nullable('customModel', 'model'),
	nullable('customEffort', 'effort'),
	nullable('customContextWindow', 'contextWindow', (value) =>
		typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
	),
	nullable('contextWindowSource', 'contextWindowSource'),
	nullable('customPath', 'customPath'),
	nullable('customArgs', 'customArgs'),
	nullable('nudgeMessage', 'nudgeMessage'),
	nullable('newSessionMessage', 'newSessionMessage'),
	{
		key: 'bookmarked',
		field: 'bookmarked',
		read: (record) => flag(record.bookmarked),
		toPatch: (value) => ({ bookmarked: value === true }),
	},
	nullable('enableMaestroP', 'enableMaestroP', bool),
	nullable('maestroPMode', 'maestroPMode', (value) =>
		value === 'interactive' || value === 'dynamic' ? value : undefined
	),
	// `exec` is the default and is stored unset, so it reads as unset on both sides.
	nullable('codexTransport', 'codexTransport', (value) =>
		isCodexTransport(value) && value !== 'exec' ? value : undefined
	),
	nullable('harnessControlMode', 'harnessControlMode', (value) =>
		isHarnessControlMode(value) && value !== 'current' ? value : undefined
	),
];

/** What one tab field sends: a rename, a star, or a `tabs.update` patch. */
type TabPushPart = { name: string } | { starred: boolean } | { patch: TabPatch };

interface TabFieldSpec {
	key: string;
	read(tab: AITabRecord): SyncValue;
	toPush(value: SyncValue): TabPushPart | undefined;
}

const TAB_FIELDS: readonly TabFieldSpec[] = [
	{
		key: 'name',
		read: (tab) => str(tab.name),
		// An empty name clears it, so the tab shows its session id label again.
		toPush: (value) => ({ name: typeof value === 'string' ? value : '' }),
	},
	{
		key: 'starred',
		read: (tab) => flag(tab.starred),
		toPush: (value) => ({ starred: value === true }),
	},
	{
		key: 'customModel',
		read: (tab) => str(tab.customModel),
		toPush: (value) => ({ patch: { model: typeof value === 'string' ? value : null } }),
	},
	{
		key: 'customEffort',
		read: (tab) => str(tab.customEffort),
		toPush: (value) => ({ patch: { effort: typeof value === 'string' ? value : null } }),
	},
	{
		key: 'readOnlyMode',
		read: (tab) => flag(tab.readOnlyMode),
		toPush: (value) => ({ patch: { readOnly: value === true } }),
	},
	{
		key: 'showThinking',
		read: (tab) => {
			const mode = asThinkingMode(tab.showThinking);
			return mode && mode !== 'off' ? mode : undefined;
		},
		toPush: (value) => ({ patch: { thinking: asThinkingMode(value) ?? 'off' } }),
	},
	{
		key: 'saveToHistory',
		read: (tab) => bool(tab.saveToHistory),
		// Unset takes the host's default, which no patch can ask for: the host's value stands.
		toPush: (value) =>
			typeof value === 'boolean' ? { patch: { saveToHistory: value } } : undefined,
	},
	{
		key: 'enterToSend',
		read: (tab) => bool(tab.enterToSend),
		toPush: (value) => ({ patch: { enterToSend: typeof value === 'boolean' ? value : null } }),
	},
];

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

const ENV_PREFIX = 'env:';

function envId(key: string): string {
	return `${ENV_PREFIX}${key}`;
}

function tabId(tab: string, key: string): string {
	return `tab:${tab}:${key}`;
}

/** The env vars a record sets, blank names and values dropped (blank means unset). */
function envOf(record: AgentRecord): Record<string, string> {
	const env: Record<string, string> = {};
	const raw = record.customEnvVars;
	if (!raw || typeof raw !== 'object') return env;
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== 'string' || isBlankEnvKey(key) || isBlankEnvValue(value)) continue;
		env[key] = value;
	}
	return env;
}

function fromStored(value: string | number | boolean | null | undefined): SyncValue {
	return value === null ? undefined : value;
}

function toStored(value: SyncValue): string | number | boolean | null {
	return value === undefined ? null : value;
}

type Decision = 'same' | 'push' | 'pull' | 'wait';

/** Plan the sync of one lifted agent. */
export function planLiftedSettingsSync(input: LiftSyncInput): LiftSyncPlan {
	const { local, host, now } = input;
	const prior = input.baseline;
	const awaiting = input.awaiting ?? {};
	const values: LiftSyncBaseline['values'] = { ...(prior?.values ?? {}) };
	const pushed: LiftSyncPlan['pushed'] = {};
	const pull: LiftSyncPull = { agent: {}, env: {}, tabs: {} };
	let pulls = false;

	/** Decide one field and record its baseline; `canPush` false makes a local edit a pull. */
	const decide = (id: string, l: SyncValue, r: SyncValue, canPush: boolean): Decision => {
		if (l === r) {
			values[id] = toStored(l);
			return 'same';
		}
		const echo = awaiting[id];
		if (echo && now < echo.until && r === echo.before) return 'wait';
		const known = prior !== undefined && id in prior.values;
		const b = known ? fromStored(prior.values[id]) : r;
		values[id] = toStored(b);
		if (l !== b && canPush) {
			pushed[id] = { local: l, host: r };
			return 'push';
		}
		values[id] = toStored(r);
		pulls = true;
		return 'pull';
	};

	const pushes: LiftSyncPush[] = [];

	// -- agent fields --------------------------------------------------------
	let agentPatch: AgentPatch = {};
	const agentIds: string[] = [];
	const fieldIds: Partial<Record<AgentPatchField, string[]>> = {};
	for (const spec of AGENT_FIELDS) {
		const l = spec.read(local);
		const r = spec.read(host);
		const patch = l === r ? undefined : spec.toPatch(l);
		const decision = decide(spec.key, l, r, patch !== undefined);
		if (decision === 'push' && patch) {
			agentPatch = { ...agentPatch, ...patch };
			agentIds.push(spec.key);
			fieldIds[spec.field] = [...(fieldIds[spec.field] ?? []), spec.key];
		} else if (decision === 'pull') {
			pull.agent[spec.key] = r;
		}
	}

	// -- env vars, one field per name ----------------------------------------
	const localEnv = envOf(local);
	const hostEnv = envOf(host);
	const scope = new Set([...Object.keys(localEnv), ...(prior?.envKeys ?? [])]);
	const envKeys: string[] = [];
	const envChanges: Record<string, string | undefined> = {};
	for (const key of [...scope].sort()) {
		if (isSecretEnvKey(key) && !(key in hostEnv)) continue;
		const id = envId(key);
		const decision = decide(id, localEnv[key], hostEnv[key], true);
		if (decision === 'push') envChanges[key] = localEnv[key];
		else if (decision === 'pull') pull.env[key] = hostEnv[key];
		const keepsKey =
			decision === 'push' || decision === 'wait'
				? true
				: (decision === 'pull' ? hostEnv[key] : localEnv[key]) !== undefined;
		if (keepsKey) envKeys.push(key);
	}
	const envChangeKeys = Object.keys(envChanges);
	if (envChangeKeys.length > 0) {
		// The patch replaces the host's whole map, so what this agent does not follow is kept.
		const next: Record<string, string> = {};
		const raw = host.customEnvVars;
		if (raw && typeof raw === 'object') {
			for (const [key, value] of Object.entries(raw)) {
				if (typeof value === 'string') next[key] = value;
			}
		}
		for (const key of envChangeKeys) {
			const value = envChanges[key];
			if (value === undefined) delete next[key];
			else next[key] = value;
		}
		agentPatch = { ...agentPatch, env: Object.keys(next).length > 0 ? next : null };
		const ids = envChangeKeys.map(envId);
		agentIds.push(...ids);
		fieldIds.env = ids;
	}
	if (agentIds.length > 0) {
		pushes.push({ action: { kind: 'update-agent', patch: agentPatch }, ids: agentIds, fieldIds });
	}

	// -- tabs both sides hold --------------------------------------------------
	const hostTabs = new Map(visibleAiTabsOf(host).map((tab) => [tab.id, tab]));
	for (const localTab of visibleAiTabsOf(local)) {
		const hostTab = hostTabs.get(localTab.id);
		if (!hostTab) continue;
		let name: { value: string; id: string } | undefined;
		let starred: { value: boolean; id: string } | undefined;
		let patch: TabPatch = {};
		const patchIds: string[] = [];
		for (const spec of TAB_FIELDS) {
			const id = tabId(localTab.id, spec.key);
			const l = spec.read(localTab);
			const r = spec.read(hostTab);
			const part = l === r ? undefined : spec.toPush(l);
			const decision = decide(id, l, r, part !== undefined);
			if (decision === 'push' && part) {
				if ('name' in part) name = { value: part.name, id };
				else if ('starred' in part) starred = { value: part.starred, id };
				else {
					patch = { ...patch, ...part.patch };
					patchIds.push(id);
				}
			} else if (decision === 'pull') {
				(pull.tabs[localTab.id] ??= {})[spec.key] = r;
			}
		}
		if (name) {
			pushes.push({
				action: { kind: 'rename-tab', tabId: localTab.id, name: name.value },
				ids: [name.id],
			});
		}
		if (starred) {
			pushes.push({
				action: { kind: 'star-tab', tabId: localTab.id, starred: starred.value },
				ids: [starred.id],
			});
		}
		if (patchIds.length > 0) {
			pushes.push({ action: { kind: 'update-tab', tabId: localTab.id, patch }, ids: patchIds });
		}
	}

	return { pushes, pull, pulls, baseline: { values, envKeys }, pushed };
}

/**
 * The baseline once the host settled some pushed fields: each takes its local value, so a field
 * the host refused reads as a change made there next time and the host's value comes back here.
 */
export function settleLiftSyncBaseline(
	plan: LiftSyncPlan,
	baseline: LiftSyncBaseline,
	ids: readonly string[]
): LiftSyncBaseline {
	const values = { ...baseline.values };
	for (const id of ids) {
		const entry = plan.pushed[id];
		if (entry) values[id] = toStored(entry.local);
	}
	return { values, envKeys: baseline.envKeys };
}

/** Write the host's values onto a local agent record (the Session in the renderer). */
export function applyLiftSyncPull<T extends AgentRecord>(agent: T, pull: LiftSyncPull): T {
	const next: Record<string, unknown> = { ...agent };
	const setOrDelete = (target: Record<string, unknown>, key: string, value: unknown) => {
		if (value === undefined) delete target[key];
		else target[key] = value;
	};
	for (const [key, value] of Object.entries(pull.agent)) {
		if (key === 'cwd') {
			// The working directory lives where `liftRemoteCwd()` read it: the SSH override if set.
			const ssh = next.sessionSshRemoteConfig as Record<string, unknown> | undefined;
			if (
				ssh?.enabled &&
				typeof ssh.workingDirOverride === 'string' &&
				ssh.workingDirOverride.trim()
			) {
				next.sessionSshRemoteConfig = { ...ssh, workingDirOverride: value };
				continue;
			}
		}
		setOrDelete(next, key, value);
	}
	const envKeys = Object.keys(pull.env);
	if (envKeys.length > 0) {
		const env: Record<string, unknown> =
			next.customEnvVars && typeof next.customEnvVars === 'object'
				? { ...(next.customEnvVars as Record<string, unknown>) }
				: {};
		for (const key of envKeys) setOrDelete(env, key, pull.env[key]);
		if (Object.keys(env).length > 0) next.customEnvVars = env;
		else delete next.customEnvVars;
	}
	const tabEdits = Object.entries(pull.tabs);
	if (tabEdits.length > 0 && Array.isArray(next.aiTabs)) {
		next.aiTabs = (next.aiTabs as AITabRecord[]).map((tab) => {
			const edits = pull.tabs[tab.id];
			if (!edits) return tab;
			const edited: Record<string, unknown> = { ...tab };
			for (const [key, value] of Object.entries(edits)) setOrDelete(edited, key, value);
			return edited as AITabRecord;
		});
	}
	return next as T;
}

/** Read a stored baseline, or undefined for a malformed one (the sync then starts over). */
export function readLiftSyncBaseline(value: unknown): LiftSyncBaseline | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const { values, envKeys } = value as Record<string, unknown>;
	if (!values || typeof values !== 'object' || Array.isArray(values)) return undefined;
	const clean: LiftSyncBaseline['values'] = {};
	for (const [id, entry] of Object.entries(values as Record<string, unknown>)) {
		if (
			entry === null ||
			typeof entry === 'string' ||
			typeof entry === 'boolean' ||
			(typeof entry === 'number' && Number.isFinite(entry))
		) {
			clean[id] = entry;
		}
	}
	const keys = Array.isArray(envKeys)
		? envKeys.filter((key): key is string => typeof key === 'string')
		: [];
	return { values: clean, envKeys: keys };
}
