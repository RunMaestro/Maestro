/**
 * @file quickChat.test.ts
 * @description The Quick Chat contract: settings resolution and the log -> message transform.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_QUICK_CHAT_SETTINGS,
	describeQuickChatRoute,
	QUICK_CHAT_MAX_MESSAGES,
	QUICK_CHAT_MIN_EXPANDED_HEIGHT,
	QUICK_CHAT_MIN_WIDTH,
	logsToQuickChatMessages,
	parseQuickChatFontScaleRequest,
	parseQuickChatImages,
	parseQuickChatRecent,
	parseQuickChatTabChoice,
	QUICK_CHAT_MAX_RECENTS,
	QUICK_CHAT_RECENT_MAX_TEXT,
	QUICK_CHAT_RECENT_MAX_TURNS,
	resolveQuickChatRecentRef,
	resolveQuickChatSettings,
	summarizeQuickChatRecent,
	upsertQuickChatRecent,
	validateQuickChatBoundsRequest,
	type QuickChatRecent,
} from '../../shared/quickChat';

const log = (id: string, source: string, text: string) => ({ id, timestamp: 1, source, text });

describe('resolveQuickChatSettings', () => {
	it('returns the defaults when nothing is persisted', () => {
		expect(resolveQuickChatSettings(undefined)).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings(null)).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings('garbage')).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
	});

	it('defaults the hotkey to Option/Alt+Space', () => {
		expect(resolveQuickChatSettings(undefined).hotkey).toEqual(['Alt', 'Space']);
	});

	it('keeps saved values and fills a partial object from the defaults', () => {
		expect(resolveQuickChatSettings({ agentId: 'a1', persistent: true })).toEqual({
			...DEFAULT_QUICK_CHAT_SETTINGS,
			agentId: 'a1',
			persistent: true,
		});
	});

	it('keeps an empty hotkey, which is how the user turns it off', () => {
		expect(resolveQuickChatSettings({ hotkey: [] }).hotkey).toEqual([]);
	});

	it('ignores values of the wrong type', () => {
		expect(
			resolveQuickChatSettings({
				hotkey: 'Alt+Space',
				agentId: 7,
				persistent: 'yes',
				ephemeralHistory: null,
			})
		).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings({ hotkey: ['Alt', 3, 'K'] }).hotkey).toEqual(['Alt', 'K']);
	});

	it('keeps a saved thinking mode, defaults it to off, and drops an unknown one', () => {
		expect(resolveQuickChatSettings(undefined).thinking).toBe('off');
		expect(resolveQuickChatSettings({ thinking: 'sticky' }).thinking).toBe('sticky');
		expect(resolveQuickChatSettings({ thinking: 'loud' }).thinking).toBe('off');
	});

	it('keeps a saved default tab, defaults it to auto, and drops an unknown one', () => {
		expect(resolveQuickChatSettings(undefined).defaultTab).toBe('auto');
		expect(resolveQuickChatSettings({ defaultTab: 'new' }).defaultTab).toBe('new');
		expect(resolveQuickChatSettings({ defaultTab: 'tab' }).defaultTab).toBe('auto');
	});

	it('never hands back the shared default array', () => {
		const resolved = resolveQuickChatSettings(undefined);
		resolved.hotkey.push('X');
		expect(DEFAULT_QUICK_CHAT_SETTINGS.hotkey).toEqual(['Alt', 'Space']);
	});
});

describe('logsToQuickChatMessages', () => {
	it('maps user, agent output, and errors, and drops process detail', () => {
		const messages = logsToQuickChatMessages([
			log('1', 'user', 'hello'),
			log('2', 'thinking', 'hmm'),
			log('3', 'tool', 'Read file'),
			log('4', 'stdout', 'hi there'),
			log('5', 'system', 'session started'),
			log('6', 'error', 'rate limited'),
		]);
		expect(messages.map((m) => [m.role, m.text])).toEqual([
			['user', 'hello'],
			['assistant', 'hi there'],
			['error', 'rate limited'],
		]);
	});

	it('joins consecutive output chunks into one reply', () => {
		const messages = logsToQuickChatMessages([
			log('1', 'user', 'q'),
			log('2', 'stdout', 'Fuhged'),
			log('3', 'thinking', 'still going'),
			log('4', 'stdout', 'daboudit'),
		]);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ id: '2', role: 'assistant', text: 'Fuhgeddaboudit' });
	});

	it('does not mutate the source log', () => {
		const logs = [log('1', 'stdout', 'a'), log('2', 'ai', 'b')];
		logsToQuickChatMessages(logs);
		expect(logs[0].text).toBe('a');
	});

	it('skips blank entries', () => {
		expect(logsToQuickChatMessages([log('1', 'stdout', '  \n')])).toEqual([]);
	});

	it('can project a full document conversation without applying the quick window cap', () => {
		const logs = Array.from({ length: QUICK_CHAT_MAX_MESSAGES + 5 }, (_, i) =>
			log(String(i), i % 2 === 0 ? 'user' : 'stdout', `m${i}`)
		);
		const messages = logsToQuickChatMessages(logs, { maxMessages: Infinity });
		expect(messages).toHaveLength(logs.length);
		expect(messages[0].text).toBe('m0');
	});
	it('keeps only the newest messages', () => {
		const logs = Array.from({ length: QUICK_CHAT_MAX_MESSAGES + 5 }, (_, i) =>
			log(String(i), i % 2 === 0 ? 'user' : 'stdout', `m${i}`)
		);
		const messages = logsToQuickChatMessages(logs);
		expect(messages).toHaveLength(QUICK_CHAT_MAX_MESSAGES);
		expect(messages[messages.length - 1].text).toBe(`m${QUICK_CHAT_MAX_MESSAGES + 4}`);
	});
});

describe('validateQuickChatBoundsRequest', () => {
	it('accepts a size, a spot, or both', () => {
		expect(validateQuickChatBoundsRequest({ width: 600 })).toBeNull();
		expect(validateQuickChatBoundsRequest({ height: 500 })).toBeNull();
		expect(validateQuickChatBoundsRequest({ x: -1200, y: 40 })).toBeNull();
		expect(validateQuickChatBoundsRequest({ x: 0, y: 0, width: 700, height: 600 })).toBeNull();
	});

	it('refuses an empty request', () => {
		expect(validateQuickChatBoundsRequest({})).toMatch(/at least one/);
	});

	it('refuses half a position', () => {
		expect(validateQuickChatBoundsRequest({ x: 10 })).toMatch(/together/);
		expect(validateQuickChatBoundsRequest({ y: 10, width: 600 })).toMatch(/together/);
	});

	it('refuses a non-number', () => {
		expect(validateQuickChatBoundsRequest({ width: Number('wide') })).toMatch(/numbers/);
		expect(validateQuickChatBoundsRequest({ x: 1, y: Infinity })).toMatch(/numbers/);
	});

	it('refuses a size below what a drag allows', () => {
		expect(validateQuickChatBoundsRequest({ width: QUICK_CHAT_MIN_WIDTH - 1 })).toMatch(/Width/);
		expect(validateQuickChatBoundsRequest({ height: QUICK_CHAT_MIN_EXPANDED_HEIGHT - 1 })).toMatch(
			/Height/
		);
	});
});

describe('parseQuickChatFontScaleRequest', () => {
	it('accepts a step, an exact scale, or a reset', () => {
		expect(parseQuickChatFontScaleRequest({ step: 1 })).toEqual({ step: 1 });
		expect(parseQuickChatFontScaleRequest({ step: -1 })).toEqual({ step: -1 });
		expect(parseQuickChatFontScaleRequest({ scale: 1.4 })).toEqual({ scale: 1.4 });
		expect(parseQuickChatFontScaleRequest({ reset: true })).toEqual({ reset: true });
	});

	it('rejects anything else off the wire', () => {
		for (const raw of [null, 'in', {}, { step: 2 }, { scale: 0 }, { scale: NaN }, { reset: 1 }]) {
			expect(parseQuickChatFontScaleRequest(raw)).toBeNull();
		}
	});
});

describe('describeQuickChatRoute', () => {
	const route = {
		status: 'done' as const,
		tabId: 't1',
		tabName: 'CI Build',
		origin: 'open' as const,
		tabOpen: true,
		since: null,
	};

	it('says where a message went and how the tab came to be', () => {
		expect(describeQuickChatRoute(route)).toBe('sent to open tab "CI Build"');
		expect(describeQuickChatRoute({ ...route, origin: 'reopened', status: 'running' })).toBe(
			'running in reopened tab "CI Build"'
		);
		expect(describeQuickChatRoute({ ...route, origin: 'new', status: 'queued' })).toBe(
			'queued for new tab "CI Build"'
		);
		expect(describeQuickChatRoute({ ...route, status: 'cancelled' })).toBe(
			'cancelled, was for open tab "CI Build"'
		);
	});

	it('covers a message with no tab yet, or none at all', () => {
		const none = { ...route, tabId: null, tabName: null, origin: null };
		expect(describeQuickChatRoute({ ...none, status: 'searching' })).toBe('searching for a tab');
		expect(describeQuickChatRoute({ ...none, status: 'failed' })).toBe('failed');
		expect(describeQuickChatRoute({ ...none, status: 'cancelled' })).toBe('cancelled');
	});
});

describe('logsToQuickChatMessages thinking', () => {
	const reply = [
		log('t1', 'thinking', 'Reading '),
		log('t2', 'thinking', 'the file.'),
		log('o1', 'stdout', 'Here is the answer.'),
		log('t3', 'thinking', 'Checking once more.'),
	];

	it('leaves thinking out by default and when off', () => {
		expect(logsToQuickChatMessages(reply).map((m) => m.role)).toEqual(['assistant']);
		expect(logsToQuickChatMessages(reply, { thinking: 'off', running: true })).toHaveLength(1);
	});

	it('keeps all of it in place when sticky, merging streamed pieces', () => {
		const messages = logsToQuickChatMessages(reply, { thinking: 'sticky' });
		expect(messages.map((m) => [m.role, m.text])).toEqual([
			['thinking', 'Reading the file.'],
			['assistant', 'Here is the answer.'],
			['thinking', 'Checking once more.'],
		]);
	});

	it('when on, shows only the reasoning since the last answer, while the reply runs', () => {
		const running = logsToQuickChatMessages(reply, { thinking: 'on', running: true });
		expect(running.map((m) => [m.role, m.text])).toEqual([
			['assistant', 'Here is the answer.'],
			['thinking', 'Checking once more.'],
		]);
		const done = logsToQuickChatMessages(reply, { thinking: 'on', running: false });
		expect(done.map((m) => m.role)).toEqual(['assistant']);
	});

	it('when on, shows reasoning before any answer has arrived', () => {
		const messages = logsToQuickChatMessages(reply.slice(0, 2), { thinking: 'on', running: true });
		expect(messages.map((m) => m.role)).toEqual(['thinking']);
	});
});

describe('parseQuickChatTabChoice', () => {
	it('reads new, auto (any case), and anything else as a tab id', () => {
		expect(parseQuickChatTabChoice('new')).toEqual({ kind: 'new' });
		expect(parseQuickChatTabChoice(' AUTO ')).toEqual({ kind: 'auto' });
		expect(parseQuickChatTabChoice('tab-123')).toEqual({ kind: 'tab', tabId: 'tab-123' });
	});

	it('returns null for nothing', () => {
		expect(parseQuickChatTabChoice('')).toBeNull();
		expect(parseQuickChatTabChoice('  ')).toBeNull();
		expect(parseQuickChatTabChoice(undefined)).toBeNull();
	});
});

describe('parseQuickChatImages', () => {
	it('takes data:image URLs, and treats a missing list as none', () => {
		const png = 'data:image/png;base64,AAAA';
		const svg = 'data:image/svg+xml;base64,PHN2Zz4=';
		expect(parseQuickChatImages([png, svg])).toEqual([png, svg]);
		expect(parseQuickChatImages(undefined)).toEqual([]);
		expect(parseQuickChatImages(null)).toEqual([]);
	});

	it.each([
		['a path', ['/tmp/shot.png']],
		['a non-image data URL', ['data:text/plain;base64,AAAA']],
		['a non-string entry', [42]],
		['a lone string', 'data:image/png;base64,AAAA'],
	])('rejects %s', (_label, raw) => {
		expect(parseQuickChatImages(raw)).toBeNull();
	});
});

const recentTurn = (id: string, text: string, timestamp = 1) => ({
	id,
	text,
	timestamp,
	phase: 'delivered' as const,
	error: null,
	tabId: 'tab-1',
	agentSessionId: 'conv-1',
	tabName: 'Calendar',
	origin: 'new' as const,
	queuedItemId: `q-${id}`,
	reply: [{ id: `r-${id}`, role: 'assistant' as const, text: 'answer', timestamp: timestamp + 1 }],
});

const recentChat = (id: string, updatedAt: number, turns = [recentTurn('t1', 'hello')]) =>
	({
		id,
		agentId: 'agent-1',
		agentName: 'Pedsidian',
		persistent: false,
		createdAt: 0,
		updatedAt,
		homeTabId: 'tab-1',
		homeAgentSessionId: 'conv-1',
		homeTabName: 'Calendar',
		ownedTabIds: ['tab-1'],
		turns,
	}) satisfies QuickChatRecent;

describe('parseQuickChatRecent', () => {
	it('reads a well-formed chat back unchanged', () => {
		const chat = recentChat('c1', 5);
		expect(parseQuickChatRecent(JSON.parse(JSON.stringify(chat)))).toEqual(chat);
	});

	it.each([null, 'x', {}, { id: 'c1', agentId: 'a', createdAt: 0, updatedAt: 0, turns: [] }])(
		'rejects %j',
		(raw) => {
			expect(parseQuickChatRecent(raw)).toBeNull();
		}
	);

	it('drops reasoning and malformed entries, keeping the rest', () => {
		const chat = recentChat('c1', 5);
		const raw = {
			...chat,
			ownedTabIds: ['tab-1', 7],
			turns: [
				{ bogus: true },
				{
					...chat.turns[0],
					phase: 'searching',
					origin: 'sideways',
					reply: [
						{ id: 'th', role: 'thinking', text: 'hmm', timestamp: 1 },
						...chat.turns[0].reply,
					],
				},
			],
		};
		const parsed = parseQuickChatRecent(raw)!;
		expect(parsed.ownedTabIds).toEqual(['tab-1']);
		expect(parsed.turns).toHaveLength(1);
		expect(parsed.turns[0]).toMatchObject({ phase: 'delivered', origin: null });
		expect(parsed.turns[0].reply.map((m) => m.role)).toEqual(['assistant']);
	});

	it('clips long texts and keeps only the latest messages', () => {
		const turns = Array.from({ length: QUICK_CHAT_RECENT_MAX_TURNS + 5 }, (_, i) =>
			recentTurn(`t${i}`, i === QUICK_CHAT_RECENT_MAX_TURNS + 4 ? 'x'.repeat(30_000) : 'm')
		);
		const parsed = parseQuickChatRecent(recentChat('c1', 5, turns))!;
		expect(parsed.turns).toHaveLength(QUICK_CHAT_RECENT_MAX_TURNS);
		expect(parsed.turns[0].id).toBe('t5');
		expect(parsed.turns.at(-1)!.text.length).toBe(QUICK_CHAT_RECENT_MAX_TEXT + 1);
	});
});

describe('upsertQuickChatRecent', () => {
	it('replaces a chat in place of its old copy, newest activity first', () => {
		const list = [recentChat('a', 30), recentChat('b', 20), recentChat('c', 10)];
		const next = upsertQuickChatRecent(list, recentChat('c', 40));
		expect(next.map((r) => r.id)).toEqual(['c', 'a', 'b']);
	});

	it('keeps at most the newest QUICK_CHAT_MAX_RECENTS', () => {
		let list: QuickChatRecent[] = [];
		for (let i = 0; i <= QUICK_CHAT_MAX_RECENTS; i++) {
			list = upsertQuickChatRecent(list, recentChat(`c${i}`, i));
		}
		expect(list).toHaveLength(QUICK_CHAT_MAX_RECENTS);
		expect(list.some((r) => r.id === 'c0')).toBe(false);
	});
});

describe('summarizeQuickChatRecent', () => {
	it("titles a chat with its first message's first line", () => {
		const chat = recentChat('c1', 5, [
			recentTurn('t1', '  plan the trip\nwith details  '),
			recentTurn('t2', 'and the hotel'),
		]);
		expect(summarizeQuickChatRecent(chat)).toMatchObject({
			id: 'c1',
			title: 'plan the trip',
			tabName: 'Calendar',
			messageCount: 2,
			searchText: '  plan the trip\nwith details  \nand the hotel',
		});
	});

	it('titles an images-only chat', () => {
		expect(summarizeQuickChatRecent(recentChat('c1', 5, [recentTurn('t1', '')])).title).toBe(
			'Image'
		);
	});
});

describe('resolveQuickChatRecentRef', () => {
	const list = [{ id: 'abc-1' }, { id: 'abd-2' }, { id: 'xyz-3' }];

	it.each([
		['abd-2', 'abd-2'],
		['1', 'abc-1'],
		[' 3 ', 'xyz-3'],
		['xy', 'xyz-3'],
	])('%j names %s', (ref, id) => {
		expect(resolveQuickChatRecentRef(list, ref)).toEqual({ id });
	});

	it.each([
		['', /Give a chat id/],
		['4', /no chat 4/],
		['0', /no chat 0/],
		['ab', /more than one/],
		['nope', /No recent chat nope/],
	])('%j is an error', (ref, error) => {
		const result = resolveQuickChatRecentRef(list, ref);
		expect('error' in result && result.error).toMatch(error);
	});
});
