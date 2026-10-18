/**
 * @file open-tool-calls.test.ts
 * @description Tests for src/maestro-p/open-tool-calls.ts - which open tool
 * calls hold off the run-mode idle watchdog.
 */

import { describe, expect, it } from 'vitest';

import {
	OpenToolCalls,
	skipsPermissionPrompts,
	withPermissionBypass,
} from '../../maestro-p/open-tool-calls';

const toolUse = (id: string, name = 'Bash') => ({
	role: 'assistant',
	content: [
		{ type: 'text', text: 'running it' },
		{ type: 'tool_use', id, name, input: {} },
	],
});
const toolResult = (id: string) => ({
	role: 'user',
	content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
});

describe('OpenToolCalls', () => {
	it('is unattended while a Bash call is open and permissions are bypassed', () => {
		const calls = new OpenToolCalls();
		calls.noteAssistant(toolUse('t1'));
		expect(calls.runningUnattended(true)).toBe(true);
	});

	it('is not unattended once every call has its result', () => {
		const calls = new OpenToolCalls();
		calls.noteAssistant(toolUse('t1'));
		calls.noteAssistant(toolUse('t2', 'Agent'));
		calls.noteToolResult(toolResult('t1'));
		expect(calls.runningUnattended(true)).toBe(true);
		calls.noteToolResult(toolResult('t2'));
		expect(calls.runningUnattended(true)).toBe(false);
	});

	it('never holds off when permissions can prompt, since the call may be parked on a dialog', () => {
		const calls = new OpenToolCalls();
		calls.noteAssistant(toolUse('t1'));
		expect(calls.runningUnattended(false)).toBe(false);
	});

	it('never holds off while a call is asking the user something', () => {
		const calls = new OpenToolCalls();
		calls.noteAssistant(toolUse('t1'));
		calls.noteAssistant(toolUse('q1', 'AskUserQuestion'));
		expect(calls.runningUnattended(true)).toBe(false);
	});

	it('ignores rows with no tool blocks', () => {
		const calls = new OpenToolCalls();
		calls.noteAssistant({ content: 'plain text' });
		calls.noteAssistant(null);
		calls.noteToolResult({ content: [{ type: 'text', text: 'hi' }] });
		expect(calls.runningUnattended(true)).toBe(false);
	});
});

describe('skipsPermissionPrompts', () => {
	it('recognizes the flags that bypass permission dialogs', () => {
		expect(skipsPermissionPrompts(['--dangerously-skip-permissions'])).toBe(true);
		expect(skipsPermissionPrompts(['--permission-mode', 'bypassPermissions'])).toBe(true);
		expect(skipsPermissionPrompts(['--permission-mode=bypassPermissions'])).toBe(true);
	});

	it('treats every other mode as able to prompt', () => {
		expect(skipsPermissionPrompts([])).toBe(false);
		expect(skipsPermissionPrompts(['--permission-mode', 'acceptEdits'])).toBe(false);
		expect(skipsPermissionPrompts(['--permission-mode', 'default'])).toBe(false);
	});
});

describe('withPermissionBypass', () => {
	// `claude -p` never stops on a permission dialog; the TUI would, with nobody
	// to answer it.
	it('adds the bypass flag when the caller set no permission mode', () => {
		expect(withPermissionBypass(['--model', 'opus'])).toEqual([
			'--model',
			'opus',
			'--dangerously-skip-permissions',
		]);
	});

	it('does not add it twice', () => {
		expect(withPermissionBypass(['--dangerously-skip-permissions'])).toEqual([
			'--dangerously-skip-permissions',
		]);
		expect(withPermissionBypass(['--permission-mode', 'bypassPermissions'])).toEqual([
			'--permission-mode',
			'bypassPermissions',
		]);
	});

	// `plan` is how a caller asks for a read-only turn; bypassing would let it write.
	it('keeps an explicit permission mode', () => {
		expect(withPermissionBypass(['--permission-mode', 'plan'])).toEqual([
			'--permission-mode',
			'plan',
		]);
		expect(withPermissionBypass(['--permission-mode=plan'])).toEqual(['--permission-mode=plan']);
	});

	it('does not modify the array it is given', () => {
		const args = ['--model', 'opus'];
		withPermissionBypass(args);
		expect(args).toEqual(['--model', 'opus']);
	});
});
