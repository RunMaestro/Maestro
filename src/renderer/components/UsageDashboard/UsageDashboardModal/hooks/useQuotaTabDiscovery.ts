import { useEffect, useRef } from 'react';
import { useClaudeUsageStore } from '../../../../stores/claudeUsageStore';
import { useCodexUsageStore } from '../../../../stores/codexUsageStore';
import {
	hasUsefulAnthropicQuotaDetails,
	hasUsefulCodexQuotaDetails,
} from '../../../../../shared/usageQuota';

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
