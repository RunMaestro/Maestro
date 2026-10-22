/**
 * Group agent defaults: the values a new agent created in a group starts with.
 *
 * The defaults are copy-at-create. They are stamped into the create-agent form
 * and never read again, so nothing here is a runtime layer and no spawn path
 * may import this module to resolve a setting.
 *
 * Shared, not renderer-only, so the desktop and `maestro-cli` write a group's
 * defaults the same way.
 *
 * `withGroupShortLabel` is here too, because Group Settings writes it in the
 * same save. It is NOT a default: a pill label is a property of the group, it
 * never reaches an agent, and it is no part of a defaults diff or a publish.
 *
 * PUBLISHING
 * Copy-at-create governs how a setting is RESOLVED. It does not have to govern
 * how one is distributed: a save may push its change into the agents already
 * in the group. That is a write into each agent's own record, never a layer
 * above it. The pure half of that is here (`diffGroupDefaults`,
 * `applyGroupDefaultsToSession`), so the desktop and `maestro-cli` push the
 * same fields by the same rules. Only the fields changed in ONE save are
 * pushed, never the whole profile: a profile that has held a model for a week
 * must not stamp it over agents the user has since retuned by hand.
 *
 * SEEDING
 * The copy itself: `resolveGroupDefaultsSeed` is the seed a new agent starts
 * from, and `groupDefaultsCreateExtras` is the part of it the create form has
 * no control for. Both are here so the desktop form and a CLI create read a
 * group's defaults by the same rules.
 */

import { canonicalJson } from './canonicalJson';
import type { BackgroundRequests } from './local-models/background-requests';
import type { LocalModelEndpoint } from './local-models/endpoints';
import { resolveRunOnLaunch, type RunOnTarget } from './local-models/run-on';
import { OFF_TOKEN_PROXY_FIELDS, type TokenProxyMode } from './local-models/token-proxy';
import type { TierTarget } from './modelTiers';
import { PEER_GRANT_LABELS } from './peerAgents';
import type { Group, GroupAgentDefaults, ToolType } from './types';

/**
 * `group` with its defaults replaced. `undefined` removes the field, so a group
 * with no opinion stores no `defaults` key at all, never an empty object: the
 * create form reads "has defaults" as "show the pre-filled banner".
 *
 * Every other field of the group is carried over, `shortLabel` included.
 */
export function withGroupDefaults(group: Group, defaults: GroupAgentDefaults | undefined): Group {
	const { defaults: _previous, ...rest } = group;
	return defaults && Object.keys(defaults).length > 0 ? { ...rest, defaults } : rest;
}

/**
 * `group` with its pill label (`shortLabel`) replaced. The label is trimmed,
 * and a blank one removes the field, so the automatic abbreviation comes back
 * and a group never stores `''`.
 *
 * The label is not cut here. `GROUP_SHORT_LABEL_MAX_LENGTH` is enforced where a
 * label is typed (the Group Settings input, the CLI flag), where the user can
 * see the cap. Read the label back with `groupBadgeLabel()`.
 */
export function withGroupShortLabel(group: Group, shortLabel: string | undefined): Group {
	const { shortLabel: _previous, ...rest } = group;
	const label = shortLabel?.trim();
	return label ? { ...rest, shortLabel: label } : rest;
}

// ============================================================================
// Publishing a save to the agents already in the group
// ============================================================================

/** One key of a group's defaults. `shortLabel` is not one: it never reaches an agent. */
export type GroupDefaultKey = keyof GroupAgentDefaults;

interface GroupDefaultField {
	/** The field's name for a person, as the form labels its control. */
	label: string;
	/** `false`: a publish never writes it to an existing agent. */
	publishable: boolean;
	/**
	 * Written for one provider's binary, models or API. A publish hands it only
	 * to the agents on that provider, the way the create form seeds it only when
	 * the seed's provider is the one selected.
	 */
	providerBound?: true;
	/**
	 * How a publish writes it over the agent's value. Absent: replaced.
	 *   - `merge`: a record, merged key by key. A key the profile never named
	 *     is left alone on the agent.
	 *   - `list`: replaced like any other value, and named in the dialog,
	 *     because it is the one lossy case: the agent's own rows are gone.
	 *   - `proxy`: not written here. The caller applies it through the token
	 *     proxy writers (see {@link GroupDefaultsProxyChange}).
	 */
	write?: 'merge' | 'list' | 'proxy';
}

