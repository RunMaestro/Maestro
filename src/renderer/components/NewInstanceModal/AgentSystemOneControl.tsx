/**
 * AgentSystemOneControl - Edit Agent's System One switch, on the Models tab.
 *
 * Off switches `maestro-cli s1` off for this one agent while it stays on for
 * the others: its requests are refused by name, and its system prompt leaves
 * System One out from its next start. On is the absence of that: the agent
 * follows "Let agents use System One" in Settings > Models > System One.
 *
 * Like the token proxy mode beside it, the switch applies at once, through
 * `setAgentSystemOneOptOut`, which flushes to main: the main process is what
 * answers a request and builds the prompt, so a value held only in this dialog
 * would do nothing.
 *
 * Under the switch is what a request from this agent would meet right now: the
 * engine that would answer, or the switch that refuses. It is read from main
 * and sends nothing to an engine. An agent on an SSH remote is said to be out
 * of reach instead: its shell is on another host, where `maestro-cli` cannot
 * reach this desktop, so its system prompt never carries System One.
 */

import { useCallback, useState } from 'react';
import { SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS } from '../../../shared/local-models/system-one-agent';
import { formatSystemOneCost } from '../../../shared/local-models/system-one-spend';
import { useSystemOneAgentAccess } from '../../hooks/localModels/useSystemOneAgentAccess';
import { setAgentSystemOneOptOut } from '../../services/agentSystemOne';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { FormFieldLabel } from '../ui/FormFieldLabel';
import { ToggleSwitch } from '../ui/ToggleSwitch';

export interface AgentSystemOneControlProps {
	theme: Theme;
	agentId: string;
	agentName: string;
	/** The agent's stored `systemOneOptOut`. */
	optedOut: boolean;
	/** Name of the SSH remote the form has chosen, when it has chosen one. */
	sshRemoteName?: string;
}

export function AgentSystemOneControl({
	theme,
	agentId,
	agentName,
	optedOut,
	sshRemoteName,
}: AgentSystemOneControlProps) {
	const { access, error: accessError, refresh } = useSystemOneAgentAccess(agentId);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const choose = useCallback(
		(allowed: boolean) => {
			setBusy(true);
			setError(undefined);
			void setAgentSystemOneOptOut(agentId, !allowed)
				.then((result) => {
					if (!result.ok) setError(result.error);
				})
				.catch((err: unknown) => setError(ipcErrorMessage(err)))
				// The opt-out is an agent setting: no System One settings event follows it.
				.finally(() => {
					setBusy(false);
					void refresh();
				});
		},
		[agentId, refresh]
	);

	// The agent's own switch is what the toggle shows; any other gate is said here.
	const elsewhere = sshRemoteName
		? `This agent runs on ${sshRemoteName}, where maestro-cli cannot reach this desktop, so it is not told about System One.`
		: access && access.gate !== 'agent-opted-out'
			? access.reason
			: null;
	const own = access?.budget.agent;

	return (
		<div data-testid="edit-agent-system-one">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<FormFieldLabel theme={theme}>System One</FormFieldLabel>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						{SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS[optedOut ? 'off' : 'on']} Applies as soon as you
						choose.
					</p>
				</div>
				<ToggleSwitch
					theme={theme}
					checked={!optedOut}
					onChange={choose}
					busy={busy}
					size="sm"
					ariaLabel={`Let ${agentName} use System One`}
				/>
			</div>
			{error && (
				<p
					className="mt-1 text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid="edit-agent-system-one-error"
				>
					{error}
				</p>
			)}
			{!optedOut && (access || sshRemoteName) && (
				<p
					className="mt-1 text-xs select-text"
					style={{ color: elsewhere ? theme.colors.warning : theme.colors.textDim }}
					data-testid="edit-agent-system-one-status"
				>
					{elsewhere ??
						(access
							? `Its requests are answered by ${access.engineLabel}${access.calibrated === false ? ', which is not calibrated' : ''}.${own ? ` It has spent ${formatSystemOneCost(own.spentTodayUsd)} today${own.budgetUsd === null ? '' : ` of its ${formatSystemOneCost(own.budgetUsd)}`}.` : ''}`
							: null)}
				</p>
			)}
			{!optedOut && !access && !sshRemoteName && accessError && (
				<p
					className="mt-1 text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid="edit-agent-system-one-status-error"
				>
					{accessError}
				</p>
			)}
		</div>
	);
}
