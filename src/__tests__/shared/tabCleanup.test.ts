/**
 * @file tabCleanup.test.ts
 * @description The shared half of tab cleanup suggestions: the deterministic
 * guard, the reply parser, which tabs the model is shown, and the text it is
 * shown. The guard is the part with consequences, so it gets the most cases:
 * whatever a model writes, a busy, starred, or drafting tab is never suggested.
 */

import { describe, it, expect } from 'vitest';

import {
	TAB_CLEANUP_MAX_CANDIDATES,
	TAB_CLEANUP_MAX_SNOOZED,
	TAB_CLEANUP_MAX_SUGGESTIONS,
	TAB_CLEANUP_REASON_MAX_LENGTH,
	TAB_CLEANUP_REPLY_SCHEMA,
	describeTabCleanupCoverage,
	describeTabCleanupProtection,
	formatTabCleanupAge,
	formatTabCleanupInput,
	guardTabCleanupSuggestions,
	isTabCleanupAction,
	isTabCleanupActionValidFor,
	parseTabCleanupReply,
	rebindTabCleanupCandidates,
	selectTabCleanupCandidates,
	tabCleanupApplyCommand,
	tabCleanupProtection,
	tabCleanupQuestionId,
	tabCleanupRef,
	tabCleanupReplyFromSystemOne,
	tabCleanupSystemOneRequest,
	TAB_CLEANUP_KEEP_OPTION,
	type RawTabCleanupSuggestion,
	type TabCleanupCandidate,
	type TabCleanupTab,
} from '../../shared/tabCleanup';
import {
	systemOneQuestionsProblem,
	systemOneStateProblem,
	type SystemOneAnswers,
} from '../../shared/local-models/system-one';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function openTab(overrides: Partial<TabCleanupTab> = {}): TabCleanupTab {
	return {
		agentId: 'agent-1',
		agentName: 'Backend',
		tabId: 'tab-1',
		kind: 'open',
		tabType: 'ai',
		label: 'Fix login bug',
		lastActivityAt: NOW - 20 * DAY,
		messageCount: 4,
		busy: false,
		starred: false,
		hasDraft: false,
		...overrides,
	};
}

function snoozedTab(overrides: Partial<TabCleanupTab> = {}): TabCleanupTab {
	return openTab({
		tabId: 'tab-s',
		kind: 'snoozed',
		snoozeId: 'snooze-1',
		label: 'Migration plan',
		wakeAt: NOW - DAY,
		...overrides,
	});
}

function candidate(ref: string, overrides: Partial<TabCleanupTab> = {}): TabCleanupCandidate {
	return { ...openTab(overrides), ref };
}

function raw(
	ref: string,
	action: RawTabCleanupSuggestion['action'],
	reason = 'Old.'
): RawTabCleanupSuggestion {
	return { ref, action, reason };
}

describe('tabCleanupProtection', () => {
	it('lets an idle, unstarred, empty-composer tab through', () => {
		expect(tabCleanupProtection({ busy: false, starred: false, hasDraft: false })).toBeNull();
	});

	it('names the reason, busy first', () => {
		expect(tabCleanupProtection({ busy: true, starred: true, hasDraft: true })).toBe('busy');
		expect(tabCleanupProtection({ busy: false, starred: true, hasDraft: true })).toBe('starred');
		expect(tabCleanupProtection({ busy: false, starred: false, hasDraft: true })).toBe('draft');
	});

	it('has a sentence for every reason', () => {
		for (const protection of ['busy', 'starred', 'draft'] as const) {
			expect(describeTabCleanupProtection(protection)).toMatch(/\.$/);
		}
	});
});

