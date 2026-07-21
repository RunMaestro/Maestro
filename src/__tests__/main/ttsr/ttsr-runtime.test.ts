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
	const loadConfig = vi.fn(() => result(options.rules ?? [makeRule()], options.projectEnabled));
	const runtime = new TtsrRuntime({
		isGloballyEnabled: () => options.enabled !== false,
		getDisabledRules: () => options.disabledRules ?? [],
		onMatched: (payload) => matched.push(payload),
		loadConfig,
	});
	const source = new EventEmitter() as unknown as TtsrProcessEventSource;
	runtime.attach(source);
	return { runtime, matched, loadConfig, source: source as unknown as EventEmitter };
}

const spawnConfig = (overrides: Record<string, unknown> = {}) => ({
	sessionId: 'sess-ai-1',
	toolType: 'claude-code',
	cwd: ROOT,
	command: 'claude',
	args: [],
	prompt: 'Refactor the auth module',
	tabId: 'tab-1',
	...overrides,
});

const textEvent = (text: string): ParsedEvent => ({ type: 'text', text });

describe('TtsrSpawnRegistry', () => {
	it('records the original prompt and prefers projectPath over cwd', () => {
		const registry = new TtsrSpawnRegistry();
		const meta = registry.noteSpawn({
			sessionId: 's1',
			toolType: 'codex',
			cwd: '/home/user',
			projectPath: '/repo',
			prompt: 'do the thing',
			tabId: 't1',
		});

		expect(meta).not.toBeNull();
		expect(meta?.projectRoot).toBe('/repo');
		expect(meta?.originalPrompt).toBe('do the thing');
		expect(meta?.agentId).toBe('codex');
		expect(registry.get('s1')?.tabId).toBe('t1');
	});

	it('ignores terminal spawns and unknown agents', () => {
		const registry = new TtsrSpawnRegistry();
		expect(registry.noteSpawn({ sessionId: 's1', toolType: 'terminal', cwd: ROOT })).toBeNull();
		expect(registry.noteSpawn({ sessionId: 's2', toolType: 'not-an-agent', cwd: ROOT })).toBeNull();
		expect(registry.size).toBe(0);
	});

	it('seeds the provider session id from a resume spawn and updates it later', () => {
		const registry = new TtsrSpawnRegistry();
		registry.noteSpawn({ ...spawnConfig(), agentSessionId: 'prov-1' });
		expect(registry.get('sess-ai-1')?.providerSessionId).toBe('prov-1');

		registry.noteProviderSessionId('sess-ai-1', 'prov-2');
		expect(registry.get('sess-ai-1')?.providerSessionId).toBe('prov-2');

		registry.clear('sess-ai-1');
		expect(registry.get('sess-ai-1')).toBeUndefined();
	});
});

