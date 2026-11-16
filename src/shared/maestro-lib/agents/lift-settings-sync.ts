/**
 * Federation settings sync: the host owns a hosted agent's settings, and every conductor follows.
 *
 * A hosted agent's settings live on its host. A conductor holds two kinds of local copy: the
 * pointer a lift left behind (a Session, still edited by Edit Agent, the bookmark, and `maestro-cli
 * update-agent`), and the pending edits made on a mirrored agent while its peer was down. This
 * module compares such a copy with the host's record field by field, against the last value both
 * sides agreed on (the baseline), a three-way merge:
 *
 * - equal on both sides: agreed, nothing to do.
 * - only the host moved off the baseline: take the host's value (another conductor changed it).
 * - only this side moved: send it to the host, which broadcasts it to every conductor.
 * - both moved, or the field was never compared and the two differ: a conflict. Nothing moves
 *   until the person picks the host's value, theirs, or a merge (`resolutions`).
 *
 * The host is the default: a conflict's suggested pick is the host's value, and a value this side
 * cannot express (an unset the host would read as its own default) never overrides it.
 *
 * Shared is the agent's own setting. A tab's model, effort, read-only, save to History, thinking,
 * Enter to send, and star are each conductor's own: they ride along on that conductor's messages
 * (`TurnOverrides`) or stay on screen, so the only tab field that syncs is its name.
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
import type { PeerAgentAction } from '../client/peer-actions';
import type { AgentPatch, AgentPatchField, TabPatch, TurnOverrides } from '../client/types';
import { isHarnessControlMode } from '../providers/native-control';
import { visibleAiTabsOf } from '../store/read-stores';
import type { AgentRecord, AITabRecord } from '../store/records';
import { liftedAutoRunFolder, liftRemoteCwd } from './lift-plan';

/** A setting's value, normalized so "unset" has one spelling on both sides. */
export type SyncValue = string | number | boolean | undefined;

/** A value as JSON stores it: unset is `null`. */
export type StoredSyncValue = string | number | boolean | null;

/** The last state both sides agreed on, per field id. Stored as JSON, so unset is `null`. */
export interface LiftSyncBaseline {
	/** A missing id was never compared; `null` means both sides agreed it is unset. */
	values: Record<string, StoredSyncValue>;
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

/** How the person settled one conflict. */
export type LiftSyncResolution =
	| { take: 'host' }
	| { take: 'local' }
	/** A value of their own (a merge they approved). Written here and sent to the host. */
	| { take: 'value'; value: SyncValue };

/** One field the two sides disagree on, waiting for the person. */
export interface LiftSyncConflict {
	id: string;
	/** What a person reads: "Nudge message", "Env var FOO". */
	label: string;
	local: SyncValue;
	host: SyncValue;
	/** Free text two people may both have extended, so a merge of the two makes sense. */
	mergeable: boolean;
	/** True when the field was never compared before (the first sync of this agent). */
	firstSync: boolean;
}

export interface LiftSyncInput {
	local: AgentRecord;
	host: AgentRecord;
	baseline?: LiftSyncBaseline;
	awaiting?: Readonly<Record<string, LiftSyncEcho>>;
	resolutions?: Readonly<Record<string, LiftSyncResolution>>;
	now: number;
}

/** One host call, and the field ids it settles. */
export interface LiftSyncPush {
	action: PeerAgentAction;
	ids: string[];
	/** `update-agent` only: the ids each patch field carries, for a partly applied update. */
	fieldIds?: Partial<Record<AgentPatchField, string[]>>;
}

/** The values to write onto the local copy. */
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
	conflicts: LiftSyncConflict[];
	/** The baseline after this plan, every pushed or conflicting field still at its old value. */
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
	label: string;
	mergeable?: boolean;
	read(record: AgentRecord): SyncValue;
	/** The patch for a value, or undefined when that value cannot be sent. */
	toPatch(value: SyncValue): AgentPatch | undefined;
}

/** A field cleared with `null` on the host. */
function nullable(
	key: string,
	field: AgentPatchField,
	label: string,
	read: (value: unknown) => SyncValue = str,
	mergeable = false
): AgentFieldSpec {
	return {
		key,
		field,
		label,
		mergeable,
		read: (record) => read(record[key]),
		toPatch: (value) => ({ [field]: value ?? null }) as AgentPatch,
	};
}

