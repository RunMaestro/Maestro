/**
 * File Explorer settings slice for settingsStore (local file-tree indexing +
 * the SSH remote variants of the same settings, kept together since both are
 * consumed by the same UI section and the same tree-building logic that picks
 * between them per session).
 *
 * Part of the same domain-slice decomposition as settingsAnnotatorSlice.ts -
 * see that file for the pattern this follows.
 */

import type { StateCreator } from 'zustand';
import type { FileExplorerIconTheme } from '../utils/fileExplorerIcons/shared';
import { isFileExplorerIconTheme } from '../utils/fileExplorerIcons/shared';
import type { SettingsStore } from './settingsStore';

// ============================================================================
// Default Constants
// ============================================================================

/** Default local ignore patterns for new installations (includes .git, node_modules, __pycache__) */
export const DEFAULT_LOCAL_IGNORE_PATTERNS = ['.git', 'node_modules', '__pycache__'];

/**
 * Default maximum recursion depth when indexing the file tree. The entry cap
 * (not this) is the memory guard - once it's hit, the walk stops recursing - so
 * this can be generous. At depth 5 a normal repo layout
 * (`src/renderer/components/Settings/tabs/...`) already falls off the tree.
 */
export const DEFAULT_FILE_EXPLORER_MAX_DEPTH = 10;
/** Minimum allowed maximum recursion depth. */
export const FILE_EXPLORER_MIN_DEPTH = 1;
/** Maximum allowed maximum recursion depth. */
export const FILE_EXPLORER_MAX_DEPTH_CAP = 20;

/** Default cap on number of file entries loaded into the file tree. */
export const DEFAULT_FILE_EXPLORER_MAX_ENTRIES = 100_000;
/** Minimum allowed file-entry cap. */
export const FILE_EXPLORER_MIN_ENTRIES = 1_000;
/** Maximum allowed file-entry cap (soft ceiling; "Load all" bypasses this). */
export const FILE_EXPLORER_MAX_ENTRIES_CAP = 1_000_000;

/**
 * Default fraction applied to {@link DEFAULT_FILE_EXPLORER_MAX_ENTRIES} when
 * "Reduce entry cap on SSH remotes" is enabled. 0.10 → 10% of the local cap.
 */
export const DEFAULT_SSH_REDUCE_ENTRY_CAP_FRACTION = 0.1;
/** Minimum allowed SSH cap fraction (5%). */
export const SSH_REDUCE_ENTRY_CAP_MIN_FRACTION = 0.05;
/** Maximum allowed SSH cap fraction (100%). */
export const SSH_REDUCE_ENTRY_CAP_MAX_FRACTION = 1.0;
/** Slider step for the SSH cap fraction. */
export const SSH_REDUCE_ENTRY_CAP_STEP = 0.05;

export interface FileExplorerState {
	showHiddenFiles: boolean;
	fileExplorerIconTheme: FileExplorerIconTheme;
	localIgnorePatterns: string[];
	localHonorGitignore: boolean;
	fileExplorerMaxDepth: number;
	fileExplorerMaxEntries: number;
	sshReduceEntryCapEnabled: boolean;
	sshReduceEntryCapFraction: number;
	sshRemoteIgnorePatterns: string[];
	sshRemoteHonorGitignore: boolean;
}

export interface FileExplorerActions {
	setShowHiddenFiles: (value: boolean) => void;
	setFileExplorerIconTheme: (value: FileExplorerIconTheme) => void;
	setLocalIgnorePatterns: (value: string[]) => void;
	setLocalHonorGitignore: (value: boolean) => void;
	setFileExplorerMaxDepth: (value: number) => void;
	setFileExplorerMaxEntries: (value: number) => void;
	setSshReduceEntryCapEnabled: (value: boolean) => void;
	setSshReduceEntryCapFraction: (value: number) => void;
	setSshRemoteIgnorePatterns: (value: string[]) => void;
	setSshRemoteHonorGitignore: (value: boolean) => void;
}

export type FileExplorerSlice = FileExplorerState & FileExplorerActions;

