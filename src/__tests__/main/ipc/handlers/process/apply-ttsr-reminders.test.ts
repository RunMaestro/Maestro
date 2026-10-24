/**
 * Phase 3c: deferred `<system-reminder>` folding at spawn time.
 *
 * The drain itself lives in the TTSR runtime; this covers the spawn-path half -
 * that a queued reminder is prepended to the conversation's next prompt, that
 * the queue survives a spawn that never happened, and that the spawn path is
 * untouched when TTSR has nothing to say (or is off).
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import { applyTtsrReminders } from '../../../../../main/ipc/handlers/process/apply-ttsr-reminders';
import type { SpawnProcessConfig } from '../../../../../main/ipc/handlers/process/spawn-types';
import { TtsrRuntime } from '../../../../../main/ttsr/ttsr-runtime';
import type { TtsrProcessEventSource } from '../../../../../main/ttsr/ttsr-spawn-registry';
import type { LoadTtsrConfigResult } from '../../../../../main/ttsr/config/ttsr-config-loader';
import {
	DEFAULT_TTSR_PROJECT_SETTINGS,
	type LoadedTtsrRule,
} from '../../../../../shared/ttsr-types';

const REMINDER =
	'<system-reminder reason="rule_violation" rule="no-console-log" path=".maestro/rules/no-console-log.md">\nUse the project logger.\n</system-reminder>';

function config(overrides: Partial<SpawnProcessConfig> = {}): SpawnProcessConfig {
	return {
		sessionId: 'sess-ai-1',
		toolType: 'claude-code',
		cwd: '/repo',
		command: 'claude',
		args: [],
		prompt: 'Add the login form',
		...overrides,
	} as SpawnProcessConfig;
}

/** A peek that always has something queued, with a spied commit. */
function peekWith(text: string) {
	const commit = vi.fn();
	return { peek: vi.fn(() => ({ text, commit })), commit };
}

