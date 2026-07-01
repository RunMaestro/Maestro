/**
 * Pianola task DAG - the pure data layer the orchestrator consumes.
 *
 * Pianola's coordinator plans work as a directed acyclic graph of tasks. This
 * module is that graph's pure core: validation, cycle detection, readiness,
 * status transitions, blocked propagation, and progress. Everything here is a
 * pure function over plain data - no fs, no electron, no Node APIs - so the same
 * logic runs in the CLI watcher, the main process, and (if needed) the renderer.
 *
 * Every function is immutable: inputs are never mutated, new objects/arrays are
 * returned. Untrusted input is validated at the boundary (validatePlan), and
 * malformed plans are reported rather than thrown, matching how the rest of the
 * Pianola storage layer drops bad data instead of crashing.
 */

/** Lifecycle state of a single task in a plan. */
export type PianolaTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped';

/** One unit of work in a plan, with its dependency edges and runtime binding. */
export interface PianolaTask {
	id: string;
	title: string;
	prompt: string;
	/** Ids of tasks that must reach 'done' before this one can run. */
	dependsOn: string[];
	status: PianolaTaskStatus;
	/** Agent the orchestrator bound this task to, once dispatched. */
	agentId?: string;
	/** Agent provider type (claude-code, codex, etc.), if pinned. */
	agentType?: string;
	/** Working directory the task should run in, if pinned. */
	cwd?: string;
	/** AI tab the task is running in, once dispatched. */
	tabId?: string;
	/** Failure detail, populated when status is 'failed'. */
	error?: string;
}

/** A full plan: an ordered set of tasks forming a DAG. */
export interface PianolaPlan {
	id: string;
	title: string;
	/** Epoch ms the plan was created. */
	createdAt: number;
	tasks: PianolaTask[];
}

const TASK_STATUSES: readonly PianolaTaskStatus[] = [
	'pending',
	'running',
	'done',
	'failed',
	'blocked',
	'skipped',
];

const TERMINAL_STATUSES: readonly PianolaTaskStatus[] = ['done', 'failed', 'skipped'];

