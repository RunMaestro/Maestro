/**
 * Tests for delivering a Design Mode pick into the agent's composer as a chip,
 * for queueing one as its own message, and for reading, editing and removing
 * staged chips.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(() => 'toast-id'),
}));

import {
	deliverDesignPick,
	queueDesignPick,
	runRemoteDesignPickCommand,
} from '../../../renderer/services/designModePick';
import {
	getStagedDesignPicks,
	removeStagedDesignPick,
	removeStagedDesignPicks,
	setStagedDesignPickNote,
} from '../../../renderer/services/stagedDesignPicks';
import { buildQueuedMessageItem } from '../../../renderer/services/queuedPrompt';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createMockAITab, createMockDesignPick, createMockSession } from '../../helpers';
import {
	buildDesignModeRegionPrompt,
	expandDesignPicks,
	type DesignModePick,
	type DesignModeRegion,
} from '../../../renderer/utils/designModePicker';
import type { QueuedItem, StagedDesignPick } from '../../../renderer/types';

const SESSION_ID = 'session-1';
const TAB_ID = 'tab-1';
const BROWSER_TAB_ID = 'browser-1';
const SHOT = `data:image/png;base64,${'A'.repeat(80)}`;
const PASTED = `data:image/png;base64,${'B'.repeat(80)}`;

const pick: DesignModePick = {
	url: 'https://example.com',
	tagName: 'button',
	selector: 'button.primary',
	domId: 'save',
	classes: ['primary'],
	text: 'Save',
	html: '<button id="save" class="primary">Save</button>',
	htmlTruncated: false,
	styles: { display: 'inline-flex' },
	rect: { x: 0, y: 0, width: 80, height: 30 },
	viewport: { width: 1280, height: 800 },
};

/** A dragged-out region holding two pricing cards. */
const region: DesignModeRegion = {
	url: 'https://example.com/pricing',
	rect: { x: 40, y: 60, width: 639.6, height: 220.4 },
	viewport: { width: 1280, height: 800 },
	elements: [
		{
			selector: 'section.plans > div.starter',
			tagName: 'div',
			rect: { x: 40, y: 60, width: 300, height: 220 },
			text: 'Starter',
			html: '<div class="starter">Starter</div>',
			htmlTruncated: false,
		},
		{
			selector: 'section.plans > div.team',
			tagName: 'div',
			rect: { x: 360, y: 60, width: 300, height: 220 },
			text: 'Team',
			html: '<div class="team">Team</div>',
			htmlTruncated: false,
		},
	],
	elementsTruncated: false,
};

function seed(tabOverrides = {}, sessionOverrides = {}) {
	const session = createMockSession({
		id: SESSION_ID,
		activeTabId: TAB_ID,
		activeBrowserTabId: BROWSER_TAB_ID,
		aiTabs: [createMockAITab({ id: TAB_ID, inputValue: '', stagedImages: [], ...tabOverrides })],
		...sessionOverrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: SESSION_ID } as never);
	return session;
}

function session() {
	return useSessionStore.getState().sessions[0];
}

function chips() {
	return session().aiTabs[0].stagedDesignPicks ?? [];
}

function queue(): QueuedItem[] {
	return session().executionQueue;
}

/** Seed the tab with one staged chip per id, each with the note `old`. */
function stageChips(ids: string[], tabOverrides = {}): StagedDesignPick[] {
	const staged = ids.map((id) =>
		createMockDesignPick({ id, label: id, note: 'old', text: `block ${id}` })
	);
	seed({ ...tabOverrides, stagedDesignPicks: staged });
	return staged;
}

const getBrowserId = vi.fn(async (): Promise<string | null> => 'browser:2');

beforeEach(() => {
	useComposerInputStore.setState({
		aiValue: '',
		aiValueTabId: null,
		aiCommandMode: 'off',
	} as never);
	useUIStore.setState({ focusRequest: null } as never);
	vi.mocked(notifyToast).mockClear();
	getBrowserId.mockClear();
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...(window as unknown as { maestro?: Record<string, unknown> }).maestro,
		coworking: { getBrowserId },
	};
});

afterEach(() => {
	getBrowserId.mockResolvedValue('browser:2');
});

