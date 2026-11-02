/**
 * SystemOneLedgerSection - the decision ledger under the System One task list.
 *
 * One row per task run that was handed to a System One engine, newest first:
 * what was answered, or what the task's fail policy did when no answer came.
 * Records are kept for 30 days. A row opens to show the model, the question
 * ids, the tokens and cost, the agent the run was for, and, when "Keep inputs
 * in the ledger" was on for that run, the redacted state and questions.
 *
 * Opening the section reads the ledger and sends nothing to an engine. The one
 * control that changes anything is the Keep inputs toggle; the two pickers only
 * narrow what is shown.
 *
 * Every control has a `maestro-cli s1` verb that calls the same main-process
 * function: `s1 ledger [--task] [--outcome]` and `s1 set keep-inputs on|off`.
 */

import { useId, useMemo, useState } from 'react';
import { ChevronRight, RefreshCw, ScrollText } from 'lucide-react';

import {
	formatCount,
	formatRelativeTime,
	truncateAtWordBoundary,
} from '../../../../../shared/formatters';
import {
	SYSTEM_ONE_LEDGER_OUTCOME_FILTERS,
	SYSTEM_ONE_LEDGER_OUTCOME_LABELS,
	SYSTEM_ONE_LEDGER_RETENTION_DAYS,
	isSystemOneLedgerOutcomeFilter,
	summarizeSystemOneDecision,
	systemOneLedgerContext,
	systemOneLedgerEngineLabel,
	systemOneLedgerTaskLabel,
	type SystemOneLedgerEntry,
} from '../../../../../shared/local-models/system-one-ledger';
import { SYSTEM_ONE_KEEP_INPUTS_DESCRIPTIONS } from '../../../../../shared/local-models/system-one-settings';
import { formatSystemOneCost } from '../../../../../shared/local-models/system-one-spend';
import {
	LOCAL_MODEL_TASKS,
	LOCAL_MODEL_TASK_IDS,
	isLocalModelTaskId,
	taskAcceptsSystemOne,
} from '../../../../../shared/local-models/tasks';
import {
	useSystemOneLedger,
	type SystemOneHookState,
	type SystemOneLedgerFilters,
} from '../../../../hooks/localModels';
import { useSessionStore } from '../../../../stores/sessionStore';
import type { Theme } from '../../../../types';
import { ToggleSwitch } from '../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { CardButton } from './CardButton';
import { CardRowTitle, CardWarning } from './CardParts';

/** The picker value that narrows nothing. */
const ALL = '';

/** The tasks a record can belong to: the ones that take the System One assignment. */
const LEDGER_TASKS = LOCAL_MODEL_TASK_IDS.map((taskId) => LOCAL_MODEL_TASKS[taskId]).filter(
	taskAcceptsSystemOne
);

/** A kept input, indented when it is the JSON the ledger wrote. Anything else is shown as stored. */
export function formatLedgerInput(input: string): string {
	try {
		return JSON.stringify(JSON.parse(input), null, 2);
	} catch {
		return input;
	}
}

/** The color that says how a run ended: answered, went ahead unchecked, or stopped. */
function outcomeColor(theme: Theme, entry: SystemOneLedgerEntry): string {
	if (entry.outcome === 'ok') return theme.colors.success;
	if (entry.outcome === 'cancelled') return theme.colors.textDim;
	return entry.outcome === 'failed-closed' ? theme.colors.error : theme.colors.warning;
}

export interface SystemOneLedgerSectionProps {
	theme: Theme;
	/** The tab's one `useSystemOne()`: the Keep inputs toggle reads and changes it. */
	systemOne: SystemOneHookState;
}