describe('TtsrRuntime tap', () => {
	it('is a no-op when the feature gate is off (no rule load, no match)', () => {
		const { runtime, loadConfig, matched, source } = setup({ enabled: false });
		source.emit('spawn', spawnConfig());

		expect(runtime.observe('sess-ai-1', textEvent('console.log(x)'))).toEqual([]);
		expect(loadConfig).not.toHaveBeenCalled();
		expect(matched).toEqual([]);
	});

	it('is a no-op for an unregistered session (terminal, or events after exit)', () => {
		const { runtime, loadConfig } = setup();
		expect(runtime.observe('never-spawned', textEvent('console.log(x)'))).toEqual([]);
		expect(loadConfig).not.toHaveBeenCalled();
	});

	it('matches a rule for a registered turn and reports it', () => {
		const { runtime, matched, source } = setup();
		source.emit('spawn', spawnConfig());

		const matches = runtime.observe('sess-ai-1', textEvent('adding console.log(x) now'));

		expect(matches).toHaveLength(1);
		expect(matches[0]?.rule.name).toBe('no-console-log');
		expect(matches[0]?.disposition).toBe('interrupt');
		expect(matched).toEqual([
			expect.objectContaining({
				sessionId: 'sess-ai-1',
				agentId: 'claude-code',
				source: 'text',
				willInterrupt: true,
			}),
		]);
	});

	it('honors the project-level enabled switch', () => {
		const { runtime, source } = setup({ projectEnabled: false });
		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-1', textEvent('console.log(x)'))).toEqual([]);
	});

	it('drops globally disabled rules', () => {
		const { runtime, source } = setup({ disabledRules: ['no-console-log'] });
		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-1', textEvent('console.log(x)'))).toEqual([]);
	});

	it('caches the rule set per project instead of re-reading it per event', () => {
		const { runtime, loadConfig, source } = setup();
		source.emit('spawn', spawnConfig());

		runtime.observe('sess-ai-1', textEvent('nothing here'));
		runtime.observe('sess-ai-1', textEvent('still nothing'));
		expect(loadConfig).toHaveBeenCalledTimes(1);

		runtime.invalidateRules(ROOT);
		runtime.observe('sess-ai-1', textEvent('and again'));
		expect(loadConfig).toHaveBeenCalledTimes(2);
	});

	it('survives a broken rule directory by matching nothing', () => {
		const loadConfig = vi.fn(() => {
			throw new Error('EACCES');
		});
		const runtime = new TtsrRuntime({ isGloballyEnabled: () => true, loadConfig });
		const source = new EventEmitter();
		runtime.attach(source as unknown as TtsrProcessEventSource);
		source.emit('spawn', spawnConfig());

		expect(runtime.observe('sess-ai-1', textEvent('console.log(x)'))).toEqual([]);
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
		expect(runtime.observe('sess-ai-1', event)).toEqual([]);
		expect(matched).toEqual([]);

		await runtime.flushAst();

		expect(matched).toHaveLength(1);
		expect(matched[0].source).toBe('tool:write');
		expect(runtime.manager.takeInterrupts('sess-ai-1')).toHaveLength(1);
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
		runtime.observe('sess-ai-1', event);

		await runtime.flushAst();
		expect(runtime.manager.takeInterrupts('sess-ai-1')).toEqual([]);
	});
});

describe('TtsrRuntime lifecycle wiring', () => {
	it('folds the provider session id into the registry and repeat state', () => {
		const { runtime, source } = setup({ rules: [makeRule({ repeatMode: 'once' })] });
		source.emit('spawn', spawnConfig());

		// Fires before the provider id is known - lands in the pending bucket.
		expect(runtime.observe('sess-ai-1', textEvent('console.log(a)'))).toHaveLength(1);
		source.emit('session-id', 'sess-ai-1', 'prov-9');

		expect(runtime.registry.get('sess-ai-1')?.providerSessionId).toBe('prov-9');
		// `once` already fired, and adopting the id must not resurrect it.
		expect(runtime.observe('sess-ai-1', textEvent('console.log(b)'))).toEqual([]);
	});

	it('picks the provider id up from the stream init event too', () => {
		const { runtime, source } = setup();
		source.emit('spawn', spawnConfig());
		runtime.observe('sess-ai-1', { type: 'init', sessionId: 'prov-init' });
		expect(runtime.registry.get('sess-ai-1')?.providerSessionId).toBe('prov-init');
	});

	it('clears the registry on exit and advances the after-gap turn counter', () => {
		const rule = makeRule({ repeatMode: 'after-gap', repeatGap: 2 });
		const { runtime, source } = setup({ rules: [rule] });

		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-1', textEvent('console.log(a)'))).toHaveLength(1);
		source.emit('exit', 'sess-ai-1', 0);
		expect(runtime.registry.size).toBe(0);

		// Turn 2: one turn elapsed, still inside the gap.
		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-1', textEvent('console.log(b)'))).toEqual([]);
		source.emit('exit', 'sess-ai-1', 0);

		// Turn 3: the gap has elapsed, so the rule is eligible again.
		source.emit('spawn', spawnConfig());
		expect(runtime.observe('sess-ai-1', textEvent('console.log(c)'))).toHaveLength(1);
	});

	it('detaches its listeners', () => {
		const { runtime, source } = setup();
		const detach = runtime.attach(source as unknown as TtsrProcessEventSource);
		detach();
		source.emit('spawn', spawnConfig());
		expect(runtime.registry.size).toBe(0);
	});
});