describe('deliverDesignPick', () => {
	it('stages a chip with the element block, screenshot and note, and lands in the AI tab', async () => {
		seed();
		useComposerInputStore.setState({ aiValue: 'Fix the header', aiValueTabId: TAB_ID } as never);

		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
			note: '  Make it blue ',
		});

		expect(getBrowserId).toHaveBeenCalledWith(SESSION_ID, BROWSER_TAB_ID);
		expect(chips()).toHaveLength(1);
		const [chip] = chips();
		expect(chip).toMatchObject({
			kind: 'element',
			label: 'button.primary "Save"',
			url: 'https://example.com',
			note: 'Make it blue',
			screenshot: SHOT,
		});
		expect(typeof chip.id).toBe('string');
		expect(chip.createdAt).toBeGreaterThan(0);
		// The chip's block is the element alone; the note is added at send.
		expect(chip.text.startsWith('Design Mode element from https://example.com')).toBe(true);
		expect(chip.text).toContain('Browser tab: `browser:2`');
		expect(chip.text).toContain('```html\n<button id="save" class="primary">Save</button>\n```');
		expect(chip.text).toContain('A screenshot of the element is attached.');
		expect(chip.text).not.toContain('Make it blue');

		// The caller gets the whole block, note included, and the chip's id.
		expect(result).toEqual({
			aiTabId: TAB_ID,
			text: `${chip.text}\n\nMake it blue`,
			pickId: chip.id,
		});

		// The draft is left alone, and the screenshot is the chip's, not a staged image.
		expect(useComposerInputStore.getState().aiValue).toBe('Fix the header');
		expect(session().aiTabs[0].inputValue).toBe('');
		expect(session().aiTabs[0].stagedImages).toEqual([]);
		// The browser tab no longer hides the chat.
		expect(session().activeBrowserTabId).toBeNull();
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: TAB_ID } });
	});

	it('stages each pick as its own chip, in pick order, beside staged images', async () => {
		seed({ stagedImages: [PASTED] });
		const first = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
			reveal: false,
		});
		const second = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick: { ...pick, tagName: 'h1', classes: [], domId: 'title', text: 'Pricing' },
			screenshot: SHOT,
			reveal: false,
		});

		expect(chips().map((c) => c.id)).toEqual([first?.pickId, second?.pickId]);
		expect(first?.pickId).not.toBe(second?.pickId);
		expect(chips().map((c) => c.label)).toEqual(['button.primary "Save"', 'h1#title "Pricing"']);
		// The same screenshot twice is two chips' screenshots, never a staged image.
		expect(session().aiTabs[0].stagedImages).toEqual([PASTED]);
	});

	it('keeps an empty note off the block, and a pick with no screenshot says nothing of one', async () => {
		seed();
		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
			note: '   ',
		});
		const [chip] = chips();
		expect(chip.note).toBe('');
		expect(chip.screenshot).toBeNull();
		expect(chip.text).not.toContain('is attached');
		expect(result?.text).toBe(chip.text);
	});

	it('leaves shell command mode, since a pick is a message for the agent', async () => {
		seed();
		useComposerInputStore.setState({
			aiValue: 'ls',
			aiValueTabId: TAB_ID,
			aiCommandMode: 'shell',
		} as never);
		await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
		});
		expect(useComposerInputStore.getState().aiCommandMode).toBe('off');
		expect(useComposerInputStore.getState().aiValue).toBe('ls');
		expect(chips()).toHaveLength(1);
	});

	it('omits the Coworking id when there is none, and still delivers if the lookup throws', async () => {
		seed();
		getBrowserId.mockResolvedValueOnce(null);
		const first = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
		});
		expect(first?.text).not.toContain('Browser tab:');

		getBrowserId.mockRejectedValueOnce(new Error('ipc gone'));
		const second = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
		});
		expect(second).not.toBeNull();
		expect(chips()).toHaveLength(2);
	});

	it('with reveal off, stages on the tab and leaves the view alone', async () => {
		seed();
		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
			reveal: false,
		});
		expect(result?.aiTabId).toBe(TAB_ID);
		expect(session().activeBrowserTabId).toBe(BROWSER_TAB_ID);
		expect(useUIStore.getState().focusRequest).toBeNull();
		expect(chips()).toHaveLength(1);
		expect(session().aiTabs[0].stagedImages).toEqual([]);
	});

	it("stages on a background agent's tab and never touches the visible composer", async () => {
		seed({ inputValue: 'saved' });
		useSessionStore.setState({ activeSessionId: 'someone-else' } as never);
		useComposerInputStore.setState({
			aiValue: 'other agent typing',
			aiValueTabId: null,
			aiCommandMode: 'shell',
		} as never);
		await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
			reveal: false,
		});
		expect(useComposerInputStore.getState()).toMatchObject({
			aiValue: 'other agent typing',
			aiValueTabId: null,
			aiCommandMode: 'shell',
		});
		expect(session().aiTabs[0].inputValue).toBe('saved');
		expect(chips()).toHaveLength(1);
	});

	it('a foreground pick into another agent brings that agent on screen', async () => {
		seed({ inputValue: '' });
		useSessionStore.setState({ activeSessionId: 'someone-else' } as never);
		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
		});
		expect(result?.aiTabId).toBe(TAB_ID);
		expect(useSessionStore.getState().activeSessionId).toBe(SESSION_ID);
		expect(session().activeTabId).toBe(TAB_ID);
		expect(session().activeBrowserTabId).toBeNull();
		expect(chips()).toHaveLength(1);
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: TAB_ID } });
	});

	it("keeps the target agent's tiled group when a foreground pick brings it on screen", async () => {
		seed(
			{},
			{
				activeGroupId: 'group-1',
				tabGroups: [
					{
						id: 'group-1',
						layout: {
							kind: 'split',
							direction: 'row',
							children: [
								{ kind: 'leaf', tab: { type: 'ai', id: TAB_ID } },
								{ kind: 'leaf', tab: { type: 'browser', id: BROWSER_TAB_ID } },
							],
						},
					},
				],
			}
		);
		useSessionStore.setState({ activeSessionId: 'someone-else' } as never);
		await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: null,
		});
		expect(useSessionStore.getState().activeSessionId).toBe(SESSION_ID);
		expect(session().activeGroupId).toBe('group-1');
		expect(session().activeTabId).toBe(TAB_ID);
		expect(chips()).toHaveLength(1);
	});

	it('refuses, with a toast, when the agent has no AI tab', async () => {
		seed({}, { aiTabs: [], activeTabId: '' });
		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			pick,
			screenshot: SHOT,
		});
		expect(result).toBeNull();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('pick the element again') })
		);
	});

	it('stages a dragged region as a region chip: its size as the label, the region block, its screenshot', async () => {
		seed({ stagedImages: [PASTED] });

		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			region,
			screenshot: SHOT,
			note: '  Put these on one row ',
			reveal: false,
		});

		expect(chips()).toHaveLength(1);
		const [chip] = chips();
		expect(chip).toMatchObject({
			kind: 'region',
			label: 'Region 640 x 220',
			url: 'https://example.com/pricing',
			note: 'Put these on one row',
			screenshot: SHOT,
		});
		// The region block with the Coworking id; the note is added at send.
		expect(chip.text).toBe(
			buildDesignModeRegionPrompt(region, { hasScreenshot: true, browserId: 'browser:2' })
		);
		expect(chip.text).toContain('Element 2: `section.plans > div.team`');
		expect(result).toEqual({
			aiTabId: TAB_ID,
			text: `${chip.text}\n\nPut these on one row`,
			pickId: chip.id,
		});
		// The screenshot is the chip's, never a staged image.
		expect(session().aiTabs[0].stagedImages).toEqual([PASTED]);
	});

	it('asks for the region again when the agent has no AI tab to stage it on', async () => {
		seed({}, { aiTabs: [], activeTabId: '' });
		const result = await deliverDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			region,
			screenshot: null,
		});
		expect(result).toBeNull();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('pick the region again') })
		);
	});
});

