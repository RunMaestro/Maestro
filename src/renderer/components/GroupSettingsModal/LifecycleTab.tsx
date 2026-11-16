/**
 * LifecycleTab - the Lifecycle tab of Group Settings: the group's Onboarding
 * and Offboarding prompts, one card each.
 *
 * The tab edits a draft the modal holds; Save writes it with the rest of the
 * group. "Run now on an agent..." runs the prompt as typed, without saving, so
 * a person can try a prompt before they commit to it.
 */

import { useRef, useState } from 'react';
import { LogIn, LogOut, Play } from 'lucide-react';
import type { Theme } from '../../types';
import {
	GROUP_LIFECYCLE_STAGE_LABELS,
	GROUP_LIFECYCLE_STAGE_SUMMARIES,
	GROUP_LIFECYCLE_STAGES,
	GROUP_LIFECYCLE_TRIGGER_LABELS,
	GROUP_LIFECYCLE_TRIGGERS,
	LIFECYCLE_TEMPLATE_VARIABLES,
	MAX_LIFECYCLE_TAB_NAME_CHARS,
	DEFAULT_OFFBOARDING_TIMEOUT_MINUTES,
	OFFBOARDING_TIMEOUT_CHOICES,
	type GroupLifecycleHook,
	type GroupLifecycleProblem,
	type GroupLifecycleStage,
	type GroupLifecycleTrigger,
} from '../../../shared/groupLifecycle';
import { TIER_LEVELS, type ModelTier } from '../../../shared/tierLevels';
import { useTemplateAutocomplete } from '../../hooks/input/useTemplateAutocomplete';
import { runGroupLifecycleNow } from '../../services/groupLifecycle';
import { TemplateAutocompleteDropdown } from '../TemplateAutocompleteDropdown';
import { SegmentedControl, ToggleSwitch } from '../ui';

/** An agent a picker offers. */
export interface LifecycleAgentOption {
	id: string;
	name: string;
}

export interface LifecycleTabProps {
	theme: Theme;
	groupId: string;
	/** The draft, with every stage present. */
	hooks: Record<GroupLifecycleStage, GroupLifecycleHook>;
	onChange: (stage: GroupLifecycleStage, hook: GroupLifecycleHook) => void;
	/** The problem the last Save refused, shown under its field. */
	problem: GroupLifecycleProblem | null;
	/** Every agent, for "Another agent". */
	agents: readonly LifecycleAgentOption[];
	/** The group's agents (worktree agents included), for "Run now". */
	members: readonly LifecycleAgentOption[];
}

const STAGE_ICONS = { onboarding: LogIn, offboarding: LogOut } as const;

/** Who the stage is about, as the "Runs in" choice names it. */
const SELF_LABELS: Readonly<Record<GroupLifecycleStage, string>> = {
	onboarding: 'The new agent',
	offboarding: 'The leaving agent',
};

const TIER_LABELS: Readonly<Record<ModelTier, string>> = {
	low: 'Low',
	medium: 'Medium',
	high: 'High',
};

export function LifecycleTab({
	theme,
	groupId,
	hooks,
	onChange,
	problem,
	agents,
	members,
}: LifecycleTabProps) {
	return (
		<div className="space-y-4" data-testid="group-settings-lifecycle">
			{GROUP_LIFECYCLE_STAGES.map((stage) => (
				<LifecycleCard
					key={stage}
					theme={theme}
					groupId={groupId}
					stage={stage}
					hook={hooks[stage]}
					onChange={(hook) => onChange(stage, hook)}
					problem={problem?.stage === stage ? problem : null}
					agents={agents}
					members={members}
				/>
			))}
		</div>
	);
}

interface LifecycleCardProps {
	theme: Theme;
	groupId: string;
	stage: GroupLifecycleStage;
	hook: GroupLifecycleHook;
	onChange: (hook: GroupLifecycleHook) => void;
	problem: GroupLifecycleProblem | null;
	agents: readonly LifecycleAgentOption[];
	members: readonly LifecycleAgentOption[];
}

