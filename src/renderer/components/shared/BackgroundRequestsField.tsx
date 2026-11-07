/**
 * BackgroundRequestsField - the one control for where the Maestro token proxy
 * sends an agent's side requests: Off, or a model on a source that serves the
 * Anthropic Messages route.
 *
 * It lists the same sources the Run on picker lists, minus the ones a
 * background request cannot be sent to (`buildBackgroundRequestsOptionGroups`),
 * and says under the picker what is routed and what never is. The host decides
 * when the control is shown at all: it only means something for a Claude Code
 * agent on the proxy.
 *
 * Controlled, and it stores nothing. The host writes the choice through
 * `setAgentBackgroundRequests`, which applies at once.
 *
 * CLI: `maestro-cli update-agent <id> --background-requests <source id>:<model>|none`.
 */

import { useMemo } from 'react';

import {
	BACKGROUND_REQUESTS_DESCRIPTION,
	buildBackgroundRequestsOptionGroups,
	formatBackgroundRequestsSpec,
	parseBackgroundRequestsSpec,
	type BackgroundRequests,
} from '../../../shared/local-models/background-requests';
import { useRunOnSources } from '../../hooks/localModels';
import type { Theme } from '../../types';
import { AssignmentOptionElements } from '../Settings/tabs/LocalModelsTab/AssignmentOptionElements';
import { FormFieldLabel } from '../ui/FormFieldLabel';

export interface BackgroundRequestsFieldProps {
	theme: Theme;
	/** The stored setting, or undefined when every request goes to the provider. */
	value: BackgroundRequests | undefined;
	onChange: (next: BackgroundRequests | undefined) => void;
	/** Why the choice must wait; disables the control. */
	disabledReason?: string;
	/** A choice is being written. */
	busy?: boolean;
	/** Why the last choice failed, or why the stored value cannot be used. */
	error?: string;
	testId?: string;
}

export function BackgroundRequestsField({
	theme,
	value,
	onChange,
	disabledReason,
	busy = false,
	error,
	testId = 'background-requests-field',
}: BackgroundRequestsFieldProps) {
	const { sources, endpoints, loading, problems } = useRunOnSources();
	const groups = useMemo(
		() => buildBackgroundRequestsOptionGroups({ current: value, sources, endpoints }),
		[value, sources, endpoints]
	);
	const selectId = `${testId}-select`;

	return (
		<div className="w-full" data-testid={testId}>
			<FormFieldLabel theme={theme} htmlFor={selectId}>
				Background requests
			</FormFieldLabel>
			<select
				id={selectId}
				value={formatBackgroundRequestsSpec(value)}
				onChange={(e) => {
					const parsed = parseBackgroundRequestsSpec(e.target.value);
					if (parsed.ok) onChange(parsed.backgroundRequests);
				}}
				disabled={disabledReason !== undefined || busy}
				title={disabledReason}
				className="w-full p-2 text-sm rounded border bg-transparent outline-none disabled:opacity-40"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					backgroundColor: theme.colors.bgMain,
				}}
				data-testid={selectId}
			>
				<AssignmentOptionElements groups={groups} />
			</select>
			<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
				{BACKGROUND_REQUESTS_DESCRIPTION}
				{loading ? ' Listing models...' : ''}
			</p>
			{disabledReason && (
				<p
					className="mt-1 text-xs select-text"
					style={{ color: theme.colors.textDim }}
					data-testid={`${testId}-blocked`}
				>
					{disabledReason}
				</p>
			)}
			{problems.map((problem) => (
				<p
					key={problem.endpointId}
					className="mt-1 text-xs select-text"
					style={{ color: theme.colors.textDim }}
					data-testid={`${testId}-source-problem`}
				>
					{problem.name}: {problem.message}
				</p>
			))}
			{error && (
				<p
					className="mt-1 text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid={`${testId}-error`}
				>
					{error}
				</p>
			)}
		</div>
	);
}

export default BackgroundRequestsField;