/**
 * Every default, in the order the form draws them. One table, keyed by the
 * type, so a new default cannot be added without deciding whether a publish
 * may write it, and `shortLabel` cannot be listed at all.
 */
const GROUP_DEFAULT_FIELDS: Record<GroupDefaultKey, GroupDefaultField> = {
	// General
	projectRoot: { label: 'Working Directory', publishable: false },
	additionalDirectories: { label: 'Additional Directories', publishable: true, write: 'list' },
	newSessionMessage: { label: 'New Session Message', publishable: true },
	nudgeMessage: { label: 'Nudge Message', publishable: true },
	// Provider
	toolType: { label: 'Provider', publishable: false },
	customPath: { label: 'Custom Path', publishable: true, providerBound: true },
	customArgs: { label: 'Custom Arguments', publishable: true, providerBound: true },
	customModel: { label: 'Model', publishable: true, providerBound: true },
	customEffort: { label: 'Effort', publishable: true, providerBound: true },
	customContextWindow: { label: 'Context Window', publishable: true, providerBound: true },
	enableMaestroP: { label: 'Token Source', publishable: true, providerBound: true },
	maestroPMode: { label: 'Token Source Mode', publishable: true, providerBound: true },
	maestroPPath: { label: 'maestro-p Path', publishable: true, providerBound: true },
	codexTransport: { label: 'Codex Transport', publishable: true, providerBound: true },
	retryOnAvailabilityErrors: { label: 'Retry on Availability Errors', publishable: true },
	retryOnTokenExhaustion: { label: 'Retry on Token Exhaustion', publishable: true },
	codexAutoResetOnExhaustion: {
		label: 'Automatic Usage Resets',
		publishable: true,
		providerBound: true,
	},
	// Models
	runOn: { label: 'Run On', publishable: true, providerBound: true },
	tierTargets: { label: 'Tier Targets', publishable: true, providerBound: true, write: 'merge' },
	backgroundRequests: {
		label: 'Background Requests',
		publishable: true,
		providerBound: true,
		write: 'proxy',
	},
	systemOneOptOut: { label: 'System One', publishable: true },
	gatewayUrl: { label: 'Local Models Gateway', publishable: true, providerBound: true },
	tokenProxyMode: {
		label: 'Maestro Token Proxy',
		publishable: true,
		providerBound: true,
		write: 'proxy',
	},
	// Environment
	customEnvVars: { label: 'Environment Variables', publishable: true, write: 'merge' },
	customEnvVarsDisabled: {
		label: 'Environment Variables (switched off)',
		publishable: true,
		write: 'merge',
	},
	// Peers
	peerAgents: { label: 'Peer Agents', publishable: true, write: 'list' },
	groupPeerAccess: { label: PEER_GRANT_LABELS.group, publishable: true },
	worktreePeerAccess: { label: PEER_GRANT_LABELS.worktree, publishable: true },
	// SSH
	sessionSshRemoteConfig: { label: 'SSH Remote', publishable: false },
};

const GROUP_DEFAULT_KEYS = Object.keys(GROUP_DEFAULT_FIELDS) as GroupDefaultKey[];

/**
 * The defaults a publish never writes to an existing agent, whatever else it
 * writes. Each one moves the agent somewhere its conversations are not:
 *
 *   - `toolType`: changing an agent's provider invalidates its provider
 *     sessions, and can cost it its tabs and transcripts.
 *   - `projectRoot`: a new working directory repoints every later turn at
 *     different files.
 *   - `sessionSshRemoteConfig`: a new host is both of those at once. The
 *     provider's transcripts stay on the old host, so every open tab resumes a
 *     session id the new host has never seen.
 *
 * A change to one of them is for new agents only, and the dialog says so.
 */
export const UNPUBLISHABLE_KEYS: readonly GroupDefaultKey[] = GROUP_DEFAULT_KEYS.filter(
	(key) => !GROUP_DEFAULT_FIELDS[key].publishable
);

/** Every default a publish may write to an existing agent. */
export const PUBLISHABLE_KEYS: readonly GroupDefaultKey[] = GROUP_DEFAULT_KEYS.filter(
	(key) => GROUP_DEFAULT_FIELDS[key].publishable
);

