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
 *
 * Once staged, a chip is edited and removed by id on its tab through
 * {@link setStagedDesignPickNote} and {@link removeStagedDesignPick}: the
 * chip strip in the composer uses them, so any other caller reaches the same
 * code. A send reads the chips with {@link getStagedDesignPicks}, expands them
 * into the message, and takes them off with {@link removeStagedDesignPicks}.
 * `maestro-cli browser-picks` reads and removes them through
 * {@link runRemoteDesignPickCommand}.
 */

import { resolveComposerTarget, stageDesignPickOnAgent } from './quoteIntoComposer';
import { selectSessionById, updateAiTab, useSessionStore } from '../stores/sessionStore';
import { captureException } from '../utils/sentry';
import { generateId } from '../utils/ids';
import {
	buildDesignModePrompt,
	designPickBlock,
	designPickLabel,
	type DesignModeCapture,
} from '../utils/designModePicker';
import type { StagedDesignPick } from '../types';
import type {
	DesignPickCommandRequest,
	DesignPickCommandResult,
	DesignPickSummary,
} from '../../shared/designPickCommands';

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

/**
 * The chips staged on `sessionId`'s AI tab `tabId`, in order, from the live
 * store rather than a render-time snapshot. Empty when there are none or the
 * tab is gone.
 */
export function getStagedDesignPicks(sessionId: string, tabId: string): StagedDesignPick[] {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	return session?.aiTabs.find((t) => t.id === tabId)?.stagedDesignPicks ?? [];
}

/** The chip `pickId` on `sessionId`'s AI tab `tabId`, from the live store. */
function findStagedDesignPick(
	sessionId: string,
	tabId: string,
	pickId: string
): StagedDesignPick | undefined {
	return getStagedDesignPicks(sessionId, tabId).find((p) => p.id === pickId);
}

/**
 * Replace the note on one staged chip, trimmed the way a delivered note is.
 * Writes nothing when the note is unchanged. Returns false when the chip is
 * not on that tab (it was sent or removed meanwhile).
 */
export function setStagedDesignPickNote(
	sessionId: string,
	tabId: string,
	pickId: string,
	note: string
): boolean {
	const pick = findStagedDesignPick(sessionId, tabId, pickId);
	if (!pick) return false;
	const trimmed = note.trim();
	if (trimmed === pick.note) return true;
	updateAiTab(sessionId, tabId, (tab) => ({
		...tab,
		stagedDesignPicks: (tab.stagedDesignPicks ?? []).map((p) =>
			p.id === pickId ? { ...p, note: trimmed } : p
		),
	}));
	return true;
}

/**
 * Take staged chips off their tab by id, screenshots and all: the chips a
 * sent message expanded, or one the user removed. Chips with other ids stay,
 * so one staged after a send read its chips is left for the next message.
 * Returns how many were taken; 0 writes nothing.
 */
export function removeStagedDesignPicks(
	sessionId: string,
	tabId: string,
	pickIds: readonly string[]
): number {
	const ids = new Set(pickIds);
	const taken = getStagedDesignPicks(sessionId, tabId).filter((p) => ids.has(p.id)).length;
	if (taken === 0) return 0;
	updateAiTab(sessionId, tabId, (tab) => ({
		...tab,
		stagedDesignPicks: (tab.stagedDesignPicks ?? []).filter((p) => !ids.has(p.id)),
	}));
	return taken;
}

/**
 * Take one staged chip off its tab, screenshot and all. Returns false when the
 * chip is not on that tab.
 */
export function removeStagedDesignPick(sessionId: string, tabId: string, pickId: string): boolean {
	return removeStagedDesignPicks(sessionId, tabId, [pickId]) > 0;
}

/** A staged chip as `browser-picks` reports it: every field but the image itself. */
function summarizeDesignPick(pick: StagedDesignPick): DesignPickSummary {
	return {
		id: pick.id,
		kind: pick.kind,
		label: pick.label,
		url: pick.url,
		note: pick.note,
		text: pick.text,
		screenshot: !!pick.screenshot,
	};
}

/**
 * Answer one `maestro-cli browser-picks` verb. Both act on the chips of the
 * agent's composer target tab ({@link resolveComposerTarget}): the tab a pick
 * lands in, whose strip the user sees. `list` reads them in chip order from
 * the live store; `remove` takes one off through {@link removeStagedDesignPick},
 * as the chip's X does.
 */
export function runRemoteDesignPickCommand(
	request: DesignPickCommandRequest
): DesignPickCommandResult {
	const session = selectSessionById(request.sessionId)(useSessionStore.getState());
	if (!session) return { success: false, error: `Agent not found: ${request.sessionId}` };
	const target = resolveComposerTarget(session);
	if (!target) return { success: false, error: `${session.name} has no AI tab` };
	const aiTabId = target.tabId;
	const picks = getStagedDesignPicks(session.id, aiTabId);

	if (request.action === 'list') {
		return { success: true, aiTabId, picks: picks.map(summarizeDesignPick) };
	}
	const pick = picks.find((p) => p.id === request.pickId);
	if (!pick) {
		return {
			success: false,
			aiTabId,
			error: `No Design Mode chip ${request.pickId} in the composer of tab ${aiTabId}`,
		};
	}
	removeStagedDesignPick(session.id, aiTabId, pick.id);
	return { success: true, aiTabId, removed: summarizeDesignPick(pick) };
}
