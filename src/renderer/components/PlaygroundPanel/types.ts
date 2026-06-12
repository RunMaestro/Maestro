import type { Dispatch, SetStateAction } from 'react';
import type { AutoRunStats, Theme, ThemeMode } from '../../types';
import type { ConfettiShape, ConfettiSettings } from './utils/confettiSettings';
import type { BatonSettings, EasingOption } from './utils/batonCss';

export interface PlaygroundPanelProps {
	theme: Theme;
	themeMode: ThemeMode;
	onClose: () => void;
}

export type TabId = 'achievements' | 'confetti' | 'baton';

export interface PlaygroundTabsState {
	activeTab: TabId;
	setActiveTab: Dispatch<SetStateAction<TabId>>;
}

export interface AchievementPlaygroundState {
	mockCumulativeTime: number;
	setMockCumulativeTime: Dispatch<SetStateAction<number>>;
	mockLongestRun: number;
	setMockLongestRun: Dispatch<SetStateAction<number>>;
	mockTotalRuns: number;
	setMockTotalRuns: Dispatch<SetStateAction<number>>;
	mockAutoRunStats: AutoRunStats;
	showStandingOvation: boolean;
	ovationBadgeLevel: number;
	setOvationBadgeLevel: Dispatch<SetStateAction<number>>;
	ovationIsNewRecord: boolean;
	setOvationIsNewRecord: Dispatch<SetStateAction<boolean>>;
	showKeyboardMasteryCelebration: boolean;
	keyboardMasteryLevel: number;
	setKeyboardMasteryLevel: Dispatch<SetStateAction<number>>;
	setToBadgeLevel: (level: number) => void;
	triggerOvation: () => void;
	closeStandingOvation: () => void;
	triggerKeyboardMastery: () => void;
	closeKeyboardMastery: () => void;
	resetMockData: () => void;
}

export interface ConfettiPlaygroundState extends ConfettiSettings {
	setParticleCount: Dispatch<SetStateAction<number>>;
	setAngle: Dispatch<SetStateAction<number>>;
	setSpread: Dispatch<SetStateAction<number>>;
	setStartVelocity: Dispatch<SetStateAction<number>>;
	setGravity: Dispatch<SetStateAction<number>>;
	setDecay: Dispatch<SetStateAction<number>>;
	setDrift: Dispatch<SetStateAction<number>>;
	setScalar: Dispatch<SetStateAction<number>>;
	setTicks: Dispatch<SetStateAction<number>>;
	setFlat: Dispatch<SetStateAction<boolean>>;
	selectedOrigins: Set<string>;
	copySuccess: boolean;
	toggleOrigin: (row: number, col: number) => void;
	toggleShape: (shape: ConfettiShape) => void;
	setColorAt: (index: number, color: string) => void;
	addColor: () => void;
	removeColor: (index: number) => void;
	firePlaygroundConfetti: () => void;
	resetConfettiSettings: () => void;
	copyConfettiSettings: () => Promise<void>;
}

export interface BatonPlaygroundState extends BatonSettings {
	batonActive: boolean;
	batonCopySuccess: boolean;
	setDuration: Dispatch<SetStateAction<number>>;
	setFadeOutStart: Dispatch<SetStateAction<number>>;
	setFadeInStart: Dispatch<SetStateAction<number>>;
	setTranslateAmount: Dispatch<SetStateAction<number>>;
	setStaggerOffset: Dispatch<SetStateAction<number>>;
	setEasing: Dispatch<SetStateAction<EasingOption>>;
	toggleBatonActive: () => void;
	resetBatonDefaults: () => void;
	copyBatonSettings: () => Promise<void>;
}

export interface PlaygroundData {
	tabs: PlaygroundTabsState;
	achievements: AchievementPlaygroundState;
	confetti: ConfettiPlaygroundState;
	baton: BatonPlaygroundState;
}