/** A default's name for a person. */
export function groupDefaultLabel(key: GroupDefaultKey): string {
	return GROUP_DEFAULT_FIELDS[key].label;
}

/** One changed default: the value the profile held, and the value it holds now. */
export type GroupDefaultsFieldChange = {
	[Key in GroupDefaultKey]: {
		key: Key;
		/** `undefined` when the profile did not hold the key before the save. */
		before: GroupAgentDefaults[Key];
		/** `undefined` when the save removed the key. */
		after: GroupAgentDefaults[Key];
	};
}[GroupDefaultKey];

/** A record default's change, key by key. */
export interface GroupDefaultsKeyedChange<Value> {
	/** Keys the save added or gave a new value, with that value. */
	set: Record<string, Value>;
	/** Keys the save removed. */
	removed: string[];
}

/** What one save changed in a group's defaults. */
export interface GroupDefaultsDiff {
	/** Every changed default, in form order. Empty when the save changed none. */
	changes: GroupDefaultsFieldChange[];
	/** `customEnvVars`, key by key. Empty when the record did not change. */
	envVars: GroupDefaultsKeyedChange<string>;
	/** `customEnvVarsDisabled` (the parked variables), key by key. */
	envVarsDisabled: GroupDefaultsKeyedChange<string>;
	/** `tierTargets`, tier by tier. */
	tierTargets: GroupDefaultsKeyedChange<TierTarget>;
	/** The profile's provider on each side of the save. Decides who a provider-bound value reaches. */
	provider: { before?: ToolType; after?: ToolType };
}