const AGENT_FIELDS: readonly AgentFieldSpec[] = [
	{
		key: 'name',
		field: 'name',
		label: 'Name',
		read: (record) => str(record.name),
		toPatch: (value) => (typeof value === 'string' ? { name: value } : undefined),
	},
	{
		key: 'toolType',
		field: 'provider',
		label: 'Provider',
		read: (record) => str(record.toolType),
		toPatch: (value) => (typeof value === 'string' ? { provider: value } : undefined),
	},
	{
		key: 'cwd',
		field: 'cwd',
		label: 'Working directory',
		read: (record) => liftRemoteCwd(record) || undefined,
		toPatch: (value) => (typeof value === 'string' ? { cwd: value } : undefined),
	},
	{
		key: 'autoRunFolderPath',
		field: 'autoRunFolderPath',
		label: 'Auto Run folder',
		read: (record) => liftedAutoRunFolder(record, liftRemoteCwd(record)),
		// An empty folder is the host's default, `.maestro/playbooks` under the working directory.
		toPatch: (value) => ({ autoRunFolderPath: typeof value === 'string' ? value : '' }),
	},
	nullable('customModel', 'model', 'Model'),
	nullable('customEffort', 'effort', 'Effort'),
	nullable('customContextWindow', 'contextWindow', 'Context window', (value) =>
		typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
	),
	nullable('contextWindowSource', 'contextWindowSource', 'Context window source'),
	nullable('customPath', 'customPath', 'Custom path'),
	nullable('customArgs', 'customArgs', 'Custom arguments', str, true),
	nullable('nudgeMessage', 'nudgeMessage', 'Nudge message', str, true),
	nullable('newSessionMessage', 'newSessionMessage', 'New session message', str, true),
	{
		key: 'bookmarked',
		field: 'bookmarked',
		label: 'Bookmark',
		read: (record) => flag(record.bookmarked),
		toPatch: (value) => ({ bookmarked: value === true }),
	},
	nullable('enableMaestroP', 'enableMaestroP', 'Token source (maestro-p)', bool),
	nullable('maestroPMode', 'maestroPMode', 'Token source mode', (value) =>
		value === 'interactive' || value === 'dynamic' ? value : undefined
	),
	// `exec` is the default and is stored unset, so it reads as unset on both sides.
	nullable('codexTransport', 'codexTransport', 'Codex transport', (value) =>
		isCodexTransport(value) && value !== 'exec' ? value : undefined
	),
	nullable('harnessControlMode', 'harnessControlMode', 'Harness control mode', (value) =>
		isHarnessControlMode(value) && value !== 'current' ? value : undefined
	),
];

const AGENT_FIELD_BY_KEY = new Map(AGENT_FIELDS.map((spec) => [spec.key, spec]));

// ---------------------------------------------------------------------------
// The Federation decision for every setting a host can be asked to change
// ---------------------------------------------------------------------------

/**
 * Where a setting of a hosted agent lives:
 * - `shared`: on the host. Every conductor sees it; this sync sends and takes it.
 * - `personal`: each conductor's own, sent with that conductor's messages (`TurnOverrides`) and
 *   never written to the host.
 * - `machine`: means something only on one machine (a Left Bar group, an SSH setting, a binary
 *   path here). Never sent.
 */
export type FederationSettingScope = 'shared' | 'personal' | 'machine';

export interface FederationSettingRule {
	scope: FederationSettingScope;
	/** Why, for the next person who reads this table. */
	why: string;
}

/**
 * Every field `agents.update` takes, with its Federation decision. A `Record` over
 * `AgentPatchField`, so a field added to `AgentPatch` does not compile until someone decides
 * here; a `shared` one must also have a spec in `AGENT_FIELDS` (or be `env`), which a test checks.
 * Read `docs/agent-guides/FEDERATION.md` before changing a row.
 */
