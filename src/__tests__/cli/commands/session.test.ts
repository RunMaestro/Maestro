/**
 * @file session.test.ts
 * @description Tests for `maestro-cli session list` and `session show`
 *
 * These two commands are PR2 of the CLI surface refactor: read-only
 * conversation-state inspection used by external pollers (Maestro-Discord,
 * Cue follow-ups) that paired with `dispatch` form the "write then poll"
 * loop the design plan calls out.
 *
 * The tests cover the CLI's contract - JSON output shape, --since/--tail
 * forwarding, error mapping - independent of the desktop. The desktop-side
 * read logic is exercised via the integration tests when the WebSocket
 * handler runs against a real session store.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import {
	MaestroNotRunningError,
	MAESTRO_NOT_RUNNING_MESSAGE,
} from '../../../cli/services/maestro-not-running';

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

	describe('hidden tabs (#2008)', () => {
		const entries = [
			{ tabId: 'tab-visible', agentId: 'agent-a', agentName: 'Backend', hidden: false },
			{ tabId: 'tab-consult', agentId: 'agent-a', agentName: 'Backend', hidden: true },
			// An older desktop omits the field; that tab is not hidden.
			{ tabId: 'tab-legacy', agentId: 'agent-a', agentName: 'Backend' },
		];
		const mockDesktop = () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'desktop_sessions_list',
				success: true,
				sessions: entries,
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = { sendCommand: mockSendCommand };
				return action(mockClient as never);
			});
		};

		it('leaves hidden tabs out by default', async () => {
			mockDesktop();
			await sessionList({ json: true });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
				'tab-visible',
				'tab-legacy',
			]);
		});

		it('lists hidden tabs, flagged, with --include-hidden', async () => {
			mockDesktop();
			await sessionList({ json: true, includeHidden: true });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
				'tab-visible',
				'tab-consult',
				'tab-legacy',
			]);
			expect(output.sessions[1].hidden).toBe(true);
		});
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
		// createdAt rendered via formatRelativeTime - the exact phrase depends on
		// `now`, but the column is non-empty for any finite epoch.
		expect(line.split('  ').filter(Boolean).length).toBeGreaterThanOrEqual(4);
	});

	describe('visible / hidden / orphaned scope (#2008)', () => {
		const tab = (
			tabId: string,
			visibility?: 'visible' | 'hidden' | 'orphaned',
			hiddenReason: string | null = null
		) => ({
			tabId,
			sessionId: tabId,
			agentId: 'agent-a',
			agentName: 'Backend',
			toolType: 'claude-code',
			name: tabId,
			agentSessionId: null,
			state: 'idle',
			createdAt: 1714268000000,
			starred: false,
			...(visibility === undefined
				? {}
				: { hidden: visibility === 'hidden', hiddenReason, visibility }),
		});
		const stripTab = (tabId: string, tabType: string, visibility: string, target: string) => ({
			tabId,
			tabType,
			agentId: 'agent-a',
			agentName: 'Backend',
			name: tabId,
			target,
			active: false,
			visibility,
		});
		const mockList = (sessions: unknown[], tabs?: unknown[]) => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'desktop_sessions_list',
				success: true,
				sessions,
				...(tabs ? { tabs } : {}),
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand: mockSendCommand } as never)
			);
			return mockSendCommand;
		};
		const fleet = [
			tab('visible-1', 'visible'),
			tab('consult-1', 'hidden', 'consult'),
			tab('dispatch-1', 'hidden', 'background'),
			tab('closed-1', 'orphaned'),
			// A desktop that predates the field: treated as visible.
			tab('legacy-1'),
		];
		const strip = [
			stripTab('file-1', 'file', 'visible', '/repo/README.md'),
			stripTab('web-1', 'browser', 'visible', 'https://example.test/'),
			stripTab('term-1', 'terminal', 'orphaned', '/repo'),
		];

		it('lists only the tabs the tab strips draw by default, and counts the rest', async () => {
			mockList(fleet);
			await sessionList({ json: true });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.scope).toBe('visible');
			expect(output.type).toBe('ai');
			expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
				'visible-1',
				'legacy-1',
			]);
			expect(output.counts).toEqual({ visible: 2, hidden: 2, orphaned: 1 });
			expect(output).not.toHaveProperty('tabs');
		});

		it('flags a desktop that does not report visibility', async () => {
			mockList([tab('legacy-1'), tab('legacy-2')]);
			await sessionList({ json: true });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.visibilityReported).toBe(false);
			expect(output.sessions).toHaveLength(2);

			consoleSpy.mockClear();
			mockList(fleet);
			await sessionList({ json: true });
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).visibilityReported).toBe(true);
		});

		it('--hidden lists only hidden tabs; --include-hidden adds them to the visible ones', async () => {
			mockList(fleet);
			await sessionList({ json: true, hidden: true });
			let output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.scope).toBe('hidden');
			expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
				'consult-1',
				'dispatch-1',
			]);

			consoleSpy.mockClear();
			mockList(fleet);
			await sessionList({ json: true, includeHidden: true });
			output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.scope).toBe('visible+hidden');
			expect(output.sessions.map((s: { tabId: string }) => s.tabId)).not.toContain('closed-1');
			expect(output.sessions).toHaveLength(4);
		});

		it('--all lists every tab, orphans included', async () => {
			mockList(fleet);
			await sessionList({ json: true, all: true });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.scope).toBe('all');
			expect(output.sessions).toHaveLength(5);
			expect(
				output.sessions.find((s: { tabId: string }) => s.tabId === 'closed-1').visibility
			).toBe('orphaned');
		});

		it('--type all adds file, browser and terminal tabs under "tabs"', async () => {
			mockList(fleet, strip);
			await sessionList({ json: true, type: 'all' });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.sessions.map((s: { tabId: string }) => s.tabId)).toEqual([
				'visible-1',
				'legacy-1',
			]);
			expect(output.tabs.map((t: { tabId: string }) => t.tabId)).toEqual(['file-1', 'web-1']);
			expect(output.counts).toEqual({ visible: 4, hidden: 2, orphaned: 2 });
		});

		it('--type file lists only file tabs and no AI tabs', async () => {
			mockList(fleet, strip);
			await sessionList({ json: true, type: 'file' });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.sessions).toEqual([]);
			expect(output.tabs).toEqual([strip[0]]);
			expect(output.counts).toEqual({ visible: 1, hidden: 0, orphaned: 0 });
		});

		it('refuses a non-AI --type against a desktop that does not report those tabs', async () => {
			mockList(fleet);
			await sessionList({ json: true, type: 'terminal' });
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).code).toBe('UNSUPPORTED');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects an unknown --type before contacting the desktop', async () => {
			const send = mockList(fleet);
			await sessionList({ json: true, type: 'tiles' });
			expect(send).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).code).toBe('INVALID_OPTION');
		});

		it('marks hidden and orphaned rows and names what was left out in text mode', async () => {
			mockList(fleet, strip);
			await sessionList({ all: true, type: 'all' });
			const lines = consoleSpy.mock.calls.map((c) => c[0] as string);
			expect(lines.find((l) => l.includes('consult-1'))).toContain('[hidden]');
			expect(lines.find((l) => l.includes('closed-1'))).toContain('[orphaned');
			expect(lines.find((l) => l.includes('visible-1'))).not.toContain('[');
			expect(lines.find((l) => l.includes('web-1'))).toContain('https://example.test/');
			expect(lines.find((l) => l.includes('term-1'))).toMatch(/^terminal .*\[orphaned/);

			consoleSpy.mockClear();
			mockList(fleet);
			await sessionList({});
			const footer = consoleSpy.mock.calls.at(-1)?.[0] as string;
			expect(footer).toContain('2 hidden, 1 orphaned not shown');
			expect(footer).toContain('--include-hidden');
		});

		it('rejects more than one scope flag before contacting the desktop', async () => {
			const send = mockList(fleet);
			await sessionList({ json: true, includeHidden: true, all: true });
			expect(send).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).code).toBe('INVALID_OPTION');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	it('preserves an unknown desktop state in human-readable output', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'desktop_sessions_list',
			success: true,
			sessions: [
				{
					tabId: 'tab-unknown',
					sessionId: 'tab-unknown',
					agentId: 'agent-a',
					agentName: 'Backend',
					toolType: 'claude-code',
					name: null,
					agentSessionId: null,
					state: 'unknown',
					createdAt: 1714268000000,
					starred: false,
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionList({});

		expect(consoleSpy.mock.calls[0][0]).toContain('unknown');
	});

	it.each([
		['no-discovery-file'],
		['stale-discovery-file'],
		['connect-timeout'],
		['connect-failed'],
	] as const)('maps a %s MaestroNotRunningError to MAESTRO_NOT_RUNNING, exit 3', async (reason) => {
		// Same outcome dispatch reports, so external scripts can branch on one
		// code and one exit status whichever verb they used.
		vi.mocked(withMaestroClient).mockRejectedValue(new MaestroNotRunningError(reason));

		await sessionList({ json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({
			success: false,
			error: MAESTRO_NOT_RUNNING_MESSAGE,
			code: 'MAESTRO_NOT_RUNNING',
		});
		expect(processExitSpy.mock.calls[0]).toEqual([3]);
	});

	it('keeps an ordinary error as COMMAND_FAILED, exit 1', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

		await sessionList({ json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.code).toBe('COMMAND_FAILED');
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
			provider: 'claude-code',
			agentProvider: 'codex',
			tabProvider: 'claude-code',
			turnProvider: 'codex',
			pendingTranslation: 'codex',
			effectiveModel: 'auto',
			effectiveEffort: 'high',
			runOn: { type: 'provider' },
			providerSessions: { codex: { agentSessionId: 'parked-private-id' } },
			customEnvVars: { PRIVATE_TEST_VALUE: 'must-not-be-published' },
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
		expect(output).toMatchObject({
			provider: 'claude-code',
			agentProvider: 'codex',
			tabProvider: 'claude-code',
			turnProvider: 'codex',
			pendingTranslation: 'codex',
			effectiveModel: 'auto',
			effectiveEffort: 'high',
			runOn: { type: 'provider' },
		});
		expect(output).not.toHaveProperty('providerSessions');
		expect(output).not.toHaveProperty('customEnvVars');
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
			// silently accept these as valid tails - the strict regex precheck
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
		// the tab exists"). The CLI must propagate the literal zero - the
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

	it('maps an absent app to MAESTRO_NOT_RUNNING, exit 3', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new MaestroNotRunningError('no-discovery-file'));

		await sessionShow('tab-1', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('MAESTRO_NOT_RUNNING');
		expect(processExitSpy.mock.calls[0]).toEqual([3]);
	});
});
