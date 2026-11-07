/**
 * TokenProxyModeField - the one control for how the Maestro token proxy
 * carries an agent's requests: Off, Passthrough or Compress.
 *
 * Shared by the Local Models gateway table and Edit Agent's Models tab, so
 * both offer the same modes, say the same thing about the chosen one, and
 * refuse the same agents before the click. The choice itself is made by
 * `useTokenProxyModeChoice`, which writes through `setAgentTokenProxyMode`:
 * choosing a mode IS choosing the agent's gateway, and it applies at once.
 *
 * Controlled, and it stores nothing.
 */

import { agentGatewaySupport } from '../../../shared/local-models/gateway';
import {
	asTokenProxyMode,
	TOKEN_PROXY_MODE_DESCRIPTIONS,
	TOKEN_PROXY_MODE_LABELS,
	TOKEN_PROXY_MODES,
	TOKEN_PROXY_NAME,
	type TokenProxyMode,
} from '../../../shared/local-models/token-proxy';
import type { Theme } from '../../types';

/**
 * Why an agent cannot use the Maestro proxy, or undefined when it can. The
 * same two refusals `setAgentTokenProxyMode` makes, said before the click.
 */
export function tokenProxyModeBlocker(
	toolType: string,
	sshRemoteName: string | undefined
): string | undefined {
	const support = agentGatewaySupport(toolType);
	if (!support.supported) return support.reason;
	if (sshRemoteName) {
		return `The ${TOKEN_PROXY_NAME} listens on this machine, which SSH remote "${sshRemoteName}" cannot reach.`;
	}
	return undefined;
}

export interface TokenProxyModeFieldProps {
	theme: Theme;
	value: TokenProxyMode;
	onChange: (mode: TokenProxyMode) => void;
	/** Why the agent cannot use the proxy; disables the control. */
	disabledReason?: string;
	/** A choice is being written. */
	busy?: boolean;
	/** Why the last choice failed. */
	error?: string;
	/** Omit for a table cell whose column header already names the field. */
	label?: string;
	ariaLabel: string;
	/** Test id of the select; the note and error take `-note` and `-error`. */
	testId: string;
	/** Table cell sizing. */
	compact?: boolean;
}

export function TokenProxyModeField({
	theme,
	value,
	onChange,
	disabledReason,
	busy = false,
	error,
	label,
	ariaLabel,
	testId,
	compact = false,
}: TokenProxyModeFieldProps) {
	return (
		<div>
			{label && (
				<div
					className="block text-xs font-bold opacity-70 uppercase mb-2"
					style={{ color: theme.colors.textMain }}
				>
					{label}
				</div>
			)}
			<select
				value={value}
				onChange={(e) => {
					const mode = asTokenProxyMode(e.target.value);
					if (mode) onChange(mode);
				}}
				disabled={disabledReason !== undefined || busy}
				title={disabledReason}
				aria-label={ariaLabel}
				className={`rounded border bg-transparent outline-none disabled:opacity-40 ${
					compact ? 'p-1.5 text-xs' : 'w-full p-2 text-sm'
				}`}
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					...(compact ? {} : { backgroundColor: theme.colors.bgMain }),
				}}
				data-testid={testId}
			>
				{TOKEN_PROXY_MODES.map((mode) => (
					<option key={mode} value={mode}>
						{TOKEN_PROXY_MODE_LABELS[mode]}
					</option>
				))}
			</select>
			{value !== 'off' && (
				// What the chosen mode does and costs, where the choice is made: the
				// two compress modes differ in what the MODEL sees, which a one-word
				// label cannot carry.
				<p
					className={`mt-1 text-xs opacity-70 ${compact ? 'max-w-xs' : ''}`}
					data-testid={`${testId}-note`}
				>
					{TOKEN_PROXY_MODE_DESCRIPTIONS[value]}
				</p>
			)}
			{/* A table cell has the select's tooltip; a form shows the reason. */}
			{!compact && disabledReason && (
				<p
					className="mt-1 text-xs select-text"
					style={{ color: theme.colors.textDim }}
					data-testid={`${testId}-blocked`}
				>
					{disabledReason}
				</p>
			)}
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
