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

/** Split a file path into its directory segments (filename excluded). Handles both / and \ separators. */
function getDirSegments(path: string): string[] {
	const segs = path.split(/[/\\]+/).filter(Boolean);
	return segs.slice(0, -1); // drop the filename, keep the directory chain (root..parent)
}

/**
 * Computes display labels for file tabs, disambiguating tabs that share the same
 * filename. When multiple open file tabs have the same name (e.g. two `service.go`
 * from different folders), each is prefixed with the minimal number of trailing
 * parent-directory segments needed to tell them apart - the immediate folder first,
 * then the folder above it, and so on until every label in the group is unique.
 * Tabs with a unique filename keep their bare name.
 *
 * Returns a Map keyed by tab id. The label is the `name` portion only (extension
 * is rendered separately as a badge); disambiguating folders are joined with `/`.
 */
export function buildFileTabDisplayNames(
	tabs: ReadonlyArray<Pick<FilePreviewTab, 'id' | 'path' | 'name' | 'extension'>>
): Map<string, string> {
	const labels = new Map<string, string>();

	// Group tabs by full filename (name + extension). Only collisions need prefixing.
	const groups = new Map<string, (typeof tabs)[number][]>();
	for (const tab of tabs) {
		const key = tab.name + tab.extension;
		const group = groups.get(key);
		if (group) group.push(tab);
		else groups.set(key, [tab]);
	}

	for (const group of groups.values()) {
		if (group.length === 1) {
			labels.set(group[0].id, group[0].name);
			continue;
		}

		const items = group.map((tab) => ({ tab, dirs: getDirSegments(tab.path) }));
		const maxDepth = Math.max(...items.map((it) => it.dirs.length));

		// Deepen the trailing-folder prefix uniformly until every label is unique.
		// Guaranteed to terminate: distinct paths with the same filename differ in
		// their directory chains, so full qualification always disambiguates.
		let k = 1;
		const prefixFor = (dirs: string[]) => dirs.slice(Math.max(0, dirs.length - k));
		while (k <= maxDepth) {
			const seen = new Map<string, number>();
			for (const it of items) {
				const label = [...prefixFor(it.dirs), it.tab.name].join('/');
				seen.set(label, (seen.get(label) ?? 0) + 1);
			}
			if ([...seen.values()].every((count) => count === 1)) break;
			k++;
		}

		for (const it of items) {
			labels.set(it.tab.id, [...prefixFor(it.dirs), it.tab.name].join('/'));
		}
	}

	return labels;
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
