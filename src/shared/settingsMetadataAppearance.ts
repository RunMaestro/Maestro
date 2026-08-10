/**
 * Appearance settings metadata (theme, fonts, left panel display, image annotator).
 *
 * Part of the settingsMetadata.ts domain-file split, mirroring the settingsStore.ts
 * slice decomposition (see settingsAnnotatorSlice.ts for that pattern).
 */

import type { SettingMetadata } from './settingsMetadata';

export const APPEARANCE_SETTINGS_METADATA: Record<string, SettingMetadata> = {
	activeThemeId: {
		description:
			'Color theme for the UI. Built-in themes include dracula, monokai, solarized-dark, nord, and others.',
		type: 'string',
		default: 'dracula',
		category: 'appearance',
	},
	customThemeColors: {
		description: 'Custom color overrides when using a user-defined theme.',
		type: 'object',
		default: {},
		category: 'appearance',
	},
	customThemeBaseId: {
		description: 'Base theme ID to extend when creating a custom theme.',
		type: 'string',
		default: 'dracula',
		category: 'appearance',
	},
	fontSize: {
		description: 'Base font size in pixels. Affects all UI text via rem scaling.',
		type: 'number',
		default: 14,
		category: 'appearance',
	},
	fontFamily: {
		description: 'Font family for the UI. Accepts any CSS font-family string.',
		type: 'string',
		default: 'Roboto Mono, Menlo, "Courier New", monospace',
		category: 'appearance',
	},
	terminalFontFamily: {
		description:
			'Font family for the command terminal, independent of the UI font. Accepts any CSS font-family string. When empty, the terminal inherits the UI font.',
		type: 'string',
		default: '',
		category: 'appearance',
	},
	customFonts: {
		description: 'List of user-installed custom font names available in the font picker.',
		type: 'array',
		default: [],
		category: 'appearance',
	},
	mediaPlayerFloatRect: {
		description:
			'Position and size of the floating media player, remembered across restarts. Null until the user moves or resizes it.',
		type: 'object',
		default: null,
		category: 'appearance',
	},
	mediaPlaybackRate: {
		description:
			'Playback speed for audio and video files opened in the file preview. Persists across files and restarts. Range 0.25 to 4.',
		type: 'number',
		default: 1,
		category: 'editor',
	},
	colorBlindMode: {
		description: 'Enable colorblind-friendly palettes for status indicators and charts.',
		type: 'boolean',
		default: false,
		category: 'accessibility',
	},
	userMessageAlignment: {
		description: 'Alignment of user messages in the AI chat view.',
		type: 'string',
		default: 'right',
		category: 'appearance',
	},
	useNativeTitleBar: {
		description: 'Use the OS-native title bar instead of the custom frameless title bar.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	tabBarWheelScroll: {
		description:
			'Pan an overflowing tab strip horizontally with the mouse wheel while hovering over the tab bar.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	autoHideMenuBar: {
		description: 'Auto-hide the menu bar (press Alt to show). Only applies on Windows/Linux.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	showAgentName: {
		description: 'Show the agent name in the main header.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showSessionIdPill: {
		description:
			'Show the provider session ID pill (short hash, e.g. "B778BF42") in the main header.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	showSessionCostPill: {
		description: 'Show the per-session running cost pill (e.g. "$21.33") in the main header.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showWorktreePill: {
		description: 'Show the WORKTREE badge next to worktree child agents in the left panel.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	showWorktreeBranchName: {
		description: 'Show the branch name beneath worktree child agents in the left panel.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	showStarredSessionsSection: {
		description:
			'Show a "Starred Sessions" section at the top of the left side bar listing every starred AI tab across all agents.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showLeftPanelGroupMemberCount: {
		description:
			'Show a member count in parentheses after each group name in the left side bar (e.g. "UNGROUPED AGENTS (24)").',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	leftPanelCollapsedPillsPerRow: {
		description:
			'Maximum number of collapsed-group activity pills per row in the left side bar before wrapping to a new row. Range: 5-50.',
		type: 'number',
		default: 20,
		category: 'appearance',
	},
	showLeftPanelLocationPills: {
		description:
			'Show the REMOTE / LOCAL / GIT location pills next to agents in the left side bar.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showLeftPanelGitIndicator: {
		description:
			'Show the git change indicator (branch icon + dirty file count) next to agents in the left side bar.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showLeftPanelCueIndicator: {
		description:
			'Show the Maestro Cue activity indicator (lightning bolt) next to agents with active Cue subscriptions in the left side bar. Hidden when the Maestro Cue Encore Feature is disabled.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showLeftPanelStartupCommandIndicator: {
		description:
			'Show the terminal prompt glyph (>_) next to agents that have at least one terminal tab with a saved startup command.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showGroupLabelInBookmarks: {
		description:
			'Show the group badge (e.g. "CCS") next to bookmarked agents in the left side bar. Turn off to hide the group pill entirely.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showFullGroupLabelInBookmarks: {
		description:
			'Show the full group name (e.g. "[2] CASE/CONTENT-SYSTEM") instead of the abbreviated badge (e.g. "CCS") next to bookmarked agents in the left side bar. Long names are truncated with the complete value available on hover.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	fileEditWordWrap: {
		description:
			'Wrap long lines in the file editor at whitespace boundaries instead of scrolling horizontally.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	fileEditShowLineNumbers: {
		description: 'Show the line-number gutter in the file editor.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	filePreviewToolbarVisibility: {
		description:
			'Per-button visibility map for the file preview / edit toolbar. Keys: save, wordWrap, remoteImages, htmlRender, openInBrowser, previewTier, editToggle, editImage, copyContent, publishGist, documentGraph, openInDefault, revealInFolder, copyPath.',
		type: 'object',
		default: {
			save: true,
			wordWrap: true,
			remoteImages: true,
			htmlRender: true,
			openInBrowser: true,
			previewTier: true,
			editToggle: true,
			editImage: true,
			copyContent: true,
			publishGist: true,
			documentGraph: true,
			openInDefault: true,
			revealInFolder: true,
			copyPath: true,
		},
		category: 'appearance',
	},
	fileExplorerIconTheme: {
		description: 'Icon theme for the file explorer sidebar. Options: default, material, or none.',
		type: 'string',
		default: 'default',
		category: 'appearance',
	},
	toastWidth: {
		description:
			'Width of toast notifications. Options: small, medium, large, dynamic (default, matches the Right Bar width).',
		type: 'string',
		default: 'dynamic',
		category: 'appearance',
	},
	disableConfetti: {
		description: 'Disable confetti animations for badge unlocks and achievements.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	annotatorPenColor: {
		description:
			'Default pen color (hex string) for the image annotator. Seeds from theme accent on first run; user-selected color persists thereafter.',
		type: 'string',
		default: '#9146FF',
		category: 'appearance',
	},
	annotatorPenSize: {
		description: 'Default pen size (in pixels) for the image annotator stroke.',
		type: 'number',
		default: 10,
		category: 'appearance',
	},
	annotatorThinning: {
		description:
			'Image annotator stroke thinning (0 to 1). Controls how much pressure affects stroke width.',
		type: 'number',
		default: 0.5,
		category: 'appearance',
	},
	annotatorSmoothing: {
		description:
			'Image annotator stroke smoothing (0 to 1). Higher values produce smoother curves.',
		type: 'number',
		default: 0.5,
		category: 'appearance',
	},
	annotatorStreamline: {
		description:
			'Image annotator stroke streamline (0 to 1). Higher values dampen pointer jitter for steadier lines.',
		type: 'number',
		default: 0.5,
		category: 'appearance',
	},
	annotatorTaperStart: {
		description: 'Image annotator taper distance at the start of a stroke (in pixels).',
		type: 'number',
		default: 0,
		category: 'appearance',
	},
	annotatorTaperEnd: {
		description: 'Image annotator taper distance at the end of a stroke (in pixels).',
		type: 'number',
		default: 0,
		category: 'appearance',
	},
	annotatorTextColor: {
		description: 'Default text color (hex string) for image annotator text labels.',
		type: 'string',
		default: '#9146FF',
		category: 'appearance',
	},
	annotatorTextSize: {
		description: 'Default text size (in pixels) for image annotator text labels.',
		type: 'number',
		default: 24,
		category: 'appearance',
	},
	annotatorTextFont: {
		description: 'Default font family for image annotator text labels (CSS font-family string).',
		type: 'string',
		default: 'sans-serif',
		category: 'appearance',
	},
	annotatorTextBgColor: {
		description:
			'Default background color (hex string) behind image annotator text labels. Empty string means no background.',
		type: 'string',
		default: '',
		category: 'appearance',
	},
};
