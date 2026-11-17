/**
 * Tests for the `maestro-cli prompt-link` verbs: the CLI's own half.
 *
 *  - Bad --uses / --expires / --open values fail BEFORE a round trip.
 *  - create is one-shot and background unless told otherwise.
 *  - create prints the URL alone on stdout, so `$(...)` captures it.
 *  - list hides inactive links unless --all.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(() => 'agent-1'),
	readActiveAgentId: vi.fn(() => 'agent-1'),
}));

import {
	promptLinkCreate,
	promptLinkList,
	promptLinkRevoke,
} from '../../../cli/commands/prompt-link';
import { withMaestroClient } from '../../../cli/services/maestro-client';

let sent: Array<Record<string, unknown>>;

function stubDesktop(reply: (msg: Record<string, unknown>) => Record<string, unknown>): void {
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((msg: Record<string, unknown>) => {
				sent.push(msg);
				return reply(msg);
			}),
		} as never)
	);
}

const LINK = {
	id: 'aaaa1111-2222-3333-4444-555555555555',
	agentId: 'agent-1',
	prompt: 'Prep me for standup',
	createdAt: 1,
	maxUses: 1,
	useCount: 0,
	open: 'background',
};

describe('maestro-cli prompt-link', () => {
	let exitSpy: MockInstance;
	let logSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sent = [];
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
		stubDesktop(() => ({ success: true, link: LINK, url: 'maestro://run/TOKEN', links: [] }));
	});

	async function expectExit(run: Promise<void>): Promise<void> {
		await expect(run).rejects.toThrow('process.exit');
		expect(exitSpy).toHaveBeenCalledWith(1);
	}

	it('create sends a one-shot background link and prints only the URL on stdout', async () => {
		await promptLinkCreate('alpha', 'Prep me for standup', {});
		expect(sent).toEqual([
			{
				type: 'prompt_link_command',
				action: 'create',
				input: {
					agentId: 'agent-1',
					prompt: 'Prep me for standup',
					maxUses: 1,
					open: 'background',
				},
			},
		]);
		expect(logSpy.mock.calls).toEqual([['maestro://run/TOKEN']]);
	});

	it('create passes uses, expiry, label, and open mode through', async () => {
		const before = Date.now();
		await promptLinkCreate('alpha', 'p', {
			uses: 'unlimited',
			expires: '7d',
			label: ' Standup ',
			open: 'foreground',
		});
		const input = sent[0].input as Record<string, unknown>;
		expect(input).toMatchObject({ maxUses: null, open: 'foreground', label: 'Standup' });
		expect(input.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
	});

	it('create reads the prompt from --prompt-file', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'prompt-link-cli-'));
		try {
			const file = path.join(dir, 'prompt.md');
			writeFileSync(file, 'From a file\nwith two lines', 'utf8');
			await promptLinkCreate('alpha', undefined, { promptFile: file });
			expect((sent[0].input as Record<string, unknown>).prompt).toBe('From a file\nwith two lines');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('create refuses bad values before connecting', async () => {
		await expectExit(promptLinkCreate('alpha', 'p', { uses: '0' }));
		await expectExit(promptLinkCreate('alpha', 'p', { expires: 'soon' }));
		await expectExit(promptLinkCreate('alpha', 'p', { open: 'sideways' }));
		await expectExit(promptLinkCreate('alpha', '   ', {}));
		await expectExit(promptLinkCreate('alpha', 'p', { promptFile: '/x' }));
		expect(sent).toEqual([]);
	});

	it("create reports the desktop's refusal", async () => {
		stubDesktop(() => ({ success: false, error: 'Prompt Links is turned off.' }));
		await expectExit(promptLinkCreate('alpha', 'p', {}));
	});

	it('create --json carries the URL and the link', async () => {
		await promptLinkCreate('alpha', 'p', { json: true });
		const out = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(out).toMatchObject({ success: true, url: 'maestro://run/TOKEN', link: { id: LINK.id } });
	});

	it('list hides inactive links unless --all', async () => {
		stubDesktop(() => ({
			success: true,
			links: [LINK, { ...LINK, id: 'bbbb', useCount: 1, label: 'spent one' }],
		}));
		await promptLinkList({ json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0])).links).toHaveLength(1);

		logSpy.mockClear();
		await promptLinkList({ json: true, all: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0])).links).toHaveLength(2);
	});

	it('list never prints a URL', async () => {
		stubDesktop(() => ({ success: true, links: [LINK] }));
		await promptLinkList({});
		expect(logSpy.mock.calls.flat().join('\n')).not.toContain('maestro://run/');
	});

	it('revoke sends the id it was given', async () => {
		await promptLinkRevoke('aaaa', {});
		expect(sent).toEqual([{ type: 'prompt_link_command', action: 'revoke', id: 'aaaa' }]);
	});
});
