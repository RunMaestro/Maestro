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
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { notifyToast } from '../stores/notificationStore';
import { resolveUiSurface, resolveUiSurfaceTab } from '../../shared/uiSurfaces';
import type { SettingsTab, UsageDashboardViewMode } from '../types';

export interface OpenUiSurfaceResult {
	ok: boolean;
	/** Why the open was refused. Present only when `ok` is false. */
	error?: string;
}

/**
 * Open `surfaceId`, optionally deep-linking to `tabId`.
 *
 * Refuses (with a toast) when the surface is behind an Encore Feature the user
 * has turned off: silently opening nothing would look like the CLI lied, and
 * silently enabling the feature would change a setting the user never touched.
 */
export function openUiSurface(surfaceId: string, tabId?: string): OpenUiSurfaceResult {
	const surface = resolveUiSurface(surfaceId);
	if (!surface) return { ok: false, error: `Unknown surface "${surfaceId}"` };

	const tab = tabId ? resolveUiSurfaceTab(surface, tabId) : null;
	if (tabId && !tab) return { ok: false, error: `Unknown tab "${tabId}" for ${surface.label}` };

	if (surface.encore) {
		const enabled = useSettingsStore.getState().encoreFeatures[surface.encore];
		if (!enabled) {
			const message = `${surface.label} is an Encore Feature and is currently off. Turn it on in Settings → General → Encore Features.`;
			notifyToast({ color: 'yellow', title: `${surface.label} is disabled`, message });
			return { ok: false, error: message };
		}
	}

	const actions = getModalActions();

	switch (surface.id) {
		case 'settings':
			actions.openSettings(tab ? (tab.id as SettingsTab) : undefined);
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
		case 'quick-actions':
			actions.setQuickActionOpen(true, 'main');
			return { ok: true };
		default:
			// Surfaces with no data payload open generically - one line here beats
			// a switch arm per modal that would drift as the registry grows.
			useModalStore.getState().openModal(surface.modal as ModalId);
			return { ok: true };
	}
}
