/**
 * AgentTokenProxyModeControl - Edit Agent's Maestro token proxy mode, on the
 * Models tab beside the gateway URL.
 *
 * Unlike the rest of the dialog it applies at once, like the chain of thought
 * export: choosing a mode IS choosing the agent's gateway, and the write goes
 * through `setAgentTokenProxyMode` (the same one the Local Models gateway table
 * uses), which picks the proxy route and flushes to main. The dialog's gateway
 * draft follows the result, so Save writes the same URL back and the mode is
 * kept.
 *
 * The mode shown is read against the DRAFT: a URL typed over the proxy's reads
 * Off, which is what Save would make it. The proxy's port is read only while
 * this is mounted, that is, while the Models tab is open.
 *
 * Under the mode it draws the Background requests picker, for a Claude Code
 * agent whose mode is not Off: the proxy is what routes those requests, so the
 * picker means nothing anywhere else. It applies at once too, through
 * `setAgentBackgroundRequests`, and it leaves with the proxy.
 */

import { useCallback, useState } from 'react';
import {
	backgroundRequestsSupport,
	parseBackgroundRequests,
	type BackgroundRequests,
} from '../../../shared/local-models/background-requests';
import {
	resolveTokenProxyMode,
	TOKEN_PROXY_NAME,
	type TokenProxyMode,
} from '../../../shared/local-models/token-proxy';
import { useTokenProxyModeChoice } from '../../hooks/localModels/useTokenProxyModeChoice';
import { useTokenProxyReport } from '../../hooks/localModels/useTokenProxyReport';
import { setAgentBackgroundRequests } from '../../services/agentGateway';
import type { Session, Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { BackgroundRequestsField } from '../shared/BackgroundRequestsField';
import { TokenProxyModeField, tokenProxyModeBlocker } from '../shared/TokenProxyModeField';

export interface AgentTokenProxyModeControlProps {
	theme: Theme;
	agentId: string;
	agentName: string;
	toolType: string;
	/** The dialog's gateway URL draft. */
	gatewayUrl: string;
	/** The mode stored on the agent now. */
	storedMode: Session['tokenProxyMode'];
	/** The background requests target stored on the agent now, as stored. */
	storedBackgroundRequests?: unknown;
	/** Name of the SSH remote the form has chosen, when it has chosen one. */
	sshRemoteName?: string;
	/** Why the choice must wait, e.g. an unsaved provider change. */
	pendingReason?: string;
	/** The agent's gateway after a mode was stored. */
	onGatewayUrlChange: (gatewayUrl: string) => void;
}

export function AgentTokenProxyModeControl({
	theme,
	agentId,
	agentName,
	toolType,
	gatewayUrl,
	storedMode,
	storedBackgroundRequests,
	sshRemoteName,
	pendingReason,
	onGatewayUrlChange,
}: AgentTokenProxyModeControlProps) {
	const proxy = useTokenProxyReport();
	const onChosen = useCallback(
		(_mode: TokenProxyMode, next: string | undefined) => onGatewayUrlChange(next ?? ''),
		[onGatewayUrlChange]
	);
	const choice = useTokenProxyModeChoice(agentId, { onChosen, onSettled: proxy.refresh });
	const mode = resolveTokenProxyMode({
		gatewayUrl,
		storedMode,
		port: proxy.report?.status.port ?? null,
	});

	// Shown for the provider the proxy can route for, and only while the agent
	// is on the proxy as the form stands.
	const offersBackgroundRequests = backgroundRequestsSupport(toolType).supported && mode !== 'off';

	return (
		<div className="space-y-5" data-testid="edit-agent-proxy-mode-control">
			<div>
				<TokenProxyModeField
					theme={theme}
					label="Maestro Token Proxy"
					value={mode}
					onChange={choice.choose}
					disabledReason={tokenProxyModeBlocker(toolType, sshRemoteName) ?? pendingReason}
					busy={choice.busy || (proxy.loading && proxy.report === null)}
					error={choice.error}
					ariaLabel={`${TOKEN_PROXY_NAME} mode for ${agentName}`}
					testId="edit-agent-proxy-mode"
				/>
				<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
					Applies as soon as you choose. Passthrough and Compress set the gateway below to the
					proxy; Off clears it.
				</p>
			</div>
			{offersBackgroundRequests && (
				<AgentBackgroundRequestsControl
					theme={theme}
					agentId={agentId}
					stored={storedBackgroundRequests}
					pendingReason={pendingReason}
				/>
			)}
		</div>
	);
}

interface AgentBackgroundRequestsControlProps {
	theme: Theme;
	agentId: string;
	/** The agent's stored `backgroundRequests`, read as data. */
	stored: unknown;
	pendingReason?: string;
}

/**
 * The Background requests picker of a live agent. A choice is written at once;
 * the value shown is the agent's stored one, which the write updates.
 */
function AgentBackgroundRequestsControl({
	theme,
	agentId,
	stored,
	pendingReason,
}: AgentBackgroundRequestsControlProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const parsed = parseBackgroundRequests(stored);

	const choose = useCallback(
		(next: BackgroundRequests | undefined) => {
			setBusy(true);
			setError(undefined);
			void setAgentBackgroundRequests(agentId, next)
				.then((result) => {
					if (!result.ok) setError(result.error);
				})
				.catch((err: unknown) => setError(ipcErrorMessage(err)))
				.finally(() => setBusy(false));
		},
		[agentId]
	);

	return (
		<div data-testid="edit-agent-background-requests-control">
			<BackgroundRequestsField
				theme={theme}
				value={parsed.ok ? parsed.backgroundRequests : undefined}
				onChange={choose}
				disabledReason={pendingReason}
				busy={busy}
				error={
					error ??
					(parsed.ok
						? undefined
						: `The stored Background requests target cannot be used: ${parsed.error} Every background request fails until a choice is made here.`)
				}
				testId="edit-agent-background-requests"
			/>
			<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
				Applies as soon as you choose, and is turned off with the proxy.
			</p>
		</div>
	);
}
