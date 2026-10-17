/**
 * LocalModelsAssignmentsSection - the task assignments of one system in the
 * Models tab: one row per task in `tasksForSystem(system)`, each with a source
 * picker and the task's readiness. System One and System Two each mount one.
 *
 * The semantic index card sits below the System One rows because it is what
 * one of them (Semantic search) builds once it is assigned a source. The
 * Utility Agent controls, which define the picker's "Utility Agent" choice,
 * belong to System Two and are mounted by the tab, not here.
 *
 * Nothing about readiness is decided here. Every verdict comes from the main
 * process (`resolveTaskReadiness`, through `useLocalModelTaskReadiness`), the
 * same answer `maestro-cli models status` prints. This surface only adds a
 * button for the recoveries it can perform in place: download the assigned
 * model, enable the assigned endpoint, or check a server again.
 *
 * A choice is validated with `localModelAssignmentProblem` before it is saved
 * and written through `withLocalModelAssignment`, so the stored record stays
 * sparse and cannot hold a pick the router would refuse.
 *
 * System One also shows a fail policy column (`failPolicies`): for each task
 * that gates something, what it does when its engine gives no answer. The
 * values and the change both belong to the tab's `useSystemOne()`, the same
 * state `maestro-cli s1 set fail-policy` writes.
 *
 * A task that declares typed questions is also offered System One as a source,
 * labeled with the engine in force (`systemOneEngine`). The assignment names no
 * engine, so a change of engine moves every task on it; readiness is asked again
 * when it changes.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Download, Loader2, Power, RefreshCw } from 'lucide-react';

import {
	formatLocalModelAssignmentSpec,
	localModelAssignmentProblem,
	parseLocalModelAssignmentSpec,
	resolveLocalModelAssignment,
	tasksForSystem,
	withLocalModelAssignment,
	type LocalModelAssignment,
	type LocalModelSystem,
	type LocalModelTaskDefinition,
	type LocalModelTaskId,
} from '../../../../../shared/local-models/tasks';
import {
	SYSTEM_ONE_FAIL_POLICIES,
	type SystemOneFailPolicy,
} from '../../../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_FAIL_POLICY_DESCRIPTIONS,
	type SystemOneEngineChoice,
	type SystemOneFailPolicyRow,
} from '../../../../../shared/local-models/system-one-settings';
import type { LocalModelTaskReadiness } from '../../../../../shared/local-models/task-readiness';
import {
	useLocalModelTaskReadiness,
	type LocalModelEndpointsState,
	type LocalModelsState,
} from '../../../../hooks/localModels';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { AssignmentOptionElements } from './AssignmentOptionElements';
import { buildAssignmentOptionGroups } from './assignmentOptions';
import { downloadPercent, isActive } from './LocalModelRow';
import { SemanticIndexSettings } from './SemanticIndexSettings';

export interface LocalModelsAssignmentsSectionProps {
	theme: Theme;
	/** Which system's tasks this section lists. */
	system: LocalModelSystem;
	/** The tab's one `useLocalModels()` instance. */
	models: LocalModelsState;
	/** The tab's one `useLocalModelEndpoints()` instance. */
	endpoints: LocalModelEndpointsState;
	/** The fail policy column. Omitted where no task has one (System Two). */
	failPolicies?: FailPolicyColumn;
	/**
	 * The System One engine in force and whether it can answer as set up, from
	 * the tab's `useSystemOne()`. Omitted where no task can run on it (System Two).
	 */
	systemOneEngine?: SystemOneEngineStanding;
}

/** What a System One source option and its readiness depend on. */
export interface SystemOneEngineStanding {
	engine: SystemOneEngineChoice;
	/** Why the engine cannot answer as set up, or null. A change asks readiness again. */
	problem: string | null;
}

/** What the fail policy column shows and how it changes a value. */
export interface FailPolicyColumn {
	/** One row per task that has a fail policy. A task not listed shows none. */
	rows: readonly SystemOneFailPolicyRow[];
	disabled: boolean;
	onChange: (taskId: LocalModelTaskId, policy: SystemOneFailPolicy) => void;
}

const FAIL_POLICY_COLUMN_CLASS = 'w-32 flex-shrink-0';
const SOURCE_COLUMN_CLASS = 'w-56 flex-shrink-0';

