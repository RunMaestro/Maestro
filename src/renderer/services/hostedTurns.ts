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
 *
 * Every call goes through `services/peerMirror.ts` (`actOnMirroredAgent()`), which toasts a
 * failure and never queues here: a host that is down refuses at once.
 */

import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import type { TurnOverrides } from '../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { notifyToast } from '../stores/notificationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { updateSessionWith } from '../stores/sessionStore';
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
 * before the move) cannot resume there, so the message opens a new host tab. True when the host
 * took it (ran or queued); the caller clears the composer then.
 */
export async function sendHostedTurn(
	session: Session,
	tabId: string | undefined,
	text: string,
	images: readonly string[]
): Promise<boolean> {
	const target = hostedTargetOf(session);
	if (!target) return false;
	if (!target.agent) {
		notifyToast({
			color: 'red',
			title: 'Message not sent',
			message: `${session.name} runs on peer "${target.peerId}", which is not connected. Nothing was sent.`,
		});
		return false;
	}
	const tab = session.aiTabs.find((candidate) => candidate.id === tabId);
	let hostTabId = tabId;
	if (!isHostTab(target, tabId)) {
		hostTabId = (await openHostedTab(session)) ?? undefined;
		if (!hostTabId) return false;
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
		images
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
	session: Pick<Session, 'liftedTo'>,
	tabId: string,
	name: string
): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) {
		void renameMirrorTab(target.peerId, target.agentId, tabId, name);
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
