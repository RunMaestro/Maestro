/**
 * Tests for the `maestro-cli snooze` verbs.
 *
 * What is worth pinning here is the CLI's own half, not the renderer's:
 *
 *  - `<when>` is parsed LOCALLY, so a typo fails before a round trip and what
 *    goes on the wire is an unambiguous instant rather than a phrase the far
 *    side re-reads against a different clock.
 *  - A snooze id does not say which agent holds it, so the id-addressed verbs
 *    resolve the owner from a `list` first, with prefix matching.
 *  - `--note ""` means "clear the note" and must survive the trip, while an
 *    omitted `--note` must not appear on the wire at all.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

const mockSession = {
	id: 'agent-1',
	name: 'Alpha',
	toolType: 'claude-code',
	cwd: '/proj',
	projectRoot: '/proj',
};
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => (id === 'missing' ? undefined : 'agent-1')),
	readActiveAgentId: vi.fn(() => 'agent-1'),
	getSessionById: vi.fn(() => mockSession),
	readSessions: vi.fn(() => [mockSession]),
	getSessionHistoryMtimeMs: vi.fn(() => 0),
}));

import {
	snoozeDismiss,
	snoozeList,
	snoozeReschedule,
	snoozeTabCommand,
	snoozeWake,
} from '../../../cli/commands/snooze';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const TAB = {
	tabId: 'tab-1',
	sessionId: 'tab-1',
	agentId: 'agent-1',
	agentName: 'Alpha',
	toolType: 'claude-code',
	name: 'Build check',
	agentSessionId: null,
	state: 'idle',
	createdAt: 0,
	starred: false,
	active: true,
	hasUnread: false,
	saveToHistory: false,
	readOnly: false,
	thinking: 'off',
	model: null,
	effort: null,
	enterToSend: null,
};

const SNOOZE = {
	snoozeId: 'snz-abcdef',
	agentId: 'agent-1',
	agentName: 'Alpha',
	type: 'ai' as const,
	label: 'Build check',
	tabId: 'tab-1',
	snoozedAt: 1,
	wakeAt: 2,
};

/** Every message the command sent, in order. */
let sent: Array<Record<string, unknown>>;

/**
 * Answer the desktop's two reads (`list_desktop_sessions`, the `list` action)
 * from fixtures and hand every other snooze verb a plain success.
 */
function stubDesktop(options: { snoozes?: Array<typeof SNOOZE> } = {}): void {
	const snoozes = options.snoozes ?? [SNOOZE];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((msg: Record<string, unknown>) => {
				sent.push(msg);
				if (msg.type === 'list_desktop_sessions') return { sessions: [TAB] };
				if (msg.action === 'list') return { success: true, snoozes };
				if (msg.action === 'history') return { success: true, history: [] };
				return { success: true, snooze: SNOOZE, tabId: 'tab-1' };
			}),
		} as never)
	);
}

/** Snooze messages only - the tab-list read is plumbing, not the assertion. */
function snoozeMessages(): Array<Record<string, unknown>> {
	return sent.filter((m) => m.type === 'snooze_command');
}

