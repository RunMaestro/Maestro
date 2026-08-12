/**
 * Notifications settings slice for settingsStore (OS notifications, audio
 * feedback, idle notifications, and toast display, all consumed by
 * NotificationsPanel.tsx / Toast.tsx).
 *
 * Part of the same domain-slice decomposition as settingsAnnotatorSlice.ts -
 * see that file for the pattern this follows.
 */

import type { StateCreator } from 'zustand';
import type { ToastWidth } from '../../shared/toastWidth';
import { isToastWidth } from '../../shared/toastWidth';
import type { SettingsStore } from './settingsStore';

export interface NotificationsState {
	toastWidth: ToastWidth;
	osNotificationsEnabled: boolean;
	audioFeedbackEnabled: boolean;
	audioFeedbackCommand: string;
	toastDuration: number;
	idleNotificationEnabled: boolean;
	idleNotificationCommand: string;
}

export interface NotificationsActions {
	setToastWidth: (value: ToastWidth) => void;
	setOsNotificationsEnabled: (value: boolean) => void;
	setAudioFeedbackEnabled: (value: boolean) => void;
	setAudioFeedbackCommand: (value: string) => void;
	setToastDuration: (value: number) => void;
	setIdleNotificationEnabled: (value: boolean) => void;
	setIdleNotificationCommand: (value: string) => void;
}

export type NotificationsSlice = NotificationsState & NotificationsActions;

export const createNotificationsSlice: StateCreator<SettingsStore, [], [], NotificationsSlice> = (
	set
) => ({
	toastWidth: 'dynamic',
	osNotificationsEnabled: true,
	audioFeedbackEnabled: false,
	audioFeedbackCommand: 'say',
	toastDuration: 20,
	idleNotificationEnabled: false,
	idleNotificationCommand: 'say Maestro is idle',

	setToastWidth: (value) => {
		set({ toastWidth: value });
		window.maestro.settings.set('toastWidth', value);
	},

	setOsNotificationsEnabled: (value) => {
		set({ osNotificationsEnabled: value });
		window.maestro.settings.set('osNotificationsEnabled', value);
	},

	setAudioFeedbackEnabled: (value) => {
		set({ audioFeedbackEnabled: value });
		window.maestro.settings.set('audioFeedbackEnabled', value);
	},

	setAudioFeedbackCommand: (value) => {
		set({ audioFeedbackCommand: value });
		window.maestro.settings.set('audioFeedbackCommand', value);
	},

	setToastDuration: (value) => {
		set({ toastDuration: value });
		window.maestro.settings.set('toastDuration', value);
	},

	setIdleNotificationEnabled: (value) => {
		set({ idleNotificationEnabled: value });
		window.maestro.settings.set('idleNotificationEnabled', value);
	},

	setIdleNotificationCommand: (value) => {
		set({ idleNotificationCommand: value });
		window.maestro.settings.set('idleNotificationCommand', value);
	},
});

/** Mutates `patch` in place with any persisted Notifications fields found in `allSettings`. */
export function hydrateNotificationsSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<NotificationsState>
): void {
	if (allSettings['toastWidth'] !== undefined) {
		patch.toastWidth = isToastWidth(allSettings['toastWidth'])
			? allSettings['toastWidth']
			: 'small';
	}

	if (allSettings['osNotificationsEnabled'] !== undefined)
		patch.osNotificationsEnabled = allSettings['osNotificationsEnabled'] as boolean;

	if (allSettings['audioFeedbackEnabled'] !== undefined)
		patch.audioFeedbackEnabled = allSettings['audioFeedbackEnabled'] as boolean;

	if (allSettings['audioFeedbackCommand'] !== undefined)
		patch.audioFeedbackCommand = allSettings['audioFeedbackCommand'] as string;

	if (allSettings['toastDuration'] !== undefined)
		patch.toastDuration = allSettings['toastDuration'] as number;

	if (allSettings['idleNotificationEnabled'] !== undefined)
		patch.idleNotificationEnabled = allSettings['idleNotificationEnabled'] as boolean;

	if (allSettings['idleNotificationCommand'] !== undefined)
		patch.idleNotificationCommand = allSettings['idleNotificationCommand'] as string;
}
