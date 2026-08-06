/**
 * useSpecDrivenConfig Hook
 *
 * Extracted from BatchRunnerModal.tsx to manage Spec-Driven Auto Run state:
 * the selected documents, their task counts (seeded from the batch store,
 * with an IPC fallback for anything the store hasn't covered yet), and loop
 * mode.
 */

import { useState, useRef, useMemo, useEffect } from 'react';
import type { BatchDocumentEntry, BatchRunConfig } from '../../types';
import { useBatchStore } from '../../stores/batchStore';
import { generateId } from '../../utils/ids';

export interface UseSpecDrivenConfigDeps {
	presetDocuments?: string[];
	initialConfig?: Partial<Pick<BatchRunConfig, 'documents' | 'loopEnabled' | 'maxLoops'>>;
	allDocuments: string[];
	getDocumentTaskCount: (filename: string) => Promise<number>;
}

export interface UseSpecDrivenConfigReturn {
	documents: BatchDocumentEntry[];
	setDocuments: React.Dispatch<React.SetStateAction<BatchDocumentEntry[]>>;
	/** Tracks the document list at the time the modal opened, for dirty-checking. */
	initialDocumentsRef: React.MutableRefObject<string[]>;
	taskCounts: Record<string, number>;
	loadingTaskCounts: boolean;
	loopEnabled: boolean;
	setLoopEnabled: React.Dispatch<React.SetStateAction<boolean>>;
	maxLoops: number | null;
	setMaxLoops: React.Dispatch<React.SetStateAction<number | null>>;
	/** Tracks loop settings at the time the modal opened, for dirty-checking. */
	initialLoopEnabledRef: React.MutableRefObject<boolean>;
	initialMaxLoopsRef: React.MutableRefObject<number | null>;
	/** Total unchecked tasks across selected documents, excluding missing ones. */
	totalTaskCount: number;
	hasNoTasks: boolean;
	missingDocCount: number;
}

export function useSpecDrivenConfig({
	presetDocuments,
	initialConfig,
	allDocuments,
	getDocumentTaskCount,
}: UseSpecDrivenConfigDeps): UseSpecDrivenConfigReturn {
	// Document list state. Opens empty unless the inline wizard's "Start Auto
	// Run" pre-seeded it with freshly generated docs via `presetDocuments`.
	const [documents, setDocuments] = useState<BatchDocumentEntry[]>(() => {
		if (initialConfig?.documents?.length) {
			return initialConfig.documents;
		}
		if (presetDocuments && presetDocuments.length > 0) {
			return presetDocuments.map((filename) => ({
				id: generateId(),
				filename,
				resetOnCompletion: false,
				isDuplicate: false,
			}));
		}
		return [];
	});

	// Track initial document state for dirty checking. Mirrors the run-list
	// initialization above so dirty detection is correct for preset opens too.
	const initialDocumentsRef = useRef<string[]>(
		initialConfig?.documents?.map((doc) => doc.filename) ??
			(presetDocuments && presetDocuments.length > 0 ? [...presetDocuments] : [])
	);

	// Task counts per document (keyed by filename, value = unchecked task count).
	// Seeded synchronously from the batch store, which is already populated by
	// useAutoRunDocumentLoader. This avoids redundant per-document SSH `cat`
	// reads in the modal - critical for SSH-remote sessions where the modal
	// otherwise stays stuck on "..." while sequential SSH reads pile up.
	const documentTaskCountsFromStore = useBatchStore((s) => s.documentTaskCounts);
	const isLoadingDocumentsFromStore = useBatchStore((s) => s.isLoadingDocuments);
	const seededTaskCounts = useMemo(() => {
		const out: Record<string, number> = {};
		documentTaskCountsFromStore.forEach((entry, filename) => {
			out[filename] = Math.max(0, entry.total - entry.completed);
		});
		return out;
	}, [documentTaskCountsFromStore]);
	const [taskCounts, setTaskCounts] = useState<Record<string, number>>(seededTaskCounts);
	const [loadingTaskCounts, setLoadingTaskCounts] = useState(
		// Only show the loading badge if the store hasn't surfaced any counts yet
		// AND it's still loading - otherwise we have stale-but-usable data to render.
		() => isLoadingDocumentsFromStore && Object.keys(seededTaskCounts).length === 0
	);

	// Loop mode state
	const [loopEnabled, setLoopEnabled] = useState(initialConfig?.loopEnabled ?? false);
	const [maxLoops, setMaxLoops] = useState<number | null>(initialConfig?.maxLoops ?? null); // null = infinite

	// Track initial loop settings for dirty checking
	const initialLoopEnabledRef = useRef(initialConfig?.loopEnabled ?? false);
	const initialMaxLoopsRef = useRef<number | null>(initialConfig?.maxLoops ?? null);

	// Use ref for getDocumentTaskCount to avoid dependency issues
	const getDocumentTaskCountRef = useRef(getDocumentTaskCount);
	getDocumentTaskCountRef.current = getDocumentTaskCount;

	// Reflect updates from the store (e.g., when a doc's tasks get checked
	// after the modal opened). For docs covered by the store, this is the
	// fast path - no IPC needed.
	useEffect(() => {
		setTaskCounts((prev) => {
			let changed = false;
			const next = { ...prev };
			for (const [filename, count] of Object.entries(seededTaskCounts)) {
				if (next[filename] !== count) {
					next[filename] = count;
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [seededTaskCounts]);

	// IPC fallback: read counts only for documents NOT already covered by the
	// store. On SSH-remote sessions the store is normally pre-populated by
	// useAutoRunDocumentLoader, so this loop runs zero IPC calls in practice.
	useEffect(() => {
		const missing = allDocuments.filter((doc) => !(doc in seededTaskCounts));
		if (missing.length === 0) {
			setLoadingTaskCounts(false);
			return;
		}

		let cancelled = false;
		const loadMissing = async () => {
			setLoadingTaskCounts(true);
			const additions: Record<string, number> = {};
			for (const doc of missing) {
				if (cancelled) return;
				try {
					additions[doc] = await getDocumentTaskCountRef.current(doc);
				} catch {
					additions[doc] = 0;
				}
			}
			if (cancelled) return;
			setTaskCounts((prev) => ({ ...prev, ...additions }));
			setLoadingTaskCounts(false);
		};

		loadMissing();
		return () => {
			cancelled = true;
		};
	}, [allDocuments, seededTaskCounts]);

	// Calculate total tasks across selected documents (excluding missing documents)
	const totalTaskCount = documents.reduce((sum, doc) => {
		// Don't count tasks from missing documents
		if (doc.isMissing) return sum;
		return sum + (taskCounts[doc.filename] || 0);
	}, 0);
	const hasNoTasks = totalTaskCount === 0;

	// Count missing documents for warning display
	const missingDocCount = documents.filter((doc) => doc.isMissing).length;

	return {
		documents,
		setDocuments,
		initialDocumentsRef,
		taskCounts,
		loadingTaskCounts,
		loopEnabled,
		setLoopEnabled,
		maxLoops,
		setMaxLoops,
		initialLoopEnabledRef,
		initialMaxLoopsRef,
		totalTaskCount,
		hasNoTasks,
		missingDocCount,
	};
}
