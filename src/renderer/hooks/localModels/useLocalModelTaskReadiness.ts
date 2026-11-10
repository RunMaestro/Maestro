/**
 * useLocalModelTaskReadiness - Local Models task readiness, as the main process
 * resolves it (`resolveTaskReadiness`): every task, or the one a surface names.
 *
 * The verdict is never re-derived here: the renderer cannot read disk or reach
 * an endpoint, and a second derivation would drift from the one
 * `maestro-cli models status` prints. The hook only decides WHEN to ask.
 *
 * It asks on mount and whenever `revision` changes. The caller builds the
 * revision from everything a verdict depends on that the renderer can see (the
 * assignments, the endpoint list, each model's install status), so an
 * assignment change or a finished download is reflected without a manual
 * refresh. A response that arrives after a newer request was issued is
 * dropped, so a slow endpoint listing cannot overwrite a fresher answer.
 *
 * Network use: readiness lists an endpoint's models only for a task ASSIGNED to
 * that endpoint, which is a server the user already chose to call.
 *
 * Pass `taskId` from a surface that offers ONE task (the Create Pull Request
 * form's draft button): asking for every task there would list the models of
 * endpoints that only other tasks use, just to decide whether to draw a button.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { LocalModelTaskId } from '../../../shared/local-models/tasks';
import type { LocalModelTaskReadiness } from '../../../shared/local-models/task-readiness';

export interface LocalModelTaskReadinessState {
	/** Per task id. Absent until the first answer lands. */
	readiness: Partial<Record<LocalModelTaskId, LocalModelTaskReadiness>>;
	loading: boolean;
	/** Set when the readiness call itself rejected. */
	error: string | null;
	refresh: () => Promise<void>;
}

export function useLocalModelTaskReadiness(
	revision: string,
	taskId?: LocalModelTaskId
): LocalModelTaskReadinessState {
	const [readiness, setReadiness] = useState<
		Partial<Record<LocalModelTaskId, LocalModelTaskReadiness>>
	>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	// Each request takes the next number; only the newest may write state.
	const latestRequest = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = useCallback(async () => {
		const request = ++latestRequest.current;
		setLoading(true);
		try {
			const entries = await window.maestro.localModels.taskReadiness(taskId);
			if (!mounted.current || request !== latestRequest.current) return;
			const byTask: Partial<Record<LocalModelTaskId, LocalModelTaskReadiness>> = {};
			for (const entry of entries) byTask[entry.taskId] = entry;
			setReadiness(byTask);
			setError(null);
		} catch (caught) {
			if (!mounted.current || request !== latestRequest.current) return;
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (mounted.current && request === latestRequest.current) setLoading(false);
		}
	}, [taskId]);

	useEffect(() => {
		void refresh();
	}, [revision, refresh]);

	return { readiness, loading, error, refresh };
}