describe('applyTtsrReminders', () => {
	it('prepends queued reminders above the user prompt without clearing them', () => {
		const { peek, commit } = peekWith(REMINDER);
		const result = applyTtsrReminders(config(), peek);

		expect(peek).toHaveBeenCalledWith('sess-ai-1');
		expect(result.config.prompt).toBe(`${REMINDER}\n\nAdd the login form`);
		// The queue is cleared by the caller, once the spawn has actually happened.
		expect(commit).not.toHaveBeenCalled();

		result.commit();
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it('returns the config untouched when nothing is queued', () => {
		const original = config();
		const result = applyTtsrReminders(original, () => ({ text: '', commit: () => {} }));
		expect(result.config).toBe(original);
		expect(() => result.commit()).not.toThrow();
	});

	it('returns the config untouched when TTSR is not wired at all', () => {
		const original = config();
		expect(applyTtsrReminders(original, undefined).config).toBe(original);
	});

	it('leaves a promptless spawn alone without reading the queue', () => {
		const { peek } = peekWith(REMINDER);
		const original = config({ prompt: undefined });

		expect(applyTtsrReminders(original, peek).config).toBe(original);
		// Reading here would strand the reminder: a terminal or interactive spawn
		// has no prompt to carry it.
		expect(peek).not.toHaveBeenCalled();
	});
});

/**
 * The drain wired to a real runtime, which is where the spawn id actually
 * matters: a forced-parallel turn spawns as `…-fp-{timestamp}`, so a queue keyed
 * on the raw id would never be read by the tab's next turn.
 */
describe('applyTtsrReminders against a live runtime', () => {
	const RULE: LoadedTtsrRule = {
		name: 'no-console-log',
		description: 'Flag stray console.log',
		condition: ['console\\.log\\('],
		astCondition: [],
		scope: ['text'],
		globs: [],
		// Never interrupts, so the match queues as a reminder for the next prompt.
		interruptMode: 'never',
		repeatMode: 'after-gap',
		repeatGap: 3,
		agents: ['claude-code'],
		content: 'Use the project logger.',
		path: '.maestro/rules/no-console-log.md',
		compiledCondition: [/console\.log\(/],
	};

	function runtimeWithQueuedReminder(spawnSessionId: string) {
		const loadConfig = (): LoadTtsrConfigResult => ({
			ok: true,
			errors: [],
			warnings: [],
			rules: [RULE],
			settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS },
		});
		const runtime = new TtsrRuntime({ isGloballyEnabled: () => true, loadConfig });
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);

		source.emit('spawn', {
			sessionId: spawnSessionId,
			toolType: 'claude-code',
			cwd: '/repo',
			prompt: 'Add the login form',
		});
		runtime.observe(spawnSessionId, { type: 'text', text: 'adding console.log(x)' });
		source.emit('exit', spawnSessionId, 0);
		return runtime;
	}

	it('drains a reminder queued under one fp spawn id on the next fp turn', () => {
		const runtime = runtimeWithQueuedReminder('sess-ai-tab-1-fp-1730000000000');

		const result = applyTtsrReminders(
			config({ sessionId: 'sess-ai-tab-1-fp-1730000009999' }),
			(sessionId) => runtime.peekDeferredReminders(sessionId)
		);

		expect(result.config.prompt).toContain('Use the project logger.');
		expect(result.config.prompt).toContain('Add the login form');
	});

	it('drains it on the tab canonical id too, and only once', () => {
		const runtime = runtimeWithQueuedReminder('sess-ai-tab-1-fp-1730000000000');
		const peek = (sessionId: string) => runtime.peekDeferredReminders(sessionId);

		const first = applyTtsrReminders(config({ sessionId: 'sess-ai-tab-1' }), peek);
		expect(first.config.prompt).toContain('Use the project logger.');
		first.commit();

		const second = config({ sessionId: 'sess-ai-tab-1-fp-1730000009999' });
		expect(applyTtsrReminders(second, peek).config).toBe(second);
	});

	it('does not hand one tab reminders to another', () => {
		const runtime = runtimeWithQueuedReminder('sess-ai-tab-1-fp-1730000000000');
		const other = config({ sessionId: 'sess-ai-tab-2-fp-1730000009999' });

		expect(applyTtsrReminders(other, (id) => runtime.peekDeferredReminders(id)).config).toBe(other);
	});

	// The whole point of the peek/commit split: `handleProcessSpawn` folds the
	// reminders in, then resolves Claude context, wraps SSH (which fails loudly
	// rather than running locally) and spawns - any of which can throw.
	it('keeps the queue intact when the spawn never happens, then delivers it once', () => {
		const runtime = runtimeWithQueuedReminder('sess-ai-tab-1');
		const peek = (sessionId: string) => runtime.peekDeferredReminders(sessionId);

		const failed = applyTtsrReminders(config({ sessionId: 'sess-ai-tab-1' }), peek);
		expect(failed.config.prompt).toContain('Use the project logger.');
		// The spawn threw, so `commit` is never reached.

		const retry = applyTtsrReminders(config({ sessionId: 'sess-ai-tab-1' }), peek);
		expect(retry.config.prompt).toContain('Use the project logger.');
		retry.commit();
		// Idempotent: a spawn path that retries internally must not eat a second
		// batch of reminders.
		retry.commit();

		expect(applyTtsrReminders(config({ sessionId: 'sess-ai-tab-1' }), peek).config.prompt).toBe(
			'Add the login form'
		);
	});

	it('does not swallow a reminder queued between the peek and the commit', () => {
		const runtime = runtimeWithQueuedReminder('sess-ai-tab-1');
		const pending = applyTtsrReminders(config({ sessionId: 'sess-ai-tab-1' }), (id) =>
			runtime.peekDeferredReminders(id)
		);

		// A second rule fires on the tail of the previous turn, after the prompt
		// was built but before the spawn landed.
		runtime.manager.deferMatches('sess-ai-tab-1', [
			{
				rule: { ...RULE, name: 'late-rule', content: 'Late guidance.' },
				source: 'text',
				disposition: 'deferred-prose',
				matchedText: 'console.log(',
			},
		]);
		pending.commit();

		const next = applyTtsrReminders(config({ sessionId: 'sess-ai-tab-1' }), (id) =>
			runtime.peekDeferredReminders(id)
		);
		expect(next.config.prompt).toContain('Late guidance.');
		expect(next.config.prompt).not.toContain('Use the project logger.');
	});
});
