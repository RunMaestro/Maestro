import { useEffect, useRef } from 'react';
import { useClaudeUsageStore } from '../../../../stores/claudeUsageStore';
import { useCodexUsageStore } from '../../../../stores/codexUsageStore';
import {
	hasUsefulAnthropicQuotaDetails,
	hasUsefulCodexQuotaDetails,
} from '../../../../../shared/usageQuota';

/**
 * Samples plan quota for the providers that HAVE a native quota contract
 * (Anthropic and OpenAI/Codex) once per open, so their tabs can appear.
 *
 * Every other provider, Grok included, has no qualified quota API, so nothing
 * is sampled for it and no quota tab exists for it. That absence means
 * "quota unavailable", never a zero balance, an unlimited budget or a reset
 * time; its known usage and spend stay on the token/cost views. Adding a
 * provider here needs a qualified backend adapter first, not a guessed call.
 */
export function useQuotaTabDiscovery(isOpen: boolean, usageStatsTabEnabled: boolean): void {
	const quotaSampledForOpenRef = useRef(false);

	useEffect(() => {
		if (!isOpen) {
			quotaSampledForOpenRef.current = false;
			return;
		}
		if (!usageStatsTabEnabled) return;
		if (quotaSampledForOpenRef.current) return;
		quotaSampledForOpenRef.current = true;

		void (async () => {
			await Promise.all([
				useClaudeUsageStore.getState().refresh(),
				useCodexUsageStore.getState().refresh(),
			]);

			const claudeHasData = Object.values(useClaudeUsageStore.getState().snapshots).some(
				hasUsefulAnthropicQuotaDetails
			);
			const codexHasData = Object.values(useCodexUsageStore.getState().snapshots).some(
				hasUsefulCodexQuotaDetails
			);

			const jobs: Promise<unknown>[] = [];
			if (!claudeHasData) {
				// The store owns the sample, so the panel's Refresh button shows it
				// in flight and a click while it runs joins it instead of stacking.
				jobs.push(useClaudeUsageStore.getState().sample());
			}
			if (!codexHasData) {
				jobs.push(useCodexUsageStore.getState().sample());
			}
			await Promise.all(jobs);
		})();
	}, [isOpen, usageStatsTabEnabled]);
}
