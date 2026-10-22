/**
 * @file dispatchCallbackCard.test.ts
 * @description The parser that reads a rendered dispatch callback back into
 * card fields, and the round-trip that binds it to the main-process template.
 */

import { describe, it, expect } from 'vitest';

import {
	DEFAULT_CALLBACK_PROMPT,
	DISPATCH_CALLBACK_HEADER,
	parseDispatchCallbackPrompt,
} from '../../shared/dispatchCallbackCard';
import {
	renderCallbackPrompt,
	type RenderCallbackPromptInput,
} from '../../main/dispatch-callbacks/dispatch-callback-prompt';
import type { DispatchCallbackFire } from '../../main/dispatch-callbacks/types';

function makeFire(overrides: Partial<DispatchCallbackFire> = {}): DispatchCallbackFire {
	return {
		entry: {
			callbackId: 'cb_1',
			targetAgentId: 'agent-target',
			targetTabId: 'tab-1',
			targetName: 'Reviewer',
			callerAgentId: 'agent-caller',
			processSessionId: 'agent-target-ai-tab-1',
			createdAt: 0,
			expiresAt: 1000,
			state: 'fired',
			timeoutMs: 1000,
			prompt: 'review the branch',
		},
		status: 'completed',
		exitCode: 0,
		durationMs: 252_000,
		...overrides,
	};
}

function render(input: RenderCallbackPromptInput): string {
	return renderCallbackPrompt(input);
}

describe('parseDispatchCallbackPrompt', () => {
	it('round-trips the default template: parse(render(x)) recovers the fields', () => {
		const rendered = render({ fire: makeFire(), output: 'all green, shipped' });
		const parsed = parseDispatchCallbackPrompt(rendered);
		expect(parsed).not.toBeNull();
		expect(parsed).toMatchObject({
			targetName: 'Reviewer',
			status: 'completed',
			exitCode: '0',
			duration: '4m 12s',
			tabId: 'tab-1',
			targetAgentId: 'agent-target',
			tasksCompleted: 'n/a',
			tasksTotal: 'n/a',
			dispatchedPrompt: 'review the branch',
			output: 'all green, shipped',
		});
	});

	it('recovers Auto Run task counts', () => {
		const rendered = render({ fire: makeFire({ tasksCompleted: 4, tasksTotal: 6 }), output: 'x' });
		const parsed = parseDispatchCallbackPrompt(rendered);
		expect(parsed?.tasksCompleted).toBe('4');
		expect(parsed?.tasksTotal).toBe('6');
	});

	it('recovers a timeout with no exit code', () => {
		const rendered = render({ fire: makeFire({ status: 'timeout', exitCode: null }), output: '' });
		const parsed = parseDispatchCallbackPrompt(rendered);
		expect(parsed?.status).toBe('timeout');
		expect(parsed?.exitCode).toBe('n/a');
	});

	it('handles multi-line dispatched prompts and output', () => {
		const fire = makeFire();
		fire.entry.prompt = 'line one\nline two\nline three';
		const rendered = render({ fire, output: 'result line one\nresult line two' });
		const parsed = parseDispatchCallbackPrompt(rendered);
		expect(parsed?.dispatchedPrompt).toBe('line one\nline two\nline three');
		expect(parsed?.output).toBe('result line one\nresult line two');
	});

	it('returns null for a custom (--callback-prompt) body', () => {
		const fire = makeFire();
		fire.entry.callbackPrompt = 'Done: {{DISPATCH_STATUS}} in {{DISPATCH_TAB_ID}}';
		expect(parseDispatchCallbackPrompt(render({ fire }))).toBeNull();
	});

	it('returns null for an ordinary user message', () => {
		expect(parseDispatchCallbackPrompt('just a normal message')).toBeNull();
		expect(parseDispatchCallbackPrompt('')).toBeNull();
	});

	it('returns null when the header is present but the body is malformed', () => {
		expect(parseDispatchCallbackPrompt(`${DISPATCH_CALLBACK_HEADER}\ngarbage`)).toBeNull();
	});

	it('rejects an unknown status word', () => {
		const rendered = render({ fire: makeFire(), output: 'x' }).replace(
			'Status: completed',
			'Status: exploded'
		);
		expect(parseDispatchCallbackPrompt(rendered)).toBeNull();
	});

	it('the shared template is the one the header constant describes', () => {
		expect(DEFAULT_CALLBACK_PROMPT.startsWith(DISPATCH_CALLBACK_HEADER)).toBe(true);
	});
});