export function LocalModelsAssignmentsSection({
	theme,
	system,
	models,
	endpoints,
	failPolicies,
	systemOneEngine,
}: LocalModelsAssignmentsSectionProps) {
	const tasks = useMemo(() => tasksForSystem(system), [system]);
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const setLocalModelAssignments = useSettingsStore((s) => s.setLocalModelAssignments);
	// The last refused pick per task, shown under its row until the next pick.
	const [problems, setProblems] = useState<Partial<Record<LocalModelTaskId, string>>>({});

	// Everything a verdict depends on that the renderer can see. A change to any
	// of it asks main again; per-chunk download progress deliberately is not in
	// here, only the install status a finished download changes.
	const revision = useMemo(
		() =>
			JSON.stringify([
				assignments,
				endpoints.endpoints,
				models.listings.map((listing) => [listing.entry.id, listing.status.status]),
				systemOneEngine?.engine ?? null,
				systemOneEngine?.problem ?? null,
			]),
		[
			assignments,
			endpoints.endpoints,
			models.listings,
			systemOneEngine?.engine,
			systemOneEngine?.problem,
		]
	);
	const readiness = useLocalModelTaskReadiness(revision);

	const choose = useCallback(
		(taskId: LocalModelTaskId, spec: string) => {
			const assignment = parseLocalModelAssignmentSpec(spec);
			const problem = assignment
				? localModelAssignmentProblem(taskId, assignment)
				: `"${spec}" is not a source.`;
			setProblems((prev) => {
				const next = { ...prev };
				if (problem) next[taskId] = problem;
				else delete next[taskId];
				return next;
			});
			if (problem || !assignment) return;
			setLocalModelAssignments(withLocalModelAssignment(assignments, taskId, assignment));
		},
		[assignments, setLocalModelAssignments]
	);

	return (
		<div
			className="select-none space-y-3"
			data-testid={`local-models-assignments-section-${system}`}
		>
			<SectionCard theme={theme} className="space-y-4">
				{readiness.error && (
					<div
						className="flex items-start gap-1.5 text-xs select-text"
						style={{ color: theme.colors.error }}
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>Could not check task readiness: {readiness.error}</span>
					</div>
				)}
				{failPolicies && (
					<div
						className="flex items-end justify-end gap-3 text-xs opacity-70"
						data-testid="local-models-assignments-columns"
						data-setting-id="local-models-system-one-fail-policy"
					>
						<span
							className={FAIL_POLICY_COLUMN_CLASS}
							title="What the task does when its System One engine gives no answer."
						>
							If no answer
						</span>
						<span className={SOURCE_COLUMN_CLASS}>Source</span>
					</div>
				)}
				{tasks.map((task) => (
					<TaskAssignmentRow
						key={task.id}
						theme={theme}
						task={task}
						failPolicy={failPolicies?.rows.find((row) => row.taskId === task.id)}
						failPolicyColumn={failPolicies}
						assignment={resolveLocalModelAssignment(assignments, task.id)}
						models={models}
						endpoints={endpoints}
						systemOneEngine={systemOneEngine?.engine}
						readiness={readiness.readiness[task.id]}
						checking={readiness.loading}
						problem={problems[task.id]}
						onChoose={(spec) => choose(task.id, spec)}
						onRecheck={readiness.refresh}
					/>
				))}
			</SectionCard>
			{tasks.some((task) => task.id === 'semantic-search') && (
				<SemanticIndexSettings theme={theme} />
			)}
		</div>
	);
}

interface TaskAssignmentRowProps {
	theme: Theme;
	task: LocalModelTaskDefinition;
	assignment: LocalModelAssignment;
	models: LocalModelsState;
	endpoints: LocalModelEndpointsState;
	/** The System One engine in force, for the label of its source option. */
	systemOneEngine: SystemOneEngineChoice | undefined;
	readiness: LocalModelTaskReadiness | undefined;
	checking: boolean;
	problem: string | undefined;
	onChoose: (spec: string) => void;
	onRecheck: () => Promise<void>;
	/** This task's fail policy, when it has one. */
	failPolicy: SystemOneFailPolicyRow | undefined;
	/** The column itself. Present for every row of a section that shows it, so the rows line up. */
	failPolicyColumn: FailPolicyColumn | undefined;
}

