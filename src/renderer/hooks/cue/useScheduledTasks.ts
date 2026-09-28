/**
 * useScheduledTasks - state for the Cue modal's Scheduled Tasks tab.
 *
 * Owns the fetch, a light poll so a task that fires (and self-destructs) stops
 * being listed without a manual refresh, and the four mutations. Every write
 * refetches, because the source of truth is `cue.yaml` on disk and the CLI can
 * change it behind our back at any moment.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { cueService } from '../../services/cue';
import { notifyToast } from '../../stores/notificationStore';
import type {
	ScheduledTask,
	ScheduledTaskCreateInput,
	ScheduledTaskUpdateInput,
} from '../../../shared/cue/scheduled-tasks';

/** Poll cadence. Slow on purpose: the list only changes when a task fires,
 *  is edited here, or is edited by the CLI. */
const POLL_INTERVAL_MS = 15_000;

export interface UseScheduledTasksReturn {
	tasks: ScheduledTask[];
	warnings: string[];
	loading: boolean;
	refresh: () => Promise<void>;
	createTask: (input: ScheduledTaskCreateInput) => Promise<boolean>;
	updateTask: (task: ScheduledTask, patch: ScheduledTaskUpdateInput) => Promise<boolean>;
	cancelTask: (task: ScheduledTask) => Promise<boolean>;
	setTaskEnabled: (task: ScheduledTask, enabled: boolean) => Promise<boolean>;
}

export function useScheduledTasks(active: boolean): UseScheduledTasksReturn {
	const [tasks, setTasks] = useState<ScheduledTask[]>([]);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const refresh = useCallback(async () => {
		const result = await cueService.listScheduledTasks();
		if (!mountedRef.current) return;
		setTasks(result.tasks);
		setWarnings(result.warnings);
		setLoading(false);
	}, []);

	// Fetch on activation and poll while the tab is visible. A hidden tab (or a
	// minimized window) skips its polls - nobody is reading the list.
	useEffect(() => {
		if (!active) return;
		void refresh();
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void refresh();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [active, refresh]);

	/** Run a mutation, toast its failure, and refetch on success. */
	const mutate = useCallback(
		async (
			action: () => Promise<{ ok: boolean; reason?: string }>,
			failureTitle: string
		): Promise<boolean> => {
			try {
				const result = await action();
				if (!result.ok) {
					notifyToast({
						color: 'red',
						title: failureTitle,
						message: result.reason ?? 'The change was not written to cue.yaml.',
					});
					return false;
				}
			} catch (err) {
				notifyToast({
					color: 'red',
					title: failureTitle,
					message: err instanceof Error ? err.message : String(err),
				});
				return false;
			}
			await refresh();
			return true;
		},
		[refresh]
	);

	const createTask = useCallback(
		(input: ScheduledTaskCreateInput) =>
			mutate(async () => {
				await cueService.createScheduledTask(input);
				return { ok: true };
			}, 'Could not create the scheduled task'),
		[mutate]
	);

	const updateTask = useCallback(
		(task: ScheduledTask, patch: ScheduledTaskUpdateInput) =>
			mutate(async () => {
				const result = await cueService.updateScheduledTask(task.projectRoot, task.name, patch);
				return { ok: result.updated, reason: result.reason };
			}, 'Could not update the scheduled task'),
		[mutate]
	);

	const cancelTask = useCallback(
		(task: ScheduledTask) =>
			mutate(async () => {
				const result = await cueService.cancelScheduledTask(task.projectRoot, task.name);
				return { ok: result.removed, reason: result.reason };
			}, 'Could not cancel the scheduled task'),
		[mutate]
	);

	const setTaskEnabled = useCallback(
		(task: ScheduledTask, enabled: boolean) => updateTask(task, { enabled }),
		[updateTask]
	);

	return { tasks, warnings, loading, refresh, createTask, updateTask, cancelTask, setTaskEnabled };
}
