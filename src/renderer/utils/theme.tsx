import { FileCode, FilePlus, FileText, Trash2 } from 'lucide-react';
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
			return '#ff8800'; // Orange - attempting to connect
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
	iconTheme: FileExplorerIconTheme = 'default'
): JSX.Element => {
	return iconTheme === 'rich'
		? getRichExplorerFileIcon(fileName, theme, type)
		: getDefaultExplorerFileIcon(fileName, theme, type);
};

export const getExplorerFolderIcon = (
	folderName: string,
	isExpanded: boolean,
	theme: Theme,
	iconTheme: FileExplorerIconTheme = 'default'
): JSX.Element => {
	return iconTheme === 'rich'
		? getRichExplorerFolderIcon(folderName, isExpanded, theme)
		: getDefaultExplorerFolderIcon(folderName, isExpanded, theme);
};
