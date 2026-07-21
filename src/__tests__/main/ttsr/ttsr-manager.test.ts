/**
 * Tests for `TtsrManager` (Phase 2 verification, detection only).
 *
 * Feeds synthetic `ParsedEvent` sequences shaped like each agent's real parser
 * output (claude whole-block text + `toolUseBlocks`, codex reasoning partials,
 * opencode end-of-turn `result` + `toolState.input`, copilot deltas) and
 * asserts the right rules fire with the right source and disposition.
 */

import { describe, it, expect, vi } from 'vitest';
import { TtsrManager, type TtsrObserveContext } from '../../../main/ttsr/ttsr-manager';
import { TtsrStateStore } from '../../../main/ttsr/ttsr-state-store';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';
import type { LoadedTtsrRule, TtsrMatchedPayload } from '../../../shared/ttsr-types';

const CWD = '/repo';

function makeRule(overrides: Partial<LoadedTtsrRule> = {}): LoadedTtsrRule {
	const condition = overrides.condition ?? ['console\\.log\\('];
	return {
		name: 'no-console-log',
		description: 'Flag stray console.log',
		condition,
		astCondition: [],
		scope: ['text', 'thinking'],
		globs: [],
		interruptMode: 'always',
		repeatMode: 'after-gap',
		repeatGap: 3,
		agents: ['claude-code', 'codex', 'opencode', 'copilot-cli', 'factory-droid', 'grok'],
		content: 'Use the project logger.',
		path: '.maestro/rules/no-console-log.md',
		compiledCondition: condition.map((source) => new RegExp(source)),
		...overrides,
	};
}

function setup(
	rules: LoadedTtsrRule[],
	options: { enabled?: boolean; store?: TtsrStateStore } = {}
): { manager: TtsrManager; matched: TtsrMatchedPayload[]; getRules: ReturnType<typeof vi.fn> } {
	const matched: TtsrMatchedPayload[] = [];
	const getRules = vi.fn(() => rules);
	const manager = new TtsrManager({
		getRules,
		isEnabled: () => options.enabled !== false,
		onMatched: (payload) => matched.push(payload),
		store: options.store,
	});
	return { manager, matched, getRules };
}

const ctx = (agentId: TtsrObserveContext['agentId']): TtsrObserveContext => ({ agentId, cwd: CWD });

describe('TtsrManager prose matching', () => {
	it('matches a claude-code whole-block text event', () => {
		const { manager, matched } = setup([makeRule()]);
		const event: ParsedEvent = { type: 'text', text: 'I will add console.log(x) here' };

		const matches = manager.observe('s1', event, ctx('claude-code'));

		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe('text');
		expect(matches[0].disposition).toBe('interrupt');
		expect(matches[0].matchedText).toBe('console.log(');
		expect(matched).toEqual([
			{
				sessionId: 's1',
				agentId: 'claude-code',
				source: 'text',
				rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
				willInterrupt: true,
				filePath: undefined,
			},
		]);
	});

	it('routes reasoning deltas to the thinking scope', () => {
		const textOnly = makeRule({ name: 'text-only', scope: ['text'] });
		const thinkingOnly = makeRule({ name: 'thinking-only', scope: ['thinking'] });
		const { manager } = setup([textOnly, thinkingOnly]);

		const matches = manager.observe(
			's1',
			{ type: 'text', text: 'maybe console.log(x)?', isPartial: true, isReasoning: true },
			ctx('codex')
		);

		expect(matches.map((m) => m.rule.name)).toEqual(['thinking-only']);
		expect(matches[0].source).toBe('thinking');
	});

	it('matches a pattern split across two streamed partials', () => {
		const { manager } = setup([makeRule()]);
		const agent = ctx('copilot-cli');

		expect(
			manager.observe('s1', { type: 'text', text: 'call conso', isPartial: true }, agent)
		).toEqual([]);
		const matches = manager.observe(
			's1',
			{ type: 'text', text: 'le.log(x) now', isPartial: true },
			agent
		);

		expect(matches.map((m) => m.matchedText)).toEqual(['console.log(']);
	});

	it('matches an opencode end-of-turn result and advances the turn counter', () => {
		const store = new TtsrStateStore();
		const { manager } = setup([makeRule()], { store });

		// Tier B: opencode has no live prose stream, so its whole answer arrives as
		// one final `result` event - the ordinary observe path, not a special case.
		const matches = manager.observe(
			's1',
			{ type: 'result', text: 'done, left console.log(x) in place' },
			ctx('opencode')
		);

		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe('text');

		manager.endTurn('s1');
		expect(store.getMessageCount('s1|-')).toBe(1);
	});

	it('does not re-fire the same rule on later deltas of the same turn', () => {
		const { manager } = setup([makeRule()]);
		const agent = ctx('claude-code');

		expect(manager.observe('s1', { type: 'text', text: 'console.log(a)' }, agent)).toHaveLength(1);
		expect(manager.observe('s1', { type: 'text', text: 'console.log(b)' }, agent)).toEqual([]);
	});

	it('re-fires an after-gap rule once the gap has elapsed', () => {
		const { manager } = setup([makeRule({ repeatGap: 2 })]);
		const agent = ctx('claude-code');

		expect(manager.observe('s1', { type: 'text', text: 'console.log(a)' }, agent)).toHaveLength(1);
		manager.endTurn('s1');
		expect(manager.observe('s1', { type: 'text', text: 'console.log(b)' }, agent)).toEqual([]);
		manager.endTurn('s1');
		expect(manager.observe('s1', { type: 'text', text: 'console.log(c)' }, agent)).toHaveLength(1);
	});
});

