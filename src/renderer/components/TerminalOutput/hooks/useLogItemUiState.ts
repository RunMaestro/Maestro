import { useState, useCallback } from 'react';

export function useLogItemUiState(
	markdownEditMode: boolean,
	setMarkdownEditMode: (value: boolean) => void
) {
	const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

	const [localFilters, setLocalFilters] = useState<Map<string, string>>(new Map());
	const [activeLocalFilter, setActiveLocalFilter] = useState<string | null>(null);

	const [filterModes, setFilterModes] = useState<
		Map<string, { mode: 'include' | 'exclude'; regex: boolean }>
	>(new Map());

	const [deleteConfirmLogId, setDeleteConfirmLogId] = useState<string | null>(null);

	const [saveModalContent, setSaveModalContent] = useState<string | null>(null);

	const toggleExpanded = useCallback((logId: string) => {
		setExpandedLogs((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(logId)) {
				newSet.delete(logId);
			} else {
				newSet.add(logId);
			}
			return newSet;
		});
	}, []);

	const toggleLocalFilter = useCallback((logId: string) => {
		setActiveLocalFilter((prev) => (prev === logId ? null : logId));
	}, []);

	const setLocalFilterQuery = useCallback((logId: string, query: string) => {
		setLocalFilters((prev) => {
			const newMap = new Map(prev);
			if (query) {
				newMap.set(logId, query);
			} else {
				newMap.delete(logId);
			}
			return newMap;
		});
	}, []);

	const setFilterModeForLog = useCallback(
		(
			logId: string,
			update: (current: { mode: 'include' | 'exclude'; regex: boolean }) => {
				mode: 'include' | 'exclude';
				regex: boolean;
			}
		) => {
			setFilterModes((prev) => {
				const newMap = new Map(prev);
				const current = newMap.get(logId) || { mode: 'include' as const, regex: false };
				newMap.set(logId, update(current));
				return newMap;
			});
		},
		[]
	);

	const clearLocalFilter = useCallback(
		(logId: string) => {
			setActiveLocalFilter(null);
			setLocalFilterQuery(logId, '');
			setFilterModes((prev) => {
				const newMap = new Map(prev);
				newMap.delete(logId);
				return newMap;
			});
		},
		[setLocalFilterQuery]
	);

	const toggleMarkdownEditMode = useCallback(() => {
		setMarkdownEditMode(!markdownEditMode);
	}, [markdownEditMode, setMarkdownEditMode]);

	const handleSaveToFile = useCallback((text: string) => {
		setSaveModalContent(text);
	}, []);

	return {
		expandedLogs,
		toggleExpanded,
		localFilters,
		activeLocalFilter,
		filterModes,
		toggleLocalFilter,
		setLocalFilterQuery,
		setFilterModeForLog,
		clearLocalFilter,
		deleteConfirmLogId,
		setDeleteConfirmLogId,
		saveModalContent,
		setSaveModalContent,
		handleSaveToFile,
		toggleMarkdownEditMode,
	};
}
