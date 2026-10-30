/**
 * reopenedTabContent - fill a reopened tab whose stored entry was a pointer.
 *
 * The closed-tab stack persists without the heavy content (see
 * `src/shared/closedTabHistory.ts`): an AI tab whose provider can give the
 * transcript back is stored with no logs, and a file tab with no content. A tab
 * reopened from such an entry (Cmd+Shift+T, the palette, a notification click,
 * a deep link, `maestro-cli tab reopen`) comes back synchronously and empty;
 * this module reads its content back:
 *
 *   - AI tab with no logs and a provider session id: `loadResumableSession()`.
 *   - File tab with no content, no pending edit, and a path: a disk read.
 *
 * A desktop-only store subscriber checks the active agent's visible tabs, so no
 * reopen path has to call in. A caller that must see the content before it
 * answers (the CLI reopen handler) awaits `loadReopenedTabContent()` itself.
 *
 * Writes never overwrite: a message sent or an edit made while the read was in
 * flight wins.
 */

import type { LogEntry, Session, UnifiedTabRef } from '../types';
import { updateAiTab, updateFileTab, useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { resolveSessionProjectPath } from '../components/AgentSessionsBrowser/utils/sessionProjectPath';
import { readFilePreviewContent } from '../hooks/tabs/internal/filePreviewTabHelpers';
import { collectLeafTabRefs, resolveActiveTabRef } from '../utils/panelLayout';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';
import { loadResumableSession } from './resumableSession';

export type ReopenedTabContentResult = 'loaded' | 'skipped' | 'unavailable' | 'failed';

/** Shown in a reopened AI tab whose conversation the provider no longer holds. */
export const REOPENED_TRANSCRIPT_UNAVAILABLE_TEXT =
	'The provider no longer has this conversation, so its transcript could not be restored. The tab keeps its name, draft, and session id.';

const inFlight = new Map<string, Promise<ReopenedTabContentResult>>();
/** Tabs already handled this run, whatever the outcome: never read twice. */
const settled = new Set<string>();

const keyOf = (sessionId: string, ref: UnifiedTabRef): string =>
	`${sessionId}:${ref.type}:${ref.id}`;

/** True when this tab is a reopened pointer still waiting for its content. */
export function needsReopenedTabContent(session: Session, ref: UnifiedTabRef): boolean {
	if (ref.type === 'ai') {
		const tab = session.aiTabs?.find((item) => item.id === ref.id);
		return !!tab && (tab.logs?.length ?? 0) === 0 && !!tab.agentSessionId;
	}
	if (ref.type === 'file') {
		const tab = session.filePreviewTabs?.find((item) => item.id === ref.id);
		return (
			!!tab && tab.content === '' && tab.editContent === undefined && !tab.isLoading && !!tab.path
		);
	}
	return false;
}

function findSession(sessionId: string): Session | undefined {
	return useSessionStore.getState().sessions.find((item) => item.id === sessionId);
}

async function loadAiTranscript(
	sessionId: string,
	tabId: string
): Promise<ReopenedTabContentResult> {
	const session = findSession(sessionId);
	const tab = session?.aiTabs.find((item) => item.id === tabId);
	if (!session || !tab?.agentSessionId) return 'skipped';
	const { projectPathForSessions, sshRemoteId } = resolveSessionProjectPath(session);
	if (!projectPathForSessions) return 'skipped';

	const resumable = await loadResumableSession({
		toolType: tab.turnProvider ?? session.toolType,
		projectRoot: projectPathForSessions,
		sshRemoteId,
		agentSessionId: tab.agentSessionId,
		starred: tab.starred,
		usageStats: tab.usageStats,
	});
	const messages: LogEntry[] = resumable
		? resumable.messages
		: [
				{
					id: generateId(),
					timestamp: Date.now(),
					source: 'system',
					text: REOPENED_TRANSCRIPT_UNAVAILABLE_TEXT,
				},
			];
	// The handleResumeSession guard: a tab that gained logs meanwhile keeps them.
	updateAiTab(sessionId, tabId, (current) =>
		current.logs.length > 0 ? current : { ...current, logs: messages }
	);
	return resumable ? 'loaded' : 'unavailable';
}

async function loadFileContent(
	sessionId: string,
	tabId: string
): Promise<ReopenedTabContentResult> {
	const tab = findSession(sessionId)?.filePreviewTabs.find((item) => item.id === tabId);
	if (!tab?.path) return 'skipped';
	const disk = await readFilePreviewContent(tab.path, tab.sshRemoteId);
	if (!disk) return 'unavailable';
	updateFileTab(sessionId, tabId, (current) =>
		current.content !== '' || current.editContent !== undefined
			? current
			: { ...current, content: disk.content, lastModified: disk.lastModified }
	);
	return 'loaded';
}

/**
 * Read a reopened tab's content back, if it still needs it. Resolves once the
 * content is in the store. Concurrent calls for one tab share a read, and a tab
 * is read at most once per run.
 */
export function loadReopenedTabContent(
	sessionId: string,
	ref: UnifiedTabRef
): Promise<ReopenedTabContentResult> {
	const key = keyOf(sessionId, ref);
	const pending = inFlight.get(key);
	if (pending) return pending;
	if (settled.has(key)) return Promise.resolve('skipped');
	const session = findSession(sessionId);
	if (!session || !needsReopenedTabContent(session, ref)) return Promise.resolve('skipped');

	const read = (async (): Promise<ReopenedTabContentResult> => {
		try {
			const result =
				ref.type === 'ai'
					? await loadAiTranscript(sessionId, ref.id)
					: await loadFileContent(sessionId, ref.id);
			settled.add(key);
			return result;
		} catch (error) {
			settled.add(key);
			logger.warn(
				`[reopenedTabContent] Failed to load the content of reopened ${ref.type} tab ${ref.id}`,
				undefined,
				error
			);
			notifyToast({
				color: 'red',
				title: ref.type === 'ai' ? 'Transcript not loaded' : 'File not loaded',
				message:
					ref.type === 'ai'
						? 'The reopened tab could not read its conversation back from the provider.'
						: 'The reopened tab could not read its file.',
			});
			return 'failed';
		} finally {
			inFlight.delete(key);
		}
	})();
	inFlight.set(key, read);
	return read;
}

/** The tabs the user can see in an agent: the active tab and the panes of the active group. */
function visibleTabRefs(session: Session): UnifiedTabRef[] {
	const refs: UnifiedTabRef[] = [];
	const active = resolveActiveTabRef(session);
	if (active) refs.push(active);
	const group = session.tabGroups?.find((item) => item.id === session.activeGroupId);
	if (group) refs.push(...collectLeafTabRefs(group.layout));
	return refs;
}

/** Load the content of any visible reopened tab in the active agent. */
function loadVisibleReopenedTabs(): void {
	const { sessions, activeSessionId, sessionsReadOk } = useSessionStore.getState();
	if (!sessionsReadOk) return;
	const session = sessions.find((item) => item.id === activeSessionId);
	if (!session) return;
	for (const ref of visibleTabRefs(session)) {
		if (ref.type !== 'ai' && ref.type !== 'file') continue;
		const key = keyOf(session.id, ref);
		if (inFlight.has(key) || settled.has(key)) continue;
		if (needsReopenedTabContent(session, ref)) void loadReopenedTabContent(session.id, ref);
	}
}

/**
 * Watch the store and fill reopened tabs as they become visible. Desktop only:
 * a web-desktop client gets transcripts through its own deferred-content path.
 * Returns the unsubscribe function.
 */
export function startReopenedTabContentLoader(): () => void {
	const unsubscribe = useSessionStore.subscribe(loadVisibleReopenedTabs);
	loadVisibleReopenedTabs();
	return unsubscribe;
}

/** Reset the per-run bookkeeping. Test-only. */
export function __resetReopenedTabContentForTests(): void {
	inFlight.clear();
	settled.clear();
}
