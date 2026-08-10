/**
 * Context Management, Document Graph, Accessibility & Performance, and Onboarding settings metadata.
 *
 * Part of the settingsMetadata.ts domain-file split, mirroring the
 * settingsStore.ts slice decomposition (see settingsAnnotatorSlice.ts
 * for that pattern).
 */

import type { SettingMetadata } from './settingsMetadata';

export const EXPERIENCE_SETTINGS_METADATA: Record<string, SettingMetadata> = {
	// --- Context Management ---
	contextManagementSettings: {
		description: 'Context grooming settings: auto-groom, max tokens, warning thresholds.',
		type: 'object',
		default: {},
		category: 'context',
	},

	// --- Document Graph ---
	documentGraphShowExternalLinks: {
		description: 'Show external link nodes in the document graph visualization.',
		type: 'boolean',
		default: false,
		category: 'document-graph',
	},
	documentGraphMaxNodes: {
		description: 'Maximum number of nodes displayed in the document graph. Range: 50-1000.',
		type: 'number',
		default: 50,
		category: 'document-graph',
	},
	documentGraphPreviewCharLimit: {
		description: 'Character limit for node preview text in the document graph. Range: 50-500.',
		type: 'number',
		default: 100,
		category: 'document-graph',
	},
	documentGraphLayoutType: {
		description:
			'Layout algorithm for the document graph. Values: mindmap, radial, hierarchical, force.',
		type: 'string',
		default: 'hierarchical',
		category: 'document-graph',
	},

	// --- Accessibility & Performance ---
	preventSleepEnabled: {
		description: 'Prevent the system from sleeping while Maestro is running.',
		type: 'boolean',
		default: false,
		category: 'accessibility',
	},
	disableGpuAcceleration: {
		description: 'Disable GPU hardware acceleration. May fix rendering issues on some systems.',
		type: 'boolean',
		default: false,
		category: 'accessibility',
	},

	// --- Onboarding ---
	tourCompleted: {
		description: 'Whether the user has completed the onboarding tour.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	firstAutoRunCompleted: {
		description: 'Whether the user has completed their first Auto Run.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	ungroupedCollapsed: {
		description: 'Whether the "Ungrouped" section in the left bar is collapsed.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	groupChatsExpanded: {
		description: 'Whether the "Group Chats" section in the left bar is expanded.',
		type: 'boolean',
		default: true,
		category: 'onboarding',
	},
	groupChatSortAlphabetical: {
		description:
			'Sort group chats alphabetically (true) instead of by most recent activity (false).',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	starredSessionsCollapsed: {
		description: 'Whether the "Starred Sessions" section in the left bar is collapsed.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	bookmarksCollapsed: {
		description: 'Whether the "Bookmarks" section in the left bar is collapsed.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
};
