import type { SettingsStoreActions, SettingsStoreState } from './settingsStore';
import { RIGHT_PANEL_MAX_WIDTH, RIGHT_PANEL_MIN_WIDTH } from '../constants/rightPanel';
import type { ModalResizeKey, ModalSize, ModalSizes } from '../utils/modalSizing';
import { sanitizeModalSizes } from '../utils/modalSizing';

type SetSettingsState = (partial: Partial<SettingsStoreState>) => void;
type PersistSetting = (key: string, value: unknown) => void;

type ShellAndAppearanceSetters = Pick<
	SettingsStoreActions,
	| 'setDefaultShell'
	| 'setCustomShellPath'
	| 'setShellArgs'
	| 'setShellEnvVars'
	| 'setGhPath'
	| 'setFontFamily'
	| 'setFontSize'
	| 'setActiveThemeId'
	| 'setCustomThemeColors'
	| 'setCustomThemeBaseId'
>;

/**
 * Setter domain for terminal shell configuration and visual appearance.
 * Persistence remains an injected, explicit side effect at the store boundary.
 */
export function createShellAndAppearanceSetters(
	set: SetSettingsState,
	persist: PersistSetting
): ShellAndAppearanceSetters {
	return {
		setDefaultShell: (value) => {
			set({ defaultShell: value });
			persist('defaultShell', value);
		},
		setCustomShellPath: (value) => {
			set({ customShellPath: value });
			persist('customShellPath', value);
		},
		setShellArgs: (value) => {
			set({ shellArgs: value });
			persist('shellArgs', value);
		},
		setShellEnvVars: (value) => {
			set({ shellEnvVars: value });
			persist('shellEnvVars', value);
		},
		setGhPath: (value) => {
			set({ ghPath: value });
			persist('ghPath', value);
		},
		setFontFamily: (value) => {
			set({ fontFamily: value });
			persist('fontFamily', value);
		},
		setFontSize: (value) => {
			set({ fontSize: value });
			persist('fontSize', value);
		},
		setActiveThemeId: (value) => {
			set({ activeThemeId: value });
			persist('activeThemeId', value);
		},
		setCustomThemeColors: (value) => {
			set({ customThemeColors: value });
			persist('customThemeColors', value);
		},
		setCustomThemeBaseId: (value) => {
			set({ customThemeBaseId: value });
			persist('customThemeBaseId', value);
		},
	};
}

type InputAndLayoutSetters = Pick<
	SettingsStoreActions,
	| 'setEnterToSendAI'
	| 'setEnterToSendAIExpanded'
	| 'setForcedParallelExecution'
	| 'setForcedParallelAcknowledged'
	| 'setDefaultSaveToHistory'
	| 'setSynopsisDebounceSeconds'
	| 'setDefaultShowThinking'
	| 'setLeftSidebarWidth'
	| 'setRightPanelWidth'
	| 'setModalSize'
	| 'resetModalSizes'
	| 'setMarkdownEditMode'
	| 'setChatRawTextMode'
	| 'setGroupChatAutoScroll'
>;

/**
 * Setter domain for input preferences and panel/modal layout. Normalization is
 * kept beside the persistence action so UI and programmatic callers agree.
 */
export function createInputAndLayoutSetters(
	set: SetSettingsState,
	persist: PersistSetting,
	getModalSizes: () => ModalSizes
): InputAndLayoutSetters {
	return {
		setEnterToSendAI: (value) => {
			set({ enterToSendAI: value });
			persist('enterToSendAI', value);
		},
		setEnterToSendAIExpanded: (value) => {
			set({ enterToSendAIExpanded: value });
			persist('enterToSendAIExpanded', value);
		},
		setForcedParallelExecution: (value) => {
			set({ forcedParallelExecution: value });
			persist('forcedParallelExecution', value);
		},
		setForcedParallelAcknowledged: (value) => {
			set({ forcedParallelAcknowledged: value });
			persist('forcedParallelAcknowledged', value);
		},
		setDefaultSaveToHistory: (value) => {
			set({ defaultSaveToHistory: value });
			persist('defaultSaveToHistory', value);
		},
		setSynopsisDebounceSeconds: (value) => {
			const clamped = Math.max(0, Math.round(value));
			set({ synopsisDebounceSeconds: clamped });
			persist('synopsisDebounceSeconds', clamped);
		},
		setDefaultShowThinking: (value) => {
			set({ defaultShowThinking: value });
			persist('defaultShowThinking', value);
		},
		setLeftSidebarWidth: (value) => {
			const clamped = Math.max(256, Math.min(600, value));
			set({ leftSidebarWidth: clamped });
			persist('leftSidebarWidth', clamped);
		},
		setRightPanelWidth: (value) => {
			const clamped = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, value));
			set({ rightPanelWidth: clamped });
			persist('rightPanelWidth', clamped);
		},
		setModalSize: (key: ModalResizeKey, value: ModalSize) => {
			const normalized = sanitizeModalSizes({ [key]: value })[key];
			if (!normalized) return;
			const next = { ...getModalSizes(), [key]: normalized };
			set({ modalSizes: next });
			persist('modalSizes', next);
		},
		resetModalSizes: () => {
			set({ modalSizes: {} });
			persist('modalSizes', {});
		},
		setMarkdownEditMode: (value) => {
			set({ markdownEditMode: value });
			persist('markdownEditMode', value);
		},
		setChatRawTextMode: (value) => {
			set({ chatRawTextMode: value });
			persist('chatRawTextMode', value);
		},
		setGroupChatAutoScroll: (value) => {
			set({ groupChatAutoScroll: value });
			persist('groupChatAutoScroll', value);
		},
	};
}
