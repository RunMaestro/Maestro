/**
 * useSemanticIndexStatus - the background semantic indexer's progress, as the
 * main process reports it.
 *
 * Asks once on mount, then follows the indexer's own pushes. Nothing is
 * derived here: the counts and the state are the record `maestro-cli models
 * index` prints, so the two cannot disagree about how far along the index is.
 *
 * `progress` is `null` until the first answer lands, so a surface can tell
 * "not known yet" from "off" instead of drawing an off state it then replaces.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
	SemanticIndexProgress,
	SemanticIndexStorage,
} from '../../../shared/local-models/embedding-index';

export interface SemanticIndexStatusState {
	/** `null` until the first read answers. */
	progress: SemanticIndexProgress | null;
	/** Set when the status read itself rejected. */
	error: string | null;
	storage: SemanticIndexStorage | null;
	storageError: string | null;
	clearing: boolean;
	refreshStorage: () => Promise<void>;
	clearIndex: () => Promise<boolean>;
}

export function useSemanticIndexStatus(): SemanticIndexStatusState {
	const [progress, setProgress] = useState<SemanticIndexProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [storage, setStorage] = useState<SemanticIndexStorage | null>(null);
	const [storageError, setStorageError] = useState<string | null>(null);
	const [clearing, setClearing] = useState(false);
	const mounted = useRef(true);
	const clearingRef = useRef(false);
	const latestStorage = useRef(0);

	const refreshStorage = useCallback(async () => {
		if (clearingRef.current) return;
		const request = ++latestStorage.current;
		try {
			const next = await window.maestro.localModels.semanticIndex.storage();
			if (mounted.current && request === latestStorage.current) {
				setStorage(next);
				setStorageError(null);
			}
		} catch (caught) {
			if (mounted.current && request === latestStorage.current)
				setStorageError(caught instanceof Error ? caught.message : String(caught));
		}
	}, []);

	const clearIndex = useCallback(async () => {
		if (clearingRef.current) return false;
		clearingRef.current = true;
		latestStorage.current++;
		setClearing(true);
		try {
			const next = await window.maestro.localModels.semanticIndex.clear();
			if (mounted.current) {
				setStorage(next);
				setStorageError(null);
			}
			return true;
		} catch (caught) {
			if (mounted.current)
				setStorageError(caught instanceof Error ? caught.message : String(caught));
			return false;
		} finally {
			clearingRef.current = false;
			if (mounted.current) setClearing(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		let cancelled = false;
		// A push can land before the read answers and is always the newer of the
		// two, so once one has arrived the read's answer is dropped.
		let pushed = false;
		const api = window.maestro.localModels.semanticIndex;

		const release = api.onProgress((next) => {
			if (cancelled) return;
			pushed = true;
			setProgress(next);
			setError(null);
		});
		api
			.status()
			.then((current) => {
				if (!cancelled && !pushed) setProgress(current);
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
			});

		return () => {
			mounted.current = false;
			latestStorage.current++;
			cancelled = true;
			release();
		};
	}, []);

	// Refresh once per state transition and at a modest rate while indexing.
	// Progress pushes can arrive four times a second; none should trigger SQL.
	const state = progress?.state;
	useEffect(() => {
		void refreshStorage();
		if (state !== 'indexing' && state !== 'paused') return;
		const timer = setInterval(() => void refreshStorage(), 5_000);
		return () => clearInterval(timer);
	}, [state, refreshStorage]);

	return { progress, error, storage, storageError, clearing, refreshStorage, clearIndex };
}
