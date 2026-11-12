/**
 * LaunchRunOn - the "Run on" section of the launch dialog: which agent runs the playbook.
 *
 * Three choices, none of which edits an agent:
 *
 * - **Current agent**: the agent this window has selected, as a read-only card.
 * - **Existing agent**: a dropdown over the agents that have an Auto Run folder, and the same
 *   read-only card for the pick.
 * - **New agent**: a button that opens the New Agent modal in capture mode, then a card for the
 *   captured settings with an Edit button. Nothing is created until Launch.
 *
 * The state lives in `useLaunchTarget`; this file only draws it.
 */

import { Pencil, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { getAgentDisplayName } from '../../../../shared/agentMetadata';
import type { Theme } from '../../../types';
import { ThemedSelect, type ThemedSelectOption } from '../../shared/ThemedSelect';
import { HeaderActionButton } from '../../ui/HeaderActionButton';
import { SegmentedControl, type SegmentedOption } from '../../ui/SegmentedControl';
import { LaunchAgentCard } from './LaunchAgentCard';
import type { LaunchRunOn as RunOnChoice, LaunchTargetChoice } from './useLaunchTarget';

const RUN_ON_OPTIONS: ReadonlyArray<SegmentedOption<RunOnChoice>> = [
	{ value: 'current', label: 'Current agent' },
	{ value: 'existing', label: 'Existing agent' },
	{ value: 'new', label: 'New agent' },
];

/** More agents than this and the dropdown gets a filter box. */
const FILTERABLE_FROM = 8;

/** The dropdown row that stands for "no pick yet". */
const NO_PICK = '';

export interface LaunchRunOnProps {
	theme: Theme;
	choice: LaunchTargetChoice;
	/** Opens the New Agent modal in capture mode. */
	onSetUpNewAgent: () => void;
	disabled?: boolean;
}

export function LaunchRunOn({
	theme,
	choice,
	onSetUpNewAgent,
	disabled = false,
}: LaunchRunOnProps) {
	const { runOn, summary, draft, existingSessions, existingSessionId } = choice;

	const agentOptions = useMemo<ThemedSelectOption[]>(
		() => [
			{ value: NO_PICK, label: 'Choose an agent...' },
			...existingSessions.map((session) => ({
				value: session.id,
				label: `${session.name} (${getAgentDisplayName(session.toolType)})`,
			})),
		],
		[existingSessions]
	);

	return (
		<section className="space-y-3" data-testid="launch-run-on">
			<h4
				className="text-xs font-bold uppercase opacity-70"
				style={{ color: theme.colors.textMain }}
			>
				Run on
			</h4>
			<SegmentedControl
				value={runOn}
				onChange={choice.setRunOn}
				options={RUN_ON_OPTIONS}
				theme={theme}
				ariaLabel="Run on"
				testId="launch-run-on-choice"
			/>

			{runOn === 'existing' && (
				<div data-testid="launch-existing-agent">
					<ThemedSelect
						value={existingSessionId}
						options={agentOptions}
						onChange={choice.setExistingSessionId}
						theme={theme}
						disabled={disabled}
						filterable={agentOptions.length > FILTERABLE_FROM}
						aria-label="Existing agent"
					/>
				</div>
			)}

			{runOn === 'new' && !draft && (
				<div className="space-y-2" data-testid="launch-new-agent-setup">
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Pick the provider, model and folder for a new agent. Nothing is created until you
						launch.
					</p>
					<HeaderActionButton
						theme={theme}
						onClick={onSetUpNewAgent}
						icon={<Plus />}
						disabled={disabled}
						testId="launch-setup-new-agent"
					>
						Set up new agent...
					</HeaderActionButton>
				</div>
			)}

			{summary && (
				<LaunchAgentCard
					theme={theme}
					summary={summary}
					testId="launch-agent-card"
					action={
						runOn === 'new' ? (
							<HeaderActionButton
								theme={theme}
								variant="ghost"
								onClick={onSetUpNewAgent}
								icon={<Pencil />}
								disabled={disabled}
								testId="launch-edit-new-agent"
							>
								Edit
							</HeaderActionButton>
						) : undefined
					}
				/>
			)}
		</section>
	);
}