describe('guardTabCleanupSuggestions', () => {
	it('keeps a valid suggestion and carries the real ids', () => {
		const { suggestions, dropped } = guardTabCleanupSuggestions(
			[raw('T1', 'close', 'Untouched for weeks.')],
			[candidate('T1')]
		);
		expect(dropped).toEqual([]);
		expect(suggestions).toEqual([
			{
				tabId: 'tab-1',
				agentId: 'agent-1',
				action: 'close',
				reason: 'Untouched for weeks.',
				agentName: 'Backend',
				label: 'Fix login bug',
				kind: 'open',
				tabType: 'ai',
				lastActivityAt: NOW - 20 * DAY,
				messageCount: 4,
			},
		]);
	});

	it.each([
		['busy', { busy: true }],
		['starred', { starred: true }],
		['draft', { hasDraft: true }],
	] as const)('drops a suggestion for a %s tab whatever the model said', (why, facts) => {
		for (const action of ['close', 'snooze'] as const) {
			const { suggestions, dropped } = guardTabCleanupSuggestions(
				[raw('T1', action)],
				[candidate('T1', facts)]
			);
			expect(suggestions).toEqual([]);
			expect(dropped).toEqual([{ ref: 'T1', action, why }]);
		}
	});

	it('drops a wake for a starred or drafting snoozed tab too', () => {
		const starred = { ...snoozedTab({ starred: true }), ref: 'T1' };
		const drafting = { ...snoozedTab({ hasDraft: true, snoozeId: 'snooze-2' }), ref: 'T2' };
		const { suggestions, dropped } = guardTabCleanupSuggestions(
			[raw('T1', 'wake'), raw('T2', 'wake')],
			[starred, drafting]
		);
		expect(suggestions).toEqual([]);
		expect(dropped.map((drop) => drop.why)).toEqual(['starred', 'draft']);
	});

	it('drops a handle that names no tab', () => {
		const { suggestions, dropped } = guardTabCleanupSuggestions(
			[raw('T9', 'close')],
			[candidate('T1')]
		);
		expect(suggestions).toEqual([]);
		expect(dropped).toEqual([{ ref: 'T9', action: 'close', why: 'unknown-tab' }]);
	});

	it('drops an action that does not fit the tab', () => {
		const { suggestions, dropped } = guardTabCleanupSuggestions(
			[raw('T1', 'wake'), raw('T2', 'close'), raw('T2', 'snooze')],
			[candidate('T1'), { ...snoozedTab(), ref: 'T2' }]
		);
		expect(suggestions).toEqual([]);
		expect(dropped.map((drop) => drop.why)).toEqual([
			'wrong-action',
			'wrong-action',
			'wrong-action',
		]);
	});

	it('keeps a wake with its snooze id and wake time', () => {
		const { suggestions } = guardTabCleanupSuggestions(
			[raw('T1', 'wake')],
			[{ ...snoozedTab(), ref: 'T1' }]
		);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toMatchObject({
			action: 'wake',
			kind: 'snoozed',
			snoozeId: 'snooze-1',
			wakeAt: NOW - DAY,
		});
	});

	it('drops a wake that has no snooze to name', () => {
		const { suggestions, dropped } = guardTabCleanupSuggestions(
			[raw('T1', 'wake')],
			[{ ...snoozedTab({ snoozeId: undefined }), ref: 'T1' }]
		);
		expect(suggestions).toEqual([]);
		expect(dropped[0].why).toBe('unknown-tab');
	});

	it('keeps the first suggestion for a tab and drops the rest', () => {
		const { suggestions, dropped } = guardTabCleanupSuggestions(
			[raw('T1', 'snooze', 'First.'), raw('t1', 'close', 'Second.')],
			[candidate('T1')]
		);
		expect(suggestions.map((s) => s.action)).toEqual(['snooze']);
		expect(dropped).toEqual([{ ref: 't1', action: 'close', why: 'duplicate' }]);
	});

	it('caps how many suggestions survive', () => {
		const candidates = Array.from({ length: TAB_CLEANUP_MAX_SUGGESTIONS + 3 }, (_, i) =>
			candidate(tabCleanupRef(i), { tabId: `tab-${i}` })
		);
		const { suggestions, dropped } = guardTabCleanupSuggestions(
			candidates.map((c) => raw(c.ref, 'close')),
			candidates
		);
		expect(suggestions).toHaveLength(TAB_CLEANUP_MAX_SUGGESTIONS);
		expect(dropped).toHaveLength(3);
		expect(dropped.every((drop) => drop.why === 'over-limit')).toBe(true);
	});
});

