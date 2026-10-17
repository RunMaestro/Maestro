/**
 * AgentProviderSelect - the provider `<select>` of a form that holds ONE set of
 * provider settings: Edit Agent, and Group Settings. (New Agent keeps a set per
 * provider and picks with `<AgentPickerGrid>` instead.)
 *
 * It lists every provider a user can pick, installed here or not: an agent can
 * run on an SSH remote that has a provider this machine lacks.
 */

import type { ReactNode } from 'react';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import type { Theme } from '../../types';
import { SUPPORTED_AGENTS } from '../NewInstanceModal/types';
import { FormFieldLabel } from '../ui/FormFieldLabel';

export interface AgentProviderSelectProps {
	theme: Theme;
	/** The chosen provider id, or `''` when `noneLabel` is chosen. */
	value: string;
	onChange: (providerId: string) => void;
	/**
	 * Label of a first option that names no provider. Omit for a form whose
	 * agent must have one.
	 */
	noneLabel?: string;
	/** Drawn under the select: what the form says about the choice. */
	children?: ReactNode;
	testId?: string;
	disabled?: boolean;
	optionLabel?: (providerId: string) => ReactNode;
}

export function AgentProviderSelect({
	theme,
	value,
	onChange,
	noneLabel,
	children,
	testId,
	disabled,
	optionLabel,
}: AgentProviderSelectProps) {
	return (
		<div>
			<FormFieldLabel theme={theme}>Agent Provider</FormFieldLabel>
			<select
				disabled={disabled}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				aria-label="Agent Provider"
				className="w-full p-2 rounded border bg-transparent outline-none text-sm"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					backgroundColor: theme.colors.bgMain,
				}}
				data-testid={testId}
			>
				{noneLabel !== undefined && <option value="">{noneLabel}</option>}
				{SUPPORTED_AGENTS.map((agentId) => (
					<option key={agentId} value={agentId}>
						{optionLabel ? optionLabel(agentId) : getAgentDisplayName(agentId)}
					</option>
				))}
			</select>
			{children}
		</div>
	);
}
