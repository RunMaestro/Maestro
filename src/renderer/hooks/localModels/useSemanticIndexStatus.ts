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

import { useEffect, useState } from 'react';

import type { SemanticIndexProgress } from '../../../shared/local-models/embedding-index';

export interface SemanticIndexStatusState {
	/** `null` until the first read answers. */
	progress: SemanticIndexProgress | null;
	/** Set when the status read itself rejected. */
	error: string | null;
}

export function useSemanticIndexStatus(): SemanticIndexStatusState {
	const [progress, setProgress] = useState<SemanticIndexProgress | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
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
			cancelled = true;
			release();
		};
	}, []);

	return { progress, error };
}
