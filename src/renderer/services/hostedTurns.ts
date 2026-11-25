/**
 * Where a hosted agent's AI work goes. A hosted agent draws and behaves like any agent (its Left
 * Bar record, kept in step by `startHostedAgentSync()`); the one difference is that a turn runs on
 * its Federation host instead of over SSH from here. The normal composer, Stop, and tab strip call
 * in here for a record with a `liftedTo` pointer:
 *
 * - `sendHostedTurn()`: the composer's send, with images and this tab's own model, effort,
 *   read-only, and save to History as the sender's `TurnOverrides`. A busy tab queues on the host.
 * - `interruptHostedTurn()`: Stop (the pill, the shortcut, `maestro-cli interrupt`).
 * - `openHostedTab()`, `closeHostedTab()`, `renameHostedTab()`, `starHostedTab()`: the strip.
 * - `updateHostedTab()`: a tab setting the host must hold before a turn starts (thinking).
 * - `settleHostedWizardTab()`: a wizard that ran here hands its tab name and session to the host.
 * - `refuseOnHostedAgent()`: an action that would spawn here, refused with a toast.
 *
 * Every call goes through `services/peerMirror.ts` (`actOnMirroredAgent()`), which toasts a
 * failure and never queues here: a host that is down refuses at once.
 */

import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import type {
	TabPatch,
	TurnOverrides,
	TurnSendReceipt,
} from '../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { notifyToast } from '../stores/notificationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import type { AITab, Session } from '../types';
import { mirrorTab } from '../utils/peerMirrorView';
import { setActiveTab } from '../utils/tabHelpers';
import {
	actOnMirroredAgent,
	closeMirrorTab,
	interruptMirroredAgent,
	renameMirrorTab,
	sendToMirroredTab,
	starMirrorTab,
} from './peerMirror';

export interface HostedTarget {
	peerId: string;
	agentId: string;
	/** The host's record, when the mirror holds it. */
	agent?: AgentRecord;
}

/** Where a record's AI work runs, or undefined for an agent that is not hosted. */
/**
 * Whether hosted agents are on (`federationHostedAgents`, Settings > SSH Hosts). Off unless the
 * setting is exactly `true` (opt-in). Off, every lifted record works as its SSH agent: nothing
 * here routes to a host, and the host sync stops.
 */
export function hostingEnabled(): boolean {
	return useSettingsStore.getState().federationHostedAgents === true;
}

export function hostedTargetOf(
	session: { liftedTo?: unknown } | null | undefined
): HostedTarget | undefined {
	if (!hostingEnabled()) return undefined;
	const pointer = session ? readLiftedTo(session.liftedTo) : undefined;
	if (!pointer) return undefined;
	const agent = usePeerMirrorStore
		.getState()
		.peers[pointer.peer]?.agents.find((candidate) => candidate.id === pointer.agentId);
	return { peerId: pointer.peer, agentId: pointer.agentId, ...(agent ? { agent } : {}) };
}

/**
 * Refuse an action that spawns a provider here, for a hosted agent. Main refuses every local spawn
 * of a lifted record (`process:spawn`), so without this the user gets a raw spawn error or an
 * orphan tab. Toasts which action and why, and answers true when the caller must stop.
 */
export function refuseOnHostedAgent(
	session: Pick<Session, 'name' | 'liftedTo'> | null | undefined,
	action: string
): boolean {
	const target = hostedTargetOf(session);
	if (!target || !session) return false;
	notifyToast({
		color: 'yellow',
		title: `${action} is not available on hosted agents yet`,
		message: `${session.name} runs on ${target.peerId}. Move it back from the host to use ${action}.`,
	});
	return true;
}

/** Whether `tabId` is one of the host's tabs (a lift keeps tab ids, so most local tabs are). */
export function isHostTab(target: HostedTarget, tabId: string | undefined): boolean {
	return !!tabId && !!target.agent?.aiTabs?.some((tab) => tab.id === tabId);
}

