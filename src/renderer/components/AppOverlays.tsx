/**
 * AppOverlays.tsx
 *
 * Consolidated overlay components extracted from App.tsx.
 * These are full-screen celebration/recognition overlays that appear
 * on top of the main application content.
 *
 * Includes:
 * - StandingOvationOverlay - Badge unlocks and Auto Run records
 * - FirstRunCelebration - First Auto Run completion
 * - KeyboardMasteryCelebration - Keyboard shortcut mastery level-ups
 */

import { StandingOvationOverlay } from './StandingOvationOverlay';
import { FirstRunCelebration } from './FirstRunCelebration';
import { KeyboardMasteryCelebration } from './KeyboardMasteryCelebration';
import type { Theme, Shortcut } from '../types';
import type { ConductorBadge } from '../constants/conductorBadges';

/**
 * Props for StandingOvationOverlay data
 */
export interface StandingOvationData {
	badge: ConductorBadge;
	isNewRecord: boolean;
	recordTimeMs?: number;
}

/**
 * Props for FirstRunCelebration data
 */
export interface FirstRunCelebrationData {
	elapsedTimeMs: number;
	completedTasks: number;
	totalTasks: number;
}

/**
 * Props for AppOverlays component
 */
export interface AppOverlaysProps {
	// Theme
	theme: Theme;

	// Standing Ovation Overlay
	standingOvationData: StandingOvationData | null;
	cumulativeTimeMs: number;
	onCloseStandingOvation: () => void;
	onOpenLeaderboardRegistration: () => void;
	isLeaderboardRegistered: boolean;

	// First Run Celebration
	firstRunCelebrationData: FirstRunCelebrationData | null;
	onCloseFirstRun: () => void;

	// Keyboard Mastery Celebration
	pendingKeyboardMasteryLevel: number | null;
	onCloseKeyboardMastery: () => void;
	shortcuts: Record<string, Shortcut>;

	// Rendering settings
	disableConfetti?: boolean;
}

/**
 * AppOverlays - Renders celebration overlays based on current state
 *
 * Only renders the overlays that are currently active (data is non-null).
 * These overlays use fixed positioning and high z-indexes to appear
 * above all other content with backdrop effects.
 */
export function AppOverlays({
	theme,
	standingOvationData,
	cumulativeTimeMs,
	onCloseStandingOvation,
	onOpenLeaderboardRegistration,
	isLeaderboardRegistered,
	firstRunCelebrationData,
	onCloseFirstRun,
	pendingKeyboardMasteryLevel,
	onCloseKeyboardMastery,
	shortcuts,
	disableConfetti = false,
}: AppOverlaysProps): JSX.Element {
	return (
		<>
			{/* --- FIRST RUN CELEBRATION OVERLAY --- */}
			{firstRunCelebrationData && (
				<FirstRunCelebration
					theme={theme}
					elapsedTimeMs={firstRunCelebrationData.elapsedTimeMs}
					completedTasks={firstRunCelebrationData.completedTasks}
					totalTasks={firstRunCelebrationData.totalTasks}
					onClose={onCloseFirstRun}
					onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
					isLeaderboardRegistered={isLeaderboardRegistered}
					disableConfetti={disableConfetti}
				/>
			)}

			{/* --- KEYBOARD MASTERY CELEBRATION OVERLAY --- */}
			{pendingKeyboardMasteryLevel !== null && (
				<KeyboardMasteryCelebration
					theme={theme}
					level={pendingKeyboardMasteryLevel}
					onClose={onCloseKeyboardMastery}
					shortcuts={shortcuts}
					disableConfetti={disableConfetti}
				/>
			)}

			{/* --- STANDING OVATION OVERLAY --- */}
			{standingOvationData && (
				<StandingOvationOverlay
					theme={theme}
					themeMode={theme.mode}
					badge={standingOvationData.badge}
					isNewRecord={standingOvationData.isNewRecord}
					recordTimeMs={standingOvationData.recordTimeMs}
					cumulativeTimeMs={cumulativeTimeMs}
					onClose={onCloseStandingOvation}
					onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
					isLeaderboardRegistered={isLeaderboardRegistered}
					disableConfetti={disableConfetti}
				/>
			)}
		</>
	);
}

export default AppOverlays;