describe('rebindTabCleanupCandidates', () => {
	it('takes the fresh facts and keeps the handle', () => {
		const shown = [candidate('T1'), candidate('T2', { tabId: 'tab-2' })];
		const fresh = [openTab({ tabId: 'tab-2', busy: true }), openTab({ hasDraft: true })];

		const rebound = rebindTabCleanupCandidates(shown, fresh);

		expect(rebound.map((c) => [c.ref, c.tabId, c.busy, c.hasDraft])).toEqual([
			['T1', 'tab-1', false, true],
			['T2', 'tab-2', true, false],
		]);
	});

	it('leaves out a tab that is no longer there, so a suggestion for it names nothing', () => {
		const shown = [candidate('T1'), candidate('T2', { tabId: 'tab-2' })];
		const rebound = rebindTabCleanupCandidates(shown, [openTab({ tabId: 'tab-2' })]);

		expect(rebound.map((c) => c.ref)).toEqual(['T2']);
		expect(guardTabCleanupSuggestions([raw('T1', 'close')], rebound).dropped[0].why).toBe(
			'unknown-tab'
		);
	});

	it('does not confuse the same tab id on two agents, or an open tab with a parked one', () => {
		const shown = [candidate('T1'), { ...snoozedTab({ tabId: 'tab-1' }), ref: 'T2' }];
		const fresh = [
			openTab({ agentId: 'agent-2', starred: true }),
			snoozedTab({ tabId: 'tab-1', starred: true }),
		];

		const rebound = rebindTabCleanupCandidates(shown, fresh);

		// agent-1's open tab is gone; the parked one is matched by its snooze id.
		expect(rebound.map((c) => [c.ref, c.kind, c.starred])).toEqual([['T2', 'snoozed', true]]);
	});

	it('is what catches a tab that became busy while the model was thinking', () => {
		const shown = selectTabCleanupCandidates([openTab()]).shown;
		const rebound = rebindTabCleanupCandidates(shown, [openTab({ busy: true })]);

		const { suggestions, dropped } = guardTabCleanupSuggestions([raw('T1', 'close')], rebound);

		expect(suggestions).toEqual([]);
		expect(dropped[0].why).toBe('busy');
	});
});

describe('parseTabCleanupReply', () => {
	it('reads the reply object', () => {
		expect(
			parseTabCleanupReply({
				suggestions: [{ tab: 't2', action: 'close', reason: '  Empty\n tab.  ' }],
			})
		).toEqual([{ ref: 'T2', action: 'close', reason: 'Empty tab.' }]);
	});

	it('treats an empty list as an answer, not a failure', () => {
		expect(parseTabCleanupReply({ suggestions: [] })).toEqual([]);
	});

	it.each([undefined, null, 'close T1', [], { suggestion: [] }, { suggestions: 'none' }])(
		'refuses a reply that is not the object: %j',
		(reply) => {
			expect(parseTabCleanupReply(reply)).toBeNull();
		}
	);

	it('skips a malformed entry and keeps the rest', () => {
		expect(
			parseTabCleanupReply({
				suggestions: [
					null,
					'T1',
					{ tab: 'T1', action: 'delete', reason: 'x' },
					{ tab: 5, action: 'close' },
					{ tab: '  ', action: 'close' },
					{ tab: 'T3', action: 'snooze' },
				],
			})
		).toEqual([{ ref: 'T3', action: 'snooze', reason: '' }]);
	});

	it('caps a long reason', () => {
		const [suggestion] = parseTabCleanupReply({
			suggestions: [{ tab: 'T1', action: 'close', reason: 'x'.repeat(500) }],
		})!;
		expect(suggestion.reason).toHaveLength(TAB_CLEANUP_REASON_MAX_LENGTH);
		expect(suggestion.reason.endsWith('...')).toBe(true);
	});
});

