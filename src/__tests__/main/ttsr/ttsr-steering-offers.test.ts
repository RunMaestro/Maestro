import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { TtsrRuntime } from '../../../main/ttsr/ttsr-runtime';
import { MAX_TTSR_INTERRUPTS, ttsrConversationKey } from '../../../main/ttsr/ttsr-state-store';
import type { TtsrProcessEventSource } from '../../../main/ttsr/ttsr-spawn-registry';
import {
	DEFAULT_TTSR_PROJECT_SETTINGS,
	type LoadedTtsrRule,
	type TtsrTriggeredPayload,
} from '../../../shared/ttsr-types';

const { findAst } = vi.hoisted(() => ({ findAst: vi.fn(async () => null as string | null) }));
vi.mock('../../../main/ttsr/ttsr-ast', () => ({
	createTtsrAstMatcher: () => ({ supports: () => true, find: findAst }),
}));

const sessionId = 'agent-ai-tab';
const rule: LoadedTtsrRule = {
	name: 'logger',
	description: 'Use logger',
	condition: ['console\\.log'],
	compiledCondition: [/console\.log/],
	astCondition: [],
	scope: ['text'],
	globs: [],
	interruptMode: 'always',
	repeatMode: 'once',
	repeatGap: 3,
	agents: ['claude-code'],
	content: 'Use the logger.',
	path: '.maestro/rules/logger.md',
};
function setup(rules: LoadedTtsrRule[] = [rule]) {
	const source = new EventEmitter();
	const offers: TtsrTriggeredPayload[] = [];
	let enabled = true;
	let disabled: string[] = [];
	let projectEnabled = true;
	const runtime = new TtsrRuntime({
		isGloballyEnabled: () => enabled,
		getDisabledRules: () => disabled,
		loadConfig: () => ({
			ok: true,
			warnings: [],
			errors: [],
			rules,
			settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS, enabled: projectEnabled },
		}),
		onTriggered: (payload) => offers.push(payload),
	});
	runtime.attach(source as unknown as TtsrProcessEventSource);
	source.emit('spawn', {
		sessionId,
		toolType: 'claude-code',
		cwd: '/project',
		agentSessionId: 'provider-1',
	});
	return {
		runtime,
		source,
		offers,
		disable: () => {
			enabled = false;
		},
		enable: () => {
			enabled = true;
		},
		disableProject: () => {
			projectEnabled = false;
			runtime.invalidateRules();
		},
		disableRule: () => {
			disabled = ['logger'];
		},
	};
}
function match(runtime: TtsrRuntime, id = sessionId) {
	runtime.observe(id, { type: 'text', text: 'console.log(x)' });
}