function TaskAssignmentRow({
	theme,
	task,
	failPolicy,
	failPolicyColumn,
	assignment,
	models,
	endpoints,
	systemOneEngine,
	readiness,
	checking,
	problem,
	onChoose,
	onRecheck,
}: TaskAssignmentRowProps) {
	const groups = useMemo(
		() =>
			buildAssignmentOptionGroups(task, assignment, {
				listings: models.listings,
				endpoints: endpoints.endpoints,
				endpointModels: endpoints.models,
				...(systemOneEngine ? { systemOneEngine } : {}),
			}),
		[task, assignment, models.listings, endpoints.endpoints, endpoints.models, systemOneEngine]
	);
	const selectId = `local-models-task-source-${task.id}`;

	return (
		<div className="space-y-1.5" data-testid={`local-models-task-${task.id}`}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<label
						htmlFor={selectId}
						className="text-sm font-medium block"
						style={{ color: theme.colors.textMain }}
					>
						{task.label}
					</label>
					<p className="text-xs opacity-70 mt-0.5">{task.description}</p>
				</div>
				<div className="flex items-start gap-3 flex-shrink-0">
					{failPolicyColumn &&
						(failPolicy ? (
							<select
								aria-label={`${task.label}: if the engine gives no answer`}
								title={SYSTEM_ONE_FAIL_POLICY_DESCRIPTIONS[failPolicy.policy]}
								value={failPolicy.policy}
								onChange={(e) =>
									failPolicyColumn.onChange(task.id, e.target.value as SystemOneFailPolicy)
								}
								disabled={failPolicyColumn.disabled}
								className={`${FAIL_POLICY_COLUMN_CLASS} p-1.5 rounded border bg-transparent outline-none text-xs`}
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								data-testid={`local-models-task-fail-policy-${task.id}`}
							>
								{SYSTEM_ONE_FAIL_POLICIES.map((policy) => (
									<option key={policy} value={policy}>
										{`Fail ${policy}${policy === failPolicy.defaultPolicy ? ' (default)' : ''}`}
									</option>
								))}
							</select>
						) : (
							<span className={FAIL_POLICY_COLUMN_CLASS} aria-hidden />
						))}
					<select
						id={selectId}
						value={formatLocalModelAssignmentSpec(assignment)}
						onChange={(e) => onChoose(e.target.value)}
						className={`${SOURCE_COLUMN_CLASS} p-1.5 rounded border bg-transparent outline-none text-xs`}
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<AssignmentOptionElements groups={groups} />
					</select>
				</div>
			</div>
			{problem && (
				<p className="text-xs select-text" style={{ color: theme.colors.error }}>
					{problem}
				</p>
			)}
			<TaskReadinessLine
				theme={theme}
				readiness={readiness}
				checking={checking}
				models={models}
				endpoints={endpoints}
				onRecheck={onRecheck}
			/>
		</div>
	);
}

export interface TaskReadinessLineProps {
	theme: Theme;
	readiness: LocalModelTaskReadiness | undefined;
	checking: boolean;
	models: LocalModelsState;
	endpoints: LocalModelEndpointsState;
	onRecheck: () => Promise<void>;
}

/**
 * One task's readiness under its source picker, with the recovery this surface
 * can perform in place. Exported for a picker outside the Models tab that sets
 * one task's source (the Computer History digest model).
 */
export function TaskReadinessLine({
	theme,
	readiness,
	checking,
	models,
	endpoints,
	onRecheck,
}: TaskReadinessLineProps) {
	if (!readiness) {
		return (
			<div className="text-xs opacity-70" data-testid="local-models-task-readiness">
				{checking ? 'Checking...' : 'Readiness unknown.'}
			</div>
		);
	}

	const dotColor =
		readiness.state === 'ready'
			? theme.colors.success
			: readiness.state === 'utility-agent'
				? theme.colors.accent
				: readiness.state === 'unavailable'
					? theme.colors.warning
					: theme.colors.border;
	const headline =
		readiness.state === 'ready'
			? 'Ready'
			: readiness.state === 'utility-agent'
				? 'Utility Agent'
				: readiness.state === 'off'
					? 'Off'
					: 'Unavailable';

	return (
		<div
			className="space-y-1"
			data-testid="local-models-task-readiness"
			data-readiness-state={readiness.state}
		>
			<div className="flex items-start gap-1.5 text-xs">
				<span
					className="w-2 h-2 rounded-full flex-shrink-0 mt-1"
					style={{ backgroundColor: dotColor }}
					aria-hidden
				/>
				<span
					className="font-medium flex-shrink-0"
					style={{
						color: readiness.state === 'unavailable' ? theme.colors.warning : theme.colors.textMain,
					}}
				>
					{headline}
				</span>
				{readiness.state !== 'off' && (
					<span className="opacity-70 select-text">{readiness.detail}</span>
				)}
			</div>
			{readiness.state === 'unavailable' && (
				<div className="flex flex-wrap items-center gap-2 pl-3.5">
					{readiness.suggestedAction && (
						<span className="text-xs opacity-70 select-text">{readiness.suggestedAction}</span>
					)}
					<RecoveryButton
						theme={theme}
						readiness={readiness}
						models={models}
						endpoints={endpoints}
						onRecheck={onRecheck}
					/>
				</div>
			)}
		</div>
	);
}

