/**
 * useTabWindowChatActions - the interactive half of an AI tab's transcript in a
 * tab window (TW-7): the same `PaneChatActions` bundle a tiled pane gets in an
 * app window, with every action that writes the agent sent to the owner as an
 * intent (D2). The queued cards' Remove / Hold / Merge / Edit / reorder / Force
 * Send / Steer, Stop, delete, replay, fork, session recovery, and file links.
 *
 * What writes nothing the owner keeps stays here: the Force Send and Steer
 * eligibility (pure, read from this window's copy of the agent; the owner
 * checks again when it runs), the lightbox, and the raw-markdown setting.
 *
 * Not offered (an app-window surface): the agent error modal, publishing a
 * message as a gist, and the saved-file "refresh the Files panel" callback.
 */

import { useMemo } from 'react';
import type { QueuedItem, Session } from '../../types';
import type { PaneChatActions } from '../MainPanel/TiledLayout';
import type { TabWindowIntent } from '../../../shared/tabWindowTypes';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import {
	sendTabWindowIntent,
	type TabWindowIntentBody,
} from '../../services/tabWindowIntentSender';
import { openLightbox } from '../../services/lightbox';
import { getForceSendEligibility, getSteerEligibility } from '../../utils/executionQueue';

export function useTabWindowChatActions(
	session: Session,
	aiTabId: string,
	inputRef: React.RefObject<HTMLTextAreaElement>
): PaneChatActions {
	const agentId = session.id;
	const forcedParallelEnabled = useSettingsStore((s) => s.forcedParallelExecution);
	const userMessageAlignment = useSettingsStore((s) => s.userMessageAlignment);
	const setChatRawTextMode = useSettingsStore((s) => s.setChatRawTextMode);
	const { fileTree, cwd, fullPath } = session;

	return useMemo<PaneChatActions>(() => {
		const send = (intent: TabWindowIntentBody, tabId = aiTabId) =>
			sendTabWindowIntent({
				...intent,
				agentId,
				tabRef: { type: 'ai', id: tabId },
			} as TabWindowIntent);
		// The eligibility rules are pure; they read this window's copy of the agent.
		const liveSession = () => useSessionStore.getState().sessions.find((s) => s.id === agentId);
		return {
			onDeleteLog: (logId) => {
				send({ kind: 'deleteLog', logId });
				// The owner deletes; the next patch carries the shorter transcript.
				return null;
			},
			onRemoveQueuedItem: (itemId) => send({ kind: 'removeQueuedItem', itemId }),
			onTogglePauseQueuedItem: (itemId) => send({ kind: 'toggleQueuedItemPaused', itemId }),
			onMergeQueuedItem: (itemId) => send({ kind: 'mergeQueuedItem', itemId }),
			onEditQueuedItem: (itemId, patch) => send({ kind: 'editQueuedItem', itemId, patch }),
			onReorderQueuedItem: (fromIndex, toIndex) =>
				send({ kind: 'reorderQueuedItem', fromIndex, toIndex }),
			onForceSendQueuedItem: (itemId) => send({ kind: 'forceSendQueuedItem', itemId }),
			forcedParallelEnabled,
			getForceSendContext: (item: QueuedItem) => {
				const current = liveSession();
				return current
					? getForceSendEligibility(current, item, {
							forcedParallelEnabled: useSettingsStore.getState().forcedParallelExecution,
						})
					: null;
			},
			getSteerContext: (item: QueuedItem) => {
				const current = liveSession();
				return current ? getSteerEligibility(current, item) : null;
			},
			onSteerQueuedItem: (itemId) => send({ kind: 'steerQueuedItem', itemId }),
			onInterrupt: () => send({ kind: 'interrupt' }),
			setLightboxImage: openLightbox,
			setMarkdownEditMode: setChatRawTextMode,
			onReplayMessage: (text, images) => send({ kind: 'replayMessage', text, images }),
			onForkConversation: (logId) => {
				send({ kind: 'forkConversation', logId });
				notifyCenterFlash({
					message: 'Forked in the main window',
					detail: 'The fork opens there as a new tab.',
					color: 'theme',
				});
			},
			onSessionRecover: ({ tabId, lastUserPrompt, groomContext }) =>
				send({ kind: 'recoverSession', lastUserPrompt, groomContext }, tabId),
			fileTree,
			cwd: cwd?.startsWith(fullPath) ? cwd.slice(fullPath.length + 1) : '',
			onFileClick: (path) => send({ kind: 'openFileLink', path }),
			onOpenInTab: (file) => send({ kind: 'openFileLink', path: file.path }),
			userMessageAlignment,
			inputRef,
		};
	}, [
		agentId,
		aiTabId,
		forcedParallelEnabled,
		userMessageAlignment,
		setChatRawTextMode,
		fileTree,
		cwd,
		fullPath,
		inputRef,
	]);
}