describe('TTSR offers to the native queue', () => {
	it('retains a deferred copy until the exact live offer is claimed once', () => {
		const { runtime, offers } = setup();
		match(runtime);
		expect(offers).toHaveLength(1);
		expect(runtime.manager.hasDeferred(sessionId)).toBe(true);
		expect(runtime.claimSteeringRequest(sessionId, 'other-token')).toBe(false);
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(true);
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(false);
		expect(runtime.peekDeferredReminders(sessionId).text).toBe('');
		expect(runtime.stateStore.getInterruptCount(ttsrConversationKey(sessionId, 'provider-1'))).toBe(
			1
		);
	});
	it.each(['global', 'rule'] as const)(
		'refuses a claim after %s authority is withdrawn',
		(kind) => {
			const state = setup();
			match(state.runtime);
			if (kind === 'global') state.disable();
			else state.disableRule();
			expect(state.runtime.claimSteeringRequest(sessionId, state.offers[0].requestId)).toBe(false);
			expect(state.runtime.manager.hasDeferred(sessionId)).toBe(true);
			expect(
				state.runtime.stateStore.getInterruptCount(ttsrConversationKey(sessionId, 'provider-1'))
			).toBe(0);
		}
	);
	it('never claims reminders already delivered by the normal next prompt', () => {
		const { runtime, offers } = setup();
		match(runtime);
		runtime.peekDeferredReminders(sessionId).commit();
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(false);
	});
	it('discards a real delayed AST match after its observed turn was replaced', async () => {
		let release!: (value: string | null) => void;
		findAst.mockReturnValueOnce(
			new Promise<string | null>((resolve) => {
				release = resolve;
			})
		);
		const astRule: LoadedTtsrRule = {
			...rule,
			name: 'ast-logger',
			condition: [],
			compiledCondition: [],
			astCondition: ['console.log($A)'],
			scope: ['tool:write'],
		};
		const { runtime, source, offers } = setup([rule, astRule]);
		runtime.observe(sessionId, {
			type: 'tool_use',
			toolUseBlocks: [
				{
					id: 'write-1',
					name: 'Write',
					input: { file_path: '/project/a.ts', content: 'console.log(x)' },
				},
			],
		});
		expect(findAst).toHaveBeenCalledOnce();
		source.emit('exit', sessionId, 0);
		source.emit('spawn', {
			sessionId,
			toolType: 'claude-code',
			cwd: '/project',
			agentSessionId: 'provider-2',
		});
		release('console.log(x)');
		await runtime.flushAst();
		expect(offers).toEqual([]);
		expect(runtime.manager.hasDeferred(sessionId)).toBe(false);
		match(runtime);
		expect(offers).toHaveLength(1);
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(true);
	});
	it('reserves reminder preparation against a concurrent native steering claim', () => {
		const { runtime, offers } = setup();
		match(runtime);
		const preparing = runtime.peekDeferredReminders(sessionId);
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(false);
		expect(preparing.text).toContain('Use the logger.');
		expect(runtime.manager.hasDeferred(sessionId)).toBe(true);
		preparing.commit();
		expect(runtime.manager.hasDeferred(sessionId)).toBe(false);
	});

	it('keeps unsupported/headless guidance for the next normal prompt', () => {
		const { runtime, source, offers } = setup();
		match(runtime);
		source.emit('exit', sessionId, 0);
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(false);
		expect(runtime.peekDeferredReminders(sessionId).text).toContain('Use the logger.');
		const drain = runtime.peekDeferredReminders(sessionId);
		drain.commit();
		expect(runtime.peekDeferredReminders(sessionId).text).toBe('');
	});
	it('offers no more automatic handoffs after the persisted correction budget', () => {
		const { runtime, offers } = setup();
		for (let i = 0; i < MAX_TTSR_INTERRUPTS; i++) runtime.manager.noteInterrupt(sessionId);
		match(runtime);
		expect(offers).toEqual([]);
		expect(runtime.peekDeferredReminders(sessionId).text).toContain('Use the logger.');
	});
	it('keeps concurrent conversation requests separate', () => {
		const { runtime, source, offers } = setup();
		source.emit('spawn', { sessionId: 'other-ai-tab', toolType: 'claude-code', cwd: '/project' });
		match(runtime);
		match(runtime, 'other-ai-tab');
		expect(offers).toHaveLength(2);
		expect(runtime.claimSteeringRequest('other-ai-tab', offers[0].requestId)).toBe(false);
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(true);
		expect(runtime.peekDeferredReminders('other-ai-tab').text).toContain('Use the logger.');
	});
	it('retains guidance when the renderer push fails', () => {
		const source = new EventEmitter();
		const runtime = new TtsrRuntime({
			isGloballyEnabled: () => true,
			loadConfig: () => ({
				ok: true,
				warnings: [],
				errors: [],
				rules: [rule],
				settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS },
			}),
			onTriggered: vi.fn(() => {
				throw new Error('window gone');
			}),
		});
		runtime.attach(source as unknown as TtsrProcessEventSource);
		source.emit('spawn', { sessionId, toolType: 'claude-code', cwd: '/project' });
		match(runtime);
		expect(runtime.peekDeferredReminders(sessionId).text).toContain('Use the logger.');
	});
});

