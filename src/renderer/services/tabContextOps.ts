/**
 * tabContextOps - the renderer end of `summarize_context`, `merge_context` and
 * `transfer_context` (`maestro-cli tab compact|merge|transfer`).
 *
 * A remote request runs the AI tab overlay menu's own handlers, not a copy:
 * `summarizeTab()` behind Context: Compact, `mergeTabContext()` behind Context:
 * Merge Into, `transferTabContext()` behind Context: Send to Agent. They live
 * in App's hooks (they share progress state with the menu's overlays), so the
 * caller hands them in. This module only resolves what the menu resolves by
 * having the tab on screen: which tab is the source (default: the agent's
 * active AI tab), which tab a merge lands in (default: the target's active AI
 * tab), and the target rules the two modals enforce by what they list.
 *
 * Context moved by Merge Into and Send to Agent is raw, never groomed. Only
 * Compact summarizes, because summarizing is what Compact is.
 */

import type { MergeOptions } from '../components/MergeSessionModal';
import type { SendToAgentOptions } from '../components/SendToAgentModal';
import type { MergeResult } from '../types/contextMerge';
import type { Session } from '../types';
import type { MergePlacement } from '../hooks/agent/useMergeSession';
import type {
	TransferPlacement,
	TransferTabContextResult,
} from '../hooks/agent/useMergeTransferHandlers';
import type { TabContextOpRequest, TabContextOpResult } from '../../shared/tabContextOps';
import { isAgentDormant, DORMANT_PIANOLA_MESSAGE } from '../../shared/agentVisibility';
import { selectActiveSession, selectSessionById, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Window event `useRemoteIntegration` raises for each remote request, answered
 * by `useAppRemoteEventListeners`, which holds App's handlers.
 */
export const TAB_CONTEXT_OP_EVENT = 'maestro:tabContextOp';

/** Detail of {@link TAB_CONTEXT_OP_EVENT}. `reply` must be called exactly once. */
export interface TabContextOpEventDetail {
	request: TabContextOpRequest;
	reply: (result: TabContextOpResult) => void;
}

/** The menu's handlers, as App's hooks expose them. */
export interface TabContextOpHandlers {
	summarizeTab: (
		sessionId: string,
		tabId: string,
		options?: { background?: boolean }
	) => Promise<TabContextOpResult>;
	mergeTabContext: (
		sourceSessionId: string,
		sourceTabId: string,
		targetSessionId: string,
		targetTabId: string | undefined,
		options: MergeOptions,
		placement?: MergePlacement
	) => Promise<MergeResult>;
	transferTabContext: (
		sourceSessionId: string,
		sourceTabId: string,
		targetSessionId: string,
		options: SendToAgentOptions,
		placement?: TransferPlacement
	) => Promise<TransferTabContextResult>;
}

/**
 * Merge Into as the CLI asks for it: into the target's existing tab, verbatim.
 * `preserveTimestamps` only orders the logs of a NEW merged session, which this
 * never creates.
 */
export const REMOTE_MERGE_OPTIONS: MergeOptions = {
	createNewSession: false,
	groomContext: false,
	preserveTimestamps: true,
};

type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

/** The agent a request names, refused when the Left Bar would not show it. */
function resolveAgent(sessionId: string): Resolved<Session> {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return { ok: false, error: `Agent not found: ${sessionId}` };
	if (isAgentDormant(session, useSettingsStore.getState().encoreFeatures)) {
		return { ok: false, error: DORMANT_PIANOLA_MESSAGE };
	}
	return { ok: true, value: session };
}

/** An AI tab of `session`: the named one, or its active AI tab. */
function resolveAiTab(session: Session, tabId: string | undefined): Resolved<string> {
	const id = tabId ?? session.activeTabId;
	if (id && session.aiTabs.some((tab) => tab.id === id)) return { ok: true, value: id };
	return {
		ok: false,
		error: tabId
			? `Tab ${tabId} is not an AI tab of agent ${session.id}`
			: `Agent ${session.id} has no active AI tab`,
	};
}

/**
 * The agent a merge or transfer sends to. Both modals list visible agents
 * only, and leave out `terminal` agents, which have no AI conversation.
 */
function resolveTargetAgent(targetSessionId: string | undefined): Resolved<Session> {
	if (!targetSessionId) return { ok: false, error: 'Missing target agent' };
	const target = resolveAgent(targetSessionId);
	if (!target.ok) return target;
	if (target.value.toolType === 'terminal') {
		return { ok: false, error: `Agent ${targetSessionId} is a terminal and has no AI tabs` };
	}
	return target;
}

/**
 * Run one remote context operation through the menu's handler and describe
 * what it did. Never throws for a refused request; a handler that throws is
 * the caller's to report.
 */
export async function runRemoteTabContextOp(
	request: TabContextOpRequest,
	handlers: TabContextOpHandlers
): Promise<TabContextOpResult> {
	const source = resolveAgent(request.sessionId);
	if (!source.ok) return { success: false, error: source.error };
	const sourceTab = resolveAiTab(source.value, request.tabId);
	if (!sourceTab.ok) return { success: false, error: sourceTab.error, sessionId: source.value.id };

	const subject = { sessionId: source.value.id, tabId: sourceTab.value };
	const background = request.background === true;

	if (request.op === 'compact') {
		const result = await handlers.summarizeTab(subject.sessionId, subject.tabId, { background });
		return { ...result, ...subject };
	}

	const target = resolveTargetAgent(request.targetSessionId);
	if (!target.ok) return { success: false, error: target.error, ...subject };
	const targetSessionId = target.value.id;

	if (request.op === 'merge') {
		const targetTab = resolveAiTab(target.value, request.targetTabId);
		if (!targetTab.ok) return { success: false, error: targetTab.error, ...subject };
		if (targetSessionId === subject.sessionId && targetTab.value === subject.tabId) {
			return { success: false, error: 'Cannot merge a tab into itself', ...subject };
		}
		const result = await handlers.mergeTabContext(
			subject.sessionId,
			subject.tabId,
			targetSessionId,
			targetTab.value,
			REMOTE_MERGE_OPTIONS,
			{ background }
		);
		if (!result.success) {
			return { success: false, error: result.error || 'Failed to merge contexts', ...subject };
		}
		// The merged context is sent by the target tab's composer when that tab
		// becomes active. A background merge into a tab nobody is looking at
		// therefore waits for it to be opened.
		const onScreen = selectActiveSession(useSessionStore.getState());
		const staged =
			background && !(onScreen?.id === targetSessionId && onScreen.activeTabId === targetTab.value);
		return {
			success: true,
			...subject,
			targetSessionId,
			targetTabId: targetTab.value,
			...(staged ? { staged: true } : {}),
		};
	}

	// Send to Agent opens a tab in ANOTHER agent; the modal never lists the source.
	if (targetSessionId === subject.sessionId) {
		return { success: false, error: 'Source and target agents must be different', ...subject };
	}
	const result = await handlers.transferTabContext(
		subject.sessionId,
		subject.tabId,
		targetSessionId,
		{ groomContext: false, targetSessionId },
		{ background }
	);
	if (!result.success) {
		return { success: false, error: result.error || 'Failed to send context', ...subject };
	}
	return {
		success: true,
		...subject,
		targetSessionId,
		...(result.newTabId ? { newTabId: result.newTabId } : {}),
		...(result.queued ? { queued: true } : {}),
	};
}
