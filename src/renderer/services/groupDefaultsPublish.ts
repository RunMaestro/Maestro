/**
 * Publishing a Group Settings save to the agents already in the group, and
 * taking it back.
 *
 * A group's defaults are copy-at-create: nothing reads them while an agent
 * runs. A publish does not change that. It is a one-time write into each
 * agent's OWN record, so afterwards the answer to "why is this agent on that
 * model?" is still on the agent.
 *
 * The rules of what is written are pure and shared
 * (`applyGroupDefaultsToSession` in `shared/groupAgentDefaults.ts`). This
 * module is the half that needs the stores: one pass over the group's direct
 * members, the two token proxy writers, the flush to the main process, and the
 * snapshot an Undo restores.
 *
 * `applySeededTokenProxy` is here too. It is the one part of SEEDING a new
 * agent that needs the same two token proxy writers.
 *
 * Only settings are written. No tab, transcript or process is touched, so a
 * turn in flight finishes on what it started with (settings are codified at
 * send) and the published values apply from the agent's next message.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import {
	applyGroupDefaultsToSession,
	directGroupMembers,
	groupDefaultLabel,
	summarizeGroupDefaultsDiff,
	type GroupDefaultsCreateExtras,
	type GroupDefaultsDiff,
	type GroupDefaultsProxyChange,
} from '../../shared/groupAgentDefaults';
import { generateUUID } from '../../shared/uuid';
import { notifyToast } from '../stores/notificationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Group, Session } from '../types';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import {
	flushAgentToStore,
	setAgentBackgroundRequests,
	setAgentTokenProxyMode,
} from './agentGateway';

/** The group a publish names in its toasts. */
export type PublishedGroup = Pick<Group, 'id' | 'name' | 'emoji'>;

/** One changed default that was not written to one agent, and why. */
export interface GroupDefaultsPublishSkip {
	agentName: string;
	label: string;
	reason: string;
}

export interface GroupDefaultsPublishResult {
	/** Names the snapshot an Undo restores. `null` when no agent's record changed. */
	publishId: string | null;
	/** How many agents the publish changed. */
	agentCount: number;
	/** The agents the publish changed, by id and name. `agentCount` is its length. */
	agents: Array<{ id: string; name: string }>;
	skipped: GroupDefaultsPublishSkip[];
}

interface PublishSnapshot {
	group: PublishedGroup;
	/** Per agent: the prior value of exactly the fields the publish changed. */
	agents: Map<string, Partial<Session>>;
}

/**
 * The snapshots an Undo can still restore, newest last. In memory only: an
 * Undo is offered by a toast, and neither outlives the app.
 */
const snapshots = new Map<string, PublishSnapshot>();
const MAX_SNAPSHOTS = 10;

/** How long the Undo toast stays up. A bulk overwrite earns more than the default. */
const UNDO_TOAST_DURATION_MS = 30_000;

/** The fields the token proxy writers can change on an agent. */
const PROXY_WRITTEN_FIELDS = ['gatewayUrl', 'tokenProxyMode', 'backgroundRequests'] as const;