const OPTIONAL_STRING_FIELDS = ['agentId', 'agentType', 'cwd', 'tabId', 'error'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** True for statuses a task can never leave on its own: done, failed, or skipped. */
export function isTerminalStatus(s: PianolaTaskStatus): boolean {
	return TERMINAL_STATUSES.includes(s);
}

/**
 * Find a dependency cycle, returning the cycle as an ordered list of task ids
 * (each task depends on the next, and the last depends back on the first), or
 * null if the graph is acyclic. dependsOn entries that reference unknown ids are
 * NOT treated as edges here - validatePlan reports those separately - so this can
 * be called on a partially-built plan without unknown deps masking a real cycle.
 */
export function findPlanCycle(tasks: readonly PianolaTask[]): string[] | null {
	const ids = new Set(tasks.map((t) => t.id));
	const adjacency = new Map<string, string[]>();
	for (const task of tasks) {
		// Keep only real edges: known targets, and never a self-edge.
		adjacency.set(
			task.id,
			task.dependsOn.filter((dep) => dep !== task.id && ids.has(dep))
		);
	}

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const id of ids) color.set(id, WHITE);

	const stack: string[] = [];

	function visit(node: string): string[] | null {
		color.set(node, GRAY);
		stack.push(node);
		for (const next of adjacency.get(node) ?? []) {
			if (color.get(next) === GRAY) {
				// Back-edge: the cycle is the stack slice from `next` to the top.
				return stack.slice(stack.indexOf(next));
			}
			if (color.get(next) === WHITE) {
				const found = visit(next);
				if (found) return found;
			}
		}
		stack.pop();
		color.set(node, BLACK);
		return null;
	}

	for (const task of tasks) {
		if (color.get(task.id) === WHITE) {
			const found = visit(task.id);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Validate one untrusted task object, pushing human-readable problems onto
 * `errors`. Returns a typed PianolaTask (with only the optional fields that were
 * present and valid) or null when the shape is unusable.
 */
function validatePianolaTask(raw: unknown, index: number, errors: string[]): PianolaTask | null {
	if (!isRecord(raw)) {
		errors.push(`Task at index ${index} is not an object.`);
		return null;
	}
	const label =
		typeof raw.id === 'string' && raw.id.length > 0 ? `"${raw.id}"` : `at index ${index}`;
	let ok = true;

	if (typeof raw.id !== 'string' || raw.id.length === 0) {
		errors.push(`Task at index ${index} must have a non-empty string id.`);
		ok = false;
	}
	if (typeof raw.title !== 'string' || raw.title.length === 0) {
		errors.push(`Task ${label} must have a non-empty string title.`);
		ok = false;
	}
	if (typeof raw.prompt !== 'string') {
		errors.push(`Task ${label} must have a string prompt.`);
		ok = false;
	}
	if (!isStringArray(raw.dependsOn)) {
		errors.push(`Task ${label} must have a dependsOn array of strings.`);
		ok = false;
	}
	if (!TASK_STATUSES.includes(raw.status as PianolaTaskStatus)) {
		errors.push(`Task ${label} has an invalid status.`);
		ok = false;
	}
	for (const field of OPTIONAL_STRING_FIELDS) {
		if (raw[field] !== undefined && typeof raw[field] !== 'string') {
			errors.push(`Task ${label} field "${field}" must be a string when present.`);
			ok = false;
		}
	}

	if (!ok) return null;

	const task: PianolaTask = {
		id: raw.id as string,
		title: raw.title as string,
		prompt: raw.prompt as string,
		dependsOn: [...(raw.dependsOn as string[])],
		status: raw.status as PianolaTaskStatus,
	};
	for (const field of OPTIONAL_STRING_FIELDS) {
		if (typeof raw[field] === 'string') task[field] = raw[field] as string;
	}
	return task;
}

/**
 * Validate an untrusted plan. Collects human-readable errors for bad shape,
 * unknown/self dependencies, duplicate ids, and dependency cycles. Returns
 * `plan: null` when there is any fatal structural error; otherwise the typed
 * plan with `errors: []`.
 */
export function validatePlan(raw: unknown): { plan: PianolaPlan | null; errors: string[] } {
	const errors: string[] = [];

	if (!isRecord(raw)) {
		return { plan: null, errors: ['Plan is not an object.'] };
	}
	if (typeof raw.id !== 'string' || raw.id.length === 0) {
		errors.push('Plan id must be a non-empty string.');
	}
	if (typeof raw.title !== 'string' || raw.title.length === 0) {
		errors.push('Plan title must be a non-empty string.');
	}
	if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) {
		errors.push('Plan createdAt must be a finite number.');
	}
	if (!Array.isArray(raw.tasks)) {
		errors.push('Plan tasks must be an array.');
		return { plan: null, errors };
	}

	const ids = new Set<string>();
	const tasks: PianolaTask[] = [];
	const rawTasks = raw.tasks as unknown[];
	for (let i = 0; i < rawTasks.length; i++) {
		const task = validatePianolaTask(rawTasks[i], i, errors);
		if (!task) continue;
		if (ids.has(task.id)) {
			errors.push(`Duplicate task id "${task.id}".`);
		} else {
			ids.add(task.id);
		}
		tasks.push(task);
	}

	for (const task of tasks) {
		for (const dep of task.dependsOn) {
			if (dep === task.id) {
				errors.push(`Task "${task.id}" depends on itself.`);
			} else if (!ids.has(dep)) {
				errors.push(`Task "${task.id}" depends on unknown task "${dep}".`);
			}
		}
	}

	const cycle = findPlanCycle(tasks);
	if (cycle) {
		errors.push(`Plan has a dependency cycle: ${cycle.join(' -> ')}.`);
	}

	if (errors.length > 0) return { plan: null, errors };

	const plan: PianolaPlan = {
		id: raw.id as string,
		title: raw.title as string,
		createdAt: raw.createdAt as number,
		tasks,
	};
	return { plan, errors: [] };
}

/**
 * Tasks that can run now: status 'pending' and every dependency 'done'. A task
 * whose dependency failed or was skipped is NOT ready (it should be blocked via
 * propagateBlocked), so this only greenlights work whose prerequisites all
 * succeeded.
 */
export function computeReadyTasks(plan: PianolaPlan): PianolaTask[] {
	const byId = new Map(plan.tasks.map((task) => [task.id, task]));
	return plan.tasks.filter((task) => {
		if (task.status !== 'pending') return false;
		return task.dependsOn.every((dep) => byId.get(dep)?.status === 'done');
	});
}

/**
 * Return a new plan with one task's status (and optional patch fields) updated.
 * A no-op clone is returned when `taskId` is not found, so callers always get a
 * fresh plan and never mutate the input.
 */
export function markTaskStatus(
	plan: PianolaPlan,
	taskId: string,
	status: PianolaTaskStatus,
	patch?: Partial<Pick<PianolaTask, 'tabId' | 'agentId' | 'agentType' | 'error'>>
): PianolaPlan {
	const tasks = plan.tasks.map((task) => {
		if (task.id !== taskId) return task;
		const next: PianolaTask = { ...task, status };
		if (patch) {
			if (patch.tabId !== undefined) next.tabId = patch.tabId;
			if (patch.agentId !== undefined) next.agentId = patch.agentId;
			if (patch.agentType !== undefined) next.agentType = patch.agentType;
			if (patch.error !== undefined) next.error = patch.error;
		}
		return next;
	});
	return { ...plan, tasks };
}

/**
 * Mark as 'blocked' any non-terminal, non-running task that has at least one
 * dependency which is failed, skipped, or already blocked. Applied iteratively
 * to a fixed point so blocking cascades down the chain: a task blocked by a
 * failed upstream will, in turn, block its own dependents. Immutable.
 */
export function propagateBlocked(plan: PianolaPlan): PianolaPlan {
	let tasks = plan.tasks;
	let changed = true;
	while (changed) {
		changed = false;
		const byId = new Map(tasks.map((task) => [task.id, task]));
		tasks = tasks.map((task) => {
			if (task.status === 'running' || task.status === 'blocked' || isTerminalStatus(task.status)) {
				return task;
			}
			const hasBlockingDep = task.dependsOn.some((dep) => {
				const upstream = byId.get(dep);
				if (!upstream) return false;
				return (
					upstream.status === 'failed' ||
					upstream.status === 'skipped' ||
					upstream.status === 'blocked'
				);
			});
			if (!hasBlockingDep) return task;
			changed = true;
			return { ...task, status: 'blocked' as PianolaTaskStatus };
		});
	}
	return { ...plan, tasks };
}

/** Tallied progress for a plan. `complete` is true when nothing can still run. */
export interface PianolaPlanProgress {
	total: number;
	pending: number;
	running: number;
	done: number;
	failed: number;
	blocked: number;
	skipped: number;
	complete: boolean;
}

/**
 * Count tasks by status. `complete` is true when every task is terminal or
 * blocked, i.e. there is nothing left that could still run.
 */
export function planProgress(plan: PianolaPlan): PianolaPlanProgress {
	const counts = {
		total: plan.tasks.length,
		pending: 0,
		running: 0,
		done: 0,
		failed: 0,
		blocked: 0,
		skipped: 0,
	};
	for (const task of plan.tasks) {
		counts[task.status] += 1;
	}
	const complete = plan.tasks.every(
		(task) => isTerminalStatus(task.status) || task.status === 'blocked'
	);
	return { ...counts, complete };
}