describe('TtsrManager gating', () => {
	it('is a complete no-op when TTSR is disabled', () => {
		const { manager, matched, getRules } = setup([makeRule()], { enabled: false });

		expect(
			manager.observe('s1', { type: 'text', text: 'console.log(x)' }, ctx('claude-code'))
		).toEqual([]);
		expect(getRules).not.toHaveBeenCalled();
		expect(matched).toEqual([]);
	});

	it('skips rules whose agents set excludes the running agent', () => {
		const { manager } = setup([makeRule({ agents: ['claude-code'] })]);

		expect(manager.observe('s1', { type: 'text', text: 'console.log(x)' }, ctx('grok'))).toEqual(
			[]
		);
	});

	it('does nothing when the project has no rules', () => {
		const { manager, matched } = setup([]);

		expect(manager.observe('s1', { type: 'text', text: 'console.log(x)' }, ctx('codex'))).toEqual(
			[]
		);
		expect(matched).toEqual([]);
	});

	// The runtime resolves the gate and rules once per event and threads them
	// through the context; the deps are only a fallback for callers that do not.
	it('uses a pre-resolved gate and rule set without touching the deps', () => {
		const { manager, getRules } = setup([], { enabled: false });
		const resolved = { enabled: true, rules: [makeRule()] };

		const matches = manager.observe(
			's1',
			{ type: 'text', text: 'console.log(x)' },
			{ ...ctx('claude-code'), resolved }
		);

		expect(matches).toHaveLength(1);
		expect(getRules).not.toHaveBeenCalled();
	});

	it('honours a pre-resolved disabled gate over enabled deps', () => {
		const { manager, getRules } = setup([makeRule()]);

		expect(
			manager.observe(
				's1',
				{ type: 'text', text: 'console.log(x)' },
				{ ...ctx('claude-code'), resolved: { enabled: false, rules: [makeRule()] } }
			)
		).toEqual([]);
		expect(getRules).not.toHaveBeenCalled();
	});
});

describe('TtsrManager tool-source matching', () => {
	const toolRule = makeRule({
		name: 'no-console-in-src',
		scope: ['tool:edit', 'tool:write'],
		globs: ['src/**/*.ts'],
	});

	it('matches a claude-code Write block and reports the file path', () => {
		const { manager } = setup([toolRule]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{
					name: 'Write',
					id: 't1',
					input: { file_path: '/repo/src/a.ts', content: 'console.log(1)\n' },
				},
			],
		};

		const matches = manager.observe('s1', event, ctx('claude-code'));

		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe('tool:write');
		expect(matches[0].filePath).toBe('/repo/src/a.ts');
	});

	it('rejects an edit outside the rule globs', () => {
		const { manager } = setup([toolRule]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{ name: 'Edit', input: { file_path: '/repo/docs/a.md', new_string: 'console.log(1)' } },
			],
		};

		expect(manager.observe('s1', event, ctx('claude-code'))).toEqual([]);
	});

	it('matches an opencode toolState edit', () => {
		const { manager } = setup([toolRule]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'edit',
			toolState: { status: 'running', input: { filePath: 'src/b.ts', content: 'console.log(2)' } },
		};

		const matches = manager.observe('s1', event, ctx('opencode'));

		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe('tool:edit');
	});

	it('classifies a non-interrupting tool match as a deferred tool reminder', () => {
		const { manager } = setup([makeRule({ ...toolRule, interruptMode: 'prose-only' })]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{ name: 'Write', input: { file_path: 'src/a.ts', content: 'console.log(1)' } },
			],
		};

		const matches = manager.observe('s1', event, ctx('claude-code'));

		expect(matches[0].disposition).toBe('deferred-tool');
		expect(manager.takeInterrupts('s1')).toEqual([]);
		expect(manager.takeDeferred('s1')).toHaveLength(1);
	});
});

