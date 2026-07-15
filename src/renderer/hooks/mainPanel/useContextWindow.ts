import { useState, useEffect, useMemo, useRef } from 'react';
import { calculateContextDisplay } from '../../utils/contextUsage';
import { resolveConfiguredContextWindow } from '../../utils/contextWindowResolver';
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
		// Explicit per-session override always wins.
		const sessionOverride = activeSession?.customContextWindow ?? 0;
		if (sessionOverride > 0) return sessionOverride;
		const reported = activeTab?.usageStats?.contextWindow ?? 0;
		// A genuinely provider/model-resolved window (omp's per-turn model catalog,
		// flagged via `contextWindowResolved`) is the ACTUAL window, so it beats the
		// agent-level configured fallback (e.g. opus's 1M vs the 200k default).
		if (activeTab?.usageStats?.contextWindowResolved && reported > 0) return reported;
		return configuredContextWindow > 0 ? configuredContextWindow : reported;
	}, [
		configuredContextWindow,
		activeTab?.usageStats?.contextWindow,
		activeTab?.usageStats?.contextWindowResolved,
		activeSession?.customContextWindow,
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
