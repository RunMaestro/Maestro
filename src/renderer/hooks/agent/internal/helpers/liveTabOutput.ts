import {
	useSessionStore,
	selectSessionById,
	updateSessionWith,
} from '../../../../stores/sessionStore';
import { markTabBusyFromOutput } from '../../../../utils/tabHelpers';

/**
 * Model output arrived for a tab: make sure this client shows it running (see
 * `markTabBusyFromOutput`). Shared by the thinking and tool-execution
 * listeners, which fire at streaming rate, so it reads the store first and
 * writes only when the tab is NOT already busy - the store helpers always
 * produce a new sessions array, and one per chunk would re-render the app.
 */
export function noteLiveTabOutput(sessionId: string, tabId: string): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const tab = session?.aiTabs.find((t) => t.id === tabId);
	if (!tab || tab.state === 'busy') return;
	updateSessionWith(sessionId, (s) => markTabBusyFromOutput(s, tabId));
}
