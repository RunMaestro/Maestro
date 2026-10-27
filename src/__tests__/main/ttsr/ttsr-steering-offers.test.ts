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
	const runtime = new TtsrRuntime({
		isGloballyEnabled: () => enabled,
		getDisabledRules: () => disabled,
		loadConfig: () => ({
			ok: true,
			warnings: [],
			errors: [],
			rules,
			settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS },
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
