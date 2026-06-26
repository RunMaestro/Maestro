import type { UseSettingsReturn } from '../../../../hooks/settings/useSettings';
import type { Theme } from '../../../../types';

export interface DisplayTabProps {
	theme: Theme;
}

export type DisplayTabSettings = UseSettingsReturn;

export interface FontConfigurationState {
	systemFonts: string[];
	customFonts: string[];
	fontLoading: boolean;
	fontsLoaded: boolean;
	handleFontInteraction: () => void;
	addCustomFont: (font: string) => void;
	removeCustomFont: (font: string) => void;
}

export interface BionifyAlgorithmState {
	algorithmDraft: string;
	setAlgorithmDraft: (value: string) => void;
	isAlgorithmValid: boolean;
	commitAlgorithmDraft: () => void;
	showInfoModal: boolean;
	openInfoModal: () => void;
	closeInfoModal: () => void;
}
