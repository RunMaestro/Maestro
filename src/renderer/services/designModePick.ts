/**
 * Deliver a Design Mode pick to the agent that owns the browser tab. A pick is
 * an element (a click) or a region (a drag): {@link DesignPickDelivery}
 * carries either capture, and each becomes a chip of its own kind.
 *
 * A browser tab has no composer under it, so a pick goes where "Quote in
 * Message" from a file tab goes: the agent's active AI tab (the tiled group's
 * AI pane when a group is showing). It lands there as a chip, through
 * {@link stageDesignPickOnAgent}: a short label, the cropped screenshot, and
 * the user's note, with the full block (the element's, or the region's and
 * the elements in it) kept on the chip until the message is sent. The chip
 * owns the screenshot; it never goes into the tab's `stagedImages`.
 *
 * {@link queueDesignPick} is the other way out: the same pick as its own
 * message in the agent's execution queue, with no chip and no draft involved.
 *
 * The click in the overlay and `maestro-cli browser-pick` both end here.
 *
 * Once staged, a chip is edited and removed by id on its tab through the
 * helpers in `stagedDesignPicks.ts` (`setStagedDesignPickNote`,
 * `removeStagedDesignPick`): the chip strip in the composer uses them, so any
 * other caller reaches the same code. A send reads the chips with
 * `getStagedDesignPicks`, expands them into the message, and takes them off
 * with `removeStagedDesignPicks`.
 * `maestro-cli browser-picks` reads and removes them through
 * {@link runRemoteDesignPickCommand}.
 */

import {
	resolveComposerTarget,
	resolveComposerTargetTab,
	stageDesignPickOnAgent,
} from './quoteIntoComposer';
import { enqueuePromptForTab } from './queuedPrompt';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import {
	getStagedDesignPicks,
	removeStagedDesignPick,
	setStagedDesignPickNote,
} from './stagedDesignPicks';
import { notifyToast } from '../stores/notificationStore';
import { captureException } from '../utils/sentry';
import { generateId } from '../utils/ids';
import { getTabDisplayName } from '../utils/tabHelpers';
import {
	buildDesignModePrompt,
	buildDesignModeRegionPrompt,
	designPickBlock,
	designPickLabel,
	designRegionLabel,
	expandDesignPicks,
	type DesignPickCapture,
} from '../utils/designModePicker';
import type { StagedDesignPick } from '../types';
import type {
	DesignPickCommandRequest,
	DesignPickCommandResult,
	DesignPickSummary,
} from '../../shared/designPickCommands';

/**
 * One pick on its way to the agent: what was captured (an element or a
 * region, with its screenshot) and where it goes.
 */
export type DesignPickDelivery = DesignPickCapture & {
	/** The agent that owns the browser tab. */
	sessionId: string;
	/** The browser tab the pick came from (for its Coworking id). */
	browserTabId: string;
	note?: string;
	/**
	 * False stages the pick without switching the visible tab. Default true.
	 * Only {@link deliverDesignPick} reads it: a queued pick moves nothing.
	 */
	reveal?: boolean;
};

/** What {@link deliverDesignPick} staged where, or null when it could not. */
export interface DesignPickDelivered {
	aiTabId: string;
	/** The block the chip adds to the message at send, note included. */
	text: string;
	/** The staged chip's id. */
	pickId: string;
}

