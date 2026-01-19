import { useEffect } from 'react';
import { Session } from '../../types';

/**
 * Dependencies for the useCliActivityMonitoring hook.
 */
export interface UseCliActivityMonitoringDeps {
	/** Function to update sessions state */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
}

/**
 * Return type for useCliActivityMonitoring hook.
 * Currently empty as all functionality is side effects.
 */
export interface UseCliActivityMonitoringReturn {
	// No return values - all functionality is via side effects
}

/**
 * Hook for monitoring CLI activity and updating session states.
 *
 * This hook listens for CLI activity changes (when CLI is running playbooks)
 * and updates session states to show busy when CLI is active. It:
 * - Checks CLI activity immediately on mount
 * - Listens for activity change events
 * - Marks sessions as busy when CLI is running a playbook on them
 * - Clears the busy state when CLI activity ends (unless process is still running)
 *
 * @param deps - Hook dependencies
 * @returns Empty object (all functionality via side effects)
 */
export function useCliActivityMonitoring(
	deps: UseCliActivityMonitoringDeps
): UseCliActivityMonitoringReturn {
	const { setSessions } = deps;

	// Listen for CLI activity changes (when CLI is running playbooks)
	// Update session states to show busy when CLI is active
	useEffect(() => {
		const checkCliActivity = async () => {
			try {
				const activities = await window.maestro.cli.getActivity();
				setSessions((prev) =>
					prev.map((session) => {
						const cliActivity = activities.find((a) => a.sessionId === session.id);
						if (cliActivity) {
							// CLI is running a playbook on this session - mark as busy
							// Only update if not already busy (to preserve aiPid-based busy state)
							if (session.state !== 'busy') {
								return {
									...session,
									state: 'busy' as const,
									cliActivity: {
										playbookId: cliActivity.playbookId,
										playbookName: cliActivity.playbookName,
										startedAt: cliActivity.startedAt,
									},
								};
							}
						} else if (session.cliActivity) {
							// CLI activity ended - set back to idle (unless process is still running)
							if (!session.aiPid) {
								return {
									...session,
									state: 'idle' as const,
									cliActivity: undefined,
								};
							}
						}
						return session;
					})
				);
			} catch (error) {
				console.error('[CLI Activity] Error checking activity:', error);
			}
		};

		// Check immediately on mount
		checkCliActivity();

		// Listen for changes
		const unsubscribe = window.maestro.cli.onActivityChange(() => {
			checkCliActivity();
		});
		return unsubscribe;
	}, [setSessions]);

	return {};
}