describe('TtsrManager shell command matching', () => {
	// The rule shape a user reaches for when they mean "never do X".
	const bashRule = makeRule({
		name: 'no-force-push',
		condition: ['git push .*--force'],
		compiledCondition: [/git push .*--force/],
		scope: ['tool:bash'],
		content: 'Never force-push a shared branch.',
	});

	it('matches the command a claude-code Bash call is about to run', () => {
		const { manager } = setup([bashRule]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [{ name: 'Bash', input: { command: 'git push --force origin main' } }],
		};

		const matches = manager.observe('s1', event, ctx('claude-code'));

		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe('tool:bash');
		expect(matches[0].disposition).toBe('interrupt');
		expect(matches[0].matchedText).toBe('git push --force');
	});

	it('matches a codex shell call', () => {
		const { manager } = setup([bashRule]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'shell',
			toolState: { status: 'running', input: { command: 'git push --force' } },
		};

		expect(manager.observe('s1', event, ctx('codex'))).toHaveLength(1);
	});

	it('does not match the same command against a prose rule', () => {
		const proseRule = makeRule({
			name: 'prose-only-rule',
			condition: ['git push .*--force'],
			compiledCondition: [/git push .*--force/],
			scope: ['text', 'thinking'],
		});
		const { manager } = setup([proseRule]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [{ name: 'Bash', input: { command: 'git push --force origin main' } }],
		};

		// Scope narrowing is the whole point: a prose rule must not silently start
		// matching commands, nor the reverse.
		expect(manager.observe('s1', event, ctx('claude-code'))).toEqual([]);
	});

	it('ignores globs on a shell rule instead of silently never firing', () => {
		const { manager } = setup([makeRule({ ...bashRule, globs: ['src/**/*.ts'] })]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [{ name: 'Bash', input: { command: 'git push --force origin main' } }],
		};

		// A command has no path, so globs cannot narrow it. Fail-closed would mean
		// the rule never fires and the user never learns why.
		expect(manager.observe('s1', event, ctx('claude-code'))).toHaveLength(1);
	});

	it('treats a shell match as tool-source for interruptMode', () => {
		const { manager } = setup([makeRule({ ...bashRule, interruptMode: 'prose-only' })]);
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [{ name: 'Bash', input: { command: 'git push --force' } }],
		};

		expect(manager.observe('s1', event, ctx('claude-code'))[0].disposition).toBe('deferred-tool');
	});
});

describe('TtsrManager buckets and provider session id', () => {
	it('splits interrupts from deferred reminders and clears each on read', () => {
		const interrupting = makeRule({ name: 'interrupting' });
		const deferring = makeRule({ name: 'deferring', interruptMode: 'never' });
		const { manager } = setup([interrupting, deferring]);

		manager.observe('s1', { type: 'text', text: 'console.log(x)' }, ctx('claude-code'));

		expect(manager.takeInterrupts('s1').map((m) => m.rule.name)).toEqual(['interrupting']);
		expect(manager.takeInterrupts('s1')).toEqual([]);
		expect(manager.takeDeferred('s1').map((m) => m.rule.name)).toEqual(['deferring']);
		expect(manager.takeDeferred('s1')).toEqual([]);
	});

	it('reports willInterrupt false when every fired rule defers', () => {
		const { manager, matched } = setup([makeRule({ interruptMode: 'never' })]);

		manager.observe('s1', { type: 'text', text: 'console.log(x)' }, ctx('claude-code'));

		expect(matched[0].willInterrupt).toBe(false);
	});

	it('adopts the provider session id from an init event so repeat state follows it', () => {
		const store = new TtsrStateStore();
		const { manager } = setup([makeRule({ repeatMode: 'once' })], { store });
		const agent = ctx('claude-code');

		manager.observe('s1', { type: 'init', sessionId: 'prov-1' }, agent);
		expect(manager.observe('s1', { type: 'text', text: 'console.log(x)' }, agent)).toHaveLength(1);

		expect(
			store.isEligible({ name: 'no-console-log', repeatMode: 'once', repeatGap: 3 }, 's1|prov-1')
		).toBe(false);
	});

	it('resets prose buffers on a new turn', () => {
		const { manager } = setup([makeRule({ condition: ['alpha\\s+beta'] })]);
		const agent = ctx('claude-code');

		manager.observe('s1', { type: 'text', text: 'alpha ' }, agent);
		manager.beginTurn('s1');
		expect(manager.observe('s1', { type: 'text', text: 'beta' }, agent)).toEqual([]);
	});

	it('drops all state for a disposed session', () => {
		const { manager } = setup([makeRule()]);
		manager.observe('s1', { type: 'text', text: 'console.log(x)' }, ctx('claude-code'));
		manager.dispose('s1');
		expect(manager.takeInterrupts('s1')).toEqual([]);
	});
});

