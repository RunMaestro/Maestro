/**
 * Deliver a Design Mode pick to the agent that owns the browser tab.
 *
 * A browser tab has no composer under it, so a pick goes where "Quote in
 * Message" from a file tab goes: the agent's active AI tab (the tiled group's
 * AI pane when a group is showing), through {@link insertIntoAgentComposer}.
 * The cropped screenshot is staged on that tab, the same `stagedImages` list a
 * pasted image uses, and the element block is appended to its draft.
 *
 * The click in the overlay and `maestro-cli browser-pick` both end here.
 */

import { insertIntoAgentComposer } from './quoteIntoComposer';
import { captureException } from '../utils/sentry';
import { buildDesignModePrompt, type DesignModeCapture } from '../utils/designModePicker';

export interface DesignPickDelivery extends DesignModeCapture {
	/** The agent that owns the browser tab. */
	sessionId: string;
	/** The browser tab the element came from (for its Coworking id). */
	browserTabId: string;
	note?: string;
	/** False stages the pick without switching the visible tab. Default true. */
	reveal?: boolean;
}

/** What {@link deliverDesignPick} put where, or null when it could not. */
export interface DesignPickDelivered {
	aiTabId: string;
	text: string;
}

/**
 * The tab's Coworking id (`browser:2`), so the agent can read or screenshot
 * the same tab with its browser tools. Null when Coworking is off, the tab is
 * hidden from agents, or the bridge is missing (web build, tests).
 */
async function lookUpBrowserId(sessionId: string, browserTabId: string): Promise<string | null> {
	const getBrowserId = window.maestro?.coworking?.getBrowserId;
	if (!getBrowserId) return null;
	try {
		return await getBrowserId(sessionId, browserTabId);
	} catch (error) {
		// The id is a convenience; the pick is still worth delivering without it.
		captureException(error, { tags: { surface: 'browser-design-mode' } });
		return null;
	}
}

export async function deliverDesignPick(
	delivery: DesignPickDelivery
): Promise<DesignPickDelivered | null> {
	const browserId = await lookUpBrowserId(delivery.sessionId, delivery.browserTabId);
	const text = buildDesignModePrompt(delivery.pick, {
		hasScreenshot: !!delivery.screenshot,
		browserId,
		note: delivery.note,
	});
	const aiTabId = insertIntoAgentComposer(delivery.sessionId, text, {
		format: 'block',
		images: delivery.screenshot ? [delivery.screenshot] : undefined,
		reveal: delivery.reveal,
		missingTabMessage: 'This agent has no AI tab. Open one, then pick the element again.',
	});
	return aiTabId ? { aiTabId, text } : null;
}
