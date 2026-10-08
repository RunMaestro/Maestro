/**
 * Tests for the TTSR runtime facade + spawn registry (Phase 2a verification).
 *
 * Covers the wiring the stream tap depends on: the spawn registry fed from the
 * ProcessManager lifecycle events, the per-project rule cache, and the feature
 * gate that must make the tap a true no-op when TTSR is off.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import { TtsrRuntime } from '../../../main/ttsr/ttsr-runtime';
import { TtsrSpawnRegistry } from '../../../main/ttsr/ttsr-spawn-registry';
import type { LoadTtsrConfigResult } from '../../../main/ttsr/config/ttsr-config-loader';
import type { TtsrProcessEventSource } from '../../../main/ttsr/ttsr-spawn-registry';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';
import {
	DEFAULT_TTSR_PROJECT_SETTINGS,
	type LoadedTtsrRule,
	type TtsrMatchedPayload,
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

function result(rules: LoadedTtsrRule[], enabled = true): LoadTtsrConfigResult {
	return {
		ok: true,
		errors: [],
		warnings: [],
		rules,
		settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS, enabled },
	};
}

function setup(
	options: {
		rules?: LoadedTtsrRule[];
		enabled?: boolean;
		projectEnabled?: boolean;
		disabledRules?: string[];
	} = {}
) {
	const matched: TtsrMatchedPayload[] = [];
	const persistence = {
		hydrate: vi.fn(),
		scheduleSave: vi.fn(),
		flush: vi.fn(),
		dispose: vi.fn(),
	};
	const loadConfig = vi.fn(() => result(options.rules ?? [makeRule()], options.projectEnabled));
	// Spied so tests can assert how often the hot path consults the gate: in
	// production these deps read a settings snapshot, and every extra call used to
	// mean another settings-file read.
	const isGloballyEnabled = vi.fn(() => options.enabled !== false);
	const getDisabledRules = vi.fn(() => options.disabledRules ?? []);
	const runtime = new TtsrRuntime({
		isGloballyEnabled,
		getDisabledRules,
		onMatched: (payload) => matched.push(payload),
		loadConfig,
		persistence,
	});
	const source = new EventEmitter() as unknown as TtsrProcessEventSource;
	runtime.attach(source);
	return {
		runtime,
		matched,
		loadConfig,
		isGloballyEnabled,
		getDisabledRules,
		persistence,
		source: source as unknown as EventEmitter,
	};
}

const spawnConfig = (overrides: Record<string, unknown> = {}) => ({
	sessionId: 'sess-ai-tab-1',
	toolType: 'claude-code',
	cwd: ROOT,
	command: 'claude',
	args: [],
	prompt: 'Refactor the auth module',
	...overrides,
});

const textEvent = (text: string): ParsedEvent => ({ type: 'text', text });

describe('TtsrSpawnRegistry', () => {
	it('records the original prompt, prefers projectPath over cwd, and parses the tab', () => {
		const registry = new TtsrSpawnRegistry();
		const meta = registry.noteSpawn({
			sessionId: 'sess-ai-t1',
			toolType: 'codex',
			cwd: '/home/user',
			projectPath: '/repo',
			prompt: 'do the thing',
		});

		expect(meta).not.toBeNull();
		expect(meta?.projectRoot).toBe('/repo');
		expect(meta?.originalPrompt).toBe('do the thing');
		expect(meta?.agentId).toBe('codex');
		// Read out of the spawn id: no spawn caller sets `config.tabId`.
		expect(registry.get('sess-ai-t1')?.tabId).toBe('t1');
	});

	it('ignores terminal spawns and unknown agents', () => {
		const registry = new TtsrSpawnRegistry();
		expect(
			registry.noteSpawn({ sessionId: 'sess-ai-t1', toolType: 'terminal', cwd: ROOT })
		).toBeNull();
		expect(
			registry.noteSpawn({ sessionId: 'sess-ai-t2', toolType: 'not-an-agent', cwd: ROOT })
		).toBeNull();
		expect(registry.size).toBe(0);
	});

	// TTSR aborts in main but can only respawn into an AI tab. Registering any
	// other spawn flavor would let it kill an unattended turn it can never
	// restart, silently truncating the run.
	it.each([
		['auto run task', 'sess-batch-1730000000000'],
		['background synopsis', 'sess-synopsis-1730000000000'],
		['group chat participant', 'group-chat-abc-reviewer-1730000000000'],
		['bare session', 'sess'],
		['legacy ai suffix', 'sess-ai'],
	])('ignores a %s spawn (no tab to respawn into)', (_label, sessionId) => {
		const registry = new TtsrSpawnRegistry();

		expect(registry.noteSpawn({ sessionId, toolType: 'claude-code', cwd: ROOT })).toBeNull();
		expect(registry.size).toBe(0);
	});

	it('registers a forced-parallel AI tab spawn', () => {
		const registry = new TtsrSpawnRegistry();
		const meta = registry.noteSpawn({
			sessionId: 'sess-ai-tab-1-fp-1730000000000',
			toolType: 'claude-code',
			cwd: ROOT,
		});

		expect(meta?.tabId).toBe('tab-1');
	});

	it('carries the original goal across a corrective respawn', () => {
		const registry = new TtsrSpawnRegistry();
		registry.noteSpawn({ ...spawnConfig(), prompt: 'Refactor the auth module' });
		registry.noteCorrectiveTurn('sess-ai-tab-1', {
			originalPrompt: 'Refactor the auth module',
			injectionPrompt: '<system-interrupt rule="no-console-log">Use the logger.</system-interrupt>',
			matches: [],
		});

		// The corrective turn respawns with the injection as its prompt; without the
		// hand-off the registry would record THAT as the goal, and a second
		// interrupt would restate the injection instead of the user's request.
		const corrective = registry.noteSpawn({
			...spawnConfig(),
			prompt: '<system-interrupt rule="no-console-log">Use the logger.</system-interrupt>',
		});
		expect(corrective?.originalPrompt).toBe('Refactor the auth module');
	});

	// Correlation is the primary match: main builds the payload AND observes the
	// spawn, so the renderer only has to hand the id back. Recognising the turn
	// by its prompt made goal carry-over depend on nothing ever appending to the
	// prompt after the injection block.
	it('recognises the corrective turn by correlation id, however the prompt was decorated', () => {
		const registry = new TtsrSpawnRegistry();
		registry.noteCorrectiveTurn('sess-ai-tab-1', {
			originalPrompt: 'Refactor the auth module',
			correlationId: 'corr-1',
			injectionPrompt: '<system-interrupt>x</system-interrupt>',
			matches: [],
		});

		const corrective = registry.noteSpawn({
			...spawnConfig(),
			// Decorated on both ends: the `endsWith` check would miss this.
			prompt: '<system-interrupt>x</system-interrupt>\n\nRespond in English.',
			ttsrCorrelationId: 'corr-1',
		});

		expect(corrective?.originalPrompt).toBe('Refactor the auth module');
		expect(corrective?.lostCorrective).toBeUndefined();
	});

	it('treats a spawn carrying a different correlation id as an unrelated turn', () => {
		const registry = new TtsrSpawnRegistry();
		registry.noteCorrectiveTurn('sess-ai-tab-1', {
			originalPrompt: 'Refactor the auth module',
			correlationId: 'corr-1',
			injectionPrompt: '<system-interrupt>x</system-interrupt>',
			matches: [],
		});

		const next = registry.noteSpawn({
			...spawnConfig(),
			prompt: 'Now write the tests',
			ttsrCorrelationId: 'corr-2',
		});

		expect(next?.originalPrompt).toBe('Now write the tests');
	});

	it('falls back to the injection-block check for a spawn with no correlation id', () => {
		const registry = new TtsrSpawnRegistry();
		registry.noteCorrectiveTurn('sess-ai-tab-1', {
			originalPrompt: 'Refactor the auth module',
			correlationId: 'corr-1',
			injectionPrompt: '<system-interrupt>x</system-interrupt>',
			matches: [],
		});

		// An older renderer, or a caller that rebuilt the spawn config from
		// scratch: the id is gone but the prompt is still the injection.
		const corrective = registry.noteSpawn({
			...spawnConfig(),
			prompt: '<system-interrupt>x</system-interrupt>',
		});

		expect(corrective?.originalPrompt).toBe('Refactor the auth module');
	});

	it('still recognises the corrective turn behind prepended deferred reminders', () => {
		const registry = new TtsrSpawnRegistry();
		registry.noteCorrectiveTurn('sess-ai-tab-1', {
			originalPrompt: 'Refactor the auth module',
			injectionPrompt: '<system-interrupt>x</system-interrupt>',
			matches: [],
		});

		const corrective = registry.noteSpawn({
			...spawnConfig(),
			prompt: '<system-reminder>y</system-reminder>\n\n<system-interrupt>x</system-interrupt>',
		});
		expect(corrective?.originalPrompt).toBe('Refactor the auth module');
	});

	it('does not attribute an unrelated later turn to the carried-over goal', () => {
		const registry = new TtsrSpawnRegistry();
		registry.noteCorrectiveTurn('sess-ai-tab-1', {
			originalPrompt: 'Refactor the auth module',
			injectionPrompt: '<system-interrupt>x</system-interrupt>',
			matches: [],
		});

		// The corrective turn never arrived (tab closed); the user's next prompt
		// must own its own goal.
		const next = registry.noteSpawn({ ...spawnConfig(), prompt: 'Now write the tests' });
		expect(next?.originalPrompt).toBe('Now write the tests');
	});

	it('seeds the provider session id from a resume spawn and updates it later', () => {
		const registry = new TtsrSpawnRegistry();
		registry.noteSpawn({ ...spawnConfig(), agentSessionId: 'prov-1' });
		expect(registry.get('sess-ai-tab-1')?.providerSessionId).toBe('prov-1');

		registry.noteProviderSessionId('sess-ai-tab-1', 'prov-2');
		expect(registry.get('sess-ai-tab-1')?.providerSessionId).toBe('prov-2');

		registry.clear('sess-ai-tab-1');
		expect(registry.get('sess-ai-tab-1')).toBeUndefined();
	});
});

describe('TtsrRuntime tap', () => {
	it('is a no-op when the feature gate is off (no rule load, no match)', () => {
		const { runtime, loadConfig, matched, source } = setup({ enabled: false });
		source.emit('spawn', spawnConfig());

		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'))).toEqual([]);
		expect(loadConfig).not.toHaveBeenCalled();
		expect(matched).toEqual([]);
	});

	// The turn lifecycle is the other half of the gate: registering a spawn would
	// create a conversation record and advance its turn counter, which schedules a
	// write of `ttsr-state.json` about a second later - for a feature that is off.
	it('creates and persists nothing across a full turn while the gate is off', () => {
		const { runtime, persistence, source } = setup({ enabled: false });

		source.emit('spawn', spawnConfig());
		runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'));
		source.emit('session-id', 'sess-ai-tab-1', 'prov-1');
		source.emit('exit', 'sess-ai-tab-1', 0);

		expect(runtime.registry.size).toBe(0);
		expect(runtime.stateStore.snapshot()).toEqual({});
		expect(persistence.scheduleSave).not.toHaveBeenCalled();
	});

	// Toggled off mid-turn: the turn still has to be released, but its exit must
	// not advance the counter or write anything.
	it('releases a turn that outlived the gate without touching state', () => {
		let enabled = true;
		const persistence = {
			hydrate: vi.fn(),
			scheduleSave: vi.fn(),
			flush: vi.fn(),
			dispose: vi.fn(),
		};
		const runtime = new TtsrRuntime({
			isGloballyEnabled: () => enabled,
			loadConfig: () => result([makeRule()]),
			persistence,
		});
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);

		source.emit('spawn', spawnConfig());
		enabled = false;
		persistence.scheduleSave.mockClear();
		source.emit('exit', 'sess-ai-tab-1', 0);

		expect(runtime.registry.size).toBe(0);
		expect(runtime.stateStore.getMessageCount('sess-ai-tab-1|-')).toBe(0);
		expect(persistence.scheduleSave).not.toHaveBeenCalled();
	});

	// The gate deps read a settings snapshot in production, so "how often" is the
	// whole point: the disabled path must cost exactly one boolean check per event.
	it('consults the gate once per event while off, and reads nothing else', () => {
		const { runtime, isGloballyEnabled, getDisabledRules, source } = setup({ enabled: false });
		source.emit('spawn', spawnConfig());
		isGloballyEnabled.mockClear();

		runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'));
		runtime.observe('sess-ai-tab-1', textEvent('console.log(y)'));

		expect(isGloballyEnabled).toHaveBeenCalledTimes(2);
		expect(getDisabledRules).not.toHaveBeenCalled();
	});

	// Same accounting on the enabled path: one `observe` resolves the gate and the
	// rule set once and threads them through, rather than re-resolving per manager
	// callback (which used to mean 6-9 resolutions per event).
	it('resolves the gate and the rule set once per observed event when on', () => {
		const rule = makeRule({
			astCondition: ['console.log($$$ARGS)'],
			scope: ['text', 'tool:write'],
		});
		const { runtime, isGloballyEnabled, getDisabledRules, source } = setup({ rules: [rule] });
		source.emit('spawn', spawnConfig());
		isGloballyEnabled.mockClear();
		getDisabledRules.mockClear();

		// A tool event: the most expensive shape, since it also drives the AST pass.
		runtime.observe('sess-ai-tab-1', {
			type: 'tool_use',
			toolUseBlocks: [
				{ name: 'Write', id: 't1', input: { file_path: '/repo/src/f.ts', content: 'x' } },
			],
		});

		expect(isGloballyEnabled).toHaveBeenCalledTimes(1);
		expect(getDisabledRules).toHaveBeenCalledTimes(1);
	});

	it('is a no-op for an unregistered session (terminal, or events after exit)', () => {
		const { runtime, loadConfig } = setup();
		expect(runtime.observe('never-spawned', textEvent('console.log(x)'))).toEqual([]);
		expect(loadConfig).not.toHaveBeenCalled();
	});

	it('matches a rule for a registered turn and reports it', () => {
		const { runtime, matched, source } = setup();
		source.emit('spawn', spawnConfig());

		const matches = runtime.observe('sess-ai-tab-1', textEvent('adding console.log(x) now'));

		expect(matches).toHaveLength(1);
		expect(matches[0]?.rule.name).toBe('no-console-log');
		expect(matches[0]?.disposition).toBe('interrupt');
		expect(matched).toEqual([
			expect.objectContaining({
				sessionId: 'sess-ai-tab-1',
				agentId: 'claude-code',
				source: 'text',
				willInterrupt: true,
			}),
		]);
	});

	it('honors the project-level enabled switch', () => {
		const { runtime, source } = setup({ projectEnabled: false });
		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'))).toEqual([]);
	});

	it('drops globally disabled rules', () => {
		const { runtime, source } = setup({ disabledRules: ['no-console-log'] });
		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'))).toEqual([]);
	});

	it('loads rules at spawn time, never from the stdout path', () => {
		const { runtime, loadConfig, source } = setup();

		// Loading is synchronous disk I/O, so it must happen off the hot path.
		source.emit('spawn', spawnConfig());
		expect(loadConfig).toHaveBeenCalledTimes(1);

		runtime.observe('sess-ai-tab-1', textEvent('nothing here'));
		runtime.observe('sess-ai-tab-1', textEvent('still nothing'));
		expect(loadConfig).toHaveBeenCalledTimes(1);

		runtime.invalidateRules(ROOT);
		runtime.observe('sess-ai-tab-1', textEvent('and again'));
		expect(loadConfig).toHaveBeenCalledTimes(2);
	});

	it('holds the cache until the rule watcher fires, not on a timer', () => {
		const loadConfig = vi.fn(() => result([makeRule()]));
		const watchers: Array<{ projectRoot: string; onChange: () => void; close: () => void }> = [];
		const watchConfig = vi.fn((projectRoot: string, onChange: () => void) => {
			const close = vi.fn();
			watchers.push({ projectRoot, onChange, close });
			return close;
		});
		const runtime = new TtsrRuntime({ isGloballyEnabled: () => true, loadConfig, watchConfig });
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);

		source.emit('spawn', spawnConfig());
		expect(watchers).toHaveLength(1);
		expect(watchers[0].projectRoot).toBe(ROOT);

		runtime.observe('sess-ai-tab-1', textEvent('nothing'));
		expect(loadConfig).toHaveBeenCalledTimes(1);

		// A rule file changed on disk.
		watchers[0].onChange();
		runtime.observe('sess-ai-tab-1', textEvent('nothing again'));
		expect(loadConfig).toHaveBeenCalledTimes(2);
		// One watcher per project root, not per turn.
		expect(watchConfig).toHaveBeenCalledTimes(1);

		runtime.dispose();
		expect(watchers[0].close).toHaveBeenCalled();
	});

	// The agent can write a rule file during the very turn TTSR is watching, so
	// the cache can be invalidated between two deltas of one turn.
	it('adopts an invalidated rule set mid-turn without re-firing what already fired', () => {
		const ruleA = makeRule();
		const ruleB = makeRule({
			name: 'no-any',
			condition: ['\\bany\\b'],
			compiledCondition: [/\bany\b/],
			content: 'Do not use `any`.',
			path: '.maestro/rules/no-any.md',
		});
		let rules = [ruleA];
		const loadConfig = vi.fn(() => result(rules));
		const runtime = new TtsrRuntime({ isGloballyEnabled: () => true, loadConfig });
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);
		source.emit('spawn', spawnConfig());

		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'))).toHaveLength(1);

		rules = [ruleA, ruleB];
		runtime.invalidateRules(ROOT);

		// The new rule is live on the very next event, and the one that already
		// fired this turn stays on its cooldown rather than firing a second time
		// just because the rule object was rebuilt.
		const second = runtime.observe('sess-ai-tab-1', textEvent('console.log(y) with any type'));
		expect(second.map((match) => match.rule.name)).toEqual(['no-any']);
		expect(loadConfig).toHaveBeenCalledTimes(2);
	});

	// A project on a network path or an inotify-exhausted box cannot be watched.
	// That is a reload problem, not an observation problem: the rules already
	// loaded keep matching.
	it('keeps observing with cached rules when the rule watcher throws', () => {
		const loadConfig = vi.fn(() => result([makeRule()]));
		const watchConfig = vi.fn(() => {
			throw new Error('ENOSPC: inotify watch limit reached');
		});
		const runtime = new TtsrRuntime({ isGloballyEnabled: () => true, loadConfig, watchConfig });
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);

		expect(() => source.emit('spawn', spawnConfig())).not.toThrow();
		expect(watchConfig).toHaveBeenCalled();

		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'))).toHaveLength(1);
		runtime.observe('sess-ai-tab-1', textEvent('more output'));
		// The failed watch must not turn the cache off: loading is synchronous disk
		// I/O and would otherwise land on the stdout hot path once per event.
		expect(loadConfig).toHaveBeenCalledTimes(1);

		// Disposing an unwatched project is still clean.
		expect(() => runtime.dispose()).not.toThrow();
	});

	it('rebuilds the cache when the globally disabled rule list changes', () => {
		let disabled: string[] = [];
		const loadConfig = vi.fn(() => result([makeRule()]));
		const runtime = new TtsrRuntime({
			isGloballyEnabled: () => true,
			getDisabledRules: () => disabled,
			loadConfig,
		});
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);
		source.emit('spawn', spawnConfig());

		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(a)'))).toHaveLength(1);

		// No file changes, so the watcher never fires - but the setting still has
		// to take effect.
		disabled = ['no-console-log'];
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(b)'))).toEqual([]);
	});

	it('survives a broken rule directory by matching nothing', () => {
		const loadConfig = vi.fn(() => {
			throw new Error('EACCES');
		});
		const runtime = new TtsrRuntime({ isGloballyEnabled: () => true, loadConfig });
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);
		source.emit('spawn', spawnConfig());

		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'))).toEqual([]);
	});

	it('drives astCondition rules off the synchronous path', async () => {
		const rule = makeRule({
			name: 'no-console-log-ast',
			condition: [],
			astCondition: ['console.log($$$ARGS)'],
			scope: ['tool:write'],
		});
		const { runtime, matched, source } = setup({ rules: [rule] });
		source.emit('spawn', spawnConfig());

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

		// The tap returns only the synchronous regex verdict; the structural match
		// settles afterwards and lands in the same interrupt bucket.
		expect(runtime.observe('sess-ai-tab-1', event)).toEqual([]);
		expect(matched).toEqual([]);

		await runtime.flushAst();

		expect(matched).toHaveLength(1);
		expect(matched[0].source).toBe('tool:write');
		expect(runtime.manager.takeInterrupts('sess-ai-tab-1')).toHaveLength(1);
	});

	it('does no AST work when no rule declares an astCondition', async () => {
		const { runtime, source } = setup();
		source.emit('spawn', spawnConfig());

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
		runtime.observe('sess-ai-tab-1', event);

		await runtime.flushAst();
		expect(runtime.manager.takeInterrupts('sess-ai-tab-1')).toEqual([]);
	});
});

describe('TtsrRuntime deferred reminders (Phase 3c)', () => {
	const deferringRule = (overrides: Partial<LoadedTtsrRule> = {}) =>
		makeRule({ interruptMode: 'never', ...overrides });

	it('renders one block per fired rule and clears the queue', () => {
		const { runtime, source } = setup({
			rules: [
				deferringRule(),
				deferringRule({
					name: 'no-any',
					condition: ['\\bany\\b'],
					compiledCondition: [/\bany\b/],
					content: 'Do not use `any`.',
					path: '.maestro/rules/no-any.md',
				}),
			],
		});
		source.emit('spawn', spawnConfig());
		runtime.observe('sess-ai-tab-1', textEvent('console.log(x) with any type'));

		const block = runtime.takeDeferredReminders('sess-ai-tab-1');
		expect(block).toContain('rule="no-console-log"');
		expect(block).toContain('rule="no-any"');
		expect(block).toContain('Use the project logger.');
		expect(block).toContain('Do not use `any`.');

		// Consumed by the read: the next prompt must not repeat it.
		expect(runtime.takeDeferredReminders('sess-ai-tab-1')).toBe('');
	});

	it('does not queue reminders for interrupting matches', () => {
		const { runtime, source } = setup();
		source.emit('spawn', spawnConfig());
		runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'));

		// interruptMode: always -> the rule aborts the turn instead, so its
		// guidance travels in the `<system-interrupt>` prompt, not here.
		expect(runtime.takeDeferredReminders('sess-ai-tab-1')).toBe('');
	});

	it('returns nothing while the feature gate is off', () => {
		let enabled = true;
		const runtime = new TtsrRuntime({
			isGloballyEnabled: () => enabled,
			loadConfig: () => result([deferringRule()]),
		});
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);
		source.emit('spawn', spawnConfig());
		runtime.observe('sess-ai-tab-1', textEvent('console.log(x)'));

		enabled = false;
		expect(runtime.takeDeferredReminders('sess-ai-tab-1')).toBe('');
	});

	it('is empty for a session that never matched anything', () => {
		const { runtime } = setup();
		expect(runtime.takeDeferredReminders('sess-ai-99')).toBe('');
	});
});

describe('TtsrRuntime lifecycle wiring', () => {
	it('folds the provider session id into the registry and repeat state', () => {
		const { runtime, source } = setup({ rules: [makeRule({ repeatMode: 'once' })] });
		source.emit('spawn', spawnConfig());

		// Fires before the provider id is known - lands in the pending bucket.
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(a)'))).toHaveLength(1);
		source.emit('session-id', 'sess-ai-tab-1', 'prov-9');

		expect(runtime.registry.get('sess-ai-tab-1')?.providerSessionId).toBe('prov-9');
		// `once` already fired, and adopting the id must not resurrect it.
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(b)'))).toEqual([]);
	});

	it('picks the provider id up from the stream init event too', () => {
		const { runtime, source } = setup();
		source.emit('spawn', spawnConfig());
		runtime.observe('sess-ai-tab-1', { type: 'init', sessionId: 'prov-init' });
		expect(runtime.registry.get('sess-ai-tab-1')?.providerSessionId).toBe('prov-init');
	});

	it('clears the registry on exit and advances the after-gap turn counter', () => {
		const rule = makeRule({ repeatMode: 'after-gap', repeatGap: 2 });
		const { runtime, source } = setup({ rules: [rule] });

		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(a)'))).toHaveLength(1);
		source.emit('exit', 'sess-ai-tab-1', 0);
		expect(runtime.registry.size).toBe(0);

		// Turn 2: one turn elapsed, still inside the gap.
		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(b)'))).toEqual([]);
		source.emit('exit', 'sess-ai-tab-1', 0);

		// Turn 3: the gap has elapsed, so the rule is eligible again.
		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(c)'))).toHaveLength(1);
	});

	it('keeps a conversation with queued reminders alive across turns', () => {
		// interruptMode: never -> the match defers instead of aborting, and the
		// reminder has to outlive the turn that produced it.
		const rule = makeRule({ interruptMode: 'never', repeatMode: 'after-gap', repeatGap: 1 });
		const { runtime, source } = setup({ rules: [rule] });

		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-tab-1', textEvent('console.log(a)'))).toHaveLength(1);
		expect(runtime.manager.takeInterrupts('sess-ai-tab-1')).toEqual([]);
		source.emit('exit', 'sess-ai-tab-1', 0);

		expect(runtime.manager.hasDeferred('sess-ai-tab-1')).toBe(true);
		expect(runtime.takeDeferredReminders('sess-ai-tab-1')).toContain('<system-reminder');
	});

	it('drops per-session state on exit when nothing is deferred', () => {
		const { runtime, source } = setup();
		source.emit('spawn', spawnConfig());
		runtime.observe('sess-ai-tab-1', textEvent('nothing to see'));
		source.emit('exit', 'sess-ai-tab-1', 0);

		// Auto Run mints a fresh session id per task, so a retained entry per turn
		// would grow without bound.
		expect(runtime.manager.hasDeferred('sess-ai-tab-1')).toBe(false);
		expect(runtime.takeDeferredReminders('sess-ai-tab-1')).toBe('');
	});

	it('detaches its listeners', () => {
		const { runtime, source } = setup();
		const detach = runtime.attach(source as unknown as TtsrProcessEventSource);
		detach();
		source.emit('spawn', spawnConfig());
		expect(runtime.registry.size).toBe(0);
	});
});

describe('TtsrRuntime interrupt budget accounting', () => {
	// A SIGINT'd process keeps streaming for up to 2s. Every late match that
	// drains through `drive` in that window is folded into the abort already in
	// flight, so it must not be charged: the budget counts aborts, not matches.
	it('charges the budget once for an abort that folds a later match', async () => {
		const ruleA = makeRule();
		const ruleB = makeRule({
			name: 'no-any',
			condition: ['\\bany\\b'],
			compiledCondition: [/\bany\b/],
			content: 'Do not use `any`.',
			path: '.maestro/rules/no-any.md',
		});
		const target = { interrupt: vi.fn(() => true), kill: vi.fn(() => true) };
		const triggered: TtsrTriggeredPayload[] = [];
		const runtime = new TtsrRuntime({
			isGloballyEnabled: () => true,
			loadConfig: () => result([ruleA, ruleB]),
			interruptTarget: target,
			onTriggered: (payload) => triggered.push(payload),
			exitTimeoutMs: 50,
		});
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);

		source.emit('spawn', spawnConfig());
		runtime.observe('sess-ai-tab-1', textEvent('adding console.log(x)'));
		expect(runtime.driver?.isAbortPending('sess-ai-tab-1')).toBe(true);

		// The tail of the aborted turn's stream trips a second, uncooled rule.
		runtime.observe('sess-ai-tab-1', textEvent('and an any type too'));

		expect(target.interrupt).toHaveBeenCalledTimes(1);
		expect(runtime.stateStore.getInterruptCount('sess-ai-tab-1|-')).toBe(1);

		source.emit('exit', 'sess-ai-tab-1', 0);
		await runtime.flushInterrupts();

		expect(triggered).toHaveLength(1);
		expect(triggered[0].rules.map((rule) => rule.name)).toEqual(['no-console-log', 'no-any']);
		expect(triggered[0].injectionPrompt).toContain('Do not use `any`.');
	});
});

// Two AI tabs working at once is the normal case, and every piece of TTSR state
// - registry entry, buffers, repeat counters, interrupt budget, pending abort -
// is keyed by session id. A leak between two live turns would reinject one tab's
// guidance into the other tab's conversation.
describe('TtsrRuntime concurrent sessions', () => {
	function setupInterrupting(rules: LoadedTtsrRule[]) {
		const target = { interrupt: vi.fn(() => true), kill: vi.fn(() => true) };
		const triggered: TtsrTriggeredPayload[] = [];
		const runtime = new TtsrRuntime({
			isGloballyEnabled: () => true,
			loadConfig: () => result(rules),
			interruptTarget: target,
			onTriggered: (payload) => triggered.push(payload),
			exitTimeoutMs: 50,
		});
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);
		return { runtime, source, target, triggered };
	}

	const secondTab = spawnConfig({ sessionId: 'sess-ai-tab-2', prompt: 'Write the tests' });

	it('drives two aborts in flight at once without crossing their payloads', async () => {
		const { runtime, source, target, triggered } = setupInterrupting([makeRule()]);

		source.emit('spawn', spawnConfig());
		source.emit('session-id', 'sess-ai-tab-1', 'prov-1');
		source.emit('spawn', secondTab);
		source.emit('session-id', 'sess-ai-tab-2', 'prov-2');

		runtime.observe('sess-ai-tab-1', textEvent('console.log(a)'));
		runtime.observe('sess-ai-tab-2', textEvent('console.log(b)'));

		expect(target.interrupt).toHaveBeenCalledTimes(2);
		expect(runtime.driver?.isAbortPending('sess-ai-tab-1')).toBe(true);
		expect(runtime.driver?.isAbortPending('sess-ai-tab-2')).toBe(true);
		// One abort charged per conversation, not two against whichever fired first.
		expect(runtime.stateStore.getInterruptCount('sess-ai-tab-1|prov-1')).toBe(1);
		expect(runtime.stateStore.getInterruptCount('sess-ai-tab-2|prov-2')).toBe(1);

		// Exits land in the reverse order of the aborts.
		source.emit('exit', 'sess-ai-tab-2', 0);
		source.emit('exit', 'sess-ai-tab-1', 0);
		await runtime.flushInterrupts();

		const byId = new Map(triggered.map((payload) => [payload.sessionId, payload]));
		expect(byId.size).toBe(2);
		expect(byId.get('sess-ai-tab-1')).toMatchObject({
			tabId: 'tab-1',
			mode: 'resume',
			providerSessionId: 'prov-1',
			originalGoal: 'Refactor the auth module',
		});
		expect(byId.get('sess-ai-tab-2')).toMatchObject({
			tabId: 'tab-2',
			mode: 'resume',
			providerSessionId: 'prov-2',
			originalGoal: 'Write the tests',
		});
	});

	it('leaves a normally streaming session alone while another one aborts', async () => {
		const { runtime, source, target, triggered } = setupInterrupting([makeRule()]);

		source.emit('spawn', spawnConfig());
		source.emit('spawn', secondTab);

		runtime.observe('sess-ai-tab-1', textEvent('console.log(a)'));
		// Tab 2 keeps streaming clean output through the whole abort.
		expect(runtime.observe('sess-ai-tab-2', textEvent('all good here'))).toEqual([]);
		expect(runtime.observe('sess-ai-tab-2', textEvent('still fine'))).toEqual([]);

		expect(target.interrupt).toHaveBeenCalledTimes(1);
		expect(target.interrupt).toHaveBeenCalledWith('sess-ai-tab-1');
		expect(runtime.driver?.isAbortPending('sess-ai-tab-2')).toBe(false);

		// Tab 2 finishes on its own terms: an ordinary exit, no corrective payload,
		// nothing deferred, and no interrupt charged against its budget.
		source.emit('exit', 'sess-ai-tab-2', 0);
		expect(runtime.driver?.isAbortPending('sess-ai-tab-1')).toBe(true);
		expect(runtime.stateStore.getInterruptCount('sess-ai-tab-2|-')).toBe(0);
		expect(runtime.takeDeferredReminders('sess-ai-tab-2')).toBe('');

		source.emit('exit', 'sess-ai-tab-1', 0);
		await runtime.flushInterrupts();

		expect(triggered.map((payload) => payload.sessionId)).toEqual(['sess-ai-tab-1']);
	});
});