describe('queueDesignPick', () => {
	const delivery = {
		sessionId: SESSION_ID,
		browserTabId: BROWSER_TAB_ID,
		pick,
		screenshot: SHOT,
	};

	it('queues the pick as its own message with the screenshot as its image, and returns it', async () => {
		seed({ name: 'Fix header' });

		const result = await queueDesignPick({ ...delivery, note: '  Make it blue ' });

		expect(getBrowserId).toHaveBeenCalledWith(SESSION_ID, BROWSER_TAB_ID);
		expect(queue()).toHaveLength(1);
		const [item] = queue();
		expect(result).toEqual({
			aiTabId: TAB_ID,
			tabName: 'Fix header',
			queueItemId: item.id,
			text: item.text,
		});
		expect(item).toMatchObject({
			type: 'message',
			tabId: TAB_ID,
			tabName: 'Fix header',
			images: [SHOT],
		});
		// The element block, then the trimmed note after a blank line.
		expect(item.text!.startsWith('Design Mode element from https://example.com')).toBe(true);
		expect(item.text).toContain('Browser tab: `browser:2`');
		expect(item.text).toContain('A screenshot of the element is attached.');
		expect(item.text!.endsWith('\n\nMake it blue')).toBe(true);
		// Queued, not run: the queue's own drain starts it.
		expect(session().state).toBe('idle');
	});

	it('queues exactly what a send of the same pick as a chip would build', async () => {
		seed();
		const input = { ...delivery, note: 'Make it blue', reveal: false };
		await deliverDesignPick(input);
		const expanded = expandDesignPicks(chips(), '');

		const queued = await queueDesignPick(input);

		expect(queue()[0]).toMatchObject({ text: expanded.text, images: expanded.images });
		expect(queued?.text).toBe(expanded.text);
	});

	it('queues a pick with no screenshot as text alone', async () => {
		seed();
		await queueDesignPick({ ...delivery, screenshot: null });
		expect(queue()[0]).not.toHaveProperty('images');
		expect(queue()[0].text).not.toContain('is attached');
	});

	it('never touches the draft, the staged images, the chips, or what is on screen', async () => {
		const kept = createMockDesignPick({ id: 'kept' });
		seed({ inputValue: 'saved', stagedImages: [PASTED], stagedDesignPicks: [kept] });
		useComposerInputStore.setState({
			aiValue: 'Fix the header',
			aiValueTabId: TAB_ID,
			aiCommandMode: 'shell',
		} as never);

		await queueDesignPick(delivery);

		expect(useComposerInputStore.getState()).toMatchObject({
			aiValue: 'Fix the header',
			aiValueTabId: TAB_ID,
			aiCommandMode: 'shell',
		});
		expect(session().aiTabs[0]).toMatchObject({ inputValue: 'saved', stagedImages: [PASTED] });
		// A queued pick is not a chip: the one already staged is the only one.
		expect(chips()).toEqual([kept]);
		// Design Mode keeps the browser tab on screen.
		expect(session().activeBrowserTabId).toBe(BROWSER_TAB_ID);
		expect(useUIStore.getState().focusRequest).toBeNull();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('lines picks up behind the work already waiting, in pick order, without dispatching any', async () => {
		const earlier: QueuedItem = {
			id: 'earlier',
			timestamp: 1,
			tabId: TAB_ID,
			type: 'message',
			text: 'Earlier message',
		};
		seed({}, { state: 'busy', executionQueue: [earlier] });

		const first = await queueDesignPick(delivery);
		const second = await queueDesignPick({ ...delivery, note: 'Again' });

		expect(queue().map((item) => item.id)).toEqual([
			'earlier',
			first?.queueItemId,
			second?.queueItemId,
		]);
		expect(first?.queueItemId).not.toBe(second?.queueItemId);
		expect(session().state).toBe('busy');
	});

	it('goes to the composer target tab: the active AI tab', async () => {
		seed(
			{},
			{
				aiTabs: [
					createMockAITab({ id: TAB_ID, name: 'First' }),
					createMockAITab({ id: 'tab-2', name: 'Second' }),
				],
				activeTabId: 'tab-2',
			}
		);

		const result = await queueDesignPick(delivery);

		expect(result?.aiTabId).toBe('tab-2');
		// The name belongs to the tab it went to, for "Queued for <tab>".
		expect(result?.tabName).toBe('Second');
		expect(queue()[0].tabId).toBe('tab-2');
	});

	it('names an unnamed tab the way the queue does: by its provider session id', async () => {
		seed({ name: null, agentSessionId: 'abcd1234-5678-90ab-cdef-1234567890ab' });

		const result = await queueDesignPick(delivery);

		expect(result?.tabName).toBe('ABCD1234');
		expect(queue()[0].tabName).toBe('ABCD1234');
	});

	it('goes to the AI pane of the tiled group on screen, not a standalone tab', async () => {
		seed(
			{},
			{
				aiTabs: [createMockAITab({ id: TAB_ID }), createMockAITab({ id: 'standalone' })],
				activeTabId: 'standalone',
				activeGroupId: 'group-1',
				tabGroups: [
					{
						id: 'group-1',
						layout: {
							kind: 'split',
							direction: 'row',
							children: [
								{ kind: 'leaf', tab: { type: 'ai', id: TAB_ID } },
								{ kind: 'leaf', tab: { type: 'browser', id: BROWSER_TAB_ID } },
							],
						},
					},
				],
			}
		);

		const result = await queueDesignPick(delivery);

		expect(result?.aiTabId).toBe(TAB_ID);
		expect(queue()[0].tabId).toBe(TAB_ID);
	});

	it('never lets the page consult another agent: the text is not read for @mentions', async () => {
		seed();
		const backend = createMockSession({ id: 'backend', name: 'Backend' });
		useSessionStore.setState({ sessions: [session(), backend] } as never);

		await queueDesignPick({
			...delivery,
			pick: { ...pick, html: '<p>ask @Backend to fix this</p>' },
		});

		const [item] = queue();
		expect(item.text).toContain('@Backend');
		expect(item.crossAgentMention).toBeUndefined();
		expect(item.crossAgentOnly).toBeUndefined();
		// The same text queued as the user's own words WOULD consult that agent, so
		// the assertions above hold because of the opt-out and not the roster.
		expect(
			buildQueuedMessageItem({ session: session(), tab: session().aiTabs[0], text: item.text! })
				.crossAgentMention
		).toBe(true);
	});

	it('refuses, with a toast and nothing queued, when the agent has no AI tab', async () => {
		seed({}, { aiTabs: [], activeTabId: '' });

		expect(await queueDesignPick(delivery)).toBeNull();

		expect(queue()).toEqual([]);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Nothing to Queue Into',
				message: expect.stringContaining('queue the pick again'),
			})
		);
	});

	it('refuses an agent that is gone', async () => {
		seed();

		expect(await queueDesignPick({ ...delivery, sessionId: 'ghost' })).toBeNull();

		expect(queue()).toEqual([]);
		expect(notifyToast).toHaveBeenCalledTimes(1);
	});

	it('queues a dragged region the same way: its block, then the note, with its screenshot', async () => {
		seed({ name: 'Fix header' });

		const result = await queueDesignPick({
			sessionId: SESSION_ID,
			browserTabId: BROWSER_TAB_ID,
			region,
			screenshot: SHOT,
			note: 'Put these on one row',
		});

		const [item] = queue();
		expect(item).toMatchObject({ type: 'message', tabId: TAB_ID, images: [SHOT] });
		expect(item.text).toBe(
			`${buildDesignModeRegionPrompt(region, { hasScreenshot: true, browserId: 'browser:2' })}\n\nPut these on one row`
		);
		expect(result).toEqual({
			aiTabId: TAB_ID,
			tabName: 'Fix header',
			queueItemId: item.id,
			text: item.text,
		});
		// A queued region stages nothing.
		expect(chips()).toEqual([]);
	});
});

