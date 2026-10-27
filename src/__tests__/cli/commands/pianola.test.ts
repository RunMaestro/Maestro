/**
 * @file pianola.test.ts
 * @description Tests for the Pianola CLI commands: Encore gating, read views,
 * and the watch loop (with the WebSocket client and dispatch mocked).
 */

import { describe, it, expect, vi, beforeEach, onTestFinished, type MockInstance } from 'vitest';
import type { PianolaRule } from '../../../shared/pianola/types';

const { connectMock, sendCommandMock, disconnectMock, runDispatchMock } = vi.hoisted(() => ({
	connectMock: vi.fn(),
	sendCommandMock: vi.fn(),
	disconnectMock: vi.fn(),
	runDispatchMock: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));
vi.mock('../../../cli/services/pianola-store', () => ({
	readPianolaRules: vi.fn(() => []),
	readPianolaRulesResult: vi.fn(() => ({ rules: [], malformed: false })),
	appendPianolaDecision: vi.fn(),
	readPianolaDecisions: vi.fn(() => []),
	getPianolaProfile: vi.fn(() => ({ source: 'none', entry: null })),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = connectMock;
		sendCommand = sendCommandMock;
		disconnect = disconnectMock;
	},
}));
vi.mock('../../../cli/commands/dispatch', () => ({ runDispatch: runDispatchMock }));

import { pianolaRules, pianolaLog, pianolaWatch } from '../../../cli/commands/pianola';
import {
	PIANOLA_WATCH_RETIRED_EXIT_CODE,
	WATCH_TAB_GONE_GRACE_MS,
} from '../../../shared/pianola/pianola-watcher';
import { readSettingValue } from '../../../cli/services/storage';
import {
	readPianolaRules,
	readPianolaDecisions,
	appendPianolaDecision,
} from '../../../cli/services/pianola-store';

function autoAnswerRule(): PianolaRule {
	return {
		id: 'rule-1',
		enabled: true,
		scope: 'global',
		match: { maxRisk: 'low', kinds: ['question'] },
		action: 'auto_answer',
		answer: 'Use tabs.',
		priority: 1,
		createdAt: 1,
		updatedAt: 1,
	};
}

function questionResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		success: true,
		agentId: 'a1',
		messages: [
			{
				id: 'm1',
				role: 'assistant',
				source: 'ai',
				content: 'Should I name it count or total?',
				timestamp: '2026-01-01T00:00:00.000Z',
			},
		],
		...over,
	};
}

describe('pianola command gating', () => {
	let consoleSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('blocks rules when the pianola Encore flag is off', () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: false });
		expect(() => pianolaRules({})).toThrow('__exit__');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('encore enable pianola'));
		expect(readPianolaRules).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('emits a JSON disabled error when --json is set', () => {
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		expect(() => pianolaLog({ json: true })).toThrow('__exit__');
		const payload = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(payload).toMatchObject({ success: false, code: 'PIANOLA_DISABLED' });
	});

	it('lists rules when the flag is on', () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		pianolaRules({});
		expect(readPianolaRules).toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith('No Pianola rules defined.');
	});

	it('shows the decision log when the flag is on', () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		pianolaLog({});
		expect(readPianolaDecisions).toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith('No Pianola decisions recorded yet.');
	});
});

describe('pianola watch', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		connectMock.mockResolvedValue(undefined);
		disconnectMock.mockReturnValue(undefined);
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		vi.mocked(readPianolaRules).mockReturnValue([]);
	});

	it('refuses to run when the Encore flag is off, before connecting', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: false });
		await expect(pianolaWatch('tab-1', { once: true })).rejects.toThrow('__exit__');
		expect(connectMock).not.toHaveBeenCalled();
	});

	it.each([undefined, 'fixture-manager'])(
		'escalates a question with no matching rule without dispatching (manager: %s)',
		async (manager) => {
			vi.stubEnv('MAESTRO_AGENT_ID', manager);
			onTestFinished(() => vi.unstubAllEnvs());
			sendCommandMock.mockResolvedValue(questionResponse());
			await pianolaWatch('tab-1', { once: true });
			expect(appendPianolaDecision).toHaveBeenCalledTimes(1);
			expect(runDispatchMock).not.toHaveBeenCalled();
			expect(disconnectMock).toHaveBeenCalled();
		}
	);

	it('auto-answers via runDispatch when a rule matches', async () => {
		vi.mocked(readPianolaRules).mockReturnValue([autoAnswerRule()]);
		sendCommandMock.mockResolvedValue(questionResponse());
		runDispatchMock.mockResolvedValue({ success: true });
		await pianolaWatch('tab-1', { once: true });
		expect(runDispatchMock).toHaveBeenCalledWith('a1', 'Use tabs.', { tab: 'tab-1' });
		// Intent + outcome records.
		expect(appendPianolaDecision).toHaveBeenCalledTimes(2);
	});

	it('uses the --agent override as the dispatch target', async () => {
		vi.mocked(readPianolaRules).mockReturnValue([autoAnswerRule()]);
		sendCommandMock.mockResolvedValue(questionResponse({ agentId: 'a1' }));
		runDispatchMock.mockResolvedValue({ success: true });
		await pianolaWatch('tab-1', { once: true, agent: 'a2' });
		expect(runDispatchMock).toHaveBeenCalledWith('a2', 'Use tabs.', { tab: 'tab-1' });
	});

	it('logs and exits the single run on a poll failure', async () => {
		sendCommandMock.mockRejectedValue(new Error('boom'));
		await pianolaWatch('tab-1', { once: true });
		expect(appendPianolaDecision).not.toHaveBeenCalled();
		expect(disconnectMock).toHaveBeenCalled();
	});

	it('retires with the retired exit code once the tab stays missing past the grace period', async () => {
		vi.useFakeTimers();
		try {
			sendCommandMock.mockResolvedValue({
				success: false,
				error: 'Tab not found: tab-1',
				code: 'TAB_NOT_FOUND',
			});
			const run = pianolaWatch('tab-1', { interval: '30' });
			await vi.advanceTimersByTimeAsync(WATCH_TAB_GONE_GRACE_MS + 60_000);
			await run;
			expect(process.exitCode).toBe(PIANOLA_WATCH_RETIRED_EXIT_CODE);
			// Polled through the grace period rather than retiring on the first miss.
			expect(sendCommandMock.mock.calls.length).toBeGreaterThan(1);
			expect(disconnectMock).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			process.exitCode = undefined;
		}
	});

	it('does not retire on a transient tab miss', async () => {
		sendCommandMock.mockResolvedValue({ success: false, code: 'TAB_NOT_FOUND' });
		await pianolaWatch('tab-1', { once: true });
		expect(process.exitCode).toBeUndefined();
	});

	it('retires an idle tab with nothing in flight', async () => {
		sendCommandMock.mockResolvedValue(
			questionResponse({
				messages: [
					{
						id: 'm1',
						role: 'user',
						source: 'user',
						content: 'thanks',
						timestamp: '2026-01-01T00:00:00.000Z',
					},
				],
			})
		);
		try {
			// A 1-second idle window is already exceeded by a message from January.
			await pianolaWatch('tab-1', { idleHours: String(1 / 3600) });
			expect(process.exitCode).toBe(PIANOLA_WATCH_RETIRED_EXIT_CODE);
		} finally {
			process.exitCode = undefined;
		}
	});

	it('exits when the connection cannot be established', async () => {
		connectMock.mockRejectedValue(new Error('no server'));
		await expect(pianolaWatch('tab-1', { once: true })).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
