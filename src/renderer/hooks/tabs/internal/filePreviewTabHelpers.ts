import type { FilePreviewHistoryEntry, FilePreviewTab } from '../../../types';
import type { FileTabOpenParams } from './types';

export interface FileNameParts {
	nameWithoutExtension: string;
	extension: string;
}

export function getFileNameParts(name: string): FileNameParts {
	const extension = name.includes('.') ? '.' + name.split('.').pop() : '';
	return {
		extension,
		nameWithoutExtension: extension ? name.slice(0, -extension.length) : name,
	};
}

export function buildReplacementNavigationHistory(
	tab: FilePreviewTab,
	currentTab: FilePreviewTab | undefined,
	file: FileTabOpenParams,
	nameWithoutExtension: string
): FilePreviewHistoryEntry[] {
	const currentHistory = tab.navigationHistory ?? [];
	const currentIndex = tab.navigationIndex ?? currentHistory.length - 1;
	const truncatedHistory =
		currentIndex >= 0 && currentIndex < currentHistory.length - 1
			? currentHistory.slice(0, currentIndex + 1)
			: currentHistory;

	let newHistory = truncatedHistory;
	if (
		currentTab &&
		currentTab.path &&
		(truncatedHistory.length === 0 ||
			truncatedHistory[truncatedHistory.length - 1].path !== currentTab.path)
	) {
		newHistory = [
			...truncatedHistory,
			{
				path: currentTab.path,
				name: currentTab.name,
				scrollTop: currentTab.scrollTop,
			},
		];
	}

	return [
		...newHistory,
		{
			path: file.path,
			name: nameWithoutExtension,
			scrollTop: 0,
		},
	];
}