describe('setStagedDesignPickNote', () => {
	it('replaces the trimmed note on that chip and leaves the others as they were', () => {
		const [, second] = stageChips(['a', 'b']);

		expect(setStagedDesignPickNote(SESSION_ID, TAB_ID, 'a', '  Make it blue \n')).toBe(true);

		expect(chips().map((c) => c.note)).toEqual(['Make it blue', 'old']);
		expect(chips()[0]).toMatchObject({ id: 'a', text: 'block a', label: 'a' });
		expect(chips()[1]).toBe(second);
	});

	it('clears a note', () => {
		stageChips(['a']);
		expect(setStagedDesignPickNote(SESSION_ID, TAB_ID, 'a', '   ')).toBe(true);
		expect(chips()[0].note).toBe('');
	});

	it('writes nothing when the note is unchanged once trimmed', () => {
		stageChips(['a']);
		const before = session();
		expect(setStagedDesignPickNote(SESSION_ID, TAB_ID, 'a', ' old ')).toBe(true);
		expect(session()).toBe(before);
	});

	it('reports a chip that is not on that tab, and writes nothing', () => {
		stageChips(['a']);
		const before = session();
		expect(setStagedDesignPickNote(SESSION_ID, TAB_ID, 'sent-already', 'x')).toBe(false);
		expect(setStagedDesignPickNote(SESSION_ID, 'other-tab', 'a', 'x')).toBe(false);
		expect(setStagedDesignPickNote('no-such-agent', TAB_ID, 'a', 'x')).toBe(false);
		expect(session()).toBe(before);
	});
});

