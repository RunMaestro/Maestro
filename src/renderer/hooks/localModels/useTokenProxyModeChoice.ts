/**
 * useTokenProxyModeChoice - make one agent's Maestro token proxy choice from a
 * surface, with the busy flag and the refusal the surface shows.
 *
 * The write is `setAgentTokenProxyMode`, which points the agent's gateway at
 * the proxy (or clears it) and flushes to main, so it applies at once. Shared
 * by the Local Models gateway table and Edit Agent's Models tab.
 */

import { useCallback, useState } from 'react';

import type { TokenProxyMode } from '../../../shared/local-models/token-proxy';
import { setAgentTokenProxyMode } from '../../services/agentGateway';

export interface UseTokenProxyModeChoiceOptions {
	/** The mode was stored; `gatewayUrl` is the agent's gateway now. */
	onChosen?: (mode: TokenProxyMode, gatewayUrl: string | undefined) => void;
	/** The write finished, either way: the proxy's picture may have changed. */
	onSettled?: () => void;
}

export interface TokenProxyModeChoiceState {
	choose: (mode: TokenProxyMode) => void;
	busy: boolean;
	/** Why the last choice was refused, or undefined. */
	error: string | undefined;
}

export function useTokenProxyModeChoice(
	agentId: string,
	{ onChosen, onSettled }: UseTokenProxyModeChoiceOptions = {}
): TokenProxyModeChoiceState {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const choose = useCallback(
		(mode: TokenProxyMode) => {
			setBusy(true);
			setError(undefined);
			void setAgentTokenProxyMode(agentId, mode)
				.then((result) => {
					if (!result.ok) {
						setError(result.error);
						return;
					}
					onChosen?.(result.mode, result.gatewayUrl);
				})
				.catch((err: unknown) => {
					setError(err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					setBusy(false);
					onSettled?.();
				});
		},
		[agentId, onChosen, onSettled]
	);

	return { choose, busy, error };
}