export function SystemOneLedgerSection({ theme, systemOne }: SystemOneLedgerSectionProps) {
	const [filters, setFilters] = useState<SystemOneLedgerFilters>({});
	const ledger = useSystemOneLedger(filters);
	const sessions = useSessionStore((s) => s.sessions);
	const agentNames = useMemo(
		() => Object.fromEntries(sessions.map((s) => [s.id, s.name])),
		[sessions]
	);

	const { page } = ledger;
	const keepInputs = systemOne.report?.settings.keepInputs ?? false;
	const filtered = filters.taskId !== undefined || filters.outcome !== undefined;
	const selectStyle = { borderColor: theme.colors.border, color: theme.colors.textMain };

	return (
		<div
			data-setting-id="local-models-system-one-ledger"
			className="select-none"
			data-testid="system-one-ledger-section"
		>
			<SettingsSectionHeading
				icon={ScrollText}
				description={`What each System One run decided, and what its fail policy did when no answer came. Kept for ${SYSTEM_ONE_LEDGER_RETENTION_DAYS} days.`}
			>
				Decision ledger
			</SettingsSectionHeading>
			<SectionCard theme={theme} className="space-y-3">
				<div
					className="flex items-start justify-between gap-3"
					data-testid="system-one-keep-inputs"
				>
					<div className="min-w-0">
						<CardRowTitle theme={theme}>Keep inputs in the ledger</CardRowTitle>
						<p className="text-xs opacity-70 mt-0.5">
							{SYSTEM_ONE_KEEP_INPUTS_DESCRIPTIONS[keepInputs ? 'on' : 'off']}
						</p>
					</div>
					<ToggleSwitch
						theme={theme}
						checked={keepInputs}
						onChange={(next) => void systemOne.set({ keepInputs: next })}
						disabled={!systemOne.report || systemOne.busy !== null}
						size="sm"
						ariaLabel="Keep inputs in the ledger"
					/>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<select
						aria-label="Show decisions for task"
						value={filters.taskId ?? ALL}
						onChange={(event) => {
							const { value } = event.target;
							setFilters((current) => ({
								...(current.outcome !== undefined ? { outcome: current.outcome } : {}),
								...(isLocalModelTaskId(value) ? { taskId: value } : {}),
							}));
						}}
						className="p-1.5 rounded border bg-transparent outline-none text-xs"
						style={selectStyle}
						data-testid="system-one-ledger-task"
					>
						<option value={ALL}>All tasks</option>
						{LEDGER_TASKS.map((task) => (
							<option key={task.id} value={task.id}>
								{task.label}
							</option>
						))}
					</select>
					<select
						aria-label="Show decisions with outcome"
						value={filters.outcome ?? ALL}
						onChange={(event) => {
							const { value } = event.target;
							setFilters((current) => ({
								...(current.taskId !== undefined ? { taskId: current.taskId } : {}),
								...(isSystemOneLedgerOutcomeFilter(value) ? { outcome: value } : {}),
							}));
						}}
						className="p-1.5 rounded border bg-transparent outline-none text-xs"
						style={selectStyle}
						data-testid="system-one-ledger-outcome"
					>
						<option value={ALL}>All outcomes</option>
						{SYSTEM_ONE_LEDGER_OUTCOME_FILTERS.map((outcome) => (
							<option key={outcome} value={outcome}>
								{SYSTEM_ONE_LEDGER_OUTCOME_LABELS[outcome]}
							</option>
						))}
					</select>
					<div className="ml-auto">
						<CardButton
							theme={theme}
							icon={RefreshCw}
							label={ledger.loading ? 'Reading...' : 'Refresh'}
							onClick={() => void ledger.refresh()}
							disabled={ledger.loading}
							testId="system-one-ledger-refresh"
						/>
					</div>
				</div>

				{ledger.error && (
					<p
						className="text-xs select-text"
						style={{ color: theme.colors.error }}
						data-testid="system-one-ledger-error"
					>
						{ledger.error}
					</p>
				)}
				{page?.notice && (
					<div data-testid="system-one-ledger-notice">
						<CardWarning theme={theme}>{page.notice}</CardWarning>
					</div>
				)}

				{page && page.entries.length === 0 && (
					<p className="text-xs opacity-70" data-testid="system-one-ledger-empty">
						{filtered
							? 'No decisions match.'
							: `No decisions in the last ${page.retentionDays} days. A task assigned to System One adds one each time it runs.`}
					</p>
				)}

				{page && page.entries.length > 0 && (
					<ul className="space-y-1" data-testid="system-one-ledger-list">
						{page.entries.map((entry) => (
							<LedgerRow
								key={entry.id}
								theme={theme}
								entry={entry}
								agentName={
									entry.agentId === undefined
										? null
										: (agentNames[entry.agentId] ?? `Removed agent ${entry.agentId.slice(0, 8)}`)
								}
							/>
						))}
					</ul>
				)}

				{page && page.total > page.entries.length && (
					<p className="text-xs opacity-70" data-testid="system-one-ledger-more">
						Showing the newest {formatCount(page.entries.length)} of {formatCount(page.total)}. Read
						the rest with: maestro-cli s1 ledger --limit {page.total}
					</p>
				)}
			</SectionCard>
		</div>
	);
}

interface LedgerRowProps {
	theme: Theme;
	entry: SystemOneLedgerEntry;
	/** Null when the run named no agent. */
	agentName: string | null;
}