/** What {@link queueDesignPick} queued where, or null when it could not. */
export interface DesignPickQueued {
	aiTabId: string;
	/** That tab's name as the queue labels it, for "Queued for <tab>". */
	tabName: string;
	/** The queued message's id, as it sits in the agent's execution queue. */
	queueItemId: string;
	/** The message that was queued: the pick's block, note included. */
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

/**
 * The chip for one pick: an element (`kind: 'element'`, labeled by
 * {@link designPickLabel}) or a region (`kind: 'region'`, labeled
 * `Region W x H`). Its `text` is the pick's block without the note: the note
 * stays editable on the chip and {@link designPickBlock} adds it at send.
 */
async function buildDesignPickChip(delivery: DesignPickDelivery): Promise<StagedDesignPick> {
	const browserId = await lookUpBrowserId(delivery.sessionId, delivery.browserTabId);
	const context = { hasScreenshot: !!delivery.screenshot, browserId };
	const described =
		'region' in delivery
			? {
					kind: 'region' as const,
					label: designRegionLabel(delivery.region),
					url: delivery.region.url,
					text: buildDesignModeRegionPrompt(delivery.region, context),
				}
			: {
					kind: 'element' as const,
					label: designPickLabel(delivery.pick),
					url: delivery.pick.url,
					text: buildDesignModePrompt(delivery.pick, context),
				};
	return {
		id: generateId(),
		...described,
		note: delivery.note?.trim() ?? '',
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
		missingTabMessage: `This agent has no AI tab. Open one, then pick the ${chip.kind} again.`,
	});
	return aiTabId ? { aiTabId, text: designPickBlock(chip), pickId: chip.id } : null;
}

/**
 * Queue one pick as its own message on `sessionId`'s composer target (the AI
 * tab {@link resolveComposerTarget} picks), for the user who wants to line up
 * twenty fixes while the agent works. It is the pick {@link deliverDesignPick}
 * would stage, expanded the way a send expands it ({@link expandDesignPicks}
 * with no typed text), so the queued message is the text and screenshot a
 * chip-only send would have produced.
 *
 * It only APPENDS to the agent's execution queue, through
 * {@link enqueuePromptForTab}; nothing is spawned here. The queue's own drain
 * does the rest: an idle agent starts the message on its next render, a busy
 * one when its turn ends, and the drain's rules all still apply (held while an
 * Agent Resilience retry counts down, waiting while the target tab is mid-turn).
 * A caller that dispatched it itself would bypass those and could lose the
 * message to a spawn collision.
 *
 * The draft, the staged images, the chips and the visible tab are all left as
 * they are, so a queued pick never needs `reveal`. The message is not read for
 * `@mentions` (`planMentions: false`): its text is the page's, and a page must
 * not be able to consult another agent.
 *
 * Returns what was queued, or null (and says so in a toast) when the agent is
 * gone or has no AI tab.
 */
export async function queueDesignPick(
	delivery: DesignPickDelivery
): Promise<DesignPickQueued | null> {
	const chip = await buildDesignPickChip(delivery);
	const { text, images } = expandDesignPicks([chip], '');
	// Resolved after the await above, like a staged pick: the agent can lose its
	// tab while the Coworking id is looked up.
	const target = resolveComposerTargetTab(delivery.sessionId);
	const item = target
		? enqueuePromptForTab({
				sessionId: delivery.sessionId,
				tabId: target.tab.id,
				text,
				images,
				planMentions: false,
			})
		: null;
	if (!target || !item) {
		notifyToast({
			color: 'yellow',
			title: 'Nothing to Queue Into',
			message: 'This agent has no AI tab. Open one, then queue the pick again.',
		});
		return null;
	}
	return {
		aiTabId: item.tabId,
		// The item stores this same label (`buildQueuedMessageItem`); read from the
		// tab itself because the item's copy is typed optional.
		tabName: getTabDisplayName(target.tab),
		queueItemId: item.id,
		text,
	};
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
 * Answer one `maestro-cli browser-picks` verb. Each acts on the chips of the
 * agent's composer target tab ({@link resolveComposerTarget}): the tab a pick
 * lands in, whose strip the user sees. `list` reads them in chip order from
 * the live store; `note` replaces one chip's note through
 * {@link setStagedDesignPickNote}, as the chip's note box does; `remove` takes
 * one off through {@link removeStagedDesignPick}, as the chip's X does.
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
	if (request.action === 'note') {
		// The same setter the chip's note box saves through.
		setStagedDesignPickNote(session.id, aiTabId, pick.id, request.note ?? '');
		const edited = getStagedDesignPicks(session.id, aiTabId).find((p) => p.id === pick.id) ?? pick;
		return { success: true, aiTabId, edited: summarizeDesignPick(edited) };
	}
	removeStagedDesignPick(session.id, aiTabId, pick.id);
	return { success: true, aiTabId, removed: summarizeDesignPick(pick) };
}
