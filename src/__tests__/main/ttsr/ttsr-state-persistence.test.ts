/**
 * Tests for TTSR repeat-state persistence (plan Phase 3d).
 *
 * The behaviour that matters end to end: a `once` rule that already fired must
 * still be ineligible after the app restarts, and an `after-gap` rule must
 * resume counting from the turn it last fired on. Everything else here guards
 * the mechanics that make that true - debounced writes, TTL/cap pruning, and
 * disk errors degrading to "no persistence" instead of throwing on the stream.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createTtsrStatePersistence,
	pruneTtsrStateSnapshot,
	MAX_PERSISTED_CONVERSATIONS,
	TTSR_STATE_TTL_MS,
	type TtsrStateBackend,
} from '../../../main/ttsr/ttsr-state-persistence';
import {
	TtsrStateStore,
	ttsrConversationKey,
	type TtsrStateSnapshot,
} from '../../../main/ttsr/ttsr-state-store';
import { TtsrRuntime } from '../../../main/ttsr/ttsr-runtime';
import type { LoadTtsrConfigResult } from '../../../main/ttsr/config/ttsr-config-loader';
import type { TtsrProcessEventSource } from '../../../main/ttsr/ttsr-spawn-registry';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';
import { DEFAULT_TTSR_PROJECT_SETTINGS, type LoadedTtsrRule } from '../../../shared/ttsr-types';

const ONCE = { name: 'once-rule', repeatMode: 'once' as const, repeatGap: 3 };
const GAP = { name: 'gap-rule', repeatMode: 'after-gap' as const, repeatGap: 3 };

/** In-memory stand-in for the electron-store namespace. */
function fakeBackend(initial: TtsrStateSnapshot = {}): TtsrStateBackend & {
	data: TtsrStateSnapshot;
	writes: number;
} {
	return {
		data: initial,
		writes: 0,
		read() {
			return this.data;
		},
		write(snapshot: TtsrStateSnapshot) {
			this.data = snapshot;
			this.writes += 1;
		},
	};
}

describe('pruneTtsrStateSnapshot', () => {
	const conv = (updatedAt: number) => ({ messageCount: 1, rules: {}, updatedAt });

	it('drops conversations quiet for longer than the TTL', () => {
		const now = 1_000_000_000_000;
		const pruned = pruneTtsrStateSnapshot(
			{
				fresh: conv(now - 1000),
				stale: conv(now - TTSR_STATE_TTL_MS - 1),
			},
			now
		);
		expect(Object.keys(pruned)).toEqual(['fresh']);
	});

	it('keeps the newest conversations when over the cap', () => {
		const now = 1_000_000_000_000;
		const snapshot: TtsrStateSnapshot = {};
		for (let i = 0; i < MAX_PERSISTED_CONVERSATIONS + 10; i++) {
			snapshot[`k${i}`] = conv(now - i);
		}
		const pruned = pruneTtsrStateSnapshot(snapshot, now);
		expect(Object.keys(pruned)).toHaveLength(MAX_PERSISTED_CONVERSATIONS);
		expect(pruned.k0).toBeDefined();
		expect(pruned[`k${MAX_PERSISTED_CONVERSATIONS + 5}`]).toBeUndefined();
	});
});

