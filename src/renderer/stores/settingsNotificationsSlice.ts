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
import { isToastWidth, TOAST_WIDTH_LABELS, describeToastWidth } from '../../shared/toastWidth';
import type { ToastPosition } from '../../shared/toastPosition';
import {
	DEFAULT_TOAST_POSITION,
	describeToastPosition,
	isToastPosition,
	TOAST_POSITION_LABELS,
	toastSidePanel,
} from '../../shared/toastPosition';
import { notifyToast, useNotificationStore } from './notificationStore';
import type { SettingsStore } from './settingsStore';

/** How long a toast-setting preview stays up. Long enough to read, short enough not to linger. */
const TOAST_PREVIEW_DURATION_MS = 5000;

/**
 * ID of the live toast-setting preview (width or position), so a new pick
 * replaces it instead of stacking.
 */
let toastPreviewId: string | null = null;

/**
 * Fire a sample toast so a width or position change is visible the moment it
 * is picked, instead of waiting for the next real notification. Replaces its
 * own previous preview so clicking through the presets updates one toast
 * rather than stacking several.
 */
function showToastSettingPreview(title: string, message: string): void {
	if (toastPreviewId) {
		useNotificationStore.getState().removeToast(toastPreviewId);
	}
	toastPreviewId = notifyToast({
		color: 'theme',
		title,
		message,
		duration: TOAST_PREVIEW_DURATION_MS,
		// In-app preview only: no TTS command, no Notification Center entry.
		skipCustomNotification: true,
		skipOsNotification: true,
	});
}

export interface NotificationsState {
	toastWidth: ToastWidth;
	toastPosition: ToastPosition;
	osNotificationsEnabled: boolean;
	audioFeedbackEnabled: boolean;
	audioFeedbackCommand: string;
	toastDuration: number;
	idleNotificationEnabled: boolean;
	idleNotificationCommand: string;
}

export interface NotificationsActions {
	setToastWidth: (value: ToastWidth) => void;
	setToastPosition: (value: ToastPosition) => void;
	setOsNotificationsEnabled: (value: boolean) => void;
	setAudioFeedbackEnabled: (value: boolean) => void;
	setAudioFeedbackCommand: (value: string) => void;
	setToastDuration: (value: number) => void;
	setIdleNotificationEnabled: (value: boolean) => void;
	setIdleNotificationCommand: (value: string) => void;
}

export type NotificationsSlice = NotificationsState & NotificationsActions;

export const createNotificationsSlice: StateCreator<SettingsStore, [], [], NotificationsSlice> = (
	set,
	get
) => ({
	toastWidth: 'dynamic',
	toastPosition: DEFAULT_TOAST_POSITION,
	osNotificationsEnabled: true,
	audioFeedbackEnabled: false,
	audioFeedbackCommand: 'say',
	toastDuration: 20,
	idleNotificationEnabled: false,
	idleNotificationCommand: 'say Maestro is idle',

	setToastWidth: (value) => {
		set({ toastWidth: value });
		window.maestro.settings.set('toastWidth', value);
		const sidePanel = toastSidePanel(get().toastPosition, get());
		showToastSettingPreview(
			`Toast Width: ${TOAST_WIDTH_LABELS[value]}`,
			describeToastWidth(value, sidePanel.width, sidePanel.name)
		);
	},

	setToastPosition: (value) => {
		set({ toastPosition: value });
		window.maestro.settings.set('toastPosition', value);
		showToastSettingPreview(
			`Toast Position: ${TOAST_POSITION_LABELS[value]}`,
			describeToastPosition(value)
		);
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

	if (allSettings['toastPosition'] !== undefined) {
		patch.toastPosition = isToastPosition(allSettings['toastPosition'])
			? allSettings['toastPosition']
			: DEFAULT_TOAST_POSITION;
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
