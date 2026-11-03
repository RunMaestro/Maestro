import { useState } from 'react';
import type { Session, Theme } from '../types';
import type { StoredBoardWorker } from '../../main/board/board-workspace-storage';
import {
	BOARD_WORKER_OPTION_FIELDS,
	readBoardWorkerOptions,
	type BoardWorkerOptionsPatch,
} from '../../shared/board/worker-options';
import { canonicalJson } from '../../shared/canonicalJson';
import { useAgentModelEffortOptions } from '../hooks/agent/useAgentModelEffortOptions';
import { getSessionSshRemoteId } from '../utils/sessionHelpers';
import { ThemedSelect } from './shared/ThemedSelect';

export function BoardWorkerOptions({
	worker,
	session,
	theme,
	roles,
	workers,
	disabled,
	onSave,
}: {
	worker: StoredBoardWorker;
	session: Session;
	theme: Theme;
	roles: Awaited<ReturnType<typeof window.maestro.board.listWorkerAccessOptions>>['roles'];
	workers: StoredBoardWorker[];
	disabled: boolean;
	onSave: (patch: BoardWorkerOptionsPatch) => Promise<boolean>;
}) {
	const options = readBoardWorkerOptions(
		Object.prototype.hasOwnProperty.call(worker.payload, 'executionOptions')
			? worker.payload.executionOptions
			: {}
	);
	const [patch, setPatch] = useState<BoardWorkerOptionsPatch>({});
	const [error, setError] = useState('');
	const { models, efforts, loaded } = useAgentModelEffortOptions(
		session.toolType,
		getSessionSshRemoteId(session)
	);
	const refs = Array.isArray(worker.payload.roleRefs) ? worker.payload.roleRefs : [];
	const inherited = refs.map((ref) => ({
		ref,
		sharedWithWorkers: workers
			.filter(
				(candidate) =>
					Array.isArray(candidate.payload.roleRefs) &&
					candidate.payload.roleRefs.some(
						(other) => other?.namespace === ref?.namespace && other?.profileId === ref?.profileId
					)
			)
			.map((candidate) => candidate.agentId),
		source: roles.find(
			(entry) => entry.namespace === ref?.namespace && entry.profileId === ref?.profileId
		),
	}));
	const conflicts = BOARD_WORKER_OPTION_FIELDS.filter((field) => {
		const profileField =
			field === 'customModel' ? 'model' : field === 'customEffort' ? 'effort' : field;
		return (
			new Set(
				inherited.map(({ source }) => canonicalJson({ value: source?.profile?.[profileField] }))
			).size > 1
		);
	});
	if (!options)
		return <p role="alert">Execution options need repair; stored values are preserved.</p>;
	const value = (field: keyof BoardWorkerOptionsPatch) =>
		Object.prototype.hasOwnProperty.call(patch, field)
			? (patch[field] ?? '')
			: (options[field] ?? '');
	const inputStyle = {
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
		backgroundColor: theme.colors.bgMain,
	};
	return (
		<details>
			<summary>Execution options for {session.name}</summary>
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				Worker overrides take priority over a card's legacy execution source, then agent defaults.
				Cards without a legacy reference use worker overrides and agent defaults. Blank model or
				effort restores inheritance.
			</p>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 my-2">
				<label>
					Model
					<input
						aria-label={`Worker model for ${session.name}`}
						disabled={disabled}
						value={value('customModel')}
						onChange={(event) => setPatch({ ...patch, customModel: event.target.value || null })}
						style={inputStyle}
						className="w-full border rounded p-1"
					/>
					{loaded && models.length > 0 && (
						<ThemedSelect
							theme={theme}
							disabled={disabled}
							aria-label={`Available worker models for ${session.name}`}
							value={value('customModel')}
							options={[
								{ value: '', label: 'Inherit' },
								...models.map((model) => ({ value: model, label: model })),
							]}
							onChange={(model) => setPatch({ ...patch, customModel: model || null })}
						/>
					)}
				</label>
				<label>
					Effort
					<input
						aria-label={`Worker effort for ${session.name}`}
						disabled={disabled}
						value={value('customEffort')}
						onChange={(event) => setPatch({ ...patch, customEffort: event.target.value || null })}
						style={inputStyle}
						className="w-full border rounded p-1"
					/>
					{loaded && efforts.length > 0 && (
						<ThemedSelect
							theme={theme}
							disabled={disabled}
							aria-label={`Available worker efforts for ${session.name}`}
							value={value('customEffort')}
							options={[
								{ value: '', label: 'Inherit' },
								...efforts.map((effort) => ({ value: effort, label: effort })),
							]}
							onChange={(effort) => setPatch({ ...patch, customEffort: effort || null })}
						/>
					)}
				</label>
				{(['appendSystemPrompt', 'customArgs'] as const).map((field) => (
					<label key={field}>
						{field === 'appendSystemPrompt' ? 'Appended system prompt' : 'Extra CLI arguments'}
						<textarea
							aria-label={`${field} for ${session.name}`}
							disabled={disabled}
							value={value(field)}
							onChange={(event) => setPatch({ ...patch, [field]: event.target.value })}
							style={inputStyle}
							className="w-full border rounded p-1"
						/>
						<button disabled={disabled} onClick={() => setPatch({ ...patch, [field]: null })}>
							Inherit {field}
						</button>
					</label>
				))}
			</div>
			<button
				disabled={disabled || !Object.keys(patch).length}
				onClick={async () => {
					setError('');
					if (await onSave(patch)) setPatch({});
					else setError('Options were not saved. Refresh workers before retrying.');
				}}
			>
				Save execution options for {session.name}
			</button>
			{error && <p role="alert">{error}</p>}
			{conflicts.length > 0 && (
				<p style={{ color: theme.colors.warning }}>
					Legacy sources differ for {conflicts.join(', ')}. Each card keeps its explicit source; no
					default source is chosen.
				</p>
			)}
			{inherited.some(({ source }) => !source) && (
				<p role="alert">
					A legacy source is missing. Cards referring to it wait until its identity is restored.
				</p>
			)}
			<details>
				<summary>Stored options and legacy origins</summary>
				<pre className="text-xs whitespace-pre-wrap select-text">
					{JSON.stringify(
						{
							executionOptions: worker.payload.executionOptions,
							migration: worker.payload.migration,
							sources: inherited,
						},
						null,
						2
					)}
				</pre>
			</details>
		</details>
	);
}
