/**
 * DigestWriterField - who writes Computer History digests: a local model or an
 * agent, one or the other (`digests.source`).
 *
 * The local model is offered first. Which model that is belongs to Local
 * Models, like every other "which model does this" choice: the picker here
 * writes the `history-digests` task assignment, the same setting the row in
 * Settings > Models > System Two and `maestro-cli models assign
 * history-digests` write. Its option list, validation and readiness line are
 * the Models tab's own (`buildAssignmentOptionGroups`,
 * `localModelAssignmentProblem`, `TaskReadinessLine`).
 *
 * Mounting lists the installed models and the models of each ENABLED endpoint,
 * and asks main whether the one assignment would run. It starts nothing.
 */

import { useCallback, useMemo, useState } from 'react';

import {
	DIGEST_SOURCE_LABELS,
	type ComputerHistoryConfigPatch,
} from '../../../../../../shared/computer-history/config';
import {
	DIGEST_SOURCES,
	type ComputerHistoryConfig,
	type DigestSource,
} from '../../../../../../shared/computer-history/types';
import { modelsSettingsLocation } from '../../../../../../shared/local-models/settings-location';
import {
	LOCAL_MODEL_TASKS,
	formatLocalModelAssignmentSpec,
	localModelAssignmentProblem,
	parseLocalModelAssignmentSpec,
	resolveLocalModelAssignment,
	withLocalModelAssignment,
} from '../../../../../../shared/local-models/tasks';
import {
	useLocalModelEndpoints,
	useLocalModels,
	useLocalModelTaskReadiness,
} from '../../../../../hooks/localModels';
import { useSettingsStore } from '../../../../../stores/settingsStore';
import type { Theme } from '../../../../../types';
import { SegmentedControl } from '../../../../ui/SegmentedControl';
import { AssignmentOptionElements } from '../../LocalModelsTab/AssignmentOptionElements';
import { buildAssignmentOptionGroups } from '../../LocalModelsTab/assignmentOptions';
import { TaskReadinessLine } from '../../LocalModelsTab/LocalModelsAssignmentsSection';

export const DIGEST_TASK_ID = 'history-digests';

/** What the picker's unassigned option reads, in place of the Models tab's "Off". */
export const CHOOSE_MODEL_LABEL = 'Choose a model';

const SOURCE_OPTIONS = DIGEST_SOURCES.map((source) => ({
	value: source,
	label: DIGEST_SOURCE_LABELS[source],
}));

const SOURCE_NOTES: Readonly<Record<DigestSource, string>> = {
	local:
		'The history is read on this computer. Nothing leaves it unless the model you choose is on a server somewhere else.',
	agent:
		'The agent reads the history files with its own tools, so its provider sees what it reads.',
};

/** The Computer History section's own field label (see "Keep days"). */
const FIELD_LABEL_CLASS = 'block text-sm font-medium';

const MODEL_SELECT_ID = 'computer-history-digest-model';
const AGENT_SELECT_ID = 'computer-history-digest-agent';

export interface DigestWriterFieldProps {
	theme: Theme;
	digests: ComputerHistoryConfig['digests'];
	/** Agents that can be asked to write digests. */
	agents: ReadonlyArray<{ id: string; name: string }>;
	onSave: (patch: ComputerHistoryConfigPatch) => void;
}

export function DigestWriterField({ theme, digests, agents, onSave }: DigestWriterFieldProps) {
	const selectStyle = {
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.bgActivity,
		color: theme.colors.textMain,
	};

	return (
		<div className="space-y-2" data-testid="computer-history-digest-writer">
			<div className={FIELD_LABEL_CLASS} style={{ color: theme.colors.textMain }}>
				Written by
			</div>
			<SegmentedControl
				value={digests.source}
				onChange={(source) => onSave({ digests: { source } })}
				options={SOURCE_OPTIONS}
				theme={theme}
				ariaLabel="Who writes digests"
				testId="computer-history-digest-source"
			/>
			<p className="text-xs opacity-70">{SOURCE_NOTES[digests.source]}</p>
			{digests.source === 'local' ? (
				<DigestModelPicker theme={theme} selectStyle={selectStyle} />
			) : (
				<div>
					<label
						htmlFor={AGENT_SELECT_ID}
						className={FIELD_LABEL_CLASS}
						style={{ color: theme.colors.textMain }}
					>
						Digest agent
					</label>
					<select
						id={AGENT_SELECT_ID}
						value={digests.agentId ?? ''}
						onChange={(e) => onSave({ digests: { agentId: e.target.value || null } })}
						className="mt-1 w-full px-2 py-1 rounded border text-sm outline-none"
						style={selectStyle}
					>
						<option value="">Choose an agent</option>
						{agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
							</option>
						))}
					</select>
				</div>
			)}
		</div>
	);
}

