/**
 * Left Panel display settings slice for settingsStore (which agent-row pills
 * and indicators show in the Left Bar, and how many collapse into a row).
 *
 * Part of the same domain-slice decomposition as settingsAnnotatorSlice.ts -
 * see that file for the pattern this follows.
 */

import type { StateCreator } from 'zustand';
import type { SettingsStore } from './settingsStore';

export interface LeftPanelDisplayState {
	showAgentName: boolean;
	showSessionIdPill: boolean;
	showSessionCostPill: boolean;
	showWorktreePill: boolean;
	showWorktreeBranchName: boolean;
	showStarredSessionsSection: boolean;
	showLeftPanelGroupMemberCount: boolean;
	leftPanelCollapsedPillsPerRow: number;
	showLeftPanelLocationPills: boolean;
	showLeftPanelGitIndicator: boolean;
	showLeftPanelCueIndicator: boolean;
	showLeftPanelStartupCommandIndicator: boolean;
	showGroupLabelInBookmarks: boolean;
	showFullGroupLabelInBookmarks: boolean;
}

export interface LeftPanelDisplayActions {
	setShowAgentName: (value: boolean) => void;
	setShowSessionIdPill: (value: boolean) => void;
	setShowSessionCostPill: (value: boolean) => void;
	setShowWorktreePill: (value: boolean) => void;
	setShowWorktreeBranchName: (value: boolean) => void;
	setShowStarredSessionsSection: (value: boolean) => void;
	setShowLeftPanelGroupMemberCount: (value: boolean) => void;
	setLeftPanelCollapsedPillsPerRow: (value: number) => void;
	setShowLeftPanelLocationPills: (value: boolean) => void;
	setShowLeftPanelGitIndicator: (value: boolean) => void;
	setShowLeftPanelCueIndicator: (value: boolean) => void;
	setShowLeftPanelStartupCommandIndicator: (value: boolean) => void;
	setShowGroupLabelInBookmarks: (value: boolean) => void;
	setShowFullGroupLabelInBookmarks: (value: boolean) => void;
}

export type LeftPanelDisplaySlice = LeftPanelDisplayState & LeftPanelDisplayActions;

export const createLeftPanelDisplaySlice: StateCreator<
	SettingsStore,
	[],
	[],
	LeftPanelDisplaySlice
> = (set) => ({
	showAgentName: true,
	showSessionIdPill: false,
	showSessionCostPill: true,
	showWorktreePill: false,
	showWorktreeBranchName: false,
	showStarredSessionsSection: true,
	showLeftPanelGroupMemberCount: false,
	leftPanelCollapsedPillsPerRow: 20,
	showLeftPanelLocationPills: true,
	showLeftPanelGitIndicator: true,
	showLeftPanelCueIndicator: true,
	showLeftPanelStartupCommandIndicator: true,
	showGroupLabelInBookmarks: true,
	showFullGroupLabelInBookmarks: false,

	setShowAgentName: (value) => {
		set({ showAgentName: value });
		window.maestro.settings.set('showAgentName', value);
	},

	setShowSessionIdPill: (value) => {
		set({ showSessionIdPill: value });
		window.maestro.settings.set('showSessionIdPill', value);
	},

	setShowSessionCostPill: (value) => {
		set({ showSessionCostPill: value });
		window.maestro.settings.set('showSessionCostPill', value);
	},

	setShowWorktreePill: (value) => {
		set({ showWorktreePill: value });
		window.maestro.settings.set('showWorktreePill', value);
	},

	setShowWorktreeBranchName: (value) => {
		set({ showWorktreeBranchName: value });
		window.maestro.settings.set('showWorktreeBranchName', value);
	},

	setShowStarredSessionsSection: (value) => {
		set({ showStarredSessionsSection: value });
		window.maestro.settings.set('showStarredSessionsSection', value);
	},

	setShowLeftPanelGroupMemberCount: (value) => {
		set({ showLeftPanelGroupMemberCount: value });
		window.maestro.settings.set('showLeftPanelGroupMemberCount', value);
	},

	setLeftPanelCollapsedPillsPerRow: (value) => {
		const clamped = Math.max(5, Math.min(50, Math.round(value)));
		set({ leftPanelCollapsedPillsPerRow: clamped });
		window.maestro.settings.set('leftPanelCollapsedPillsPerRow', clamped);
	},

	setShowLeftPanelLocationPills: (value) => {
		set({ showLeftPanelLocationPills: value });
		window.maestro.settings.set('showLeftPanelLocationPills', value);
	},

	setShowLeftPanelGitIndicator: (value) => {
		set({ showLeftPanelGitIndicator: value });
		window.maestro.settings.set('showLeftPanelGitIndicator', value);
	},

	setShowLeftPanelCueIndicator: (value) => {
		set({ showLeftPanelCueIndicator: value });
		window.maestro.settings.set('showLeftPanelCueIndicator', value);
	},

	setShowLeftPanelStartupCommandIndicator: (value) => {
		set({ showLeftPanelStartupCommandIndicator: value });
		window.maestro.settings.set('showLeftPanelStartupCommandIndicator', value);
	},

	setShowGroupLabelInBookmarks: (value) => {
		set({ showGroupLabelInBookmarks: value });
		window.maestro.settings.set('showGroupLabelInBookmarks', value);
	},

	setShowFullGroupLabelInBookmarks: (value) => {
		set({ showFullGroupLabelInBookmarks: value });
		window.maestro.settings.set('showFullGroupLabelInBookmarks', value);
	},
});

