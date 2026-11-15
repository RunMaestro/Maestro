/**
 * Tests for the `maestro-cli diff-review` verbs: the CLI's own half.
 *
 *  - A span or side that cannot be valid fails BEFORE a round trip.
 *  - `send` is background by default (a new verb, called by agents), and
 *    `--focus` asks for the button's behaviour.
 *  - `remove` resolves a unique id prefix against the pending list.
 *  - Outdated comments left behind by `send` are reported, not hidden.
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
	resolveAgentId: vi.fn(() => 'agent-1'),
	readActiveAgentId: vi.fn(() => 'agent-1'),
	getSessionById: vi.fn(() => mockSession),
	readSessions: vi.fn(() => [mockSession]),
	getSessionHistoryMtimeMs: vi.fn(() => 0),
}));

import {
	diffReviewAdd,
	diffReviewClear,
	diffReviewEdit,
	diffReviewList,
	diffReviewRemove,
	diffReviewSend,
} from '../../../cli/commands/diff-review';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { DiffReviewCommentSummary } from '../../../shared/diffReviewCommands';

const COMMENTS: DiffReviewCommentSummary[] = [
	{
		id: 'c-aaa111',
		path: 'src/app.ts',
		side: 'new',
		startLine: 12,
		endLine: 14,
		location: 'src/app.ts:12-14',
		body: 'Merge these.',
		outdated: false,
	},
	{
		id: 'c-bbb222',
		path: 'src/old.ts',
		side: 'old',
		startLine: 3,
		endLine: 3,
		location: 'src/old.ts:3 (previous version)',
		body: 'Why remove this?',
		outdated: true,
	},
];

let sent: Array<Record<string, unknown>>;
let timeouts: unknown[];

function stubDesktop(reply: (msg: Record<string, unknown>) => Record<string, unknown>): void {
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((msg: Record<string, unknown>, _type: string, timeout: unknown) => {
					sent.push(msg);
					timeouts.push(timeout);
					if (msg.action === 'list') return { success: true, cwd: '/proj', comments: COMMENTS };
					return reply(msg);
				}),
		} as never)
	);
}

function printed(spy: MockInstance): string {
	return spy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('maestro-cli diff-review', () => {
	let exitSpy: MockInstance;
	let logSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sent = [];
		timeouts = [];
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
		stubDesktop(() => ({ success: true }));
	});

	async function expectExit(run: Promise<void>): Promise<void> {
		await expect(run).rejects.toThrow('process.exit');
		expect(exitSpy).toHaveBeenCalledWith(1);
	}

	it('list prints each comment and flags the outdated one', async () => {
		await diffReviewList({ agent: 'alpha' });
		const out = printed(logSpy);
		expect(out).toContain('c-aaa111  src/app.ts:12-14');
		expect(out).toContain('src/old.ts:3 (previous version)  [outdated, will not be sent]');
		// git diff runs on the far side, so the CLI waits past its 10s default.
		expect(timeouts[0]).toBeGreaterThan(10_000);
	});

	it('add sends the parsed span, side, and trimmed comment', async () => {
		stubDesktop(() => ({ success: true, comment: COMMENTS[0] }));
		await diffReviewAdd(' src/app.ts ', '14-12', '  Merge these. ', { agent: 'alpha', json: true });
		expect(sent).toEqual([
			{
				type: 'diff_review_command',
				action: 'add',
				sessionId: 'agent-1',
				path: 'src/app.ts',
				startLine: 12,
				endLine: 14,
				side: 'new',
				body: 'Merge these.',
			},
		]);
	});

	it('add refuses a bad span, side, or empty comment without a round trip', async () => {
		await expectExit(diffReviewAdd('f.ts', '12-', 'x', { agent: 'alpha' }));
		await expectExit(diffReviewAdd('f.ts', '12', 'x', { agent: 'alpha', side: 'left' }));
		await expectExit(diffReviewAdd('f.ts', '12', '  ', { agent: 'alpha' }));
		expect(sent).toEqual([]);
	});

	it('add reports the desktop refusal (lines not in the diff)', async () => {
		stubDesktop(() => ({
			success: false,
			error: 'f.ts:99 (new version) is not shown in the diff',
		}));
		await expectExit(diffReviewAdd('f.ts', '99', 'x', { agent: 'alpha' }));
	});

	it('remove resolves a unique id prefix to the whole id', async () => {
		stubDesktop(() => ({ success: true, comment: COMMENTS[0] }));
		await diffReviewRemove('c-aaa', { agent: 'alpha' });
		expect(sent[1]).toMatchObject({ action: 'remove', commentId: 'c-aaa111' });
	});

	it('edit resolves a prefix and sends the trimmed new text', async () => {
		stubDesktop(() => ({ success: true, comment: { ...COMMENTS[0], body: 'Merge all three.' } }));
		await diffReviewEdit('c-bbb', '  Merge all three. ', { agent: 'alpha' });
		expect(sent[1]).toEqual({
			type: 'diff_review_command',
			action: 'edit',
			sessionId: 'agent-1',
			commentId: 'c-bbb222',
			body: 'Merge all three.',
		});
		expect(printed(logSpy)).toContain('Updated comment on src/app.ts:12-14');
	});

	it('edit refuses empty text without a round trip', async () => {
		await expectExit(diffReviewEdit('c-aaa111', '  ', { agent: 'alpha' }));
		expect(sent).toEqual([]);
	});

	it('remove refuses an ambiguous prefix', async () => {
		await expectExit(diffReviewRemove('c-', { agent: 'alpha' }));
		expect(sent.filter((m) => m.action === 'remove')).toEqual([]);
	});

	it('clear reports how many were discarded', async () => {
		stubDesktop(() => ({ success: true, cleared: 2 }));
		await diffReviewClear({ agent: 'alpha' });
		expect(printed(logSpy)).toContain('Discarded 2 review comments');
	});

	it('send is background by default and --focus takes the user there', async () => {
		stubDesktop(() => ({ success: true, delivered: [COMMENTS[0]], outdated: [COMMENTS[1]] }));
		await diffReviewSend({ agent: 'alpha' });
		expect(sent[0]).toMatchObject({ action: 'send', background: true });
		expect(sent[0]).not.toHaveProperty('compose');
		const out = printed(logSpy);
		expect(out).toContain('Review (1 comment) queued for agent-1');
		expect(out).toContain('Not sent, lines changed since they were written (1)');

		sent = [];
		await diffReviewSend({ agent: 'alpha', focus: true, compose: true });
		expect(sent[0]).toMatchObject({ action: 'send', background: false, compose: true });
	});

	it('send fails loudly when nothing current is left to send', async () => {
		stubDesktop(() => ({ success: false, error: 'Every pending comment is outdated' }));
		await expectExit(diffReviewSend({ agent: 'alpha' }));
	});
});