function LifecycleCard({
	theme,
	groupId,
	stage,
	hook,
	onChange,
	problem,
	agents,
	members,
}: LifecycleCardProps) {
	const label = GROUP_LIFECYCLE_STAGE_LABELS[stage];
	const Icon = STAGE_ICONS[stage];
	const iconColor = stage === 'onboarding' ? theme.colors.success : theme.colors.warning;
	const idPrefix = `group-lifecycle-${stage}`;
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const set = (patch: Partial<GroupLifecycleHook>) => onChange({ ...hook, ...patch });

	const autocomplete = useTemplateAutocomplete({
		textareaRef: promptRef,
		value: hook.prompt,
		onChange: (prompt) => set({ prompt }),
	});

	const toggleTrigger = (trigger: GroupLifecycleTrigger) => {
		const triggers = hook.triggers.includes(trigger)
			? hook.triggers.filter((candidate) => candidate !== trigger)
			: GROUP_LIFECYCLE_TRIGGERS.filter(
					(candidate) => candidate === trigger || hook.triggers.includes(candidate)
				);
		set({ triggers });
	};

	const runsInOther = hook.runsInAgentId !== undefined;
	const errorFor = (field: GroupLifecycleProblem['field']) =>
		problem?.field === field ? problem.error : undefined;
	const fieldStyle = {
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
		backgroundColor: theme.colors.bgMain,
	};

	return (
		<section
			className="rounded-lg border p-4 space-y-3"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
			data-testid={idPrefix}
			aria-labelledby={`${idPrefix}-title`}
		>
			<div className="flex items-center justify-between gap-3 select-none">
				<div className="flex items-center gap-3 min-w-0">
					<div
						className="w-8 h-8 rounded-lg grid place-items-center shrink-0"
						style={{ backgroundColor: `${iconColor}22`, color: iconColor }}
					>
						<Icon className="w-4 h-4" />
					</div>
					<div className="min-w-0">
						<div
							id={`${idPrefix}-title`}
							className="text-sm font-semibold"
							style={{ color: theme.colors.textMain }}
						>
							{label}
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							{GROUP_LIFECYCLE_STAGE_SUMMARIES[stage]}
						</div>
					</div>
				</div>
				<ToggleSwitch
					theme={theme}
					checked={hook.enabled}
					onChange={(enabled) => set({ enabled })}
					ariaLabel={`${label} on`}
				/>
			</div>

			<Row theme={theme} label="When">
				<div className="flex flex-wrap gap-2" role="group" aria-label={`${label} events`}>
					{GROUP_LIFECYCLE_TRIGGERS.map((trigger) => {
						const checked = hook.triggers.includes(trigger);
						return (
							<label
								key={trigger}
								className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs cursor-pointer select-none"
								style={{
									borderColor: checked ? theme.colors.accent : theme.colors.border,
									backgroundColor: checked ? `${theme.colors.accent}22` : 'transparent',
									color: theme.colors.textMain,
								}}
							>
								<input
									type="checkbox"
									checked={checked}
									onChange={() => toggleTrigger(trigger)}
									data-testid={`${idPrefix}-trigger-${trigger}`}
								/>
								{GROUP_LIFECYCLE_TRIGGER_LABELS[stage][trigger]}
							</label>
						);
					})}
				</div>
			</Row>
			<FieldError theme={theme} error={errorFor('triggers')} />

			<Row theme={theme} label="Runs in">
				<div className="flex flex-wrap items-center gap-2">
					<SegmentedControl
						theme={theme}
						value={runsInOther ? 'other' : 'self'}
						onChange={(choice) =>
							set({
								runsInAgentId:
									choice === 'self' ? undefined : (hook.runsInAgentId ?? agents[0]?.id ?? ''),
							})
						}
						options={[
							{ value: 'self', label: SELF_LABELS[stage] },
							{ value: 'other', label: 'Another agent' },
						]}
						ariaLabel={`Where ${label} runs`}
						testId={`${idPrefix}-runs-in`}
					/>
					{runsInOther && (
						<select
							value={hook.runsInAgentId ?? ''}
							onChange={(e) => set({ runsInAgentId: e.target.value })}
							aria-label={`Agent that runs ${label}`}
							className="p-1.5 rounded border outline-none text-xs"
							style={fieldStyle}
							data-testid={`${idPrefix}-runs-in-agent`}
						>
							{!agents.some((agent) => agent.id === hook.runsInAgentId) && (
								<option value={hook.runsInAgentId ?? ''}>Choose an agent</option>
							)}
							{agents.map((agent) => (
								<option key={agent.id} value={agent.id}>
									{agent.name}
								</option>
							))}
						</select>
					)}
					<span className="text-xs ml-2" style={{ color: theme.colors.textDim }}>
						Tab
					</span>
					<input
						type="text"
						value={hook.tabName ?? ''}
						placeholder={label}
						maxLength={MAX_LIFECYCLE_TAB_NAME_CHARS}
						onChange={(e) => set({ tabName: e.target.value || undefined })}
						aria-label={`${label} tab name`}
						className="w-32 p-1.5 rounded border outline-none text-xs"
						style={fieldStyle}
						data-testid={`${idPrefix}-tab-name`}
					/>
					<span className="text-xs ml-2" style={{ color: theme.colors.textDim }}>
						Tier
					</span>
					<select
						value={hook.tier ?? 'default'}
						onChange={(e) =>
							set({
								tier: e.target.value === 'default' ? undefined : (e.target.value as ModelTier),
							})
						}
						aria-label={`${label} model tier`}
						className="p-1.5 rounded border outline-none text-xs"
						style={fieldStyle}
						data-testid={`${idPrefix}-tier`}
					>
						<option value="default">Default</option>
						{TIER_LEVELS.map((tier) => (
							<option key={tier} value={tier}>
								{TIER_LABELS[tier]}
							</option>
						))}
					</select>
				</div>
			</Row>
			<FieldError theme={theme} error={errorFor('runsIn') ?? errorFor('tabName')} />

			{stage === 'offboarding' && (
				<>
					<Row theme={theme} label="Time limit">
						<div
							className="flex items-center gap-2 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							<span>Wait up to</span>
							<select
								value={hook.timeoutMinutes ?? DEFAULT_OFFBOARDING_TIMEOUT_MINUTES}
								onChange={(e) => set({ timeoutMinutes: Number(e.target.value) })}
								aria-label="Offboarding time limit"
								className="p-1.5 rounded border outline-none text-xs"
								style={fieldStyle}
								data-testid={`${idPrefix}-timeout`}
							>
								{timeoutChoices(hook.timeoutMinutes).map((minutes) => (
									<option key={minutes} value={minutes}>
										{minutes} min
									</option>
								))}
							</select>
							<span>for this turn, then remove the agent anyway</span>
						</div>
					</Row>
					<FieldError theme={theme} error={errorFor('timeout')} />
				</>
			)}

			<div className="relative">
				<textarea
					ref={promptRef}
					value={hook.prompt}
					onChange={autocomplete.handleChange}
					onKeyDown={(e) => {
						autocomplete.handleKeyDown(e);
					}}
					rows={4}
					placeholder={
						stage === 'onboarding'
							? 'Set this agent up: copy .env from {{PARENT_PATH}}, install dependencies... (type {{ for variables)'
							: 'Tear down what this agent started: stop servers, drop databases... (type {{ for variables)'
					}
					aria-label={`${label} prompt`}
					className="w-full p-2.5 rounded border outline-none text-xs font-mono resize-y min-h-[88px] select-text"
					style={{
						...fieldStyle,
						borderColor: errorFor('prompt') ? theme.colors.error : theme.colors.border,
					}}
					data-testid={`${idPrefix}-prompt`}
				/>
				<TemplateAutocompleteDropdown
					ref={autocomplete.autocompleteRef}
					theme={theme}
					state={autocomplete.autocompleteState}
					onSelect={autocomplete.selectVariable}
				/>
			</div>
			<FieldError theme={theme} error={errorFor('prompt')} />

			<div className="flex flex-wrap items-start justify-between gap-3 text-xs">
				<p className="min-w-0 flex-1" style={{ color: theme.colors.textDim }}>
					Type <code>{'{{'}</code> for variables. They describe the agent{' '}
					{stage === 'onboarding' ? 'joining' : 'leaving'}, even when another agent runs the prompt.
					Also:{' '}
					{LIFECYCLE_TEMPLATE_VARIABLES.map((entry, index) => (
						<span key={entry.variable} title={entry.description}>
							{index > 0 && ', '}
							<code>{entry.variable}</code>
						</span>
					))}
					.{stage === 'offboarding' && ' Removal waits for this turn, or for the time limit.'}
				</p>
				<RunNow theme={theme} groupId={groupId} stage={stage} hook={hook} members={members} />
			</div>
		</section>
	);
}

