import { useState, useEffect, useMemo, useRef } from 'react';
import { calculateContextDisplay } from '../../utils/contextUsage';
import { resolveConfiguredContextWindow } from '../../utils/contextWindowResolver';
import { getModelContextWindowOverride } from '../../../shared/agentConstants';
import type { Session, AITab } from '../../types';

/**
 * Loads and computes context window metrics for the active tab.
 *
 * Resolves the configured context window from session override or agent settings,
 * then calculates token usage and usage percentage.
 */
export function useContextWindow(activeSession: Session | null, activeTab: AITab | null) {
	const [configuredContextWindow, setConfiguredContextWindow] = useState(0);

	// Resolve the configured context window from session override or agent settings.
	useEffect(() => {
		let isActive = true;

		const loadContextWindow = async () => {
			if (!activeSession) {
				if (isActive) setConfiguredContextWindow(0);
				return;
			}

			const value = await resolveConfiguredContextWindow(activeSession);
			if (isActive) setConfiguredContextWindow(value);
		};

		loadContextWindow();
		return () => {
			isActive = false;
		};
	}, [activeSession?.toolType, activeSession?.customContextWindow]);

	const activeTabContextWindow = useMemo(() => {
		// Precedence (finding P1). Keep this list POSITIONALLY IDENTICAL to
		// useAgentUsageListener's, or the header gauge and the Context Timeline
		// disagree again (the bug PR #1221 fixed):
		//   1. `[1m]` model marker
		//   2. resolved reported window
		//   3. `customContextWindow` override
		//   4. async configured window
		//   5. raw reported window
		// A `[1m]` marker on the session's custom model is an explicit model choice
		// the user made per-session, so it stays at the top.
		const modelMarker = getModelContextWindowOverride(activeSession?.customModel) ?? 0;
		if (modelMarker > 0) return modelMarker;
		const reported = activeTab?.usageStats?.contextWindow ?? 0;
		// A genuinely provider-resolved window (flagged via `contextWindowResolved`,
		// set only where the value came from the provider's own payload) is runtime
		// truth, so it outranks the stored override below.
		if (activeTab?.usageStats?.contextWindowResolved && reported > 0) return reported;
		// `customContextWindow` is NOT reliably something the user chose: the agent
		// definition's `contextWindow` default is materialized into every new session
		// at creation time (see P1), which is how a fresh omp agent displayed 200k
		// instead of the provider's real 1M. Treat it as a fallback that applies
		// until the provider reports an authoritative window.
		const sessionOverride = activeSession?.customContextWindow ?? 0;
		if (sessionOverride > 0) return sessionOverride;
		return configuredContextWindow > 0 ? configuredContextWindow : reported;
	}, [
		configuredContextWindow,
		activeTab?.usageStats?.contextWindow,
		activeTab?.usageStats?.contextWindowResolved,
		activeSession?.customContextWindow,
		activeSession?.customModel,
	]);

	// Hold the last trustworthy result per tab so an untrustworthy frame
	// (overflow without fallback, missing window) preserves the prior good
	// values instead of displaying the capacity as if it were usage (#762).
	const lastGoodRef = useRef<{ tabId: string | null; tokens: number; percentage: number }>({
		tabId: null,
		tokens: 0,
		percentage: 0,
	});

	// Compute context tokens and percentage using the shared helper.
	// Handles accumulated multi-tool turns by falling back to session.contextUsage.
	const { tokens: activeTabContextTokens, percentage: activeTabContextUsage } = useMemo(() => {
		const currentTabId = activeTab?.id ?? null;
		// Reset last-good when switching tabs so a previous tab's reading doesn't
		// bleed into a fresh tab that hasn't reported usage yet.
		if (lastGoodRef.current.tabId !== currentTabId) {
			lastGoodRef.current = { tabId: currentTabId, tokens: 0, percentage: 0 };
		}

		if (!activeTab?.usageStats) {
			return { tokens: lastGoodRef.current.tokens, percentage: lastGoodRef.current.percentage };
		}

		const result = calculateContextDisplay(
			{
				inputTokens: activeTab.usageStats.inputTokens,
				outputTokens: activeTab.usageStats.outputTokens,
				cacheCreationInputTokens: activeTab.usageStats.cacheCreationInputTokens ?? 0,
				cacheReadInputTokens: activeTab.usageStats.cacheReadInputTokens ?? 0,
			},
			activeTabContextWindow,
			activeSession?.toolType,
			activeSession?.contextUsage
		);

		if (result.trustworthy) {
			lastGoodRef.current = {
				tabId: currentTabId,
				tokens: result.tokens,
				percentage: result.percentage,
			};
			return { tokens: result.tokens, percentage: result.percentage };
		}

		// Untrustworthy frame: keep last known good values.
		return { tokens: lastGoodRef.current.tokens, percentage: lastGoodRef.current.percentage };
	}, [
		activeTab?.id,
		activeTab?.usageStats,
		activeSession?.toolType,
		activeTabContextWindow,
		activeSession?.contextUsage,
	]);

	return {
		activeTabContextWindow,
		activeTabContextTokens,
		activeTabContextUsage,
	};
}
