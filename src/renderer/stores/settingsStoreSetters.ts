import type { SettingsStoreActions, SettingsStoreState } from './settingsStore';

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