describe('removeStagedDesignPick', () => {
	it('takes that chip off its tab and keeps the rest in pick order', () => {
		stageChips(['a', 'b', 'c']);
		expect(removeStagedDesignPick(SESSION_ID, TAB_ID, 'b')).toBe(true);
		expect(chips().map((c) => c.id)).toEqual(['a', 'c']);

		expect(removeStagedDesignPick(SESSION_ID, TAB_ID, 'a')).toBe(true);
		expect(removeStagedDesignPick(SESSION_ID, TAB_ID, 'c')).toBe(true);
		expect(chips()).toEqual([]);
	});

	it('reports a chip that is not there, and writes nothing', () => {
		stageChips(['a']);
		const before = session();
		expect(removeStagedDesignPick(SESSION_ID, TAB_ID, 'missing')).toBe(false);
		expect(removeStagedDesignPick(SESSION_ID, 'other-tab', 'a')).toBe(false);
		expect(removeStagedDesignPick('no-such-agent', TAB_ID, 'a')).toBe(false);
		expect(session()).toBe(before);
	});

	it('never touches the draft or the staged images', () => {
		stageChips(['a'], { inputValue: 'Fix it', stagedImages: [PASTED] });

		removeStagedDesignPick(SESSION_ID, TAB_ID, 'a');

		expect(session().aiTabs[0]).toMatchObject({ inputValue: 'Fix it', stagedImages: [PASTED] });
		expect(chips()).toEqual([]);
	});
});