/** The tab's own composer settings as this sender's overrides for one turn. */
export function hostedTurnOverrides(tab: AITab | undefined): TurnOverrides | undefined {
	if (!tab) return undefined;
	const overrides: TurnOverrides = {};
	if (tab.customModel) overrides.model = tab.customModel;
	if (tab.customEffort) overrides.effort = tab.customEffort;
	if (tab.readOnlyMode !== undefined) overrides.readOnly = tab.readOnlyMode === true;
	if (tab.saveToHistory !== undefined) overrides.saveToHistory = tab.saveToHistory === true;
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** Show `tabId` on the record, adding a blank tab for it until the host's update fills it in. */
function focusHostTab(sessionId: string, tabId: string): void {
	updateSessionWith(sessionId, (session) => {
		let next = session;
		if (!next.aiTabs.some((tab) => tab.id === tabId)) {
			next = {
				...next,
				aiTabs: [...next.aiTabs, mirrorTab({ id: tabId })],
				unifiedTabOrder: [...(next.unifiedTabOrder ?? []), { type: 'ai', id: tabId }],
			};
		}
		return setActiveTab(next, tabId)?.session ?? next;
	});
}

/** Open a tab on the host and show it. Answers the new tab's id, or null when the host refused. */
export async function openHostedTab(
	session: Pick<Session, 'id' | 'liftedTo'>
): Promise<string | null> {
	const target = hostedTargetOf(session);
	if (!target) return null;
	const result = await actOnMirroredAgent(target.peerId, target.agentId, { kind: 'new-tab' });
	if (result?.kind !== 'new-tab') return null;
	focusHostTab(session.id, result.tabId);
	return result.tabId;
}

/**
 * Send what the person typed to the host. A tab the host does not have (a conversation kept from
 * before the move) cannot resume there, so the message opens a new host tab. The host's receipt
 * when it took the message (ran, queued, or held), null when it did not; the caller clears the
 * composer on a receipt. A `queued` receipt names the host's queue item (what a steer acts on).
 * `opts.held` is Queue Held: the host queues the message paused, even on an idle tab.
 */
export async function sendHostedTurn(
	session: Session,
	tabId: string | undefined,
	text: string,
	images: readonly string[],
	opts: { held?: boolean } = {}
): Promise<TurnSendReceipt | null> {
	const target = hostedTargetOf(session);
	if (!target) return null;
	if (!target.agent) {
		notifyToast({
			color: 'red',
			title: 'Message not sent',
			message: `${session.name} runs on peer "${target.peerId}", which is not connected. Nothing was sent.`,
		});
		return null;
	}
	const tab = session.aiTabs.find((candidate) => candidate.id === tabId);
	let hostTabId = tabId;
	if (!isHostTab(target, tabId)) {
		hostTabId = (await openHostedTab(session)) ?? undefined;
		if (!hostTabId) return null;
		notifyToast({
			color: 'theme',
			title: 'Sent in a new tab',
			message: `That conversation is the copy kept from before the move, so it continues in a new tab on ${target.peerId}.`,
		});
	}
	return sendToMirroredTab(
		target.peerId,
		target.agentId,
		hostTabId as string,
		text,
		hostedTurnOverrides(tab),
		images,
		opts.held
	);
}

/** Stop the host's turn on one tab, or every busy tab without `tabId`. */
export async function interruptHostedTurn(
	session: Pick<Session, 'liftedTo'>,
	tabId?: string
): Promise<void> {
	const target = hostedTargetOf(session);
	if (target) await interruptMirroredAgent(target.peerId, target.agentId, tabId);
}

/** Close a host tab too (the local close is the caller's). A kept local tab has none. */
export function closeHostedTab(session: Pick<Session, 'liftedTo'>, tabId: string): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) void closeMirrorTab(target.peerId, target.agentId, tabId);
}

/** Rename a host tab too. An empty name clears it. */
export function renameHostedTab(
	session: Pick<Session, 'liftedTo'> | null | undefined,
	tabId: string,
	name: string
): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) {
		void renameMirrorTab(target.peerId, target.agentId, tabId, name);
	}
}

/**
 * Push one tab's composer setting to the host too. Model, effort, read-only, and save to History
 * travel with each turn (`hostedTurnOverrides()`); a setting that decides what the host's process
 * streams, such as thinking, has to be on the host's tab before the turn starts.
 */
export function updateHostedTab(
	session: Pick<Session, 'liftedTo'>,
	tabId: string,
	patch: TabPatch
): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) {
		void actOnMirroredAgent(target.peerId, target.agentId, { kind: 'update-tab', tabId, patch });
	}
}

/**
 * A wizard that ran here for a hosted tab ends as a local one does: the tab keeps the name the
 * wizard gave it and resumes the wizard's provider session (`flattenWizardIntoTab()`). Both live
 * on the host's tab, which runs the next turn, so push whichever differs there. Reads the tab as
 * the flatten left it in the store; the host's name and session come back on the next sync. A
 * no-op for an agent that is not hosted.
 */
export function settleHostedWizardTab(sessionId: string, tabId: string): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const target = hostedTargetOf(session);
	if (!session || !target) return;
	const tab = session.aiTabs.find((candidate) => candidate.id === tabId);
	const hostTab = target.agent?.aiTabs?.find((candidate) => candidate.id === tabId);
	if (!tab || !hostTab) return;
	if (tab.name && tab.name !== hostTab.name) {
		void renameMirrorTab(target.peerId, target.agentId, tabId, tab.name);
	}
	if (tab.agentSessionId && tab.agentSessionId !== hostTab.agentSessionId) {
		void actOnMirroredAgent(target.peerId, target.agentId, {
			kind: 'update-tab',
			tabId,
			patch: { agentSessionId: tab.agentSessionId },
		});
	}
}

/** Star or unstar a host tab too. */
export function starHostedTab(
	session: Pick<Session, 'liftedTo'>,
	tabId: string,
	starred: boolean
): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) {
		void starMirrorTab(target.peerId, target.agentId, tabId, starred);
	}
}