function sameValue(a: unknown, b: unknown): boolean {
	return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function currentSession(sessionId: string): Session | undefined {
	return useSessionStore.getState().sessions.find((s) => s.id === sessionId);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Put one agent on (or off) the proxy the way a click in Edit Agent does: the
 * mode first, because it is what sets the gateway, then the background
 * requests target, which is refused for an agent that is not on the proxy.
 * Each writer validates for THIS agent and flushes. A refusal is a skip.
 */
async function applyProxyChange(
	agent: Session,
	proxy: GroupDefaultsProxyChange,
	skipped: GroupDefaultsPublishSkip[]
): Promise<void> {
	const skip = (key: 'tokenProxyMode' | 'backgroundRequests', reason: string) =>
		skipped.push({ agentName: agent.name, label: groupDefaultLabel(key), reason });
	try {
		if (proxy.mode !== undefined) {
			const result = await setAgentTokenProxyMode(agent.id, proxy.mode);
			if (!result.ok) {
				skip('tokenProxyMode', result.error);
				// Without the mode there is no proxy for a target to belong to.
				return;
			}
		}
		// Taking an agent off the proxy already cleared its target.
		if (proxy.backgroundRequests && proxy.mode !== 'off') {
			const result = await setAgentBackgroundRequests(agent.id, proxy.backgroundRequests.value);
			if (!result.ok) skip('backgroundRequests', result.error);
		}
	} catch (error) {
		// The proxy's port comes from the main process. A failed call there is
		// one agent's setting not published, not a publish that stops half way.
		skip('tokenProxyMode', ipcErrorMessage(error));
	}
}

/**
 * The token proxy half of a group seed: put a NEW agent on the proxy its
 * group's defaults name, then set its background requests target.
 *
 * The create form has no control for either, and neither can be stamped onto
 * the record: the proxy's address is worked out per agent, by the same writers
 * a click in Edit Agent uses. Call it once the agent is in the store. A writer
 * that refuses (an agent on an SSH remote, a provider with no gateway) leaves
 * the agent off the proxy, and the toast says which setting and why: a default
 * the user chose must not go missing silently.
 *
 * Never throws.
 */
export async function applySeededTokenProxy(
	agentId: string,
	extras: Pick<GroupDefaultsCreateExtras, 'tokenProxyMode' | 'backgroundRequests'>
): Promise<void> {
	const agent = currentSession(agentId);
	if (!agent || !extras.tokenProxyMode) return;
	const skipped: GroupDefaultsPublishSkip[] = [];
	await applyProxyChange(
		agent,
		{
			mode: extras.tokenProxyMode,
			...(extras.backgroundRequests
				? { backgroundRequests: { value: extras.backgroundRequests } }
				: {}),
		},
		skipped
	);
	if (skipped.length > 0) {
		notifyToast({
			color: 'yellow',
			title: 'Some group settings were not applied',
			message: skipped.map((skip) => `${skip.agentName}: ${skip.label}. ${skip.reason}`).join('\n'),
			dismissible: true,
		});
	}
}

/**
 * Publish one save to the group's direct members.
 *
 * The settings pass is synchronous: every member's record is written in one
 * store update before this function first yields, so a caller that writes the
 * group's profile and then calls this has written both in one pass. The token
 * proxy writes and the flush to the main process follow.
 */
export async function publishGroupDefaults(
	group: PublishedGroup,
	diff: GroupDefaultsDiff
): Promise<GroupDefaultsPublishResult> {
	const store = useSessionStore.getState();
	const members = directGroupMembers(store.sessions, group.id);
	const endpoints = useSettingsStore.getState().localModelEndpoints ?? [];
	const results = new Map(
		members.map((member) => [member.id, applyGroupDefaultsToSession(member, diff, { endpoints })])
	);
	store.setSessions((prev) => prev.map((s) => results.get(s.id)?.next ?? s));

	const skipped: GroupDefaultsPublishSkip[] = [];
	for (const member of members) {
		for (const skip of results.get(member.id)!.skipped) {
			skipped.push({ agentName: member.name, ...skip });
		}
	}

	// The spawn path reads an agent's settings from the main-process store, and
	// the renderer's own persistence is debounced. Write the changed agents now,
	// so a message sent straight after the publish runs on what was published.
	await Promise.all(
		members
			.filter((member) => results.get(member.id)!.next !== member)
			.map((member) => flushAgentToStore(member.id))
	);

	for (const member of members) {
		const proxy = results.get(member.id)!.proxy;
		if (proxy) await applyProxyChange(member, proxy, skipped);
	}

	// `member` is the record from before the publish, so a field that differs
	// now is a field the publish changed, by either half.
	const agents = new Map<string, Partial<Session>>();
	for (const member of members) {
		const undo: Partial<Session> = { ...results.get(member.id)!.undo };
		const now = currentSession(member.id);
		if (now) {
			for (const key of PROXY_WRITTEN_FIELDS) {
				if (!sameValue(now[key], member[key])) Object.assign(undo, { [key]: member[key] });
			}
		}
		if (Object.keys(undo).length > 0) agents.set(member.id, undo);
	}

	if (agents.size === 0) return { publishId: null, agentCount: 0, agents: [], skipped };

	const publishId = generateUUID();
	snapshots.set(publishId, { group, agents });
	while (snapshots.size > MAX_SNAPSHOTS) {
		snapshots.delete(snapshots.keys().next().value as string);
	}
	return {
		publishId,
		agentCount: agents.size,
		agents: members.filter((member) => agents.has(member.id)).map(({ id, name }) => ({ id, name })),
		skipped,
	};
}

/**
 * Tell the user what a publish did. The toast is the Undo: a click restores
 * every agent the publish changed. A setting that was skipped on an agent is
 * reported in its own toast, which stays until it is dismissed.
 */
export function notifyGroupDefaultsPublished(
	group: PublishedGroup,
	diff: GroupDefaultsDiff,
	result: GroupDefaultsPublishResult
): void {
	const groupName = `${group.emoji} ${group.name}`;
	if (result.publishId) {
		const changed = summarizeGroupDefaultsDiff(diff).changed.join(', ');
		notifyToast({
			color: 'green',
			title: `Published to ${plural(result.agentCount, 'agent')}`,
			message: `${changed} in ${groupName}. Click to undo.`,
			duration: UNDO_TOAST_DURATION_MS,
			clickAction: { kind: 'undo-group-publish', publishId: result.publishId },
		});
	} else if (result.skipped.length === 0) {
		notifyToast({
			color: 'theme',
			title: 'Nothing to publish',
			message: `The agents in ${groupName} already had these settings.`,
		});
	}

	if (result.skipped.length > 0) {
		notifyToast({
			color: 'yellow',
			title: 'Some settings were not published',
			message: result.skipped
				.map((skip) => `${skip.agentName}: ${skip.label}. ${skip.reason}`)
				.join('\n'),
			dismissible: true,
		});
	}
}

/**
 * Undo a publish: put back the prior value of every field it changed, on every
 * agent that still exists. The group's profile is not touched, so the result
 * is the one "New agents only" would have given.
 *
 * A snapshot is restored once. Resolves `false` when there is none left to
 * restore, and says so.
 */
export async function undoGroupDefaultsPublish(publishId: string): Promise<boolean> {
	const snapshot = snapshots.get(publishId);
	if (!snapshot) {
		notifyToast({
			color: 'yellow',
			title: 'Nothing to undo',
			message: 'That publish was already undone, or Maestro was restarted since.',
		});
		return false;
	}
	snapshots.delete(publishId);

	const store = useSessionStore.getState();
	const restored = store.sessions.filter((s) => snapshot.agents.has(s.id));
	store.setSessions((prev) =>
		prev.map((s) => {
			const undo = snapshot.agents.get(s.id);
			return undo ? { ...s, ...undo } : s;
		})
	);
	await Promise.all(restored.map((agent) => flushAgentToStore(agent.id)));

	notifyToast({
		color: 'green',
		title: 'Publish undone',
		message: `Restored ${plural(restored.length, 'agent')} in ${snapshot.group.emoji} ${snapshot.group.name}. The group's defaults for new agents are unchanged.`,
	});
	return true;
}

/** Test seam: forget every snapshot. */
export function __resetGroupDefaultsPublishForTests(): void {
	snapshots.clear();
}
