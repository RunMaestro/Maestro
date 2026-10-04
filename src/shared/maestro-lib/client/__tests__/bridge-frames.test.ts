import { describe, it, expect } from 'vitest';
import {
	changedWebSettingKeys,
	classifyFailure,
	parseProcessFrame,
	parseProcessId,
	parseUserInputFrame,
	resolveBridgeOutcome,
} from '../bridge-frames';

const AGENT = '1f0c5e2a-aaaa-4bbb-8ccc-0123456789ab';
const TAB = '9d8c7b6a-1111-4222-8333-fedcba987654';

describe('parseProcessId', () => {
	it('splits a tab process id into agent and tab', () => {
		expect(parseProcessId(`${AGENT}-ai-${TAB}`)).toEqual({
			kind: 'tab',
			agentId: AGENT,
			tabId: TAB,
		});
	});

	it('reads the legacy id as the agent active tab', () => {
		expect(parseProcessId(`${AGENT}-ai`)).toEqual({ kind: 'legacy', agentId: AGENT });
	});

	it.each([
		['Auto Run batch', `${AGENT}-batch-1712345678`],
		['synopsis', `${AGENT}-synopsis-1712345678`],
		['group chat', 'group-chat-abc-moderator-1'],
		['consult', 'cross-agent-req_1'],
		['terminal', `${AGENT}-terminal-${TAB}`],
		['legacy terminal', `${AGENT}-terminal`],
		['command mode', `${AGENT}-shell-r1`],
		['forced parallel run', `${AGENT}-ai-${TAB}-fp-3`],
		['unrelated id', 'something-else'],
	])('drops %s', (_label, id) => {
		expect(parseProcessId(id)).toBeNull();
	});
});

describe('parseProcessFrame', () => {
	const pid = `${AGENT}-ai-${TAB}`;
	const target = { kind: 'tab', agentId: AGENT, tabId: TAB };

	it('maps the streamed channels one to one', () => {
		expect(parseProcessFrame('process:data', [pid, 'hi'])).toEqual({
			target,
			frame: { kind: 'stream', event: { kind: 'text', text: 'hi' } },
		});
		expect(parseProcessFrame('process:thinking-chunk', [pid, 'hmm'])?.frame).toEqual({
			kind: 'stream',
			event: { kind: 'thinking', text: 'hmm' },
		});
		expect(parseProcessFrame('process:session-id', [pid, 'sess-1'])?.frame).toEqual({
			kind: 'stream',
			event: { kind: 'session', providerSessionId: 'sess-1' },
		});
		const usage = { inputTokens: 1, outputTokens: 2 };
		expect(parseProcessFrame('process:usage', [pid, usage])?.frame).toEqual({
			kind: 'stream',
			event: { kind: 'usage', usage },
		});
		const error = { type: 'rate_limited', message: 'slow down' };
		expect(parseProcessFrame('agent:error', [pid, error])?.frame).toEqual({
			kind: 'stream',
			event: { kind: 'error', error },
		});
	});

	it('maps tool executions, reading failed as error and a missing status as running', () => {
		const frame = (state: unknown) =>
			parseProcessFrame('process:tool-execution', [
				pid,
				{ toolName: 'Read', state, toolCallId: 'call-1', parentToolUseId: 'parent-1' },
			])?.frame;
		expect(frame({ status: 'completed', output: 'x' })).toEqual({
			kind: 'stream',
			event: {
				kind: 'tool',
				tool: {
					id: 'call-1',
					name: 'Read',
					status: 'completed',
					detail: { status: 'completed', output: 'x' },
					parentId: 'parent-1',
				},
			},
		});
		expect(frame({ status: 'failed' })).toMatchObject({ event: { tool: { status: 'error' } } });
		expect(frame({ input: {} })).toMatchObject({ event: { tool: { status: 'running' } } });
	});

	it('reads an exit with its code and signal', () => {
		expect(parseProcessFrame('process:exit', [pid, 0, undefined])?.frame).toEqual({
			kind: 'exit',
			exitCode: 0,
			signal: null,
		});
		expect(parseProcessFrame('process:exit', [pid, null, 'SIGTERM'])?.frame).toEqual({
			kind: 'exit',
			exitCode: null,
			signal: 'SIGTERM',
		});
	});

	it('ignores other channels, other processes, and malformed arguments', () => {
		expect(parseProcessFrame('process:stderr', [pid, 'x'])).toBeNull();
		expect(parseProcessFrame('process:data', [`${AGENT}-terminal`, 'x'])).toBeNull();
		expect(parseProcessFrame('process:data', [pid, 42])).toBeNull();
		expect(parseProcessFrame('process:data', [])).toBeNull();
		expect(parseProcessFrame('process:tool-execution', [pid, { state: {} }])).toBeNull();
	});
});

