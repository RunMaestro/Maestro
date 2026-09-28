/**
 * @file dispatch-callback-prompt.test.ts
 * @description Template rendering for the dispatch callback wake-up prompt.
 */

import { describe, it, expect } from 'vitest';

import {
	DEFAULT_CALLBACK_PROMPT,
	DISPATCH_OUTPUT_MAX_CHARS,
	buildDispatchVariables,
	renderCallbackPrompt,
	truncateDispatchOutput,
} from '../../../main/dispatch-callbacks/dispatch-callback-prompt';
import type { DispatchCallbackFire } from '../../../main/dispatch-callbacks/types';

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

describe('truncateDispatchOutput', () => {
	it('keeps short output intact', () => {
		expect(truncateDispatchOutput('hello')).toEqual({ text: 'hello', truncated: false });
	});

	it('tail-slices long output (the conclusion is at the end)', () => {
		const long = 'a'.repeat(DISPATCH_OUTPUT_MAX_CHARS) + 'CONCLUSION';
		const result = truncateDispatchOutput(long);
		expect(result.truncated).toBe(true);
		expect(result.text).toHaveLength(DISPATCH_OUTPUT_MAX_CHARS);
		expect(result.text.endsWith('CONCLUSION')).toBe(true);
	});
});

describe('buildDispatchVariables', () => {
	it('exposes the tab handle and status fields', () => {
		const vars = buildDispatchVariables({ fire: makeFire(), output: 'done' });
		expect(vars.DISPATCH_TARGET_ID).toBe('agent-target');
		expect(vars.DISPATCH_TAB_ID).toBe('tab-1');
		expect(vars.DISPATCH_TARGET_NAME).toBe('Reviewer');
		expect(vars.DISPATCH_STATUS).toBe('completed');
		expect(vars.DISPATCH_EXIT_CODE).toBe('0');
		expect(vars.DISPATCH_DURATION).toBe('4m 12s');
		expect(vars.DISPATCH_OUTPUT).toBe('done');
		expect(vars.DISPATCH_OUTPUT_TRUNCATED).toBe('false');
	});

	it('falls back to the agent id when no display name is known', () => {
		const fire = makeFire();
		delete fire.entry.targetName;
		expect(buildDispatchVariables({ fire }).DISPATCH_TARGET_NAME).toBe('agent-target');
	});

	it('reports n/a task counts outside Auto Run', () => {
		const vars = buildDispatchVariables({ fire: makeFire() });
		expect(vars.DISPATCH_TASKS_COMPLETED).toBe('n/a');
		expect(vars.DISPATCH_TASKS_TOTAL).toBe('n/a');
	});

	it('carries Auto Run task counts when present', () => {
		const vars = buildDispatchVariables({
			fire: makeFire({ tasksCompleted: 4, tasksTotal: 6 }),
		});
		expect(vars.DISPATCH_TASKS_COMPLETED).toBe('4');
		expect(vars.DISPATCH_TASKS_TOTAL).toBe('6');
	});

	it('reports n/a for a null exit code (timeout / killed)', () => {
		const vars = buildDispatchVariables({ fire: makeFire({ status: 'timeout', exitCode: null }) });
		expect(vars.DISPATCH_EXIT_CODE).toBe('n/a');
		expect(vars.DISPATCH_STATUS).toBe('timeout');
	});
});

describe('renderCallbackPrompt', () => {
	it('substitutes the default template', () => {
		const rendered = renderCallbackPrompt({ fire: makeFire(), output: 'all green' });
		expect(rendered).toContain('Your dispatch to "Reviewer" has finished.');
		expect(rendered).toContain('Tab handle: tab-1');
		expect(rendered).toContain('all green');
		expect(rendered).not.toContain('{{DISPATCH_');
	});

	it('fences the agent output as untrusted data', () => {
		expect(DEFAULT_CALLBACK_PROMPT).toContain('untrusted agent output');
		const rendered = renderCallbackPrompt({ fire: makeFire(), output: 'x' });
		expect(rendered).toContain('<<<DISPATCH_OUTPUT');
	});

	it('honours a custom callback prompt', () => {
		const fire = makeFire();
		fire.entry.callbackPrompt = 'Done: {{DISPATCH_STATUS}} in {{DISPATCH_TAB_ID}}';
		expect(renderCallbackPrompt({ fire })).toBe('Done: completed in tab-1');
	});

	it('does not re-substitute placeholders that appear inside agent output', () => {
		const rendered = renderCallbackPrompt({
			fire: makeFire(),
			output: 'literal {{DISPATCH_CALLBACK_ID}} text',
		});
		// Single pass over the template: the placeholder in the output survives
		// verbatim instead of expanding into another variable.
		expect(rendered).toContain('literal {{DISPATCH_CALLBACK_ID}} text');
	});

	it('leaves unknown DISPATCH_ placeholders untouched', () => {
		const fire = makeFire();
		fire.entry.callbackPrompt = 'x {{DISPATCH_NOT_A_THING}}';
		expect(renderCallbackPrompt({ fire })).toBe('x {{DISPATCH_NOT_A_THING}}');
	});

	it('explains when no output could be captured', () => {
		const rendered = renderCallbackPrompt({ fire: makeFire() });
		expect(rendered).toContain('(no output captured');
	});
});
