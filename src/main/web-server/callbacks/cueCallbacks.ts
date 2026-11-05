import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { toCueActivityEntries } from '../../cue/cue-activity-entries';
import { toCueSubscriptionInfos } from '../../cue/cue-subscription-entries';

export function registerCueCallbacks(
	server: WebServer,
	deps: Pick<
		WebServerFactoryDependencies,
		'getCueGraphData' | 'setCueSubscriptionEnabled' | 'getCueActivityLog' | 'triggerCueSubscription'
	>
): void {
	// Get Cue subscriptions - calls engine directly in the main process.
	// Previous implementation forwarded `remote:getCueSubscriptions` to
	// the renderer and waited 30 s for a response, but no renderer code
	// ever registered a handler for that channel. The CLI's 10 s timeout
	// fired every time, surfacing as `cue list` hanging with
	// `Command timed out waiting for cue_subscriptions`. Mirrors the same
	// pattern as `triggerCueSubscription` below - the engine lives in
	// main process anyway, so the IPC bounce was never needed.
	server.setGetCueSubscriptionsCallback(async (sessionId?: string) => {
		if (!deps.getCueGraphData) {
			logger.warn('getCueGraphData dependency not available', 'WebServer');
			return [];
		}
		// The mapping (ids, schedules, which agent a row is listed under) lives
		// in `toCueSubscriptionInfos`, which the headless host and the CLI's
		// cue.yaml read share.
		return toCueSubscriptionInfos(deps.getCueGraphData(), sessionId);
	});

	// Toggle Cue subscription - calls engine directly in the main process.
	// Previous implementation forwarded `remote:toggleCueSubscription` to
	// the renderer and waited 10 s for a response, but no renderer code
	// ever registered a handler for that channel. Every web-UI toggle
	// silently became a no-op after a 10 s stall. Same dead-bridge fix as
	// `setGetCueSubscriptionsCallback` and `setTriggerCueSubscriptionCallback`.
	server.setToggleCueSubscriptionCallback(async (subscriptionId: string, enabled: boolean) => {
		if (!deps.setCueSubscriptionEnabled) {
			logger.warn('setCueSubscriptionEnabled dependency not available', 'WebServer');
			return false;
		}
		return deps.setCueSubscriptionEnabled(subscriptionId, enabled);
	});

	// Get Cue activity log - calls engine directly in the main process.
	// Previously forwarded to the renderer with no listener registered -
	// the 30 s timeout fired every time and the web UI's activity tab
	// always rendered empty. The mapping, agent filter and limit live in
	// `toCueActivityEntries`, which the CLI's headless `cue.db` read shares.
	server.setGetCueActivityCallback(async (sessionId?: string, limit?: number) => {
		if (!deps.getCueActivityLog) {
			logger.warn('getCueActivityLog dependency not available', 'WebServer');
			return [];
		}
		return toCueActivityEntries(deps.getCueActivityLog(), { sessionId, limit });
	});

	// Trigger a Cue subscription by name - calls engine directly in the main process.
	// Previous implementation routed through the renderer via IPC round-trip, which
	// caused sourceAgentId to be dropped during Electron IPC serialization.
	server.setTriggerCueSubscriptionCallback(
		async (subscriptionName: string, prompt?: string, sourceAgentId?: string) => {
			if (!deps.triggerCueSubscription) {
				logger.warn('triggerCueSubscription dependency not available', 'WebServer');
				return false;
			}
			return deps.triggerCueSubscription(subscriptionName, prompt, sourceAgentId);
		}
	);
}