function LedgerRow({ theme, entry, agentName }: LedgerRowProps) {
	const [open, setOpen] = useState(false);
	const detailId = useId();
	const context = useMemo(() => systemOneLedgerContext(entry), [entry]);
	const detail: Array<[string, string]> = [
		['When', new Date(entry.startedAt).toLocaleString()],
		...(entry.model !== undefined ? [['Model', entry.model] as [string, string]] : []),
		['Questions', entry.questionIds.join(', ') || 'none'],
		...(entry.code !== undefined ? [['Why no answer', entry.code] as [string, string]] : []),
		...(entry.usage
			? [
					[
						'Tokens',
						`${formatCount(entry.usage.inputTokens)} in, ${formatCount(entry.usage.outputTokens)} out`,
					] as [string, string],
				]
			: []),
		...(entry.costUsd !== undefined
			? [['Cost (est.)', formatSystemOneCost(entry.costUsd)] as [string, string]]
			: []),
		...(agentName !== null ? [['Agent', agentName] as [string, string]] : []),
	];

	return (
		<li data-testid="system-one-ledger-row" data-outcome={entry.outcome} data-task={entry.taskId}>
			<button
				type="button"
				className="w-full text-left text-xs flex items-start gap-2 py-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2"
				style={{ color: theme.colors.textMain, outlineColor: theme.colors.accent }}
				onClick={() => setOpen((current) => !current)}
				aria-expanded={open}
				aria-controls={detailId}
				title={open ? 'Collapse decision details' : 'Expand decision details'}
			>
				<ChevronRight
					className={`w-3.5 h-3.5 mt-0.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
					style={{ color: theme.colors.accent }}
					aria-hidden="true"
					data-testid="system-one-ledger-chevron"
				/>
				<span className="min-w-0 flex-1 space-y-1">
					<span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
						<span className="opacity-70 w-16 shrink-0">{formatRelativeTime(entry.startedAt)}</span>
						<span className="font-medium" data-testid="system-one-ledger-topic">
							{context.label}
						</span>
						<span className="opacity-70">{systemOneLedgerEngineLabel(entry.engine)}</span>
						<span style={{ color: outcomeColor(theme, entry) }}>
							{SYSTEM_ONE_LEDGER_OUTCOME_LABELS[entry.outcome]}
						</span>
						<span className="min-w-0 break-words">{summarizeSystemOneDecision(entry)}</span>
						<span className="opacity-70 ml-auto whitespace-nowrap">
							{formatCount(entry.latencyMs)} ms
						</span>
					</span>
					<span
						className="block break-words opacity-70"
						title={context.question ?? undefined}
						data-testid="system-one-ledger-question"
					>
						{context.question
							? truncateAtWordBoundary(context.question, 160)
							: entry.input === undefined
								? 'Decision context unavailable: input was not kept.'
								: 'Decision context unavailable: no saved question.'}
					</span>
					<span
						className="flex flex-wrap gap-x-3 gap-y-0.5 opacity-70"
						data-testid="system-one-ledger-summary"
					>
						{context.label !== systemOneLedgerTaskLabel(entry.taskId) && (
							<span>{systemOneLedgerTaskLabel(entry.taskId)}</span>
						)}
						<span className="min-w-0 break-words">Agent: {agentName ?? 'No agent named'}</span>
						{entry.model !== undefined && (
							<span className="min-w-0 break-words">Model: {entry.model}</span>
						)}
						{entry.cached && <span>Cached</span>}
						{entry.usage && (
							<span>
								Tokens: {formatCount(entry.usage.inputTokens)} in,{' '}
								{formatCount(entry.usage.outputTokens)} out
							</span>
						)}
						{entry.costUsd !== undefined && (
							<span>Cost (est.): {formatSystemOneCost(entry.costUsd)}</span>
						)}
					</span>
				</span>
			</button>
			{open && (
				<div
					id={detailId}
					className="pl-6 pb-2 space-y-1 text-xs select-text"
					data-testid="system-one-ledger-detail"
				>
					{detail.map(([label, value]) => (
						<div key={label} className="flex gap-2">
							<span className="opacity-70 w-24 flex-shrink-0">{label}</span>
							<span className="min-w-0 break-words">{value}</span>
						</div>
					))}
					{entry.input === undefined ? (
						<p className="opacity-70">The input was not kept for this run.</p>
					) : (
						<pre
							className="max-h-64 overflow-auto rounded border p-2 font-mono whitespace-pre-wrap break-words"
							style={{ borderColor: theme.colors.border }}
							data-testid="system-one-ledger-input"
						>
							{formatLedgerInput(entry.input)}
						</pre>
					)}
				</div>
			)}
		</li>
	);
}