// A forced-parallel turn spawns as `{sessionId}-ai-{tabId}-fp-{timestamp}`, so
// every one of them carries a different process id for the same conversation.
// Everything the manager tracks belongs to the tab, not to the turn.
describe('TtsrManager forced-parallel spawn ids', () => {
	const FP_ONE = 'sess-ai-tab-1-fp-1730000000000';
	const FP_TWO = 'sess-ai-tab-1-fp-1730000009999';
	const agent = ctx('claude-code');

	it('treats every fp turn of a tab as one conversation for repeat policy', () => {
		const { manager } = setup([makeRule({ repeatMode: 'once' })]);

		expect(manager.observe(FP_ONE, { type: 'text', text: 'console.log(a)' }, agent)).toHaveLength(
			1
		);
		// Without normalization this mints a fresh conversation, and `once` fires
		// again on every forced-parallel turn forever.
		expect(manager.observe(FP_TWO, { type: 'text', text: 'console.log(b)' }, agent)).toEqual([]);
		// The canonical id is the same conversation too.
		expect(
			manager.observe('sess-ai-tab-1', { type: 'text', text: 'console.log(c)' }, agent)
		).toEqual([]);
	});

	it('drains a reminder queued under one fp id on the next fp turn', () => {
		const { manager } = setup([makeRule({ interruptMode: 'never' })]);

		manager.observe(FP_ONE, { type: 'text', text: 'console.log(a)' }, agent);

		expect(manager.hasDeferred(FP_TWO)).toBe(true);
		expect(manager.takeDeferred(FP_TWO).map((match) => match.rule.name)).toEqual([
			'no-console-log',
		]);
	});

	it('records one conversation in the store, not one per fp turn', () => {
		const store = new TtsrStateStore();
		const { manager } = setup([makeRule()], { store });

		manager.observe(FP_ONE, { type: 'text', text: 'console.log(a)' }, agent);
		manager.endTurn(FP_ONE);
		manager.observe(FP_TWO, { type: 'text', text: 'console.log(b)' }, agent);
		manager.endTurn(FP_TWO);

		expect(Object.keys(store.snapshot())).toEqual(['sess-ai-tab-1|-']);
		expect(store.getMessageCount('sess-ai-tab-1|-')).toBe(2);
	});

	it('still keeps separate tabs of one agent apart', () => {
		const { manager } = setup([makeRule({ repeatMode: 'once' })]);

		expect(manager.observe(FP_ONE, { type: 'text', text: 'console.log(a)' }, agent)).toHaveLength(
			1
		);
		expect(
			manager.observe(
				'sess-ai-tab-2-fp-1730000000000',
				{ type: 'text', text: 'console.log(b)' },
				agent
			)
		).toHaveLength(1);
	});
});

describe('TtsrManager refunds', () => {
	// An announced abort that never happened cost the user no turn, so holding
	// the charge would spend the budget on nothing and degrade the rest of the
	// conversation to deferred-only.
	it('gives back an interrupt charge, never below zero', () => {
		const store = new TtsrStateStore();
		const { manager } = setup([makeRule()], { store });

		manager.noteInterrupt('s1');
		manager.noteInterrupt('s1');
		manager.refundInterrupt('s1');
		expect(store.getInterruptCount('s1|-')).toBe(1);

		manager.refundInterrupt('s1');
		manager.refundInterrupt('s1');
		expect(store.getInterruptCount('s1|-')).toBe(0);
	});

	// The firing is recorded at match time, so a `once` rule whose guidance was
	// never delivered would be silenced for the rest of the conversation.
	it('re-arms rules whose guidance never reached the agent', () => {
		const rule = makeRule({ repeatMode: 'once' });
		const { manager } = setup([rule]);
		const agent = ctx('claude-code');

		expect(manager.observe('s1', { type: 'text', text: 'console.log(a)' }, agent)).toHaveLength(1);
		expect(manager.observe('s1', { type: 'text', text: 'console.log(b)' }, agent)).toEqual([]);

		manager.clearInjections('s1', ['no-console-log']);
		expect(manager.observe('s1', { type: 'text', text: 'console.log(c)' }, agent)).toHaveLength(1);
	});

	it('ignores refunds for rules and conversations it has never seen', () => {
		const { manager } = setup([makeRule()]);
		expect(() => {
			manager.refundInterrupt('unknown');
			manager.clearInjections('unknown', ['no-such-rule']);
		}).not.toThrow();
	});
});