describe('createTtsrStatePersistence', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('debounces writes and coalesces a burst of mutations into one', () => {
		const backend = fakeBackend();
		const persistence = createTtsrStatePersistence({ backend, debounceMs: 50 });
		const store = new TtsrStateStore({ onChange: () => persistence.scheduleSave(store) });

		store.noteInjection('k', ONCE.name);
		store.noteTurnEnd('k');
		store.noteTurnEnd('k');
		expect(backend.writes).toBe(0);

		vi.advanceTimersByTime(50);
		expect(backend.writes).toBe(1);
		expect(backend.data.k.messageCount).toBe(2);
	});

	it('flush writes immediately and cancels the pending timer', () => {
		const backend = fakeBackend();
		const persistence = createTtsrStatePersistence({ backend, debounceMs: 50 });
		const store = new TtsrStateStore({ onChange: () => persistence.scheduleSave(store) });

		store.noteTurnEnd('k');
		persistence.flush();
		expect(backend.writes).toBe(1);

		vi.advanceTimersByTime(100);
		expect(backend.writes).toBe(1);
	});

	it('dispose drops the pending write instead of firing it later', () => {
		const backend = fakeBackend();
		const persistence = createTtsrStatePersistence({ backend, debounceMs: 50 });
		const store = new TtsrStateStore({ onChange: () => persistence.scheduleSave(store) });

		store.noteTurnEnd('k');
		persistence.dispose();
		vi.advanceTimersByTime(100);
		expect(backend.writes).toBe(0);
	});

	it('survives a restart: a fired once rule stays ineligible', () => {
		const backend = fakeBackend();
		const first = createTtsrStatePersistence({ backend, debounceMs: 50 });
		const before = new TtsrStateStore({ onChange: () => first.scheduleSave(before) });
		first.hydrate(before);

		before.noteInjection('k', ONCE.name);
		before.noteInjection('k', GAP.name);
		before.noteTurnEnd('k');
		first.flush();

		const second = createTtsrStatePersistence({ backend, debounceMs: 50 });
		const after = new TtsrStateStore();
		second.hydrate(after);

		expect(after.isEligible(ONCE, 'k')).toBe(false);
		// One turn elapsed before the restart, so the gap rule still owes two.
		expect(after.isEligible(GAP, 'k')).toBe(false);
		after.noteTurnEnd('k');
		after.noteTurnEnd('k');
		expect(after.isEligible(GAP, 'k')).toBe(true);
	});

	it('ignores expired conversations on hydrate', () => {
		const stale = Date.now() - TTSR_STATE_TTL_MS - 1;
		const backend = fakeBackend({
			old: {
				messageCount: 1,
				rules: { [ONCE.name]: { lastInjectedAt: 0, injectionCount: 1 } },
				updatedAt: stale,
			},
		});
		const persistence = createTtsrStatePersistence({ backend });
		const store = new TtsrStateStore();
		persistence.hydrate(store);

		expect(store.isEligible(ONCE, 'old')).toBe(true);
	});

	it('degrades to no persistence when the disk layer throws', () => {
		const backend: TtsrStateBackend = {
			read: () => {
				throw new Error('EACCES');
			},
			write: () => {
				throw new Error('ENOSPC');
			},
		};
		const persistence = createTtsrStatePersistence({ backend, debounceMs: 10 });
		const store = new TtsrStateStore({ onChange: () => persistence.scheduleSave(store) });

		expect(() => persistence.hydrate(store)).not.toThrow();
		store.noteInjection('k', ONCE.name);
		expect(() => persistence.flush()).not.toThrow();
		// The in-memory answer is still correct; only the durability is lost.
		expect(store.isEligible(ONCE, 'k')).toBe(false);
	});
});

// ── runtime-level round trip ──

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
		interruptMode: 'never',
		repeatMode: 'once',
		repeatGap: 3,
		agents: ['claude-code'],
		content: 'Use the project logger.',
		path: '.maestro/rules/no-console-log.md',
		compiledCondition: condition.map((source) => new RegExp(source)),
		...overrides,
	};
}

const loadResult = (rules: LoadedTtsrRule[]): LoadTtsrConfigResult => ({
	ok: true,
	errors: [],
	warnings: [],
	rules,
	settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS },
});

const spawnConfig = {
	sessionId: 'sess-ai-1',
	toolType: 'claude-code',
	cwd: ROOT,
	command: 'claude',
	args: [],
	prompt: 'Refactor the auth module',
	tabId: 'tab-1',
};

const textEvent = (text: string): ParsedEvent => ({ type: 'text', text });

function bootRuntime(backend: TtsrStateBackend) {
	const persistence = createTtsrStatePersistence({ backend, debounceMs: 0 });
	const runtime = new TtsrRuntime({
		isGloballyEnabled: () => true,
		loadConfig: () => loadResult([makeRule()]),
		persistence,
	});
	const source = new EventEmitter() as unknown as TtsrProcessEventSource;
	runtime.attach(source);
	return { runtime, source: source as unknown as EventEmitter };
}

describe('TtsrRuntime state persistence', () => {
	it('does not re-fire a once rule after the runtime is rebuilt', () => {
		const backend = fakeBackend();

		const first = bootRuntime(backend);
		first.source.emit('spawn', spawnConfig);
		first.source.emit('session-id', 'sess-ai-1', 'prov-1');
		expect(first.runtime.observe('sess-ai-1', textEvent('console.log(x)'))).toHaveLength(1);
		first.source.emit('exit', 'sess-ai-1', 0);
		first.runtime.dispose();

		expect(backend.data[ttsrConversationKey('sess-ai-1', 'prov-1')]).toBeDefined();

		// Fresh process, same conversation: the rule already had its one shot.
		const second = bootRuntime(backend);
		second.source.emit('spawn', { ...spawnConfig, agentSessionId: 'prov-1' });
		expect(second.runtime.observe('sess-ai-1', textEvent('console.log(y)'))).toHaveLength(0);
		second.runtime.dispose();
	});
});
