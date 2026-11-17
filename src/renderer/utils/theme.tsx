import { FileCode, FilePlus, FileText, Trash2 } from 'lucide-react';
import { blendColors } from '../../shared/colorContrast';
import type { Theme, SessionState, FileChangeType } from '../types';
import type { FileExplorerIconTheme } from './fileExplorerIcons/shared';
import { FILE_EXPLORER_ICON_THEMES, isFileExplorerIconTheme } from './fileExplorerIcons/shared';
import {
	getDefaultExplorerFileIcon,
	getDefaultExplorerFolderIcon,
} from './fileExplorerIcons/defaultTheme';
import { getRichExplorerFileIcon, getRichExplorerFolderIcon } from './fileExplorerIcons/richTheme';

// Re-export formatActiveTime from formatters for backwards compatibility
export { formatActiveTime } from './formatters';
export { FILE_EXPLORER_ICON_THEMES, isFileExplorerIconTheme };
export type { FileExplorerIconTheme } from './fileExplorerIcons/shared';

// Get color based on context usage percentage.
// Thresholds default to 60/80 but can be overridden to match user's context warning settings.
export const getContextColor = (
	usage: number,
	theme: Theme,
	yellowThreshold = 60,
	redThreshold = 80
): string => {
	if (usage >= redThreshold) return theme.colors.error;
	if (usage >= yellowThreshold) return theme.colors.warning;
	return theme.colors.success;
};

// How much of the theme's error color is mixed into its warning color to land on
// the connecting orange. Enough to read as a distinctly warmer hue than the busy
// yellow, not enough to be mistaken for the error red.
const CONNECTING_ERROR_MIX = 0.35;

/**
 * The orange used for "attempting to connect" and for an agent stuck auto-retrying
 * after an outage. Connecting is deliberately NOT the same color as busy: the
 * status legend calls one yellow and the other orange, and the pulse animation is
 * a second signal rather than the only one. Derived from the theme's own warning
 * and error slots so a theme that repaints its semantic palette repaints this too
 * - it used to be a hard-coded `#ff8800` that stayed put on every theme.
 * Colorblind mode overrides it upstream via `COLORBLIND_STATUS_COLORS.connecting`.
 */
export const getConnectingColor = (theme: Theme): string =>
	blendColors(theme.colors.warning, theme.colors.error, CONNECTING_ERROR_MIX);

/**
 * The `box-shadow` that marks a status dot as live (busy, connecting, retrying):
 * a faint ring plus a soft glow in the dot's own color. `color` is a 6-digit hex.
 *
 * This is a STATIC signal on purpose. Live dots used to loop `animate-ping` or
 * `animate-pulse`, one infinite animation per busy agent, tab, and pill, and
 * any running animation keeps the renderer producing a frame every vsync. A Nov
 * 2026 field trace of an idle window with six busy agents measured 4,977 frames
 * in 45 seconds and ~2.5s of renderer main thread spent restyling those dots.
 * The header wand's breathing is the one shared motion that says "working".
 */
export const activeStatusHalo = (color: string): string =>
	`0 0 0 2px ${color}33, 0 0 6px ${color}99`;

// Get color based on session state
// Status indicator colors:
// - Green: ready and waiting (idle)
// - Yellow: agent is thinking (busy, waiting_input)
// - Red: no connection with agent (error)
// - Pulsing orange: attempting to establish connection (connecting)
export const getStatusColor = (state: SessionState, theme: Theme): string => {
	switch (state) {
		case 'idle':
			return theme.colors.success; // Green - ready and waiting
		case 'busy':
			return theme.colors.warning; // Yellow - agent is thinking
		case 'waiting_input':
			return theme.colors.warning; // Yellow - waiting for input
		case 'error':
			return theme.colors.error; // Red - no connection
		case 'connecting':
			return getConnectingColor(theme); // Orange - attempting to connect
		default:
			return theme.colors.success;
	}
};

// Get file icon based on change type
export const getFileIcon = (type: FileChangeType | undefined, theme: Theme): JSX.Element => {
	switch (type) {
		case 'added':
			return <FilePlus className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />;
		case 'deleted':
			return <Trash2 className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />;
		case 'modified':
			return <FileCode className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />;
		default:
			return <FileText className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />;
	}
};

export const getExplorerFileIcon = (
	fileName: string,
	theme: Theme,
	type?: FileChangeType,
	iconTheme: FileExplorerIconTheme = 'flat',
	colorBlindMode: boolean = false
): JSX.Element => {
	return iconTheme === 'rich'
		? getRichExplorerFileIcon(fileName, theme, type)
		: getDefaultExplorerFileIcon(fileName, theme, type, colorBlindMode);
};

export const getExplorerFolderIcon = (
	folderName: string,
	isExpanded: boolean,
	theme: Theme,
	iconTheme: FileExplorerIconTheme = 'flat'
): JSX.Element => {
	return iconTheme === 'rich'
		? getRichExplorerFolderIcon(folderName, isExpanded, theme)
		: getDefaultExplorerFolderIcon(folderName, isExpanded, theme);
};