/** Mutates `patch` in place with any persisted Left Panel display fields found in `allSettings`. */
export function hydrateLeftPanelDisplaySettings(
	allSettings: Record<string, unknown>,
	patch: Partial<LeftPanelDisplayState>
): void {
	if (allSettings['showAgentName'] !== undefined)
		patch.showAgentName = allSettings['showAgentName'] as boolean;

	if (allSettings['showSessionIdPill'] !== undefined)
		patch.showSessionIdPill = allSettings['showSessionIdPill'] as boolean;

	if (allSettings['showSessionCostPill'] !== undefined)
		patch.showSessionCostPill = allSettings['showSessionCostPill'] as boolean;

	if (allSettings['showWorktreePill'] !== undefined)
		patch.showWorktreePill = allSettings['showWorktreePill'] as boolean;

	if (allSettings['showWorktreeBranchName'] !== undefined)
		patch.showWorktreeBranchName = allSettings['showWorktreeBranchName'] as boolean;

	if (allSettings['showStarredSessionsSection'] !== undefined)
		patch.showStarredSessionsSection = allSettings['showStarredSessionsSection'] as boolean;

	if (allSettings['showLeftPanelGroupMemberCount'] !== undefined)
		patch.showLeftPanelGroupMemberCount = allSettings['showLeftPanelGroupMemberCount'] as boolean;

	if (allSettings['leftPanelCollapsedPillsPerRow'] !== undefined) {
		const perRow = allSettings['leftPanelCollapsedPillsPerRow'] as number;
		if (typeof perRow === 'number' && perRow >= 5 && perRow <= 50) {
			patch.leftPanelCollapsedPillsPerRow = perRow;
		}
	}

	if (allSettings['showLeftPanelLocationPills'] !== undefined)
		patch.showLeftPanelLocationPills = allSettings['showLeftPanelLocationPills'] as boolean;

	if (allSettings['showLeftPanelGitIndicator'] !== undefined)
		patch.showLeftPanelGitIndicator = allSettings['showLeftPanelGitIndicator'] as boolean;

	if (allSettings['showLeftPanelCueIndicator'] !== undefined)
		patch.showLeftPanelCueIndicator = allSettings['showLeftPanelCueIndicator'] as boolean;

	if (allSettings['showLeftPanelStartupCommandIndicator'] !== undefined)
		patch.showLeftPanelStartupCommandIndicator = allSettings[
			'showLeftPanelStartupCommandIndicator'
		] as boolean;

	if (allSettings['showGroupLabelInBookmarks'] !== undefined)
		patch.showGroupLabelInBookmarks = allSettings['showGroupLabelInBookmarks'] as boolean;

	if (allSettings['showFullGroupLabelInBookmarks'] !== undefined)
		patch.showFullGroupLabelInBookmarks = allSettings['showFullGroupLabelInBookmarks'] as boolean;
}