/** The reasons a fresh look at the server can clear, once the user fixed it outside Maestro. */
const RECHECKABLE_ENDPOINT_REASONS = new Set<LocalModelTaskReadiness['reason']>([
	'endpoint-unreachable',
	'endpoint-rejected',
	'endpoint-key-missing',
	'endpoint-model-missing',
]);

interface RecoveryButtonProps {
	theme: Theme;
	readiness: LocalModelTaskReadiness;
	models: LocalModelsState;
	endpoints: LocalModelEndpointsState;
	onRecheck: () => Promise<void>;
}

/**
 * The one in-place recovery for an unavailable task, or nothing when the fix is
 * a different pick (an unknown model, a wrong kind, an unsupported need) or
 * lives elsewhere (a native runtime). The suggested action beside it already
 * says what to do in those cases.
 */
function RecoveryButton({ theme, readiness, models, endpoints, onRecheck }: RecoveryButtonProps) {
	const [rechecking, setRechecking] = useState(false);
	const { assignment, reason } = readiness;

	const buttonClass = 'px-2 py-1 rounded border text-xs flex items-center gap-1.5';
	const buttonStyle = { borderColor: theme.colors.border, color: theme.colors.textMain };

	if (
		assignment.type === 'local' &&
		(reason === 'model-not-installed' || reason === 'model-corrupt')
	) {
		const modelId = assignment.modelId;
		const listing = models.listings.find((candidate) => candidate.entry.id === modelId);
		const name = listing?.entry.displayName ?? modelId;
		const progress = models.progress[modelId];
		if (isActive(progress)) {
			return (
				<span className="text-xs flex items-center gap-1.5 opacity-70">
					<Loader2 className="w-3 h-3 animate-spin" />
					Downloading {name} ({downloadPercent(progress)}%)
				</span>
			);
		}
		const paused = progress?.phase === 'paused';
		return (
			<button
				type="button"
				className={buttonClass}
				style={buttonStyle}
				onClick={() => void (paused ? models.resume(modelId) : models.download(modelId))}
				data-testid="local-models-task-recovery"
			>
				<Download className="w-3 h-3" />
				{paused
					? `Resume ${name}`
					: reason === 'model-corrupt'
						? `Re-download ${name}`
						: `Download ${name}`}
			</button>
		);
	}

	if (assignment.type === 'endpoint' && reason === 'endpoint-disabled') {
		const endpoint = endpoints.endpoints.find(
			(candidate) => candidate.id === assignment.endpointId
		);
		if (!endpoint) return null;
		return (
			<button
				type="button"
				className={buttonClass}
				style={buttonStyle}
				onClick={() => endpoints.setEnabled(endpoint.id, true)}
				data-testid="local-models-task-recovery"
			>
				<Power className="w-3 h-3" />
				Enable {endpoint.name}
			</button>
		);
	}

	if (assignment.type === 'endpoint' && RECHECKABLE_ENDPOINT_REASONS.has(reason)) {
		const recheck = async () => {
			setRechecking(true);
			try {
				await endpoints.refreshModels(assignment.endpointId);
				await onRecheck();
			} finally {
				setRechecking(false);
			}
		};
		return (
			<button
				type="button"
				className={buttonClass}
				style={buttonStyle}
				onClick={() => void recheck()}
				disabled={rechecking}
				data-testid="local-models-task-recovery"
			>
				<RefreshCw className={`w-3 h-3${rechecking ? ' animate-spin' : ''}`} />
				Check again
			</button>
		);
	}

	return null;
}