describe('getStagedDesignPicks', () => {
	it("reads the tab's chips, in pick order, from the live store", () => {
		const staged = stageChips(['a', 'b']);
		expect(getStagedDesignPicks(SESSION_ID, TAB_ID)).toEqual(staged);

		removeStagedDesignPick(SESSION_ID, TAB_ID, 'a');
		expect(getStagedDesignPicks(SESSION_ID, TAB_ID).map((c) => c.id)).toEqual(['b']);
	});

	it('is empty for a tab with no chips, another tab, or an agent that is gone', () => {
		seed();
		expect(getStagedDesignPicks(SESSION_ID, TAB_ID)).toEqual([]);
		stageChips(['a']);
		expect(getStagedDesignPicks(SESSION_ID, 'other-tab')).toEqual([]);
		expect(getStagedDesignPicks('no-such-agent', TAB_ID)).toEqual([]);
	});
});

describe('removeStagedDesignPicks', () => {
	it('takes the named chips off and keeps any other chip, so a later pick survives a send', () => {
		stageChips(['sent-1', 'later', 'sent-2']);

		expect(removeStagedDesignPicks(SESSION_ID, TAB_ID, ['sent-1', 'sent-2'])).toBe(2);

		expect(chips().map((c) => c.id)).toEqual(['later']);
	});

	it('counts only the chips still there, and writes nothing when none are', () => {
		stageChips(['a', 'b']);
		expect(removeStagedDesignPicks(SESSION_ID, TAB_ID, ['a', 'gone'])).toBe(1);
		expect(chips().map((c) => c.id)).toEqual(['b']);

		const before = session();
		expect(removeStagedDesignPicks(SESSION_ID, TAB_ID, ['gone'])).toBe(0);
		expect(removeStagedDesignPicks(SESSION_ID, TAB_ID, [])).toBe(0);
		expect(removeStagedDesignPicks(SESSION_ID, 'other-tab', ['b'])).toBe(0);
		expect(session()).toBe(before);
	});
});

