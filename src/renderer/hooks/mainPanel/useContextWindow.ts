import { useState, useEffect, useMemo, useRef } from 'react';
import { calculateContextDisplay, resolveGaugeTokenStats } from '../../utils/contextUsage';
import { resolveConfiguredContextWindow } from '../../utils/contextWindowResolver';
import { resolveContextWindow } from '../../utils/contextWindowPrecedence';
import { projectTabProvider, resolveTurnProvider } from '../../utils/providerTabSessions';
import type { Session, AITab } from '../../types';

/**
 * Loads and computes context window metrics for the active tab.
 *
 * Resolves the configured context window from session override or agent settings,
 * then calculates token usage and usage percentage.
 */
export function useContextWindow(activeSession: Session | null, activeTab: AITab | null) {
	const projected = useMemo(
		() => (activeSession ? projectTabProvider(activeSession, activeTab ?? undefined) : null),
		[activeSession, activeTab]
	);
	const provider = projected?.agent.toolType;
	const customModel = projected?.tab?.customModel ?? projected?.agent.customModel;
	const customContextWindow = projected?.agent.customContextWindow;
	const contextWindowSource = projected?.agent.contextWindowSource;
	const contextSource = useMemo(
		() => ({ toolType: provider, customModel, customContextWindow }),
		[provider, customModel, customContextWindow]
	);
	const [configured, setConfigured] = useState({ source: contextSource, window: 0 });
	// Never display another provider's fallback while its replacement is loading.
	const configuredContextWindow = configured.source === contextSource ? configured.window : 0;
	const contextIdentity = useMemo(
		() => [activeSession?.id, activeTab?.id, provider, projected?.tab?.agentSessionId],
		[activeSession?.id, activeTab?.id, provider, projected?.tab?.agentSessionId]
	);
	const fallbackUsage =
		activeSession &&
		provider === activeSession.toolType &&
		resolveTurnProvider(activeTab ?? undefined, activeSession) === provider
			? activeSession.contextUsage
			: undefined;

	// Resolve the configured context window from session override or agent settings.
	useEffect(() => {
		let isActive = true;

		const loadContextWindow = async () => {
			const value = await resolveConfiguredContextWindow(contextSource);
			if (isActive) setConfigured({ source: contextSource, window: value });
		};

		loadContextWindow();
		return () => {
			isActive = false;
		};
	}, [contextSource]);

	// Resolved window AND which rank supplied it. The source is what lets the
	// Edit Agent panel say "your stored value is being overridden" without
	// re-deriving the ranking (#1370) - a second copy could disagree with this
	// one, which is the bug PR #1221 fixed.
	const resolvedContextWindow = useMemo(
		() =>
			resolveContextWindow({
				customModel,
				customContextWindow,
				contextWindowSource,
				reportedWindow: activeTab?.usageStats?.contextWindow,
				reportedResolved: activeTab?.usageStats?.contextWindowResolved,
				configuredWindow: configuredContextWindow,
			}),
		[
			configuredContextWindow,
			activeTab?.usageStats?.contextWindow,
			activeTab?.usageStats?.contextWindowResolved,
			customContextWindow,
			contextWindowSource,
			customModel,
		]
	);
	const activeTabContextWindow = resolvedContextWindow.window;

	// Hold the last trustworthy result per provider/native session so an untrustworthy frame
	// (overflow without fallback, missing window) preserves the prior good
	// values instead of displaying the capacity as if it were usage (#762).
	const lastGoodRef = useRef<{ identity: object | null; tokens: number; percentage: number }>({
		identity: null,
		tokens: 0,
		percentage: 0,
	});

	// Compute context tokens and percentage using the shared helper.
	// Handles accumulated multi-tool turns by falling back to session.contextUsage.
	const { tokens: activeTabContextTokens, percentage: activeTabContextUsage } = useMemo(() => {
		const identity = contextIdentity;
		// Reset on tab, provider or native-session changes so old usage cannot
		// bleed into a conversation that has not reported usage yet.
		if (lastGoodRef.current.identity !== identity) {
			lastGoodRef.current = { identity, tokens: 0, percentage: 0 };
		}

		if (!activeTab?.usageStats) {
			return { tokens: lastGoodRef.current.tokens, percentage: lastGoodRef.current.percentage };
		}

		// Measure the occupancy snapshot when the provider attached one, not the
		// turn's summed token spend (#1782).
		const result = calculateContextDisplay(
			resolveGaugeTokenStats(activeTab.usageStats, provider),
			activeTabContextWindow,
			provider,
			fallbackUsage
		);

		if (result.trustworthy) {
			lastGoodRef.current = {
				identity,
				tokens: result.tokens,
				percentage: result.percentage,
			};
			return { tokens: result.tokens, percentage: result.percentage };
		}

		// Untrustworthy frame: keep last known good values.
		return { tokens: lastGoodRef.current.tokens, percentage: lastGoodRef.current.percentage };
	}, [contextIdentity, activeTab?.usageStats, provider, activeTabContextWindow, fallbackUsage]);

	return {
		activeTabContextWindow,
		activeTabContextTokens,
		activeTabContextUsage,
		/** Which rank supplied `activeTabContextWindow` (see contextWindowPrecedence). */
		activeTabContextWindowSource: resolvedContextWindow.source,
	};
}