export const AGENT_PATCH_FEDERATION: Readonly<Record<AgentPatchField, FederationSettingRule>> = {
	name: { scope: 'shared', why: 'Every conductor names the agent the same way.' },
	cwd: { scope: 'shared', why: 'The directory the provider runs in, on the host.' },
	groupId: {
		scope: 'machine',
		why: 'Left Bar groups are per machine; the host has its own group ids.',
	},
	provider: { scope: 'shared', why: 'The host runs the provider.' },
	model: { scope: 'shared', why: 'The agent default; a tab override is personal.' },
	effort: { scope: 'shared', why: 'The agent default; a tab override is personal.' },
	contextWindow: { scope: 'shared', why: 'Part of how the host runs every turn.' },
	customPath: {
		scope: 'shared',
		why: 'The provider binary on the host (an SSH agent already used the remote path).',
	},
	customArgs: { scope: 'shared', why: 'Arguments for the provider the host runs.' },
	env: {
		scope: 'shared',
		why: 'Per variable name, and only names this agent set; secrets only when the host holds them.',
	},
	ssh: {
		scope: 'machine',
		why: 'A hosted agent runs on the host; SSH settings would point it back out.',
	},
	autoRunFolderPath: {
		scope: 'shared',
		why: 'Only a folder inside the working directory; elsewhere is a path the host may not share.',
	},
	nudgeMessage: { scope: 'shared', why: 'Added to every turn the host runs.' },
	newSessionMessage: {
		scope: 'shared',
		why: 'Added to the first turn of every session the host starts.',
	},
	bookmarked: { scope: 'shared', why: 'The host keeps the bookmark, so every conductor sees it.' },
	contextWindowSource: { scope: 'shared', why: 'Provenance of the shared context window.' },
	enableMaestroP: { scope: 'shared', why: 'The token source the host runs turns with.' },
	maestroPMode: { scope: 'shared', why: 'The token source the host runs turns with.' },
	maestroPPath: { scope: 'machine', why: 'A binary path on one machine.' },
	codexTransport: { scope: 'shared', why: 'How the host runs Codex turns.' },
	harnessControlMode: { scope: 'shared', why: 'How the host drives the provider.' },
};

/**
 * Every tab field `tabs.update` takes. None is shared: a tab is one conversation several conductors
 * may type into, so each keeps their own choice (`TurnOverrides`, or on screen only). The tab name,
 * which `tabs.rename` sets, is the one shared tab field.
 */
export const TAB_PATCH_FEDERATION: Readonly<Record<keyof TabPatch, FederationSettingRule>> = {
	model: { scope: 'personal', why: 'Sent with each message as `TurnOverrides.model`.' },
	effort: { scope: 'personal', why: 'Sent with each message as `TurnOverrides.effort`.' },
	readOnly: { scope: 'personal', why: 'Sent with each message as `TurnOverrides.readOnly`.' },
	saveToHistory: {
		scope: 'personal',
		why: 'Sent with each message as `TurnOverrides.saveToHistory`.',
	},
	thinking: { scope: 'personal', why: 'How this conductor shows the transcript; never sent.' },
	enterToSend: { scope: 'personal', why: "This conductor's keyboard habit; never sent." },
};

/** Every personal tab choice a message can carry, so a new one is a compile error here too. */
export const TURN_OVERRIDE_FIELDS: Readonly<Record<keyof TurnOverrides, keyof TabPatch>> = {
	model: 'model',
	effort: 'effort',
	readOnly: 'readOnly',
	saveToHistory: 'saveToHistory',
};

/**
 * Agent settings Edit Agent writes that the host cannot take yet: `AgentPatch` has no field for
 * them, so they stay on this machine and a hosted agent runs without them. Each is a gap to close
 * by adding the field to `AgentPatch`, the host, and `AGENT_PATCH_FEDERATION`.
 */
export const HOSTED_SETTINGS_NOT_YET_SYNCED: Readonly<Record<string, string>> = {
	additionalDirectories: 'Extra directories the provider may read; no host field yet.',
	retryOnAvailabilityErrors: 'Agent Resilience retry on 529 and outages; no host field yet.',
	retryOnTokenExhaustion: 'Agent Resilience retry on quota; no host field yet.',
	codexAutoResetOnExhaustion: "Spends this machine's Codex reset credits; no host field yet.",
	customEnvVarsDisabled: 'Env vars parked with the eye button; the host keeps only live ones.',
};

/** The `agents.update` fields this sync sends and takes (the `shared` rows that have a spec). */
export function syncedAgentPatchFields(): AgentPatchField[] {
	return [...new Set<AgentPatchField>([...AGENT_FIELDS.map((spec) => spec.field), 'env'])];
}

/** The settings an import cannot carry; a lift sends them right after it (`liftFollowUpPatch`). */
const IMPORT_GAP_KEYS: ReadonlySet<string> = new Set([
	'bookmarked',
	'enableMaestroP',
	'maestroPMode',
	'codexTransport',
	'harnessControlMode',
	'contextWindowSource',
]);

/**
 * The part of an agent's settings `agents.import` does not carry, as the update a lift sends right
 * after the import, so the hosted copy starts complete and the first sync finds nothing to ask.
 * Undefined when the agent sets none of them.
 */
