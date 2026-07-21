/**
 * Phase 3a verification: the abort half of the interrupt + reinject loop.
 *
 * Covers the injection templates, the driver's signal choice per `contextMode`,
 * its wait for the aborted turn's `exit`, the Gate A resume-vs-degraded split,
 * and the end-to-end path from a matched delta to a `ttsr:triggered` payload.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import {
	buildFreshInjectionPrompt,
	renderTtsrInterrupt,
	renderTtsrReminder,
	summarizeGoal,
} from '../../../main/ttsr/ttsr-injection';
import {
	TtsrInterruptDriver,
	type TtsrInterruptTarget,
} from '../../../main/ttsr/ttsr-interrupt-driver';
import { TtsrRuntime } from '../../../main/ttsr/ttsr-runtime';
import type { TtsrMatch } from '../../../main/ttsr/ttsr-manager';
import type { TtsrSpawnMeta, TtsrProcessEventSource } from '../../../main/ttsr/ttsr-spawn-registry';
import type { LoadTtsrConfigResult } from '../../../main/ttsr/config/ttsr-config-loader';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';
import type { AgentId } from '../../../shared/agentIds';
import {
	DEFAULT_TTSR_PROJECT_SETTINGS,
	type LoadedTtsrRule,
	type TtsrAbortPendingPayload,
	type TtsrContextMode,
	type TtsrTriggeredPayload,
} from '../../../shared/ttsr-types';

const ROOT = '/repo';

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

function makeMatch(rule: LoadedTtsrRule = makeRule()): TtsrMatch {
	return { rule, source: 'text', disposition: 'interrupt', matchedText: 'console.log(' };
}

function makeMeta(overrides: Partial<TtsrSpawnMeta> = {}): TtsrSpawnMeta {
	return {
		sessionId: 'sess-ai-1',
		agentId: 'claude-code',
		projectRoot: ROOT,
		originalPrompt: 'Refactor the auth module',
		tabId: 'tab-1',
		providerSessionId: 'prov-1',
		startedAt: 0,
		...overrides,
	};
}

function makeDriver(overrides: Partial<TtsrInterruptTarget> = {}) {
	const triggered: TtsrTriggeredPayload[] = [];
	const abortPending: TtsrAbortPendingPayload[] = [];
	const target = {
		interrupt: vi.fn(() => true),
		kill: vi.fn(() => true),
		...overrides,
	};
	const driver = new TtsrInterruptDriver({
		target,
		onTriggered: (payload) => triggered.push(payload),
		onAbortPending: (payload) => abortPending.push(payload),
		exitTimeoutMs: 50,
	});
	return { driver, target, triggered, abortPending };
}

describe('TTSR injection templates', () => {
	it('renders one interrupt block per rule with its name and path', () => {
		const block = renderTtsrInterrupt([makeMatch()]);
		expect(block).toBe(
			'<system-interrupt reason="rule_violation" rule="no-console-log" path=".maestro/rules/no-console-log.md">\n' +
				'Use the project logger.\n' +
				'</system-interrupt>'
		);
	});

	it('states a rule once even when it fired on several streams', () => {
		const rule = makeRule();
		const blocks = renderTtsrInterrupt([
			makeMatch(rule),
			{ ...makeMatch(rule), source: 'thinking' },
			makeMatch(makeRule({ name: 'other', content: 'Second rule.' })),
		]);
		expect(blocks.match(/<system-interrupt/g)).toHaveLength(2);
		expect(blocks).toContain('rule="other"');
	});

	it('escapes quotes so agent-authored rule names cannot break the tag', () => {
		const block = renderTtsrInterrupt([makeMatch(makeRule({ name: 'say "hi"' }))]);
		expect(block).toContain('rule="say &quot;hi&quot;"');
	});

	it('renders deferred matches as system-reminder instead', () => {
		expect(renderTtsrReminder([makeMatch()])).toContain('<system-reminder reason="rule_violation"');
	});

	it('collapses and truncates the restated goal for a fresh reinject', () => {
		expect(summarizeGoal('  do\n  the   thing  ')).toBe('do the thing');
		expect(summarizeGoal('x'.repeat(1000))).toHaveLength(600);

		const prompt = buildFreshInjectionPrompt('Refactor\nthe auth module', 'BLOCK');
		expect(prompt).toBe('Continuing this request: Refactor the auth module\n\nBLOCK');
	});

	it('omits the restatement when the original prompt is unknown', () => {
		expect(buildFreshInjectionPrompt('', 'BLOCK')).toBe('BLOCK');
	});
});

describe('TtsrInterruptDriver', () => {
	it('interrupts for contextMode keep and hard-kills for discard', async () => {
		const keep = makeDriver();
		const keepDone = keep.driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta(),
			matches: [makeMatch()],
			contextMode: 'keep',
		});
		expect(keep.target.interrupt).toHaveBeenCalledWith('sess-ai-1');
		expect(keep.target.kill).not.toHaveBeenCalled();
		keep.driver.noteExit('sess-ai-1');
		await keepDone;

		const discard = makeDriver();
		const discardDone = discard.driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta(),
			matches: [makeMatch()],
			contextMode: 'discard',
		});
		expect(discard.target.kill).toHaveBeenCalledWith('sess-ai-1');
		expect(discard.target.interrupt).not.toHaveBeenCalled();
		discard.driver.noteExit('sess-ai-1');
		await discardDone;
		expect(discard.triggered[0]?.contextMode).toBe('discard');
	});

	it('waits for the turn to exit before emitting the corrective payload', async () => {
		const { driver, triggered } = makeDriver();
		const done = driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta(),
			matches: [makeMatch()],
			contextMode: 'keep',
		});

		expect(driver.isAbortPending('sess-ai-1')).toBe(true);
		await Promise.resolve();
		expect(triggered).toEqual([]);

		expect(driver.noteExit('sess-ai-1')).toBe(true);
		await done;

		expect(driver.isAbortPending('sess-ai-1')).toBe(false);
		expect(triggered).toHaveLength(1);
		expect(triggered[0]).toMatchObject({
			sessionId: 'sess-ai-1',
			tabId: 'tab-1',
			agentId: 'claude-code',
			mode: 'resume',
			providerSessionId: 'prov-1',
			originalGoal: 'Refactor the auth module',
			rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		});
		expect(triggered[0].injectionPrompt).toContain('<system-interrupt');
	});

	it('announces the abort before signalling, so exit handling can suppress the turn', async () => {
		const { driver, target, triggered, abortPending } = makeDriver({
			interrupt: vi.fn(() => {
				// Announced first: by the time the signal lands, the renderer must
				// already know the exit it produces is a TTSR abort, not a failure.
				expect(abortPending).toHaveLength(1);
				return true;
			}),
		});

		const done = driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta(),
			matches: [makeMatch()],
			contextMode: 'keep',
		});
		expect(target.interrupt).toHaveBeenCalled();
		expect(triggered).toEqual([]);
		expect(abortPending[0]).toEqual({
			sessionId: 'sess-ai-1',
			tabId: 'tab-1',
			agentId: 'claude-code',
			rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
			contextMode: 'keep',
		});

		driver.noteExit('sess-ai-1');
		await done;
		expect(triggered).toHaveLength(1);
	});

	it('emits without waiting when the process is already gone', async () => {
		const { driver, triggered } = makeDriver({ interrupt: vi.fn(() => false) });
		await driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta(),
			matches: [makeMatch()],
			contextMode: 'keep',
		});
		expect(triggered).toHaveLength(1);
	});

	it('gives up waiting after the exit timeout instead of stranding the turn', async () => {
		const { driver, triggered } = makeDriver();
		await driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta(),
			matches: [makeMatch()],
			contextMode: 'keep',
		});
		expect(triggered).toHaveLength(1);
	});

	it('folds a late match into the abort already in flight', async () => {
		const { driver, target, triggered } = makeDriver();
		const done = driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta(),
			matches: [makeMatch()],
			contextMode: 'keep',
		});

		const second = await driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta(),
			matches: [makeMatch(makeRule({ name: 'late-rule', content: 'Late guidance.' }))],
			contextMode: 'keep',
		});
		expect(second).toBeNull();
		expect(target.interrupt).toHaveBeenCalledTimes(1);

		driver.noteExit('sess-ai-1');
		await done;

		expect(triggered).toHaveLength(1);
		expect(triggered[0].rules.map((rule) => rule.name)).toEqual(['no-console-log', 'late-rule']);
		expect(triggered[0].injectionPrompt).toContain('Late guidance.');
	});

	it('degrades to a fresh restated turn for agents with no mid-turn session id', async () => {
		for (const agentId of ['copilot-cli', 'grok'] as AgentId[]) {
			const { driver, triggered } = makeDriver();
			const done = driver.trigger({
				sessionId: 'sess-ai-1',
				meta: makeMeta({ agentId, providerSessionId: undefined }),
				matches: [makeMatch()],
				contextMode: 'keep',
			});
			driver.noteExit('sess-ai-1');
			await done;

			expect(triggered[0].mode).toBe('fresh');
			expect(triggered[0].providerSessionId).toBeUndefined();
			expect(triggered[0].injectionPrompt).toContain(
				'Continuing this request: Refactor the auth module'
			);
		}
	});

	it('degrades a clean-resume agent too when its session id never arrived', async () => {
		const { driver, triggered } = makeDriver();
		const done = driver.trigger({
			sessionId: 'sess-ai-1',
			meta: makeMeta({ providerSessionId: undefined }),
			matches: [makeMatch()],
			contextMode: 'keep',
		});
		driver.noteExit('sess-ai-1');
		await done;
		expect(triggered[0].mode).toBe('fresh');
	});

	it('reports an unrelated exit as not a TTSR abort', () => {
		const { driver } = makeDriver();
		expect(driver.noteExit('sess-ai-1')).toBe(false);
	});
});

describe('TtsrRuntime interrupt loop', () => {
	function setup(options: { rules?: LoadedTtsrRule[]; contextMode?: TtsrContextMode } = {}) {
		const triggered: TtsrTriggeredPayload[] = [];
		const target = { interrupt: vi.fn(() => true), kill: vi.fn(() => true) };
		const loadConfig = vi.fn(
			(): LoadTtsrConfigResult => ({
				ok: true,
				errors: [],
				warnings: [],
				rules: options.rules ?? [makeRule()],
				settings: {
					...DEFAULT_TTSR_PROJECT_SETTINGS,
					contextMode: options.contextMode ?? 'keep',
				},
			})
		);
		const runtime = new TtsrRuntime({
			isGloballyEnabled: () => true,
			loadConfig,
			interruptTarget: target,
			onTriggered: (payload) => triggered.push(payload),
			exitTimeoutMs: 50,
		});
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);
		return { runtime, source, target, triggered };
	}

	const spawnConfig = {
		sessionId: 'sess-ai-1',
		toolType: 'claude-code',
		cwd: ROOT,
		prompt: 'Refactor the auth module',
		tabId: 'tab-1',
	};

	it('aborts the turn on a matched delta and reinjects after exit', async () => {
		const { runtime, source, target, triggered } = setup();
		source.emit('spawn', spawnConfig);
		source.emit('session-id', 'sess-ai-1', 'prov-7');

		runtime.observe('sess-ai-1', { type: 'text', text: 'adding console.log(x)' });

		// The signal goes out synchronously with the match - no renderer round-trip.
		expect(target.interrupt).toHaveBeenCalledWith('sess-ai-1');
		expect(runtime.isAbortPending('sess-ai-1')).toBe(true);
		expect(triggered).toEqual([]);

		source.emit('exit', 'sess-ai-1', 0);
		await runtime.flushInterrupts();

		expect(triggered).toHaveLength(1);
		expect(triggered[0]).toMatchObject({
			sessionId: 'sess-ai-1',
			tabId: 'tab-1',
			mode: 'resume',
			providerSessionId: 'prov-7',
			contextMode: 'keep',
		});
		expect(triggered[0].injectionPrompt).toContain('Use the project logger.');
		expect(runtime.isAbortPending('sess-ai-1')).toBe(false);
	});

	it('hard-kills when the project sets contextMode discard', async () => {
		const { runtime, source, target } = setup({ contextMode: 'discard' });
		source.emit('spawn', spawnConfig);
		runtime.observe('sess-ai-1', { type: 'text', text: 'console.log(x)' });

		expect(target.kill).toHaveBeenCalledWith('sess-ai-1');
		expect(target.interrupt).not.toHaveBeenCalled();

		source.emit('exit', 'sess-ai-1', 0);
		await runtime.flushInterrupts();
	});

	it('does not abort on a non-interrupting match', async () => {
		const { runtime, source, target, triggered } = setup({
			rules: [makeRule({ interruptMode: 'never' })],
		});
		source.emit('spawn', spawnConfig);
		runtime.observe('sess-ai-1', { type: 'text', text: 'console.log(x)' });

		await runtime.flushInterrupts();
		expect(target.interrupt).not.toHaveBeenCalled();
		expect(triggered).toEqual([]);
		// The match is still queued as a reminder for the next prompt (Phase 3c).
		expect(runtime.manager.takeDeferred('sess-ai-1')).toHaveLength(1);
	});

	it('aborts on a structural match that settles after the delta', async () => {
		const { runtime, source, target, triggered } = setup({
			rules: [
				makeRule({
					name: 'no-console-log-ast',
					condition: [],
					astCondition: ['console.log($$$ARGS)'],
					scope: ['tool:write'],
				}),
			],
		});
		source.emit('spawn', spawnConfig);

		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{
					name: 'Write',
					id: 't1',
					input: { file_path: '/repo/src/f.ts', content: 'console.log(1);' },
				},
			],
		};
		runtime.observe('sess-ai-1', event);
		expect(target.interrupt).not.toHaveBeenCalled();

		await runtime.flushAst();
		expect(target.interrupt).toHaveBeenCalledWith('sess-ai-1');

		source.emit('exit', 'sess-ai-1', 0);
		await runtime.flushInterrupts();
		expect(triggered[0]?.rules[0]?.name).toBe('no-console-log-ast');
	});
});