describe('selectTabCleanupCandidates', () => {
	it('leaves protected tabs out and counts them', () => {
		const selection = selectTabCleanupCandidates([
			openTab({ tabId: 'a' }),
			openTab({ tabId: 'b', busy: true }),
			openTab({ tabId: 'c', starred: true }),
			openTab({ tabId: 'd', hasDraft: true }),
		]);
		expect(selection.shown.map((c) => c.tabId)).toEqual(['a']);
		expect(selection.protectedCount).toBe(3);
		expect(selection.truncated).toBe(false);
	});

	it('numbers what it shows, open tabs oldest first, then snoozed', () => {
		const selection = selectTabCleanupCandidates([
			openTab({ tabId: 'new', lastActivityAt: NOW - DAY }),
			snoozedTab({ tabId: 'parked' }),
			openTab({ tabId: 'old', lastActivityAt: NOW - 30 * DAY }),
		]);
		expect(selection.shown.map((c) => [c.ref, c.tabId])).toEqual([
			['T1', 'old'],
			['T2', 'new'],
			['T3', 'parked'],
		]);
	});

	it('keeps the oldest tabs when there are more than fit', () => {
		const tabs = Array.from({ length: TAB_CLEANUP_MAX_CANDIDATES + 5 }, (_, i) =>
			openTab({ tabId: `tab-${i}`, lastActivityAt: NOW - i * DAY })
		);
		const selection = selectTabCleanupCandidates(tabs);

		expect(selection.shown).toHaveLength(TAB_CLEANUP_MAX_CANDIDATES);
		expect(selection.truncated).toBe(true);
		// The five newest (smallest i) are the ones left out.
		expect(selection.shown.some((c) => c.tabId === 'tab-0')).toBe(false);
		expect(selection.shown[0].tabId).toBe(`tab-${TAB_CLEANUP_MAX_CANDIDATES + 4}`);
	});

	it('gives snoozed tabs a bounded share', () => {
		const tabs = [
			...Array.from({ length: TAB_CLEANUP_MAX_SNOOZED + 4 }, (_, i) =>
				snoozedTab({ tabId: `s-${i}`, snoozeId: `snooze-${i}` })
			),
			...Array.from({ length: TAB_CLEANUP_MAX_CANDIDATES }, (_, i) => openTab({ tabId: `o-${i}` })),
		];
		const selection = selectTabCleanupCandidates(tabs);

		expect(selection.shown).toHaveLength(TAB_CLEANUP_MAX_CANDIDATES);
		expect(selection.shown.filter((c) => c.kind === 'snoozed')).toHaveLength(
			TAB_CLEANUP_MAX_SNOOZED
		);
		expect(selection.truncated).toBe(true);
	});

	it('never hands out a handle the reply schema cannot name', () => {
		const tabs = Array.from({ length: TAB_CLEANUP_MAX_CANDIDATES + 20 }, (_, i) =>
			openTab({ tabId: `tab-${i}` })
		);
		const schema = TAB_CLEANUP_REPLY_SCHEMA as {
			properties: { suggestions: { items: { properties: { tab: { enum: string[] } } } } };
		};
		const allowed = new Set(schema.properties.suggestions.items.properties.tab.enum);
		for (const shown of selectTabCleanupCandidates(tabs).shown) {
			expect(allowed.has(shown.ref)).toBe(true);
		}
	});
});

describe('formatTabCleanupInput', () => {
	it('writes one line of facts per tab, and no real id', () => {
		const shown = selectTabCleanupCandidates([
			openTab({ summary: 'now add\nthe tests' }),
			snoozedTab({ note: 'after the release', tabType: 'file', messageCount: 0 }),
		]).shown;

		const text = formatTabCleanupInput(shown, NOW);
		const lines = text.split('\n');

		expect(lines[0]).toBe('Tabs:');
		expect(lines).toHaveLength(3);
		expect(lines[1]).toBe(
			'T1 | open | agent "Backend" | "Fix login bug" | last active 2 weeks ago | 4 messages | last asked: now add the tests'
		);
		expect(lines[2]).toMatch(/^T2 \| snoozed until .+ \| agent "Backend" \| "Migration plan" \| /);
		expect(lines[2]).toContain('| file | note: after the release');
		expect(text).not.toContain('tab-1');
		expect(text).not.toContain('agent-1');
		expect(text).not.toContain('snooze-1');
	});

	it('caps a long name so one tab cannot spend the context', () => {
		const shown = selectTabCleanupCandidates([openTab({ label: 'x'.repeat(400) })]).shown;
		const line = formatTabCleanupInput(shown, NOW).split('\n')[1];
		expect(line.length).toBeLessThanOrEqual(220);
	});

	it('says "1 message" for one', () => {
		const shown = selectTabCleanupCandidates([openTab({ messageCount: 1 })]).shown;
		expect(formatTabCleanupInput(shown, NOW)).toContain('| 1 message');
	});
});

