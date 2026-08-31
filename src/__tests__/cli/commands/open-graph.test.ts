/**
 * @file open-graph.test.ts
 * @description Tests for the open-graph CLI command.
 *
 * `open-graph` is a separate verb rather than a `maestro-cli open <surface>`
 * entry because `open_modal` carries only a surface name and a tab. These tests
 * pin the parts that are easy to get wrong: paths go over the wire ABSOLUTE
 * (the renderer roots the graph at `projectRoot || cwd`, which is not always
 * the cwd the CLI resolved against), a lone directory stays a directory, and
 * anything else flattens to an explicit file list.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	statSync: vi.fn(),
	readdirSync: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

const mockSession = {
	id: 'session-123',
	name: 'Test Agent',
	toolType: 'claude-code',
	cwd: '/home/user/project',
	projectRoot: '/home/user/project',
};
vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(() => mockSession),
	readSessions: vi.fn(() => [mockSession]),
	getSessionHistoryMtimeMs: vi.fn(() => 0),
}));

import { openGraph } from '../../../cli/commands/open-graph';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { existsSync, statSync, readdirSync } from 'fs';

interface SentMessage {
	type?: string;
	sessionId?: string;
	files?: string[];
	directory?: string;
	focusPath?: string;
}

/** Capture the message the command puts on the wire. */
function captureSend(): { sent: SentMessage } {
	const captured: { sent: SentMessage } = { sent: {} };
	vi.mocked(withMaestroClient).mockImplementation(async (action) => {
		const client = {
			sendCommand: vi.fn().mockImplementation((msg: SentMessage) => {
				captured.sent = msg;
				return Promise.resolve({ type: 'open_document_graph_result', success: true });
			}),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		return action(client);
	});
	return captured;
}

function asFile() {
	return { isDirectory: () => false } as unknown as ReturnType<typeof statSync>;
}
function asDirectory() {
	return { isDirectory: () => true } as unknown as ReturnType<typeof statSync>;
}

describe('open-graph command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(existsSync).mockReturnValue(true);
	});

	it('sends explicit markdown files as an absolute file list', async () => {
		const captured = captureSend();
		vi.mocked(statSync).mockReturnValue(asFile());

		await openGraph(['/home/user/project/a.md', '/home/user/project/b.md'], {
			agent: 'session-123',
		});

		expect(captured.sent.type).toBe('open_document_graph');
		expect(captured.sent.sessionId).toBe('session-123');
		expect(captured.sent.files).toEqual(['/home/user/project/a.md', '/home/user/project/b.md']);
		expect(captured.sent.directory).toBeUndefined();
		expect(consoleSpy).toHaveBeenCalled();
	});

	it('keeps a lone directory as a directory scope', async () => {
		// Left as a directory so the app scans it at render time and picks up
		// documents written since the command was typed.
		const captured = captureSend();
		vi.mocked(statSync).mockReturnValue(asDirectory());

		await openGraph(['/home/user/project/docs'], { agent: 'session-123' });

		expect(captured.sent.directory).toBe('/home/user/project/docs');
		expect(captured.sent.files).toEqual([]);
	});

	it('expands a directory when it is mixed with explicit files', async () => {
		const captured = captureSend();
		vi.mocked(statSync).mockImplementation((p) =>
			String(p).endsWith('docs') ? asDirectory() : asFile()
		);
		vi.mocked(readdirSync).mockReturnValue([
			{ name: 'one.md', isDirectory: () => false },
			{ name: 'skip.txt', isDirectory: () => false },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		] as any);

		await openGraph(['/home/user/project/a.md', '/home/user/project/docs'], {
			agent: 'session-123',
		});

		expect(captured.sent.directory).toBeUndefined();
		expect(captured.sent.files).toContain('/home/user/project/a.md');
		expect(captured.sent.files).toContain('/home/user/project/docs/one.md');
		// Only markdown is graphable, so a stray text file must not ride along.
		expect(captured.sent.files?.some((f) => f.endsWith('skip.txt'))).toBe(false);
	});

	it('de-duplicates a file named twice', async () => {
		const captured = captureSend();
		vi.mocked(statSync).mockReturnValue(asFile());

		await openGraph(['/home/user/project/a.md', '/home/user/project/a.md'], {
			agent: 'session-123',
		});

		expect(captured.sent.files).toEqual(['/home/user/project/a.md']);
	});

	it('passes an explicit --focus through as an absolute path', async () => {
		const captured = captureSend();
		vi.mocked(statSync).mockReturnValue(asFile());

		await openGraph(['/home/user/project/a.md', '/home/user/project/b.md'], {
			agent: 'session-123',
			focus: '/home/user/project/b.md',
		});

		expect(captured.sent.focusPath).toBe('/home/user/project/b.md');
	});

	it('leaves focusPath unset so the app auto-centers when none is given', async () => {
		const captured = captureSend();
		vi.mocked(statSync).mockReturnValue(asFile());

		await openGraph(['/home/user/project/a.md'], { agent: 'session-123' });

		expect(captured.sent.focusPath).toBeUndefined();
	});

	it('errors when given no paths at all', async () => {
		await openGraph([], { agent: 'session-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('at least one markdown file')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('errors on a path that does not exist', async () => {
		vi.mocked(existsSync).mockReturnValue(false);

		await openGraph(['/home/user/project/missing.md'], { agent: 'session-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('errors on a non-markdown file rather than silently dropping it', async () => {
		vi.mocked(statSync).mockReturnValue(asFile());

		await openGraph(['/home/user/project/notes.txt'], { agent: 'session-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Not a markdown document')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