describe('parseUserInputFrame', () => {
	const entry = { id: 'e1', timestamp: 5, source: 'user', text: 'hello' };

	it('reads an AI input with its tab', () => {
		expect(
			parseUserInputFrame([{ originId: 'o', sessionId: AGENT, tabId: TAB, inputMode: 'ai', entry }])
		).toEqual({ agentId: AGENT, tabId: TAB, entry });
	});

	it('leaves the tab open when the payload names none', () => {
		expect(
			parseUserInputFrame([{ sessionId: AGENT, inputMode: 'ai', entry }])?.tabId
		).toBeUndefined();
	});

	it('drops terminal input and malformed payloads', () => {
		expect(parseUserInputFrame([{ sessionId: AGENT, inputMode: 'terminal', entry }])).toBeNull();
		expect(parseUserInputFrame([{ sessionId: AGENT, entry: { id: 'e' } }])).toBeNull();
		expect(parseUserInputFrame([])).toBeNull();
	});
});

describe('resolveBridgeOutcome', () => {
	const base = {
		exitCode: 0,
		signal: null,
		interruptRequested: false,
		lastError: undefined,
		answerText: 'done',
		providerId: 'claude-code',
		sessionId: `${AGENT}-ai-${TAB}`,
	} as const;

	it('is completed for a clean exit', () => {
		expect(resolveBridgeOutcome(base)).toEqual({ outcome: 'completed', exitCode: 0 });
	});

	it('is interrupted when this client asked to stop, before any error', () => {
		const error = { type: 'agent_crashed', message: 'x', recoverable: true } as never;
		expect(
			resolveBridgeOutcome({ ...base, exitCode: 143, interruptRequested: true, lastError: error })
				.outcome
		).toBe('interrupted');
	});

	it('guesses interrupted for a signal exit with no error (gap G5)', () => {
		expect(resolveBridgeOutcome({ ...base, exitCode: null, signal: 'SIGINT' }).outcome).toBe(
			'interrupted'
		);
	});

	it('is crashed with the error when the turn reported one', () => {
		const error = { type: 'rate_limited', message: 'slow down', recoverable: true } as never;
		const result = resolveBridgeOutcome({ ...base, exitCode: 1, lastError: error });
		expect(result).toEqual({ outcome: 'crashed', exitCode: 1, error });
	});

	it('is a warning when text arrived despite a non-zero exit, for a provider that does not call it a crash', () => {
		expect(
			resolveBridgeOutcome({ ...base, providerId: 'provider-from-the-future', exitCode: 2 }).outcome
		).toBe('completed-with-warning');
	});

	it('lets the provider parser classify a non-zero exit as a crash', () => {
		expect(resolveBridgeOutcome({ ...base, exitCode: 2 }).outcome).toBe('crashed');
	});

	it('copes with a provider it has no parser for', () => {
		expect(resolveBridgeOutcome({ ...base, providerId: 'provider-from-the-future' }).outcome).toBe(
			'completed'
		);
	});
});

describe('changedWebSettingKeys', () => {
	it('has nothing to compare against on the first snapshot', () => {
		expect(changedWebSettingKeys(undefined, { theme: 'dracula' })).toBeNull();
	});

	it('maps changed fields back to store keys', () => {
		const before = { theme: 'dracula', fontSize: 14, notificationsEnabled: true, autoScroll: true };
		const after = { theme: 'nord', fontSize: 14, notificationsEnabled: false, autoScroll: false };
		expect(changedWebSettingKeys(before, after)).toEqual([
			'activeThemeId',
			'osNotificationsEnabled',
		]);
	});

	it('compares nested values by content', () => {
		const shortcut = { keys: ['Meta', 'k'] };
		expect(
			changedWebSettingKeys(
				{ shortcuts: { a: shortcut } },
				{ shortcuts: { a: { keys: ['Meta', 'k'] } } }
			)
		).toEqual([]);
		expect(
			changedWebSettingKeys(
				{ shortcuts: { a: shortcut } },
				{ shortcuts: { a: { keys: ['Meta', 'j'] } } }
			)
		).toEqual(['shortcuts']);
	});
});

describe('classifyFailure', () => {
	it('maps the enqueue reasons, the unsupported texts, and not-found texts', () => {
		expect(classifyFailure('Session not found', { reason: 'session-not-found' })).toBe('not-found');
		expect(classifyFailure('No ipcMain handler registered for channel "x"')).toBe('unsupported');
		expect(classifyFailure('Channel "webLogin:x" is not available over the web interface')).toBe(
			'unsupported'
		);
		expect(classifyFailure('Tab abc no longer exists')).toBe('not-found');
		expect(classifyFailure('Tab not found: abc')).toBe('not-found');
	});

	it('keeps a state refusal apart from a plain failure', () => {
		expect(classifyFailure('A live process blocks it', { stateRefusal: true })).toBe('rejected');
		expect(classifyFailure('boom')).toBe('failed');
		expect(classifyFailure(undefined)).toBe('failed');
	});
});