function sameValue(a: unknown, b: unknown): boolean {
	return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function keyedChange<Value>(
	before: Partial<Record<string, Value>> | undefined,
	after: Partial<Record<string, Value>> | undefined
): GroupDefaultsKeyedChange<Value> {
	const set: Record<string, Value> = {};
	for (const [key, value] of Object.entries(after ?? {})) {
		if (value !== undefined && !sameValue(before?.[key], value)) set[key] = value;
	}
	const removed = Object.keys(before ?? {}).filter((key) => after?.[key] === undefined);
	return { set, removed };
}

/**
 * What a save changed: `after` against `before`, the group's stored defaults on
 * each side of it. A key is in the diff when its value differs, when the save
 * added it, or when the save removed it. Nothing else is: a default the save
 * did not touch is not pushed anywhere, however long the profile has held it.
 *
 * A group's pill label is not a default, so a save that changed only the label
 * gives an empty diff.
 */
export function diffGroupDefaults(
	before: GroupAgentDefaults | undefined,
	after: GroupAgentDefaults | undefined
): GroupDefaultsDiff {
	const changes: GroupDefaultsFieldChange[] = [];
	for (const key of GROUP_DEFAULT_KEYS) {
		if (!sameValue(before?.[key], after?.[key])) {
			changes.push({ key, before: before?.[key], after: after?.[key] } as GroupDefaultsFieldChange);
		}
	}
	return {
		changes,
		envVars: keyedChange(before?.customEnvVars, after?.customEnvVars),
		envVarsDisabled: keyedChange(before?.customEnvVarsDisabled, after?.customEnvVarsDisabled),
		tierTargets: keyedChange<TierTarget>(before?.tierTargets, after?.tierTargets),
		provider: { before: before?.toolType, after: after?.toolType },
	};
}

/**
 * Whether the save moved the profile from one provider to another. The old
 * provider's values were then dropped by the switch, not by the user, so a
 * publish removes them from nobody.
 */
function providerSwitched(provider: GroupDefaultsDiff['provider']): boolean {
	return (
		provider.before !== undefined &&
		provider.after !== undefined &&
		provider.before !== provider.after
	);
}

/**
 * The provider whose agents a provider-bound change reaches, or `undefined`
 * when it reaches none. A value that is set goes to the agents on the
 * profile's provider. A value that is removed leaves the agents on the
 * provider it was written for.
 */
function providerReached(
	change: GroupDefaultsFieldChange,
	provider: GroupDefaultsDiff['provider']
): ToolType | undefined {
	if (change.after !== undefined) return provider.after;
	return providerSwitched(provider) ? undefined : provider.before;
}

/**
 * The provider a publish of `diff` hands its provider-bound values to: the one
 * the dialog names. `undefined` when the profile names no provider on either
 * side of the save.
 */
export function groupDefaultsPublishProvider(diff: GroupDefaultsDiff): ToolType | undefined {
	return diff.provider.after ?? diff.provider.before;
}

/**
 * The changes of `diff` a publish writes to an agent on `toolType`: the
 * publishable ones, less every provider-bound value written for another
 * provider. Empty means a publish does nothing to that agent.
 */
export function publishableChangesFor(
	toolType: ToolType,
	diff: GroupDefaultsDiff
): GroupDefaultsFieldChange[] {
	return diff.changes.filter((change) => {
		const field = GROUP_DEFAULT_FIELDS[change.key];
		if (!field.publishable) return false;
		return !field.providerBound || providerReached(change, diff.provider) === toolType;
	});
}

/**
 * The agents a publish can reach: the group's DIRECT members. Groups nest, and
 * a publish that reached into child groups would be one the user cannot
 * predict from the count the dialog shows. So a child group's agents are not
 * members here, and a publish never touches them.
 */
export function directGroupMembers<Agent extends { groupId?: string }>(
	agents: readonly Agent[],
	groupId: string
): Agent[] {
	return agents.filter((agent) => agent.groupId === groupId);
}

/** The names of one change, for a person: the field, or each key of a record. */
function changeLabels(change: GroupDefaultsFieldChange, diff: GroupDefaultsDiff): string[] {
	const keysOf = (keyed: GroupDefaultsKeyedChange<unknown>) => [
		...Object.keys(keyed.set),
		...keyed.removed,
	];
	switch (change.key) {
		// A variable is named by its own name, switched on or off.
		case 'customEnvVars':
			return keysOf(diff.envVars);
		case 'customEnvVarsDisabled':
			return keysOf(diff.envVarsDisabled);
		case 'tierTargets':
			return keysOf(diff.tierTargets).map((tier) => `Tier: ${tier}`);
		default:
			return [groupDefaultLabel(change.key)];
	}
}

/** What the publish dialog says about a save, as names a person reads. */
export interface GroupDefaultsDiffSummary {
	/** Every changed default a publish may write. */
	changed: string[];
	/** Changed, and never published: new agents only. */
	unpublished: string[];
	/** Changed lists. A publish replaces the agent's list with the profile's. */
	replaced: string[];
	/** Changed defaults that reach only the agents on one provider. */
	providerBound: string[];
}

/**
 * The names behind a diff, for the publish dialog and the CLI's report. A
 * variable moved between switched on and switched off is named once.
 */
export function summarizeGroupDefaultsDiff(diff: GroupDefaultsDiff): GroupDefaultsDiffSummary {
	const summary: GroupDefaultsDiffSummary = {
		changed: [],
		unpublished: [],
		replaced: [],
		providerBound: [],
	};
	const add = (list: string[], labels: string[]) => {
		for (const label of labels) if (!list.includes(label)) list.push(label);
	};
	for (const change of diff.changes) {
		const field = GROUP_DEFAULT_FIELDS[change.key];
		const labels = changeLabels(change, diff);
		// A provider-bound value the save dropped by moving to another provider
		// reaches no agent, so it is new agents only, like the provider itself.
		const reachesNobody =
			!!field.providerBound && providerReached(change, diff.provider) === undefined;
		if (!field.publishable || reachesNobody) {
			add(summary.unpublished, labels);
			continue;
		}
		add(summary.changed, labels);
		if (field.write === 'list') add(summary.replaced, labels);
		if (field.providerBound) add(summary.providerBound, labels);
	}
	return summary;
}

/** The fields of an agent's record a publish reads and writes. */
export type GroupDefaultsTarget = GroupAgentDefaults & {
	toolType: ToolType;
	/** Provenance of `customContextWindow`. Written with it, so the two cannot disagree. */
	contextWindowSource?: 'user-edited';
};

/** What a publish needs besides the agent and the diff. */
export interface GroupDefaultsApplyContext {
	/** The saved sources, so a target an agent's SSH remote cannot reach is not written. */
	endpoints?: readonly LocalModelEndpoint[];
}

/** One changed default a publish did not write to one agent, and why. */
export interface GroupDefaultsSkip {
	label: string;
	reason: string;
}

/**
 * The token proxy half of a publish. The proxy's address is not a stored
 * value: it depends on the agent's credentials and on a port only the main
 * process knows, so the pure apply cannot write it. The caller applies `mode`
 * through the writer that sets an agent's proxy mode, and then
 * `backgroundRequests` through its own writer.
 */
export interface GroupDefaultsProxyChange {
	/** The mode to set. `off` takes the agent off the proxy. Absent: not changed. */
	mode?: TokenProxyMode;
	/** Present when the target changed. A `value` of `undefined` turns it off. */
	backgroundRequests?: { value: BackgroundRequests | undefined };
}

export interface GroupDefaultsApplyResult<Target> {
	/** The agent with the publish applied. The SAME object when nothing changed. */
	next: Target;
	/** The prior value of exactly the fields `next` changed. Spread over the agent to undo. */
	undo: Partial<Target>;
	/** Changed defaults that were not written to this agent, each with its reason. */
	skipped: GroupDefaultsSkip[];
	/** What the caller must still apply through the token proxy writers, when anything. */
	proxy?: GroupDefaultsProxyChange;
}

const REMOTE_CANNOT_REACH_SOURCE =
	"This agent runs on an SSH remote, which cannot reach a source on this machine's loopback address.";

/**
 * Why a Run on or tier target must not be written to this agent, or
 * `undefined` when it may be. The one case decided here is the one a launch
 * would refuse for where the agent runs, not for what the target is: a
 * loopback source and an agent on an SSH remote. The launch's own resolver
 * decides it, so the two cannot disagree.
 */
function unreachableTargetReason(
	session: GroupDefaultsTarget,
	target: RunOnTarget | TierTarget | undefined,
	context: GroupDefaultsApplyContext
): string | undefined {
	const ssh = session.sessionSshRemoteConfig;
	if (!ssh?.enabled || !ssh.remoteId) return undefined;
	if (!target || target.type !== 'source') return undefined;
	const resolution = resolveRunOnLaunch({
		toolType: session.toolType,
		target,
		endpoint: context.endpoints?.find((endpoint) => endpoint.id === target.endpointId) ?? null,
		userEnvVars: session.customEnvVars,
		remote: { name: ssh.remoteId },
	});
	return resolution.kind === 'refused' && resolution.code === 'run-on-loopback-on-remote'
		? REMOTE_CANNOT_REACH_SOURCE
		: undefined;
}

function nonEmpty<Value>(record: Record<string, Value>): Record<string, Value> | undefined {
	return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Publish one save to one agent: write the publishable half of `diff` into
 * `session`, and report the prior value of every field that changed.
 *
 * The rules, each of which exists because the plain version is destructive:
 *
 *   - Only the diff is written. A default the save did not change is not.
 *   - `UNPUBLISHABLE_KEYS` are never written.
 *   - A provider-bound value reaches only an agent on the provider it was
 *     written for (`publishableChangesFor`).
 *   - Records merge by key. A variable or a tier the profile set is written
 *     over the agent's, one the save removed is removed, and one the profile
 *     never named is left alone. A variable lives in exactly one of the two
 *     env records (`parkedRecords.ts`), and the profile's side wins it.
 *   - Lists replace. The agent's own rows are gone.
 *   - A Run on or tier target the agent's SSH remote cannot reach is skipped,
 *     with the reason.
 *   - The two token proxy fields are returned in `proxy`, not written.
 *
 * Only settings are read and written here. No tab, transcript, process or
 * provider session id is touched, so a turn in flight finishes on what it
 * started with and the new values apply from the agent's next message.
 */
export function applyGroupDefaultsToSession<Target extends GroupDefaultsTarget>(
	session: Target,
	diff: GroupDefaultsDiff,
	context: GroupDefaultsApplyContext = {}
): GroupDefaultsApplyResult<Target> {
	const next: GroupDefaultsTarget = { ...session };
	const undo: Partial<GroupDefaultsTarget> = {};
	const skipped: GroupDefaultsSkip[] = [];
	let proxy: GroupDefaultsProxyChange | undefined;

	const write = <Key extends keyof GroupDefaultsTarget>(
		key: Key,
		value: GroupDefaultsTarget[Key]
	) => {
		if (sameValue(next[key], value)) return;
		if (!(key in undo)) undo[key] = session[key];
		next[key] = value;
	};

	const changes = publishableChangesFor(session.toolType, diff);
	const reaches = (key: GroupDefaultKey) => changes.some((change) => change.key === key);

	// The two env records first, as one merge: the targets below read the
	// agent's variables as the publish leaves them.
	if (reaches('customEnvVars') || reaches('customEnvVarsDisabled')) {
		const active = { ...session.customEnvVars };
		const parked = { ...session.customEnvVarsDisabled };
		for (const key of diff.envVars.removed) delete active[key];
		for (const key of diff.envVarsDisabled.removed) delete parked[key];
		for (const [key, value] of Object.entries(diff.envVarsDisabled.set)) {
			parked[key] = value;
			delete active[key];
		}
		for (const [key, value] of Object.entries(diff.envVars.set)) {
			active[key] = value;
			delete parked[key];
		}
		write('customEnvVars', nonEmpty(active));
		write('customEnvVarsDisabled', nonEmpty(parked));
	}

	for (const change of changes) {
		switch (change.key) {
			case 'customEnvVars':
			case 'customEnvVarsDisabled':
				break; // Merged above.

			case 'tierTargets': {
				const tiers: Record<string, TierTarget> = { ...session.tierTargets };
				// A tier the old provider's profile held was dropped by the switch.
				if (!providerSwitched(diff.provider)) {
					for (const tier of diff.tierTargets.removed) delete tiers[tier];
				}
				for (const [tier, target] of Object.entries(diff.tierTargets.set)) {
					const reason = unreachableTargetReason(next, target, context);
					if (reason) skipped.push({ label: `Tier: ${tier}`, reason });
					else tiers[tier] = target;
				}
				write('tierTargets', nonEmpty(tiers));
				break;
			}

			case 'runOn': {
				const reason = unreachableTargetReason(next, change.after, context);
				if (reason) skipped.push({ label: groupDefaultLabel('runOn'), reason });
				else write('runOn', change.after);
				break;
			}

			case 'customContextWindow':
				write('customContextWindow', change.after);
				// A published window is a number a person chose, so it outranks the
				// provider's report. A removed one takes its provenance with it.
				write('contextWindowSource', change.after === undefined ? undefined : 'user-edited');
				break;

			case 'gatewayUrl':
				// A proxy mode, and the background requests target beside it, belong
				// to the gateway they were chosen for.
				if (!sameValue(next.gatewayUrl, change.after)) {
					write('gatewayUrl', change.after);
					write('tokenProxyMode', OFF_TOKEN_PROXY_FIELDS.tokenProxyMode);
					write('backgroundRequests', OFF_TOKEN_PROXY_FIELDS.backgroundRequests);
				}
				break;

			case 'tokenProxyMode':
				proxy = { ...proxy, mode: change.after ?? 'off' };
				break;

			case 'backgroundRequests':
				proxy = { ...proxy, backgroundRequests: { value: change.after } };
				break;

			default:
				write(change.key, change.after as never);
		}
	}

	const changed = Object.keys(undo).length > 0;
	return {
		next: changed ? (next as Target) : session,
		undo: undo as Partial<Target>,
		skipped,
		...(proxy ? { proxy } : {}),
	};
}

// ============================================================================
// Seeding a new agent
// ============================================================================

/** What a seed needs to know about this machine. */
export interface GroupDefaultsSeedContext {
	/**
	 * The ids of the SSH remotes that exist. Absent means not known, and then no
	 * remote is judged gone: a remote that cannot be resolved fails the launch
	 * by name, which is loud. A remote wrongly judged gone would run the agent
	 * on this machine, which is not.
	 */
	sshRemoteIds?: readonly string[];
	/** The saved sources, so a target the seed's SSH remote cannot reach is left out. */
	endpoints?: readonly LocalModelEndpoint[];
}

/** A group's defaults, as a new agent can start from them. */
export interface GroupDefaultsSeed {
	/** The defaults, less what a new agent cannot use. */
	seed: GroupAgentDefaults;
	/** The defaults name an SSH remote that no longer exists, so the seed runs on this machine. */
	sshRemoteMissing: boolean;
	/** Defaults left out of the seed, each with its reason. */
	skipped: GroupDefaultsSkip[];
}

/**
 * The seed a new agent in a group starts from: the group's defaults, less the
 * two things a new agent cannot use as they are stored.
 *
 *   - An SSH remote that was deleted since the defaults were saved. The seed
 *     runs on this machine and says so (`sshRemoteMissing`); it is never
 *     handed a remote id that resolves to nothing.
 *   - A Run on target the seed's own SSH remote cannot reach (a source on this
 *     machine's loopback address). It is not seeded, with the reason.
 *
 * The remote is decided first, so a seed whose remote is gone keeps a loopback
 * target: it runs here, where the source is.
 */
export function resolveGroupDefaultsSeed(
	defaults: GroupAgentDefaults,
	context: GroupDefaultsSeedContext = {}
): GroupDefaultsSeed {
	const seed: GroupAgentDefaults = { ...defaults };
	const skipped: GroupDefaultsSkip[] = [];

	const ssh = defaults.sessionSshRemoteConfig;
	const sshRemoteMissing =
		!!ssh?.enabled &&
		!!ssh.remoteId &&
		context.sshRemoteIds !== undefined &&
		!context.sshRemoteIds.includes(ssh.remoteId);
	if (sshRemoteMissing) {
		// The mirror flag stands without a remote: it marks an agent that runs
		// here and is controlled from another machine.
		if (ssh?.shareHistoryToProjectDir) {
			seed.sessionSshRemoteConfig = {
				enabled: false,
				remoteId: null,
				shareHistoryToProjectDir: true,
			};
		} else {
			delete seed.sessionSshRemoteConfig;
		}
	}

	if (seed.toolType && seed.runOn) {
		const reason = unreachableTargetReason(
			{ ...seed, toolType: seed.toolType },
			seed.runOn,
			context
		);
		if (reason) {
			delete seed.runOn;
			skipped.push({ label: groupDefaultLabel('runOn'), reason });
		}
	}

	return { seed, sshRemoteMissing, skipped };
}

/**
 * The defaults the create-agent form draws no control for. A seed cannot put
 * them in the form, so they are stamped onto the new agent as it is created,
 * and the form names them so the user knows they are coming.
 */
export type GroupDefaultsCreateExtras = Pick<
	GroupAgentDefaults,
	| 'tierTargets'
	| 'backgroundRequests'
	| 'systemOneOptOut'
	| 'tokenProxyMode'
	| 'customEnvVarsDisabled'
>;

/** The agent a seed's extras are judged against: the create form as it stands. */
export type GroupDefaultsNewAgent = Pick<
	GroupDefaultsTarget,
	'toolType' | 'customEnvVars' | 'gatewayUrl' | 'sessionSshRemoteConfig'
>;

export interface GroupDefaultsCreateExtrasResult {
	/** What to stamp onto the new agent, in form order. Empty when there is nothing. */
	extras: GroupDefaultsCreateExtras;
	/** Extras that are not stamped onto this agent, each with its reason. */
	skipped: GroupDefaultsSkip[];
}

/**
 * The extras of `seed` that go onto `agent`, the agent the create form is
 * about to make. Judged against the form as it stands and not as it was
 * seeded, because the user may have changed the provider, the SSH remote or
 * the gateway since.
 *
 *   - A provider-bound extra (tiers, the token proxy mode, background
 *     requests) goes only to an agent on the seed's provider, the rule the
 *     form's own provider settings follow.
 *   - A tier target the agent's SSH remote cannot reach is left out, with the
 *     reason. A tier the group never set is not stamped at all, so it keeps
 *     following the harness default.
 *   - The token proxy mode is left out when the form sets a gateway of its
 *     own: the proxy would take that gateway's place. Background requests
 *     belong to the proxy and go with it. Whether THIS agent can use the proxy
 *     at all is decided by the writer that applies the mode.
 *   - A switched-off variable the form holds switched on is left out: a
 *     variable lives in one of the two env records, and the form's side wins.
 */
export function groupDefaultsCreateExtras(
	seed: GroupAgentDefaults,
	agent: GroupDefaultsNewAgent,
	context: GroupDefaultsApplyContext = {}
): GroupDefaultsCreateExtrasResult {
	const extras: GroupDefaultsCreateExtras = {};
	const skipped: GroupDefaultsSkip[] = [];
	const sameProvider = seed.toolType !== undefined && seed.toolType === agent.toolType;

	if (sameProvider) {
		const tiers: Record<string, TierTarget> = {};
		for (const [tier, target] of Object.entries(seed.tierTargets ?? {})) {
			if (!target) continue;
			const reason = unreachableTargetReason(agent, target, context);
			if (reason) skipped.push({ label: `Tier: ${tier}`, reason });
			else tiers[tier] = target;
		}
		if (Object.keys(tiers).length > 0) extras.tierTargets = tiers;
	}

	const proxyMode = sameProvider ? seed.tokenProxyMode : undefined;
	const onProxy = proxyMode !== undefined && !agent.gatewayUrl;
	if (proxyMode !== undefined && !onProxy) {
		skipped.push({
			label: groupDefaultLabel('tokenProxyMode'),
			reason:
				'This form sets a Local Models gateway of its own, and the proxy would take its place.',
		});
	}
	if (onProxy && seed.backgroundRequests) extras.backgroundRequests = seed.backgroundRequests;
	if (seed.systemOneOptOut) extras.systemOneOptOut = true;
	if (onProxy) extras.tokenProxyMode = proxyMode;

	const parked: Record<string, string> = {};
	for (const [key, value] of Object.entries(seed.customEnvVarsDisabled ?? {})) {
		if (agent.customEnvVars?.[key] === undefined) parked[key] = value;
	}
	if (Object.keys(parked).length > 0) extras.customEnvVarsDisabled = parked;

	return { extras, skipped };
}

/**
 * The defaults that become fields of a new agent's own record at create: every
 * key the create form draws a control for. The rest of the profile is not here:
 * `projectRoot` and `toolType` pick WHERE and WHICH (the caller already holds
 * both), and the five keys of {@link GroupDefaultsCreateExtras} are judged
 * against the finished agent by `groupDefaultsCreateExtras()`.
 */
export type GroupDefaultsCreateFields = Omit<
	GroupAgentDefaults,
	'projectRoot' | 'toolType' | keyof GroupDefaultsCreateExtras
>;

/**
 * What a create that seeded from a group reports back to a caller that cannot
 * see the form (`maestro-cli create-agent`): the group it seeded from, and the
 * defaults it left out, each with its reason.
 */
export interface GroupSeededCreateReport {
	/** The group whose defaults seeded the agent, or `null` when none did. */
	seededFromGroup: string | null;
	/** Defaults the new agent could not take, as `Label: reason`. */
	skipped: string[];
}

const NON_FIELD_KEYS: ReadonlySet<GroupDefaultKey> = new Set<GroupDefaultKey>([
	'projectRoot',
	'toolType',
	'tierTargets',
	'backgroundRequests',
	'systemOneOptOut',
	'tokenProxyMode',
	'customEnvVarsDisabled',
]);

/**
 * The fields a new agent on `toolType` starts with when it is created in a
 * group, with whatever the caller set explicitly laid over them. The rules are
 * the create form's own, so a scripted create and a click store the same agent:
 *
 *   - A provider-bound default (path, arguments, model, effort, Run on, the
 *     gateway, ...) is taken only when the seed names `toolType`. A default
 *     written for one provider's binary is never handed to another.
 *   - An explicit value beats the seed's, always. An absent one (`undefined`)
 *     is no opinion and leaves the seed's.
 *   - Environment variables merge key by key, the explicit side winning, which
 *     is how the form lays the profile's variables over a provider's own.
 *   - The gateway and a Run on target exclude each other (a target takes the
 *     gateway's place at launch), so an explicit one drops the seed's other.
 *
 * Lists and records are cloned: the new agent's record must not alias the
 * group's.
 */
export function groupDefaultsCreateFields(
	seed: GroupAgentDefaults,
	toolType: ToolType,
	explicit: GroupDefaultsCreateFields = {}
): GroupDefaultsCreateFields {
	const fields: Record<string, unknown> = {};
	const sameProvider = seed.toolType === toolType;
	for (const key of GROUP_DEFAULT_KEYS) {
		if (NON_FIELD_KEYS.has(key)) continue;
		if (GROUP_DEFAULT_FIELDS[key].providerBound && !sameProvider) continue;
		const value = seed[key];
		if (value !== undefined) fields[key] = structuredClone(value);
	}

	for (const [key, value] of Object.entries(explicit)) {
		if (value !== undefined) fields[key] = value;
	}

	if (seed.customEnvVars || explicit.customEnvVars) {
		fields.customEnvVars = { ...seed.customEnvVars, ...explicit.customEnvVars };
	}
	if (explicit.runOn !== undefined && explicit.gatewayUrl === undefined) delete fields.gatewayUrl;
	if (explicit.gatewayUrl !== undefined && explicit.runOn === undefined) delete fields.runOn;

	return fields as GroupDefaultsCreateFields;
}