/** The minute choices, with a stored value outside the list kept selectable. */
function timeoutChoices(current: number | undefined): number[] {
	if (current === undefined || OFFBOARDING_TIMEOUT_CHOICES.includes(current)) {
		return [...OFFBOARDING_TIMEOUT_CHOICES];
	}
	return [...OFFBOARDING_TIMEOUT_CHOICES, current].sort((a, b) => a - b);
}

function Row({
	theme,
	label,
	children,
}: {
	theme: Theme;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-20 shrink-0 text-xs select-none" style={{ color: theme.colors.textDim }}>
				{label}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

function FieldError({ theme, error }: { theme: Theme; error: string | undefined }) {
	if (!error) return null;
	return (
		<p className="text-xs select-text" style={{ color: theme.colors.error }} role="alert">
			{error}
		</p>
	);
}

/**
 * "Run now on an agent...": the prompt as typed, on one agent of the group.
 * Offboarding here runs the prompt only; it removes nothing.
 */
function RunNow({
	theme,
	groupId,
	stage,
	hook,
	members,
}: {
	theme: Theme;
	groupId: string;
	stage: GroupLifecycleStage;
	hook: GroupLifecycleHook;
	members: readonly LifecycleAgentOption[];
}) {
	const [agentId, setAgentId] = useState('');
	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
	const [running, setRunning] = useState(false);
	const target = members.some((member) => member.id === agentId) ? agentId : '';
	const disabled = running || !target || !hook.prompt.trim();

	const run = async () => {
		if (disabled) return;
		setRunning(true);
		setStatus(null);
		const outcome = await runGroupLifecycleNow(groupId, stage, target, hook);
		setRunning(false);
		setStatus(
			outcome.ok
				? { ok: true, text: `Queued in tab "${outcome.report.tabName}".` }
				: { ok: false, text: outcome.error }
		);
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<div className="flex items-center gap-2">
				<select
					value={target}
					onChange={(e) => {
						setAgentId(e.target.value);
						setStatus(null);
					}}
					aria-label={`Agent to run ${GROUP_LIFECYCLE_STAGE_LABELS[stage]} on`}
					className="p-1.5 rounded border outline-none text-xs max-w-[12rem]"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgMain,
					}}
					disabled={members.length === 0}
					data-testid={`group-lifecycle-${stage}-run-agent`}
				>
					<option value="">
						{members.length === 0 ? 'No agents in this group' : 'Run now on...'}
					</option>
					{members.map((member) => (
						<option key={member.id} value={member.id}>
							{member.name}
						</option>
					))}
				</select>
				<button
					type="button"
					onClick={() => void run()}
					disabled={disabled}
					className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
					style={{ color: theme.colors.accent }}
					title={
						stage === 'offboarding'
							? 'Run the Offboarding prompt as typed. Nothing is removed.'
							: 'Run the Onboarding prompt as typed, without saving'
					}
					data-testid={`group-lifecycle-${stage}-run`}
				>
					<Play className="w-3 h-3" />
					Run now
				</button>
			</div>
			{status && (
				<span
					className="text-xs select-text"
					style={{ color: status.ok ? theme.colors.success : theme.colors.error }}
					role="status"
				>
					{status.text}
				</span>
			)}
		</div>
	);
}
