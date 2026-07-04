import { useEffect, useRef } from 'react';
import { useClaudeUsageStore } from '../../../../stores/claudeUsageStore';
import { useCodexUsageStore } from '../../../../stores/codexUsageStore';
import { logger } from '../../../../utils/logger';
import { hasUsefulAnthropicQuotaDetails, hasUsefulCodexQuotaDetails } from '../quotaDetails';

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
				jobs.push(
					window.maestro.agents
						.refreshClaudeUsageSnapshots()
						.then(() => useClaudeUsageStore.getState().refresh())
						.catch((err) => {
							logger.warn('Failed to sample Anthropic usage details:', undefined, err);
						})
				);
			}
			if (!codexHasData) {
				jobs.push(
					window.maestro.agents
						.refreshCodexUsageSnapshots()
						.then(() => useCodexUsageStore.getState().refresh())
						.catch((err) => {
							logger.warn('Failed to sample OpenAI usage details:', undefined, err);
						})
				);
			}
			await Promise.all(jobs);
		})();
	}, [isOpen, usageStatsTabEnabled]);
}