describe('runRemoteDesignPickCommand (browser-picks)', () => {
	it('lists the composer chips in order, every field but the image itself', () => {
		const shot = createMockDesignPick({
			id: 'a',
			note: 'bigger',
			text: 'block a',
			screenshot: SHOT,
		});
		const bare = createMockDesignPick({ id: 'b', kind: 'region', label: 'Region 640 x 220' });
		seed({ stagedDesignPicks: [shot, bare] });

		expect(runRemoteDesignPickCommand({ action: 'list', sessionId: SESSION_ID })).toEqual({
			success: true,
			aiTabId: TAB_ID,
			picks: [
				{
					id: 'a',
					kind: 'element',
					label: 'button.cta "Sign up"',
					url: 'https://example.com',
					note: 'bigger',
					text: 'block a',
					screenshot: true,
				},
				{
					id: 'b',
					kind: 'region',
					label: 'Region 640 x 220',
					url: 'https://example.com',
					note: '',
					text: 'BLOCK',
					screenshot: false,
				},
			],
		});
	});

	it('lists nothing for a composer with no chips', () => {
		seed();
		expect(runRemoteDesignPickCommand({ action: 'list', sessionId: SESSION_ID })).toEqual({
			success: true,
			aiTabId: TAB_ID,
			picks: [],
		});
	});

	it('removes one chip, as its X does, and reports it', () => {
		stageChips(['a', 'b', 'c'], { inputValue: 'Fix it', stagedImages: [PASTED] });

		const result = runRemoteDesignPickCommand({
			action: 'remove',
			sessionId: SESSION_ID,
			pickId: 'b',
		});

		expect(result).toMatchObject({ success: true, aiTabId: TAB_ID, removed: { id: 'b' } });
		expect(chips().map((c) => c.id)).toEqual(['a', 'c']);
		expect(session().aiTabs[0]).toMatchObject({ inputValue: 'Fix it', stagedImages: [PASTED] });
	});

	it('reports a chip that is not in the composer, and writes nothing', () => {
		stageChips(['a']);
		const before = session();

		expect(
			runRemoteDesignPickCommand({ action: 'remove', sessionId: SESSION_ID, pickId: 'gone' })
		).toEqual({
			success: false,
			aiTabId: TAB_ID,
			error: `No Design Mode chip gone in the composer of tab ${TAB_ID}`,
		});
		expect(session()).toBe(before);
	});

	it("acts on the composer target tab only, not another tab's chips", () => {
		const other = createMockAITab({
			id: 'tab-2',
			stagedDesignPicks: [createMockDesignPick({ id: 'elsewhere' })],
		});
		seed({}, { aiTabs: [createMockAITab({ id: TAB_ID }), other] });

		expect(runRemoteDesignPickCommand({ action: 'list', sessionId: SESSION_ID })).toMatchObject({
			aiTabId: TAB_ID,
			picks: [],
		});
		expect(
			runRemoteDesignPickCommand({ action: 'remove', sessionId: SESSION_ID, pickId: 'elsewhere' })
		).toMatchObject({ success: false });
		expect(session().aiTabs[1].stagedDesignPicks?.map((c) => c.id)).toEqual(['elsewhere']);
	});

	it('refuses an agent that is gone or has no AI tab', () => {
		seed({}, { activeTabId: '' });

		expect(runRemoteDesignPickCommand({ action: 'list', sessionId: 'ghost' })).toEqual({
			success: false,
			error: 'Agent not found: ghost',
		});
		expect(runRemoteDesignPickCommand({ action: 'list', sessionId: SESSION_ID })).toMatchObject({
			success: false,
			error: expect.stringContaining('has no AI tab'),
		});
	});
});
