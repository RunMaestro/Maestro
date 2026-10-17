/**
 * Open one of the app's registered UI surfaces by id (see
 * `shared/uiSurfaces.ts`). This is the renderer end of `maestro-cli open`,
 * and the single place that knows how a surface id becomes a modal-store call.
 *
 * Everything routes through `getModalActions()`, so a surface opened from the
 * CLI lands in exactly the state a hotkey or command-palette entry would
 * produce - including the modal layer stack and Escape handling.
 */

import type { CueModalData, ModalId } from '../stores/modalStore';
import { getModalActions, useModalStore } from '../stores/modalStore';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { useFeedbackDraftStore } from '../stores/feedbackDraftStore';
import { useThroughputGaugeStore } from '../stores/throughputGaugeStore';
import { notifyToast, useNotificationStore } from '../stores/notificationStore';
import { openAgentSettings } from '../services/agentNavigation';
import {
	resolveUiSurface,
	resolveUiSurfaceTarget,
	surfaceEncoreRefusal,
	type OpenUiSurfaceRequest,
} from '../../shared/uiSurfaces';
import type { AgentSettingsTabId } from '../../shared/agentSettingsTabs';
import { isWebDesktop } from './runtimeContext';
import type { SettingsTab, UsageDashboardViewMode } from '../types';

export interface OpenUiSurfaceResult {
	ok: boolean;
	/** Why the open was refused. Present only when `ok` is false. */
	error?: string;
}

/**
 * Open the surface a request names, optionally deep-linking to its `tab` and,
 * inside it, `subTab`, on the agent group `group` for a surface that takes
 * one, or for the agent `agent` when the surface is one agent's.
 *
 * Refuses (with a toast) when the surface is behind an Encore Feature the user
 * has turned off: silently opening nothing would look like the CLI lied, and
 * silently enabling the feature would change a setting the user never touched.
 */
export function openUiSurface(request: OpenUiSurfaceRequest): OpenUiSurfaceResult {
	const surface = resolveUiSurface(request.surface);
	if (!surface) return { ok: false, error: `Unknown surface "${request.surface}"` };

	const target = resolveUiSurfaceTarget(surface, request);
	if ('error' in target) return { ok: false, error: target.error };
	const { tab, subTab } = target;

	const refusal = surfaceEncoreRefusal(surface, useSettingsStore.getState().encoreFeatures);
	if (refusal) {
		notifyToast({ color: 'yellow', title: `${surface.label} is disabled`, message: refusal });
		return { ok: false, error: refusal };
	}

	const actions = getModalActions();

	switch (surface.id) {
		case 'notification-center': {
			// Switched off, there is no inbox to open. Say so rather than opening
			// nothing, and never flip the setting on the user's behalf.
			if (!useSettingsStore.getState().notificationCenterEnabled) {
				const message =
					'The notification center is off. Turn it on in Settings → Notifications → Notification center.';
				notifyToast({ color: 'yellow', title: 'Notification Center is off', message });
				return { ok: false, error: message };
			}
			useNotificationStore.getState().setNotificationCenterOpen(true);
			return { ok: true };
		}
		case 'settings':
			actions.openSettings(tab ? (tab.id as SettingsTab) : undefined, undefined, subTab?.id);
			return { ok: true };
		case 'cue':
			if (tab) actions.openCueModalWithTab(tab.id as NonNullable<CueModalData['initialTab']>);
			else actions.setCueModalOpen(true);
			return { ok: true };
		case 'usage-dashboard':
			// The dashboard reads its initial tab from the UI store on mount, so
			// setting it first is the deep-link - no prop threading required.
			if (tab) {
				useUIStore.getState().setUsageDashboardViewMode(tab.id as UsageDashboardViewMode);
			}
			actions.setUsageDashboardOpen(true);
			return { ok: true };
		case 'quick-chat': {
			// A separate window owned by the main process, and only the Electron
			// app has one: the web-desktop bridge exposes no Quick Chat window.
			const quickChat = isWebDesktop() ? undefined : window.maestro?.quickChat;
			if (!quickChat)
				return { ok: false, error: 'Quick Chat is only available in the desktop app' };
			void quickChat.window('show');
			return { ok: true };
		}
		case 'throughput-gauge':
			// A floating card, not a modal: show it through its own store. Showing
			// never moves focus, so the user keeps typing where they were.
			useThroughputGaugeStore.getState().show();
			return { ok: true };
		case 'quick-actions':
			actions.setQuickActionOpen(true, 'main');
			return { ok: true };
		case 'feedback': {
			// Same as the Feedback button: a parked draft is restored, not replaced
			// by a fresh modal that would throw the conversation away.
			const draft = useFeedbackDraftStore.getState();
			if (draft.isMinimized) draft.setMinimized(false);
			else useModalStore.getState().openModal('feedback');
			return { ok: true };
		}
		case 'group-settings':
			// The registry refuses this surface without a group, so one is here.
			if (!target.group) return { ok: false, error: `${surface.label} opens on one group.` };
			actions.openGroupSettings(target.group);
			return { ok: true };
		case 'agent-settings': {
			// The registry refuses this surface without an agent, so one is here.
			const session = target.agent
				? selectSessionById(target.agent)(useSessionStore.getState())
				: undefined;
			if (!session) return { ok: false, error: `Agent not found: ${target.agent ?? ''}` };
			// The same opener the Delegation Graph uses to land on the Peers tab.
			openAgentSettings(session, tab ? { tab: tab.id as AgentSettingsTabId } : {});
			return { ok: true };
		}
		case 'delegation-graph':
			// A group that is gone by now is not refused here: the graph falls
			// back to every agent, the same as a scope whose group is deleted
			// while it is open.
			actions.openDelegationGraph(target.group);
			return { ok: true };
		default:
			// Surfaces with no data payload open generically - one line here beats
			// a switch arm per modal that would drift as the registry grows.
			useModalStore.getState().openModal(surface.modal as ModalId);
			return { ok: true };
	}
}