interface DigestModelPickerProps {
	theme: Theme;
	selectStyle: React.CSSProperties;
}

/** The `history-digests` assignment, as a picker. Mounted only for the local source. */
function DigestModelPicker({ theme, selectStyle }: DigestModelPickerProps) {
	const task = LOCAL_MODEL_TASKS[DIGEST_TASK_ID];
	const models = useLocalModels();
	const endpoints = useLocalModelEndpoints();
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const setLocalModelAssignments = useSettingsStore((s) => s.setLocalModelAssignments);
	const assignment = resolveLocalModelAssignment(assignments, DIGEST_TASK_ID);
	// Why the last pick was refused, until the next pick.
	const [problem, setProblem] = useState<string | null>(null);

	const groups = useMemo(
		() =>
			buildAssignmentOptionGroups(task, assignment, {
				listings: models.listings,
				endpoints: endpoints.endpoints,
				endpointModels: endpoints.models,
			}).map((group) => ({
				...group,
				options: group.options.map((option) =>
					option.value === 'off' ? { ...option, label: CHOOSE_MODEL_LABEL } : option
				),
			})),
		[task, assignment, models.listings, endpoints.endpoints, endpoints.models]
	);
	// The head group is the unassigned option alone until a source can do the job.
	const hasSources = groups.length > 1;

	const revision = useMemo(
		() =>
			JSON.stringify([
				assignment,
				endpoints.endpoints,
				models.listings.map((listing) => [listing.entry.id, listing.status.status]),
			]),
		[assignment, endpoints.endpoints, models.listings]
	);
	const readiness = useLocalModelTaskReadiness(revision, DIGEST_TASK_ID);

	const choose = useCallback(
		(spec: string) => {
			const next = parseLocalModelAssignmentSpec(spec);
			const refusal = next
				? localModelAssignmentProblem(DIGEST_TASK_ID, next)
				: `"${spec}" is not a source.`;
			setProblem(refusal);
			if (refusal || !next) return;
			setLocalModelAssignments(withLocalModelAssignment(assignments, DIGEST_TASK_ID, next));
		},
		[assignments, setLocalModelAssignments]
	);

	return (
		<div className="space-y-1.5">
			<label
				htmlFor={MODEL_SELECT_ID}
				className={FIELD_LABEL_CLASS}
				style={{ color: theme.colors.textMain }}
			>
				Digest model
			</label>
			<select
				id={MODEL_SELECT_ID}
				value={formatLocalModelAssignmentSpec(assignment)}
				onChange={(e) => choose(e.target.value)}
				className="mt-1 w-full px-2 py-1 rounded border text-sm outline-none"
				style={selectStyle}
			>
				<AssignmentOptionElements groups={groups} />
			</select>
			{problem && (
				<p className="text-xs select-text" style={{ color: theme.colors.error }}>
					{problem}
				</p>
			)}
			{!hasSources && !models.loading && (
				<p className="text-xs opacity-70" data-testid="computer-history-digest-no-models">
					No text model is installed yet. Download one in {modelsSettingsLocation('library')}, or
					add a model server in {modelsSettingsLocation('sources')}.
				</p>
			)}
			{assignment.type !== 'off' && (
				<TaskReadinessLine
					theme={theme}
					readiness={readiness.readiness[DIGEST_TASK_ID]}
					checking={readiness.loading}
					models={models}
					endpoints={endpoints}
					onRecheck={readiness.refresh}
				/>
			)}
		</div>
	);
}
