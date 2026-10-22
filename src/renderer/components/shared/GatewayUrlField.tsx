/**
 * GatewayUrlField - the one control for an agent's Local Models gateway URL.
 *
 * Shared by the Edit Agent dialog and the Local Models gateway table, so both
 * say the same thing about the same value. It draws the field and, under it,
 * what the launch will do with what is typed, from the same
 * `resolveAgentGateway` the launch plan runs:
 *
 * - a provider with no base-URL variable shows the field DISABLED with the
 *   reason (Copilot CLI ignores base-URL variables);
 * - an agent that sets the variable itself is told the gateway is not applied;
 * - a loopback URL on an SSH-remote agent is flagged before the launch
 *   refuses it;
 * - an agent whose Run on target is a source shows the field DISABLED with the
 *   reason the host gives (`disabledReason`): the gateway is not applied.
 *
 * Controlled, and it stores nothing: the host decides when a value is saved
 * (`onCommit` fires on Enter and on blur).
 */

import { useMemo } from 'react';
import {
	agentGatewaySupport,
	resolveAgentGateway,
	type AgentGatewayResolution,
} from '../../../shared/local-models/gateway';
import type { Theme } from '../../types';
import { FormInput } from '../ui/FormInput';

export interface GatewayUrlFieldProps {
	theme: Theme;
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	value: string;
	onChange: (value: string) => void;
	/** Enter or blur: the host saves here when it saves per field. */
	onCommit?: () => void;
	/**
	 * The agent's effective custom vars (its own, or the provider-level set
	 * when it has none), so the field can say when one of them wins.
	 */
	userEnvVars?: Record<string, string>;
	/** Name of the SSH remote the agent runs on, when it runs on one. */
	sshRemoteName?: string;
	/** Omit for a table cell whose column header already names the field. */
	label?: string;
	/** A save error from the host, shown in place of the status line. */
	error?: string;
	/**
	 * Why the gateway does not apply to this agent at all (its Run on target is a
	 * source). Disables the field and takes the status line's place. The stored
	 * URL stays in the field: it applies again when the reason goes away.
	 */
	disabledReason?: string;
	testId?: string;
}

type StatusTone = 'dim' | 'warning' | 'error';

/** What the launch will do with this value, as one line for the user. */
export function describeGatewayStatus(
	resolution: AgentGatewayResolution
): { tone: StatusTone; text: string } | null {
	switch (resolution.kind) {
		case 'none':
			return null;
		case 'inject':
			return { tone: 'dim', text: `Sets ${resolution.envVar} when this agent starts.` };
		case 'user-override':
			return {
				tone: 'warning',
				text: `Not applied: ${resolution.envVar} is set in this agent's environment variables, and that value wins.`,
			};
		case 'refused':
			return {
				tone: resolution.code === 'gateway-loopback-on-remote' ? 'warning' : 'error',
				text: resolution.message,
			};
	}
}

export function GatewayUrlField({
	theme,
	toolType,
	value,
	onChange,
	onCommit,
	userEnvVars,
	sshRemoteName,
	label,
	error,
	disabledReason,
	testId = 'gateway-url-field',
}: GatewayUrlFieldProps) {
	const support = agentGatewaySupport(toolType);
	const status = useMemo(
		() =>
			describeGatewayStatus(
				resolveAgentGateway({
					toolType,
					gatewayUrl: value,
					userEnvVars,
					remote: sshRemoteName ? { name: sshRemoteName } : null,
				})
			),
		[toolType, value, userEnvVars, sshRemoteName]
	);

	// An unsupported provider shows its reason whether or not a value is stored,
	// because the reason is why the field cannot be used at all.
	const line = error
		? { tone: 'error' as const, text: error }
		: !support.supported
			? { tone: 'dim' as const, text: support.reason }
			: disabledReason
				? { tone: 'dim' as const, text: disabledReason }
				: status;
	const lineColor =
		line?.tone === 'error'
			? theme.colors.error
			: line?.tone === 'warning'
				? theme.colors.warning
				: theme.colors.textDim;

	return (
		<div className="w-full" data-testid={testId} onBlur={onCommit}>
			<FormInput
				theme={theme}
				label={label}
				value={value}
				onChange={onChange}
				onSubmit={onCommit}
				placeholder={support.supported ? 'http://127.0.0.1:8787' : 'Not available'}
				disabled={!support.supported || disabledReason !== undefined}
				monospace
				heightClass="!p-2"
				testId={`${testId}-input`}
			/>
			{line && (
				<p
					className="mt-1 text-xs select-text"
					style={{ color: lineColor }}
					data-testid={`${testId}-status`}
					data-tone={line.tone}
				>
					{line.text}
				</p>
			)}
		</div>
	);
}

export default GatewayUrlField;
