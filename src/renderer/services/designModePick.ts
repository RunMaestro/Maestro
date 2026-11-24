/**
 * Deliver a Design Mode pick to the agent that owns the browser tab.
 *
 * A browser tab has no composer under it, so a pick goes where "Quote in
 * Message" from a file tab goes: the agent's active AI tab (the tiled group's
 * AI pane when a group is showing). It lands there as a chip, through
 * {@link stageDesignPickOnAgent}: a short label, the cropped screenshot, and
 * the user's note, with the full element block kept on the chip until the
 * message is sent. The chip owns the screenshot; it never goes into the tab's
 * `stagedImages`.
 *
 * The click in the overlay and `maestro-cli browser-pick` both end here.
 */

import { stageDesignPickOnAgent } from './quoteIntoComposer';
import { captureException } from '../utils/sentry';
import { generateId } from '../utils/ids';
import {
	buildDesignModePrompt,
	designPickBlock,
	designPickLabel,
	type DesignModeCapture,
} from '../utils/designModePicker';
import type { StagedDesignPick } from '../types';

export interface DesignPickDelivery extends DesignModeCapture {
	/** The agent that owns the browser tab. */
	sessionId: string;
	/** The browser tab the element came from (for its Coworking id). */
	browserTabId: string;
	note?: string;
	/** False stages the pick without switching the visible tab. Default true. */
	reveal?: boolean;
}

/** What {@link deliverDesignPick} staged where, or null when it could not. */
export interface DesignPickDelivered {
	aiTabId: string;
	/** The block the chip adds to the message at send, note included. */
	text: string;
	/** The staged chip's id. */
	pickId: string;
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

/**
 * The chip for one pick. Its `text` is the element block without the note:
 * the note stays editable on the chip and {@link designPickBlock} adds it at
 * send.
 */
async function buildDesignPickChip(delivery: DesignPickDelivery): Promise<StagedDesignPick> {
	const browserId = await lookUpBrowserId(delivery.sessionId, delivery.browserTabId);
	return {
		id: generateId(),
		kind: 'element',
		label: designPickLabel(delivery.pick),
		url: delivery.pick.url,
		note: delivery.note?.trim() ?? '',
		text: buildDesignModePrompt(delivery.pick, {
			hasScreenshot: !!delivery.screenshot,
			browserId,
		}),
		screenshot: delivery.screenshot,
		createdAt: Date.now(),
	};
}

export async function deliverDesignPick(
	delivery: DesignPickDelivery
): Promise<DesignPickDelivered | null> {
	const chip = await buildDesignPickChip(delivery);
	const aiTabId = stageDesignPickOnAgent(delivery.sessionId, chip, {
		reveal: delivery.reveal,
		missingTabMessage: 'This agent has no AI tab. Open one, then pick the element again.',
	});
	return aiTabId ? { aiTabId, text: designPickBlock(chip), pickId: chip.id } : null;
}
