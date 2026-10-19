/**
 * TabWindowModals - the dialogs a tab window answers itself (Tab Windows, D2:
 * confirmations run in the tab window, and the intent carries only the
 * confirmed action).
 *
 * Each renderer has its own modal store, so the shared openers (`openModal`,
 * `openLightbox`) work here unchanged; this host draws what they open, with
 * the same components an app window draws:
 *   - `confirm`: a close with a draft, unsaved edits, or a running terminal;
 *     a queued card's confirms;
 *   - `renameTab`: the chip's "Rename" (the `renameTab` / `autoNameTab` intents);
 *   - `snoozeTab`: the chip's "Snooze" (the `snoozeTab` intent);
 *   - `lightbox`: images in the transcript and the staged-image strip.
 */

import { useCallback } from 'react';
import type { Session, Theme } from '../../types';
import type { TabWindowIntent, TabWindowTabRef } from '../../../shared/tabWindowTypes';
import {
	getModalActions,
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../stores/modalStore';
import { updateAiTab } from '../../stores/sessionStore';
import {
	sendTabWindowIntent,
	type TabWindowIntentBody,
} from '../../services/tabWindowIntentSender';
import { findSessionTabRef } from '../../services/tabWindowNavigation';
import { closeLightbox } from '../../services/lightbox';
import { ConfirmModal } from '../ConfirmModal';
import { RenameTabModal } from '../RenameTabModal';
import { SnoozeTabModal } from '../SnoozeTabModal';
import { LightboxModal } from '../LightboxModal';

export interface TabWindowModalsProps {
	theme: Theme;
	/** The agent as this window sees it; null until the owner's first snapshot. */
	session: Session | null;
}

export function TabWindowModals({ theme, session }: TabWindowModalsProps) {
	const closeModal = useModalStore((s) => s.closeModal);
	const confirmOpen = useModalStore(selectModalOpen('confirm'));
	const confirm = useModalStore(selectModalData('confirm'));
	const renameOpen = useModalStore(selectModalOpen('renameTab'));
	const rename = useModalStore(selectModalData('renameTab'));
	const snoozeOpen = useModalStore(selectModalOpen('snoozeTab'));
	const snooze = useModalStore(selectModalData('snoozeTab'));
	const lightboxOpen = useModalStore(selectModalOpen('lightbox'));
	const lightbox = useModalStore(selectModalData('lightbox'));

	/** Send `intent` for the tab `tabId` names, whatever kind it is. */
	const sendForTab = useCallback(
		(tabId: string, intent: TabWindowIntentBody) => {
			if (!session) return;
			const tabRef: TabWindowTabRef | null = findSessionTabRef(session, tabId);
			if (!tabRef) return;
			sendTabWindowIntent({ ...intent, agentId: session.id, tabRef } as TabWindowIntent);
		},
		[session]
	);

	const renamedAiTab = rename ? session?.aiTabs.find((t) => t.id === rename.tabId) : undefined;

	// A staged image can be removed from the lightbox; a transcript image cannot.
	const deleteStagedImage = useCallback(
		(image: string) => {
			if (!session) return;
			updateAiTab(session.id, session.activeTabId, (tab) => ({
				...tab,
				stagedImages: (tab.stagedImages ?? []).filter((staged) => staged !== image),
			}));
		},
		[session]
	);

	return (
		<>
			{confirmOpen && confirm && (
				<ConfirmModal
					theme={theme}
					title={confirm.title}
					destructive={confirm.destructive}
					message={confirm.message}
					onConfirm={confirm.onConfirm}
					onClose={() => closeModal('confirm')}
				/>
			)}

			{renameOpen && rename && session && (
				<RenameTabModal
					theme={theme}
					initialName={rename.initialName}
					agentSessionId={renamedAiTab?.agentSessionId}
					onClose={() => closeModal('renameTab')}
					onRename={(name) => sendForTab(rename.tabId, { kind: 'renameTab', name })}
					onAutoName={
						renamedAiTab
							? () => {
									sendForTab(rename.tabId, { kind: 'autoNameTab' });
									closeModal('renameTab');
								}
							: undefined
					}
					hasLogs={(renamedAiTab?.logs.length ?? 0) > 0}
				/>
			)}

			{snoozeOpen && snooze && session && (
				<SnoozeTabModal
					theme={theme}
					tabLabel={snooze.tabLabel}
					canRunWakePrompt={snooze.canRunWakePrompt}
					onClose={() => closeModal('snoozeTab')}
					onConfirm={(wakeAt, content) => {
						sendForTab(snooze.tabId, {
							kind: 'snoozeTab',
							wakeAt,
							note: content?.note,
							wakePrompt: content?.wakePrompt,
						});
						closeModal('snoozeTab');
					}}
				/>
			)}

			{lightboxOpen && lightbox?.image && (
				<LightboxModal
					image={lightbox.image}
					stagedImages={lightbox.images}
					onClose={closeLightbox}
					onNavigate={(image) => getModalActions().setLightboxImage(image)}
					onDelete={lightbox.allowDelete ? deleteStagedImage : undefined}
					theme={theme}
				/>
			)}
		</>
	);
}
