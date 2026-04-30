/**
 * @file session.test.ts
 * @description Tests for `maestro-cli session list` and `session show`
 *
 * These two commands are PR2 of the CLI surface refactor: read-only
 * conversation-state inspection used by external pollers (Maestro-Discord,
 * Cue follow-ups) that paired with `dispatch` form the "write then poll"
 * loop the design plan calls out.
 *
 * The tests cover the CLI's contract — JSON output shape, --since/--tail
 * forwarding, error mapping — independent of the desktop. The desktop-side
 * read logic is exercised via the integration tests when the WebSocket
 * handler runs against a real session store.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

import { sessionList, sessionShow } from '../../../cli/commands/session';
import { withMaestroClient } from '../../../cli/services/maestro-client';

describe('session list command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('sends list_desktop_sessions and emits JSON with the desktop-supplied entries', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'desktop_sessions_list',
			success: true,
			sessions: [
				{
					tabId: 'tab-1',
					sessionId: 'tab-1',
					agentId: 'agent-a',
					agentName: 'Backend',
					toolType: 'claude-code',
					name: 'Refactor parser',
					agentSessionId: 'claude-uuid-1',
					state: 'idle',
					createdAt: 1714268000000,
					starred: false,
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionList({ json: true });

		expect(mockSendCommand).toHaveBeenCalledWith(
			{ type: 'list_desktop_sessions' },
			'desktop_sessions_list'
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.sessions).toHaveLength(1);
		expect(output.sessions[0].tabId).toBe('tab-1');
		expect(output.sessions[0].agentId).toBe('agent-a');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('returns an empty array when the desktop reports no open tabs', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'desktop_sessions_list',
			success: true,
			sessions: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionList({ json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.sessions).toEqual([]);
	});

	it('renders a human-readable table when --json is omitted', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'desktop_sessions_list',
			success: true,
			sessions: [
				{
					tabId: 'tab-1',
					sessionId: 'tab-1',
					agentId: 'agent-a',
					agentName: 'Backend',
					toolType: 'claude-code',
					name: null,
					agentSessionId: null,
					state: 'busy',
					createdAt: 1714268000000,
					starred: true,
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionList({});

		// Default text mode includes state, star, tabId, agent name+id, and a
		// relative createdAt column. Asserting each surface independently catches
		// regressions where any column is dropped without freezing exact spacing.
		const line = consoleSpy.mock.calls[0][0] as string;
		expect(line).toContain('tab-1');
		expect(line).toContain('Backend');
		expect(line).toContain('busy');
		expect(line).toContain('★');
		// createdAt rendered via formatRelativeTime — the exact phrase depends on
		// `now`, but the column is non-empty for any finite epoch.
		expect(line.split('  ').filter(Boolean).length).toBeGreaterThanOrEqual(4);
	});

	it('maps connection errors to MAESTRO_NOT_RUNNING (consistent with dispatch)', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

		await sessionList({ json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('MAESTRO_NOT_RUNNING');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it.each([
		['Maestro desktop app is not running'],
		['Maestro discovery file is stale (app may have crashed)'],
		['Not connected to Maestro'],
	])('maps MaestroClient error "%s" to MAESTRO_NOT_RUNNING', async (errorMessage) => {
		// Same three pre-WebSocket throws covered by dispatch.test — keeping the
		// mapping in sync means external scripts can branch on a single error
		// code regardless of which CLI verb they used.
		vi.mocked(withMaestroClient).mockRejectedValue(new Error(errorMessage));

		await sessionList({ json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.code).toBe('MAESTRO_NOT_RUNNING');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});

describe('session show command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('sends get_session_history with the tab id and prints JSON when --json is set', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: 'claude-uuid-1',
			messages: [
				{
					id: 'log-1',
					role: 'user',
					source: 'user',
					content: 'Hello',
					timestamp: '2026-04-28T10:00:00.000Z',
				},
				{
					id: 'log-2',
					role: 'assistant',
					source: 'ai',
					content: 'Hi there',
					timestamp: '2026-04-28T10:00:01.000Z',
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { json: true });

		expect(mockSendCommand).toHaveBeenCalledWith(
			{ type: 'get_session_history', tabId: 'tab-1' },
			'session_history_result'
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.tabId).toBe('tab-1');
		expect(output.messages).toHaveLength(2);
		expect(output.messages[0].role).toBe('user');
		expect(output.messages[1].role).toBe('assistant');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('renders a formatted transcript by default (no --json flag)', async () => {
		// Default text mode prints a header line followed by one block per
		// message. ISO timestamps are emitted verbatim so callers can feed them
		// back into `--since` without re-parsing.
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: 'claude-uuid-1',
			messages: [
				{
					id: 'log-1',
					role: 'user',
					source: 'user',
					content: 'Hello',
					timestamp: '2026-04-28T10:00:00.000Z',
				},
				{
					id: 'log-2',
					role: 'assistant',
					source: 'ai',
					content: 'Hi there',
					timestamp: '2026-04-28T10:00:01.000Z',
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', {});

		const lines = consoleSpy.mock.calls.map((c) => c[0] as string);
		const joined = lines.join('\n');
		// Header
		expect(joined).toContain('Tab: tab-1');
		expect(joined).toContain('Agent: agent-a');
		expect(joined).toContain('Session: claude-uuid-1');
		expect(joined).toContain('Messages: 2');
		// Per-message blocks with verbatim ISO timestamps + roles + content
		expect(joined).toContain('[2026-04-28T10:00:00.000Z] user');
		expect(joined).toContain('Hello');
		expect(joined).toContain('[2026-04-28T10:00:01.000Z] assistant');
		expect(joined).toContain('Hi there');
		// Should not be a single JSON blob
		expect(() => JSON.parse(lines[0])).toThrow();
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('prints a friendly placeholder when the conversation is empty (text mode)', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', {});

		const joined = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
		expect(joined).toContain('Messages: 0');
		expect(joined).toContain('(no messages)');
	});

	it('forwards --since as ms epoch when given an ISO timestamp', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { since: '2026-04-28T10:00:00.000Z' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'get_session_history',
				tabId: 'tab-1',
				sinceMs: Date.parse('2026-04-28T10:00:00.000Z'),
			}),
			'session_history_result'
		);
	});

	it('treats a numeric --since below 1e12 as seconds (matches Date.now()/1000 cursors)', async () => {
		// Heuristic protection: a Discord bot pickling a `Math.floor(Date.now() /
		// 1000)` cursor would otherwise filter the entire transcript out (every
		// log timestamp is ms, so the seconds value would be ~1000x too small
		// and pass the > comparison trivially). Auto-scaling matches both
		// cursor styles without requiring explicit unit flags.
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { since: '1714268000' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ sinceMs: 1714268000 * 1000 }),
			'session_history_result'
		);
	});

	it('treats a numeric --since at or above 1e12 as ms', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { since: '1714268000000' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ sinceMs: 1714268000000 }),
			'session_history_result'
		);
	});

	it('rejects an unparseable --since with INVALID_OPTION', async () => {
		await sessionShow('tab-1', { since: 'not-a-date' });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('INVALID_OPTION');
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('forwards --tail as an integer to the desktop', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { tail: '5' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'get_session_history', tabId: 'tab-1', tail: 5 }),
			'session_history_result'
		);
	});

	it('rejects a negative --tail with INVALID_OPTION', async () => {
		await sessionShow('tab-1', { tail: '-1' });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('INVALID_OPTION');
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it.each([['5abc'], ['1.9'], ['5e2'], ['  '], ['']])(
		'rejects partially-numeric --tail %p with INVALID_OPTION (no silent truncation)',
		async (raw) => {
			// `Number.parseInt('5abc', 10) === 5` and `parseInt('1.9', 10) === 1`
			// silently accept these as valid tails — the strict regex precheck
			// is the only thing keeping a typo from quietly capping history at
			// the wrong number.
			await sessionShow('tab-1', { tail: raw });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_OPTION');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		}
	);

	it('forwards --tail 0 as numeric 0 (handler enforces empty-history semantics)', async () => {
		// `--tail 0` is a legitimate ask ("give me nothing yet, just confirm
		// the tab exists"). The CLI must propagate the literal zero — the
		// desktop side has its own slice-bug guard for the historical
		// `slice(-0)` foot-gun. Asserting the wire value here keeps the two
		// halves of the contract pinned down independently.
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { tail: '0' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'get_session_history', tabId: 'tab-1', tail: 0 }),
			'session_history_result'
		);
	});

	it('surfaces TAB_NOT_FOUND from the desktop response', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: false,
			error: 'Tab not found: tab-bogus',
			code: 'TAB_NOT_FOUND',
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-bogus', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('TAB_NOT_FOUND');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('maps connection errors to MAESTRO_NOT_RUNNING', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

		await sessionShow('tab-1', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('MAESTRO_NOT_RUNNING');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