export const createFileExplorerSlice: StateCreator<SettingsStore, [], [], FileExplorerSlice> = (
	set
) => ({
	showHiddenFiles: true,
	fileExplorerIconTheme: 'rich',
	localIgnorePatterns: [...DEFAULT_LOCAL_IGNORE_PATTERNS],
	localHonorGitignore: true,
	fileExplorerMaxDepth: DEFAULT_FILE_EXPLORER_MAX_DEPTH,
	fileExplorerMaxEntries: DEFAULT_FILE_EXPLORER_MAX_ENTRIES,
	sshReduceEntryCapEnabled: false,
	sshReduceEntryCapFraction: DEFAULT_SSH_REDUCE_ENTRY_CAP_FRACTION,
	sshRemoteIgnorePatterns: ['.git', '*cache*'],
	sshRemoteHonorGitignore: true,

	setShowHiddenFiles: (value) => {
		set({ showHiddenFiles: value });
		window.maestro.settings.set('showHiddenFiles', value);
	},

	setFileExplorerIconTheme: (value) => {
		set({ fileExplorerIconTheme: value });
		window.maestro.settings.set('fileExplorerIconTheme', value);
	},

	setLocalIgnorePatterns: (value) => {
		set({ localIgnorePatterns: value });
		window.maestro.settings.set('localIgnorePatterns', value);
	},

	setLocalHonorGitignore: (value) => {
		set({ localHonorGitignore: value });
		window.maestro.settings.set('localHonorGitignore', value);
	},

	setFileExplorerMaxDepth: (value) => {
		const clamped = Math.max(
			FILE_EXPLORER_MIN_DEPTH,
			Math.min(FILE_EXPLORER_MAX_DEPTH_CAP, Math.floor(value))
		);
		set({ fileExplorerMaxDepth: clamped });
		window.maestro.settings.set('fileExplorerMaxDepth', clamped);
	},

	setFileExplorerMaxEntries: (value) => {
		const clamped = Math.max(
			FILE_EXPLORER_MIN_ENTRIES,
			Math.min(FILE_EXPLORER_MAX_ENTRIES_CAP, Math.floor(value))
		);
		set({ fileExplorerMaxEntries: clamped });
		window.maestro.settings.set('fileExplorerMaxEntries', clamped);
	},

	setSshReduceEntryCapEnabled: (value) => {
		set({ sshReduceEntryCapEnabled: value });
		window.maestro.settings.set('sshReduceEntryCapEnabled', value);
	},

	setSshReduceEntryCapFraction: (value) => {
		// Snap to the slider step so persisted values stay on-grid even if the
		// caller passes a high-precision float (e.g. from a range input).
		const steps = Math.round(value / SSH_REDUCE_ENTRY_CAP_STEP);
		const snapped = steps * SSH_REDUCE_ENTRY_CAP_STEP;
		const clamped = Math.max(
			SSH_REDUCE_ENTRY_CAP_MIN_FRACTION,
			Math.min(SSH_REDUCE_ENTRY_CAP_MAX_FRACTION, snapped)
		);
		set({ sshReduceEntryCapFraction: clamped });
		window.maestro.settings.set('sshReduceEntryCapFraction', clamped);
	},

	setSshRemoteIgnorePatterns: (value) => {
		set({ sshRemoteIgnorePatterns: value });
		window.maestro.settings.set('sshRemoteIgnorePatterns', value);
	},

	setSshRemoteHonorGitignore: (value) => {
		set({ sshRemoteHonorGitignore: value });
		window.maestro.settings.set('sshRemoteHonorGitignore', value);
	},
});

/** Mutates `patch` in place with any persisted File Explorer fields found in `allSettings`. */
export function hydrateFileExplorerSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<FileExplorerState>
): void {
	if (allSettings['showHiddenFiles'] !== undefined)
		patch.showHiddenFiles = allSettings['showHiddenFiles'] as boolean;

	if (allSettings['fileExplorerIconTheme'] !== undefined) {
		patch.fileExplorerIconTheme = isFileExplorerIconTheme(allSettings['fileExplorerIconTheme'])
			? allSettings['fileExplorerIconTheme']
			: 'rich';
	}

	// Local file indexing ignore patterns (with array validation)
	if (
		allSettings['localIgnorePatterns'] !== undefined &&
		Array.isArray(allSettings['localIgnorePatterns'])
	) {
		patch.localIgnorePatterns = allSettings['localIgnorePatterns'] as string[];
	}

	if (allSettings['localHonorGitignore'] !== undefined)
		patch.localHonorGitignore = allSettings['localHonorGitignore'] as boolean;

	if (
		allSettings['fileExplorerMaxDepth'] !== undefined &&
		typeof allSettings['fileExplorerMaxDepth'] === 'number' &&
		Number.isFinite(allSettings['fileExplorerMaxDepth'])
	) {
		const raw = allSettings['fileExplorerMaxDepth'] as number;
		patch.fileExplorerMaxDepth = Math.max(
			FILE_EXPLORER_MIN_DEPTH,
			Math.min(FILE_EXPLORER_MAX_DEPTH_CAP, Math.floor(raw))
		);
	}

	if (
		allSettings['fileExplorerMaxEntries'] !== undefined &&
		typeof allSettings['fileExplorerMaxEntries'] === 'number' &&
		Number.isFinite(allSettings['fileExplorerMaxEntries'])
	) {
		const raw = allSettings['fileExplorerMaxEntries'] as number;
		patch.fileExplorerMaxEntries = Math.max(
			FILE_EXPLORER_MIN_ENTRIES,
			Math.min(FILE_EXPLORER_MAX_ENTRIES_CAP, Math.floor(raw))
		);
	}

	if (typeof allSettings['sshReduceEntryCapEnabled'] === 'boolean') {
		patch.sshReduceEntryCapEnabled = allSettings['sshReduceEntryCapEnabled'] as boolean;
	}

	if (
		allSettings['sshReduceEntryCapFraction'] !== undefined &&
		typeof allSettings['sshReduceEntryCapFraction'] === 'number' &&
		Number.isFinite(allSettings['sshReduceEntryCapFraction'])
	) {
		const raw = allSettings['sshReduceEntryCapFraction'] as number;
		const steps = Math.round(raw / SSH_REDUCE_ENTRY_CAP_STEP);
		const snapped = steps * SSH_REDUCE_ENTRY_CAP_STEP;
		patch.sshReduceEntryCapFraction = Math.max(
			SSH_REDUCE_ENTRY_CAP_MIN_FRACTION,
			Math.min(SSH_REDUCE_ENTRY_CAP_MAX_FRACTION, snapped)
		);
	}

	// SSH Remote settings (with array validation)
	if (
		allSettings['sshRemoteIgnorePatterns'] !== undefined &&
		Array.isArray(allSettings['sshRemoteIgnorePatterns'])
	) {
		patch.sshRemoteIgnorePatterns = allSettings['sshRemoteIgnorePatterns'] as string[];
	}

	if (allSettings['sshRemoteHonorGitignore'] !== undefined)
		patch.sshRemoteHonorGitignore = allSettings['sshRemoteHonorGitignore'] as boolean;
}