describe('formatTabCleanupAge', () => {
	it('reads as one unit', () => {
		expect(formatTabCleanupAge(NOW - 30_000, NOW)).toBe('just now');
		expect(formatTabCleanupAge(NOW - 3 * 60 * 60 * 1000, NOW)).toBe('3 hours ago');
		expect(formatTabCleanupAge(NOW - 2 * DAY, NOW)).toBe('2 days ago');
	});

	it('does not report a future or missing time as an age', () => {
		expect(formatTabCleanupAge(NOW + DAY, NOW)).toBe('just now');
		expect(formatTabCleanupAge(Number.NaN, NOW)).toBe('just now');
	});
});

describe('helpers', () => {
	it('knows the three actions', () => {
		expect(isTabCleanupAction('close')).toBe(true);
		expect(isTabCleanupAction('wake')).toBe(true);
		expect(isTabCleanupAction('delete')).toBe(false);
		expect(isTabCleanupAction(undefined)).toBe(false);
	});

	it('pairs each action with the kind of tab it applies to', () => {
		expect(isTabCleanupActionValidFor('close', 'open')).toBe(true);
		expect(isTabCleanupActionValidFor('snooze', 'open')).toBe(true);
		expect(isTabCleanupActionValidFor('wake', 'open')).toBe(false);
		expect(isTabCleanupActionValidFor('wake', 'snoozed')).toBe(true);
		expect(isTabCleanupActionValidFor('close', 'snoozed')).toBe(false);
	});

	it('names the command that applies a suggestion', () => {
		const base = { tabId: 'tab-1', agentId: 'agent-1' };
		expect(tabCleanupApplyCommand({ ...base, action: 'close' })).toBe(
			'maestro-cli tab close tab-1'
		);
		expect(tabCleanupApplyCommand({ ...base, action: 'snooze' })).toBe(
			'maestro-cli snooze tab tab-1 <when> --agent agent-1'
		);
		expect(tabCleanupApplyCommand({ ...base, action: 'wake', snoozeId: 'snooze-1' })).toBe(
			'maestro-cli snooze wake snooze-1'
		);
	});

	it('describes what a run looked at', () => {
		const result = {
			success: true as const,
			suggestions: [],
			considered: 1,
			protectedCount: 0,
			droppedCount: 0,
			truncated: false,
		};
		expect(describeTabCleanupCoverage(result)).toBe('1 tab reviewed');
		expect(
			describeTabCleanupCoverage({ ...result, considered: 40, protectedCount: 3, truncated: true })
		).toBe(
			'40 tabs reviewed, 3 left out (busy, starred, or with a draft), more tabs than fit, the oldest were reviewed'
		);
	});
});

