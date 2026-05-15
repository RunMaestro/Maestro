import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../../../utils/logger';

const MESSAGE_AUTO_CLEAR_MS = 5_000;

export interface PrStatusCheckResult {
	merged?: number;
	closed?: number;
	checked?: number;
}

export interface PrStatusSyncResult {
	message?: string;
}

export interface UsePrStatusSyncDeps {
	checkPRStatuses: () => Promise<PrStatusCheckResult>;
	syncContribution: (contributionId: string) => Promise<PrStatusSyncResult>;
}

export interface UsePrStatusSyncResult {
	isCheckingPRStatuses: boolean;
	prStatusMessage: string | null;
	/** ID of the contribution currently syncing, or null. */
	syncingContributionId: string | null;
	checkPRStatuses: () => Promise<void>;
	syncContribution: (contributionId: string) => Promise<void>;
}

/**
 * Coordinates the "Check PR Status" button (batch check) and the per-card
 * sync action (individual contribution).
 *
 * The 5-second auto-clear timer is shared: any new message resets the clock
 * so two rapid calls don't show stale UI. The hook owns the timer ref and
 * clears it on unmount.
 */
export function usePrStatusSync({
	checkPRStatuses,
	syncContribution,
}: UsePrStatusSyncDeps): UsePrStatusSyncResult {
	const [isCheckingPRStatuses, setIsCheckingPRStatuses] = useState(false);
	const [prStatusMessage, setPrStatusMessage] = useState<string | null>(null);
	const [syncingContributionId, setSyncingContributionId] = useState<string | null>(null);
	const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const scheduleClear = useCallback((message: string) => {
		setPrStatusMessage(message);
		if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
		clearTimerRef.current = setTimeout(() => {
			setPrStatusMessage(null);
			clearTimerRef.current = null;
		}, MESSAGE_AUTO_CLEAR_MS);
	}, []);

	useEffect(() => {
		return () => {
			if (clearTimerRef.current) {
				clearTimeout(clearTimerRef.current);
				clearTimerRef.current = null;
			}
		};
	}, []);

	const doCheckPRStatuses = useCallback(async () => {
		setIsCheckingPRStatuses(true);
		setPrStatusMessage(null);
		try {
			const result = await checkPRStatuses();
			const messages: string[] = [];
			if ((result.merged ?? 0) > 0) {
				messages.push(`${result.merged} PR${(result.merged ?? 0) > 1 ? 's' : ''} merged`);
			}
			if ((result.closed ?? 0) > 0) {
				messages.push(`${result.closed} PR${(result.closed ?? 0) > 1 ? 's' : ''} closed`);
			}
			if (messages.length > 0) {
				scheduleClear(messages.join(', '));
			} else if ((result.checked ?? 0) > 0) {
				scheduleClear('All PRs up to date');
			} else {
				scheduleClear('No PRs to check');
			}
		} catch (err) {
			logger.error('Failed to check PR statuses:', undefined, err);
			scheduleClear('Failed to check statuses');
		} finally {
			setIsCheckingPRStatuses(false);
		}
	}, [checkPRStatuses, scheduleClear]);

	const doSyncContribution = useCallback(
		async (contributionId: string) => {
			setSyncingContributionId(contributionId);
			try {
				const result = await syncContribution(contributionId);
				if (result.message) {
					scheduleClear(result.message);
				}
			} catch (err) {
				logger.error('Failed to sync contribution:', undefined, err);
				scheduleClear('Sync failed');
			} finally {
				setSyncingContributionId((current) => (current === contributionId ? null : current));
			}
		},
		[syncContribution, scheduleClear]
	);

	return {
		isCheckingPRStatuses,
		prStatusMessage,
		syncingContributionId,
		checkPRStatuses: doCheckPRStatuses,
		syncContribution: doSyncContribution,
	};
}