describe('TTSR native reminder concurrency regressions', () => {
	const fp = `${sessionId}-fp-1730000000000`;
	it('reserves exact matches across normal and forced-parallel offer aliases', () => {
		const { runtime, offers } = setup();
		match(runtime);
		const preparing = runtime.peekDeferredReminders(fp);
		expect(preparing.text).toContain('Use the logger.');
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(false);
		// A second preparation must not receive an already reserved match.
		expect(runtime.peekDeferredReminders(sessionId).text).toBe('');
		preparing.rollback();
		const retry = runtime.peekDeferredReminders(sessionId);
		expect(retry.text).toContain('Use the logger.');
		retry.commit();
		expect(runtime.manager.hasDeferred(fp)).toBe(false);
	});
	it.each(['global', 'project', 'rule'] as const)(
		'omits %s-disabled guidance after exit',
		(kind) => {
			const state = setup();
			match(state.runtime);
			state.source.emit('exit', sessionId, 0);
			if (kind === 'global') state.disable();
			else if (kind === 'project') state.disableProject();
			else state.disableRule();
			expect(state.runtime.peekDeferredReminders(fp).text).toBe('');
		}
	);
	it('commits identities rather than removing newly appended guidance at the cap', () => {
		const rules = Array.from({ length: 11 }, (_, i) => ({
			...rule,
			name: `r${i}`,
			content: `guidance-${i}`,
		}));
		const { runtime } = setup(rules.slice(0, 10));
		match(runtime);
		const preparing = runtime.peekDeferredReminders(sessionId);
		const newer = {
			rule: rules[10],
			source: 'text' as const,
			disposition: 'deferred-prose' as const,
			matchedText: 'x',
		};
		runtime.manager.deferMatches(fp, [newer]);
		preparing.commit();
		expect(runtime.manager.peekDeferred(sessionId)).toEqual([newer]);
	});
	it('keeps simultaneous turn buffers separate across sibling spawn and exit', () => {
		const { runtime, source, offers } = setup();
		runtime.observe(sessionId, { type: 'text', text: 'console.' });
		source.emit('spawn', {
			sessionId: fp,
			toolType: 'claude-code',
			cwd: '/project',
			agentSessionId: 'provider-1',
		});
		runtime.observe(fp, { type: 'text', text: 'log(x)' });
		expect(offers).toEqual([]);
		source.emit('exit', fp, 0);
		runtime.observe(sessionId, { type: 'text', text: 'log(y)' });
		expect(offers).toHaveLength(1);
	});
	it('drops stale rule content after an edit but accepts unchanged reloaded definitions', () => {
		const rules = [{ ...rule }];
		const { runtime } = setup(rules);
		match(runtime);
		rules[0] = { ...rule };
		runtime.invalidateRules();
		const unchanged = runtime.peekDeferredReminders(sessionId);
		expect(unchanged.text).toContain('Use the logger.');
		unchanged.rollback();
		rules[0] = { ...rule, content: 'New guidance.' };
		runtime.invalidateRules();
		expect(runtime.peekDeferredReminders(sessionId).text).toBe('');
		expect(runtime.manager.hasDeferred(sessionId)).toBe(false);
		match(runtime);
		expect(runtime.peekDeferredReminders(sessionId).text).toContain('New guidance.');
	});
	it('keeps provider identity and AST-seen state local to each simultaneous turn', async () => {
		const astRule: LoadedTtsrRule = {
			...rule,
			condition: [],
			compiledCondition: [],
			astCondition: ['console.log($A)'],
			scope: ['tool:write'],
		};
		const { runtime, source, offers } = setup([astRule]);
		source.emit('spawn', {
			sessionId: fp,
			toolType: 'claude-code',
			cwd: '/project',
			agentSessionId: 'provider-2',
		});
		findAst.mockResolvedValue('console.log(x)');
		const event = {
			type: 'tool_use' as const,
			toolUseBlocks: [
				{
					name: 'Write',
					id: 'w',
					input: { file_path: '/project/a.ts', content: 'console.log(x)' },
				},
			],
		};
		runtime.observe(sessionId, event);
		runtime.observe(fp, event);
		await runtime.flushAst();
		expect(offers).toHaveLength(2);
		for (const provider of ['provider-1', 'provider-2']) {
			expect(
				runtime.stateStore.getRuleState(ttsrConversationKey(sessionId, provider), rule.name)
					?.injectionCount
			).toBe(1);
		}
		findAst.mockResolvedValue(null);
	});
	it('adopts only the announcing unknown turn after its sibling already matched', () => {
		const { runtime, source, offers } = setup();
		source.emit('spawn', { sessionId, toolType: 'claude-code', cwd: '/project' });
		source.emit('spawn', { sessionId: fp, toolType: 'claude-code', cwd: '/project' });
		match(runtime);
		source.emit('session-id', fp, 'provider-B');
		expect(
			runtime.stateStore.getRuleState(ttsrConversationKey(sessionId, 'provider-B'), rule.name)
		).toBeNull();
		expect(runtime.observe(sessionId, { type: 'text', text: 'console.log(again)' })).toEqual([]);
		source.emit('session-id', sessionId, 'provider-A');
		expect(runtime.claimSteeringRequest(sessionId, offers[0].requestId)).toBe(true);
		expect(
			runtime.stateStore.getRuleState(ttsrConversationKey(sessionId, 'provider-A'), rule.name)
				?.injectionCount
		).toBe(1);
		expect(runtime.observe(fp, { type: 'text', text: 'console.log(b)' })).toHaveLength(1);
	});
	it('shares bounded unknown-provider handoff budgets and completed turn counts', () => {
		const { runtime, source } = setup();
		source.emit('spawn', { sessionId, toolType: 'claude-code', cwd: '/project' });
		source.emit('spawn', { sessionId: fp, toolType: 'claude-code', cwd: '/project' });
		for (let i = 0; i < MAX_TTSR_INTERRUPTS; i++)
			runtime.manager.noteInterrupt(i % 2 ? fp : sessionId);
		expect(runtime.manager.canInterrupt(fp)).toBe(false);
		expect(runtime.manager.canInterrupt(sessionId)).toBe(false);
		source.emit('exit', fp, 0);
		expect(runtime.manager.canInterrupt(sessionId)).toBe(false);
		source.emit('exit', sessionId, 0);
		const snapshot = runtime.stateStore.snapshot();
		expect(Object.keys(snapshot)).toEqual([ttsrConversationKey(sessionId)]);
		expect(snapshot[ttsrConversationKey(sessionId)].messageCount).toBe(2);
		expect(snapshot[ttsrConversationKey(sessionId)].interruptCount).toBe(MAX_TTSR_INTERRUPTS);
	});
	it('keeps once ownership across disabled unknown-provider exits without counting a turn', () => {
		const state = setup();
		state.source.emit('spawn', { sessionId, toolType: 'claude-code', cwd: '/project' });
		match(state.runtime);
		state.disable();
		state.source.emit('exit', sessionId, 0);
		state.enable();
		state.source.emit('spawn', { sessionId: fp, toolType: 'claude-code', cwd: '/project' });
		expect(state.runtime.observe(fp, { type: 'text', text: 'console.log(b)' })).toEqual([]);
		expect(state.runtime.manager.peekDeferred(fp)).toHaveLength(1);
		expect(state.runtime.stateStore.getMessageCount(ttsrConversationKey(sessionId))).toBe(0);
	});
	it('does not fabricate matches from interleaved sibling text', () => {
		const { runtime, source, offers } = setup();
		source.emit('spawn', {
			sessionId: fp,
			toolType: 'claude-code',
			cwd: '/project',
			agentSessionId: 'provider-1',
		});
		runtime.observe(sessionId, { type: 'text', text: 'console.' });
		runtime.observe(fp, { type: 'text', text: 'log(x)' });
		expect(offers).toEqual([]);
	});
});