describe('tab cleanup on System One', () => {
	const JEV = 'Jev (TypeSafe cloud)';
	const shown = selectTabCleanupCandidates([
		openTab({ tabId: 'tab-old', label: 'Old spike', lastActivityAt: NOW - 30 * DAY }),
		openTab({ tabId: 'tab-quiet', label: 'Migration', lastActivityAt: NOW - 9 * DAY }),
		snoozedTab({ tabId: 'tab-parked', snoozeId: 'snooze-9', note: 'after the release' }),
	]).shown;
	const pick = (choice: string, probability?: number) => ({
		type: 'choice' as const,
		choice,
		...(probability !== undefined ? { probabilities: { [choice]: probability } } : {}),
	});

	it('keys each question by the real id: the tab id, or the snooze id for a parked tab', () => {
		expect(shown.map(tabCleanupQuestionId)).toEqual(['tab-old', 'tab-quiet', 'snooze-9']);
		// A parked entry with no snooze id still gets a key of its own.
		expect(tabCleanupQuestionId({ kind: 'snoozed', tabId: 'tab-x' })).toBe('tab-x');
	});

	it('asks one choice per tab, with the tab facts inside its own question and no handle', () => {
		const request = tabCleanupSystemOneRequest({ candidates: shown, now: NOW });
		expect(systemOneStateProblem(request.state)).toBeNull();
		expect(systemOneQuestionsProblem(request.questions)).toBeNull();
		expect(Object.keys(request.questions)).toEqual(['tab-old', 'tab-quiet', 'snooze-9']);

		const open = request.questions['tab-old'];
		expect(open.type).toBe('choice');
		expect(open.instructions).toBe(
			'What should be done with this tab? open | agent "Backend" | "Old spike" | last active 4 weeks ago | 4 messages'
		);
		expect(open.instructions).not.toMatch(/\bT1\b/);
		expect(Object.keys(open.criteria ?? {})).toEqual(['close', 'snooze', TAB_CLEANUP_KEEP_OPTION]);
	});

	it('offers a parked tab wake or keep, so an action that means nothing cannot be answered', () => {
		const request = tabCleanupSystemOneRequest({ candidates: shown, now: NOW });
		const parked = request.questions['snooze-9'];
		expect(Object.keys(parked.criteria ?? {})).toEqual(['wake', TAB_CLEANUP_KEEP_OPTION]);
		expect(parked.instructions).toContain('note: after the release');
	});

	it('asks nothing about no tabs', () => {
		expect(tabCleanupSystemOneRequest({ candidates: [], now: NOW }).questions).toEqual({});
	});

	it('reads the answers as raw suggestions on the handles the guard knows, and keep as nothing', () => {
		const answers: SystemOneAnswers = {
			'tab-old': pick('close', 0.871),
			'tab-quiet': pick(TAB_CLEANUP_KEEP_OPTION, 0.7),
			'snooze-9': pick('wake'),
		};
		const reply = tabCleanupReplyFromSystemOne(answers, shown, JEV);
		expect(reply).toEqual([
			{ ref: 'T1', action: 'close', reason: `${JEV} chose close, 87% likely.` },
			// An engine that reports no distribution (the local judge) gives no number.
			{ ref: 'T3', action: 'wake', reason: `${JEV} chose wake.` },
		]);

		const { suggestions, dropped } = guardTabCleanupSuggestions(reply!, shown);
		expect(dropped).toEqual([]);
		expect(suggestions.map((s) => [s.tabId, s.action, s.snoozeId])).toEqual([
			['tab-old', 'close', undefined],
			['tab-parked', 'wake', 'snooze-9'],
		]);
	});

	it('leaves the guard the last word on an answer for a tab that became protected', () => {
		const reply = tabCleanupReplyFromSystemOne({ 'tab-old': pick('close') }, shown, JEV);
		const now = shown.map((c) => (c.tabId === 'tab-old' ? { ...c, busy: true } : c));
		expect(guardTabCleanupSuggestions(reply!, now)).toEqual({
			suggestions: [],
			dropped: [{ ref: 'T1', action: 'close', why: 'busy' }],
		});
	});

	it('skips a tab with no usable answer, and an option that is not an action', () => {
		const answers: SystemOneAnswers = {
			'tab-old': { type: 'noul', probability: 0.9 },
			'tab-quiet': pick('archive'),
			'snooze-9': pick('wake'),
		};
		expect(tabCleanupReplyFromSystemOne(answers, shown, JEV)).toEqual([
			{ ref: 'T3', action: 'wake', reason: `${JEV} chose wake.` },
		]);
	});

	it('is unusable when no tab got a choice at all, and an empty list when every tab is kept', () => {
		expect(tabCleanupReplyFromSystemOne({}, shown, JEV)).toBeNull();
		expect(
			tabCleanupReplyFromSystemOne(
				Object.fromEntries(shown.map((c) => [tabCleanupQuestionId(c), pick('keep')])),
				shown,
				JEV
			)
		).toEqual([]);
		expect(tabCleanupReplyFromSystemOne({}, [], JEV)).toEqual([]);
	});

	it('keeps a reason inside the cap a model reason is held to', () => {
		const reply = tabCleanupReplyFromSystemOne(
			{ 'tab-old': pick('close') },
			shown,
			'Local judge (a very long model name) '.repeat(8)
		);
		expect(reply![0].reason.length).toBeLessThanOrEqual(TAB_CLEANUP_REASON_MAX_LENGTH);
	});
});
