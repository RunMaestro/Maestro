/**
 * Tests for delivering a Design Mode pick into the agent's composer as a chip,
 * and for editing and removing a staged chip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(() => 'toast-id'),
}));

import {
	deliverDesignPick,
	removeStagedDesignPick,
	setStagedDesignPickNote,
} from '../../../renderer/services/designModePick';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createMockAITab, createMockSession } from '../../helpers';
import type { DesignModePick } from '../../../renderer/utils/designModePicker';
import type { StagedDesignPick } from '../../../renderer/types';

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

/** Seed the tab with one staged chip per id, each with the note `old`. */
function stageChips(ids: string[], tabOverrides = {}): StagedDesignPick[] {
	const staged = ids.map((id) => ({
		id,
		kind: 'element' as const,
		label: id,
		url: 'https://example.com',
		note: 'old',
		text: `block ${id}`,
		screenshot: null,
		createdAt: 1,
	}));
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