describe('TTSR AST transaction regressions', () => {
	const astRule: LoadedTtsrRule = {
		...rule,
		condition: [],
		compiledCondition: [],
		astCondition: ['console.log($A)'],
		scope: ['tool:write'],
	};
	const event = (file: string) => ({
		type: 'tool_use' as const,
		toolUseBlocks: [
			{
				id: file,
				name: 'Write',
				input: { file_path: `/project/${file}.ts`, content: 'console.log(x)' },
			},
		],
	});
	it('charges a once rule once for two concurrent file matches and adopts the current provider ID', async () => {
		const releases: Array<(value: string | null) => void> = [];
		findAst.mockImplementationOnce(() => new Promise((resolve) => releases.push(resolve)));
		findAst.mockImplementationOnce(() => new Promise((resolve) => releases.push(resolve)));
		const { runtime, source } = setup([astRule]);
		source.emit('spawn', { sessionId, toolType: 'claude-code', cwd: '/project' });
		runtime.observe(sessionId, event('a'));
		runtime.observe(sessionId, event('b'));
		source.emit('session-id', sessionId, 'provider-current');
		for (const release of releases) release('console.log(x)');
		await runtime.flushAst();
		expect(runtime.manager.peekDeferred(sessionId)).toHaveLength(1);
		expect(
			runtime.stateStore.getRuleState(ttsrConversationKey(sessionId, 'provider-current'), rule.name)
				?.injectionCount
		).toBe(1);
		expect(
			runtime.stateStore.getRuleState(ttsrConversationKey(sessionId, 'provider-1'), rule.name)
		).toBeNull();
	});
	it('does not charge earlier AST hits when a later rule finishes after turn replacement', async () => {
		let release!: (value: string | null) => void;
		findAst.mockResolvedValueOnce('console.log(x)').mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const { runtime, source } = setup([astRule, { ...astRule, name: 'second' }]);
		runtime.observe(sessionId, event('a'));
		await Promise.resolve();
		source.emit('exit', sessionId, 0);
		source.emit('spawn', {
			sessionId,
			toolType: 'claude-code',
			cwd: '/project',
			agentSessionId: 'provider-1',
		});
		release('console.log(x)');
		await runtime.flushAst();
		expect(
			runtime.stateStore.getRuleState(ttsrConversationKey(sessionId, 'provider-1'), rule.name)
		).toBeNull();
		findAst.mockResolvedValue('console.log(x)');
		runtime.observe(sessionId, event('b'));
		await runtime.flushAst();
		expect(runtime.manager.peekDeferred(sessionId)).toHaveLength(2);
		findAst.mockResolvedValue(null);
	});
});