describe('maestro-cli snooze', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sent = [];
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		// The real `process.exit` never returns, and `failCommand` is typed
		// `never` on that promise. A spy that returns undefined lets execution
		// fall through into code the command would never have reached, so the
		// stand-in throws to reproduce the same control flow.
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
		stubDesktop();
	});

	/** Run a command that is expected to bail out, swallowing the fake exit. */
	async function expectExit(run: Promise<void>): Promise<void> {
		await expect(run).rejects.toThrow('process.exit');
		expect(exitSpy).toHaveBeenCalledWith(1);
	}

	describe('snooze tab', () => {
		it('resolves the phrase locally and sends an absolute instant', async () => {
			const before = Date.now();
			await snoozeTabCommand('tab-1', '2h', { json: true });

			const [msg] = snoozeMessages();
			expect(msg).toMatchObject({ action: 'snooze', sessionId: 'agent-1', targetId: 'tab-1' });
			// Two hours out, rounded down to the minute by the shared parser.
			expect(msg.wakeAt as number).toBeGreaterThan(before + 110 * 60 * 1000);
			expect(msg.wakeAt as number).toBeLessThan(before + 125 * 60 * 1000);
		});

		it('fails on an unreadable phrase without talking to the desktop', async () => {
			// The phrase is the part a human gets wrong most often, and the parser's
			// own message names what it could not read.
			await expectExit(snoozeTabCommand('tab-1', 'tomorrrow', { json: true }));
			expect(snoozeMessages()).toHaveLength(0);
		});

		it('refuses a snooze shorter than the parser floor', async () => {
			await expectExit(snoozeTabCommand('tab-1', '10s', { json: true }));
			expect(snoozeMessages()).toHaveLength(0);
		});

		it('carries the note and wake prompt through', async () => {
			await snoozeTabCommand('tab-1', '1d', {
				json: true,
				note: 'check the build',
				wakePrompt: 'summarize what changed',
			});

			expect(snoozeMessages()[0]).toMatchObject({
				note: 'check the build',
				wakePrompt: 'summarize what changed',
			});
		});

		it('omits an unset note rather than sending an empty one', async () => {
			// On the far side an absent note means "leave it alone" - sending '' by
			// default would clear a note the caller never mentioned.
			await snoozeTabCommand('tab-1', '1d', { json: true });
			expect('note' in snoozeMessages()[0]).toBe(false);
		});

		it('sends background only when asked, and lets --focus win', async () => {
			await snoozeTabCommand('tab-1', '1d', { json: true });
			expect(snoozeMessages()[0].background).toBe(false);

			sent = [];
			await snoozeTabCommand('tab-1', '1d', { json: true, background: true });
			expect(snoozeMessages()[0].background).toBe(true);

			sent = [];
			await snoozeTabCommand('tab-1', '1d', { json: true, background: true, focus: true });
			expect(snoozeMessages()[0].background).toBe(false);
		});

		it('tells the caller to name an agent for a tab kind it cannot resolve', async () => {
			// Only AI tabs are in the desktop tab list, so a file / terminal /
			// browser / group id needs --agent to say who owns it.
			await expectExit(snoozeTabCommand('file-9', '1d', { json: true }));
			expect(snoozeMessages()).toHaveLength(0);
		});

		it('passes an unresolvable id straight through once --agent is given', async () => {
			await snoozeTabCommand('group-9', '1d', { json: true, agent: 'agent-1' });

			expect(snoozeMessages()[0]).toMatchObject({
				action: 'snooze',
				sessionId: 'agent-1',
				targetId: 'group-9',
			});
		});
	});

	describe('snooze list', () => {
		it('asks for every agent by default and narrows with --agent', async () => {
			await snoozeList({ json: true });
			expect('sessionId' in snoozeMessages()[0]).toBe(false);

			sent = [];
			await snoozeList({ json: true, agent: 'agent-1' });
			expect(snoozeMessages()[0].sessionId).toBe('agent-1');
		});
	});

	describe('id-addressed verbs', () => {
		it('resolves the owning agent from the list, since an id does not name one', async () => {
			await snoozeWake('snz-abcdef', { json: true });

			const [list, wake] = snoozeMessages();
			expect(list.action).toBe('list');
			expect(wake).toMatchObject({
				action: 'wake',
				sessionId: 'agent-1',
				targetId: 'snz-abcdef',
			});
		});

		it('accepts a unique prefix', async () => {
			await snoozeWake('snz-a', { json: true });
			expect(snoozeMessages()[1].targetId).toBe('snz-abcdef');
		});

		it('refuses an ambiguous prefix rather than guessing', async () => {
			stubDesktop({ snoozes: [SNOOZE, { ...SNOOZE, snoozeId: 'snz-abcxyz' }] });
			await expectExit(snoozeWake('snz-abc', { json: true }));
			expect(snoozeMessages().filter((m) => m.action === 'wake')).toHaveLength(0);
		});

		it('reports an id that matches nothing', async () => {
			stubDesktop({ snoozes: [] });
			await expectExit(snoozeDismiss('snz-gone', { json: true }));
			expect(snoozeMessages().filter((m) => m.action === 'dismiss')).toHaveLength(0);
		});

		it('reschedules with a locally resolved instant', async () => {
			const before = Date.now();
			await snoozeReschedule('snz-abcdef', '3h', { json: true });

			const msg = snoozeMessages().find((m) => m.action === 'reschedule')!;
			expect(msg.targetId).toBe('snz-abcdef');
			expect(msg.wakeAt as number).toBeGreaterThan(before + 170 * 60 * 1000);
		});

		it('keeps an explicit empty note, which is how a note is cleared', async () => {
			await snoozeReschedule('snz-abcdef', '3h', { json: true, note: '' });
			expect(snoozeMessages().find((m) => m.action === 'reschedule')!.note).toBe('');
		});
	});
});