export function liftFollowUpPatch(agent: AgentRecord): AgentPatch | undefined {
	let patch: AgentPatch = {};
	for (const spec of AGENT_FIELDS) {
		if (!IMPORT_GAP_KEYS.has(spec.key)) continue;
		const value = spec.read(agent);
		if (value === undefined) continue;
		const part = spec.toPatch(value);
		if (part) patch = { ...patch, ...part };
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

/** The only tab field all conductors share; the rest are each conductor's own. */
const TAB_NAME_KEY = 'name';

// ---------------------------------------------------------------------------
// Field ids
// ---------------------------------------------------------------------------

const ENV_PREFIX = 'env:';
const TAB_PREFIX = 'tab:';

function envId(key: string): string {
	return `${ENV_PREFIX}${key}`;
}

function tabFieldId(tab: string, key: string): string {
	return `${TAB_PREFIX}${tab}:${key}`;
}

/** What a person reads for a field id, in a conflict list or `maestro-cli federation conflicts`. */
export function liftSyncFieldLabel(id: string): string {
	if (id.startsWith(ENV_PREFIX)) return `Env var ${id.slice(ENV_PREFIX.length)}`;
	if (id.startsWith(TAB_PREFIX)) return 'Tab name';
	return AGENT_FIELD_BY_KEY.get(id)?.label ?? id;
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

export function fromStored(value: StoredSyncValue | undefined): SyncValue {
	return value === null ? undefined : value;
}

export function toStored(value: SyncValue): StoredSyncValue {
	return value === undefined ? null : value;
}

/**
 * Every shared agent setting of a record by field id (`env:NAME` for env vars), normalized. A
 * caller that edits a hosted agent compares the edited record with the host's through this.
 */
export function liftSyncAgentValues(record: AgentRecord): Record<string, SyncValue> {
	const values: Record<string, SyncValue> = {};
	for (const spec of AGENT_FIELDS) values[spec.key] = spec.read(record);
	for (const [key, value] of Object.entries(envOf(record))) values[envId(key)] = value;
	return values;
}

/**
 * The host's record with some field values replaced: the local copy a set of pending edits on a
 * mirrored agent stands for. Unset values remove the field.
 */
export function overlaySyncValues(
	host: AgentRecord,
	values: Readonly<Record<string, StoredSyncValue>>
): AgentRecord {
	const agent: Record<string, SyncValue> = {};
	const env: Record<string, string | undefined> = {};
	for (const [id, stored] of Object.entries(values)) {
		const value = fromStored(stored);
		if (id.startsWith(ENV_PREFIX)) {
			env[id.slice(ENV_PREFIX.length)] = typeof value === 'string' ? value : undefined;
		} else if (AGENT_FIELD_BY_KEY.has(id)) {
			agent[id] = value;
		}
	}
	return applyLiftSyncPull(host, { agent, env, tabs: {} });
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

type Decision = 'same' | 'push' | 'pull' | 'wait' | 'conflict';

/** Plan the sync of one hosted agent's local copy. */
export function planLiftedSettingsSync(input: LiftSyncInput): LiftSyncPlan {
	const { local, host, now } = input;
	const prior = input.baseline;
	const awaiting = input.awaiting ?? {};
	const resolutions = input.resolutions ?? {};
	const values: LiftSyncBaseline['values'] = { ...(prior?.values ?? {}) };
	const pushed: LiftSyncPlan['pushed'] = {};
	const pull: LiftSyncPull = { agent: {}, env: {}, tabs: {} };
	const conflicts: LiftSyncConflict[] = [];
	let pulls = false;

	/**
	 * Decide one field and record its baseline. `canPush` false: this side's value cannot be sent,
	 * so the host's stands. Answers the value to push or pull (a resolution may supply its own).
	 */
	const decide = (
		id: string,
		l: SyncValue,
		r: SyncValue,
		canPush: (value: SyncValue) => boolean,
		mergeable: boolean
	): { decision: Decision; value: SyncValue } => {
		const resolution = resolutions[id];
		if (l === r && !(resolution?.take === 'value' && resolution.value !== l)) {
			values[id] = toStored(l);
			return { decision: 'same', value: l };
		}
		const known = prior !== undefined && id in prior.values;
		if (resolution) {
			if (resolution.take === 'host') {
				values[id] = toStored(r);
				pulls = true;
				return { decision: 'pull', value: r };
			}
			const chosen = resolution.take === 'local' ? l : resolution.value;
			if (!canPush(chosen)) {
				values[id] = toStored(r);
				pulls = true;
				return { decision: 'pull', value: r };
			}
			if (known) values[id] = prior.values[id];
			else delete values[id];
			pushed[id] = { local: chosen, host: r };
			if (chosen !== l) {
				// A merged value is written here as well, so this copy shows what was sent.
				pulls = true;
			}
			return { decision: 'push', value: chosen };
		}
		const echo = awaiting[id];
		if (echo && now < echo.until && r === echo.before) return { decision: 'wait', value: l };
		if (!known) {
			conflicts.push({
				id,
				label: liftSyncFieldLabel(id),
				local: l,
				host: r,
				mergeable,
				firstSync: true,
			});
			return { decision: 'conflict', value: l };
		}
		const b = fromStored(prior.values[id]);
		const localMoved = l !== b;
		const hostMoved = r !== b;
		if (localMoved && hostMoved) {
			conflicts.push({
				id,
				label: liftSyncFieldLabel(id),
				local: l,
				host: r,
				mergeable,
				firstSync: false,
			});
			return { decision: 'conflict', value: l };
		}
		if (localMoved && canPush(l)) {
			pushed[id] = { local: l, host: r };
			return { decision: 'push', value: l };
		}
		values[id] = toStored(r);
		pulls = true;
		return { decision: 'pull', value: r };
	};

	const pushes: LiftSyncPush[] = [];

	// -- agent fields --------------------------------------------------------
	let agentPatch: AgentPatch = {};
	const agentIds: string[] = [];
	const fieldIds: Partial<Record<AgentPatchField, string[]>> = {};
	for (const spec of AGENT_FIELDS) {
		const l = spec.read(local);
		const r = spec.read(host);
		const { decision, value } = decide(
			spec.key,
			l,
			r,
			(candidate) => spec.toPatch(candidate) !== undefined,
			spec.mergeable === true
		);
		if (decision === 'push') {
			const patch = spec.toPatch(value);
			if (!patch) continue;
			agentPatch = { ...agentPatch, ...patch };
			agentIds.push(spec.key);
			fieldIds[spec.field] = [...(fieldIds[spec.field] ?? []), spec.key];
			if (value !== l) pull.agent[spec.key] = value;
		} else if (decision === 'pull') {
			pull.agent[spec.key] = value;
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
		const { decision, value } = decide(id, localEnv[key], hostEnv[key], () => true, false);
		let after: SyncValue = localEnv[key];
		if (decision === 'push') {
			envChanges[key] = typeof value === 'string' ? value : undefined;
			if (value !== localEnv[key]) pull.env[key] = envChanges[key];
		} else if (decision === 'pull') {
			pull.env[key] = typeof value === 'string' ? value : undefined;
			after = value;
		}
		const keepsKey =
			decision === 'push' || decision === 'wait' || decision === 'conflict'
				? true
				: after !== undefined;
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

	// -- tab names, for tabs both sides hold -----------------------------------
	const hostTabs = new Map(visibleAiTabsOf(host).map((tab) => [tab.id, tab]));
	for (const localTab of visibleAiTabsOf(local)) {
		const hostTab = hostTabs.get(localTab.id);
		if (!hostTab) continue;
		const id = tabFieldId(localTab.id, TAB_NAME_KEY);
		const l = str(localTab.name);
		const r = str(hostTab.name);
		const { decision, value } = decide(id, l, r, () => true, false);
		if (decision === 'push') {
			// An empty name clears it, so the tab shows its session id label again.
			pushes.push({
				action: {
					kind: 'rename-tab',
					tabId: localTab.id,
					name: typeof value === 'string' ? value : '',
				},
				ids: [id],
			});
			if (value !== l) (pull.tabs[localTab.id] ??= {})[TAB_NAME_KEY] = value;
		} else if (decision === 'pull') {
			(pull.tabs[localTab.id] ??= {})[TAB_NAME_KEY] = value;
		}
	}

	return { pushes, pull, pulls, conflicts, baseline: { values, envKeys }, pushed };
}

/**
 * The baseline once the host settled some pushed fields: each takes its pushed value, so a field
 * the host refused reads as a change made here next time and the host's value comes back here.
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

/** Write values onto a local agent record (the Session in the renderer). */
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
	const clean = readStoredSyncValues(values);
	if (!clean) return undefined;
	const keys = Array.isArray(envKeys)
		? envKeys.filter((key): key is string => typeof key === 'string')
		: [];
	return { values: clean, envKeys: keys };
}

/** Read a stored `{ id: value }` map, or undefined when it is not one. Bad entries are dropped. */
export function readStoredSyncValues(value: unknown): Record<string, StoredSyncValue> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const clean: Record<string, StoredSyncValue> = {};
	for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
		if (
			entry === null ||
			typeof entry === 'string' ||
			typeof entry === 'boolean' ||
			(typeof entry === 'number' && Number.isFinite(entry))
		) {
			clean[id] = entry;
		}
	}
	return clean;
}
