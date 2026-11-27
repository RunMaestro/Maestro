/**
 * Tests for src/renderer/services/fileReview.ts: a File Preview review is
 * delivered through the same queue / composer paths as a Git Diff review,
 * outdated comments stay behind, and every `maestro-cli file-review` verb
 * reads and writes the store the File Preview draws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(() => 'toast-id'),
}));
vi.mock('../../../renderer/stores/centerFlashStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/centerFlashStore')>()),
	notifyCenterFlash: vi.fn(),
}));
vi.mock('../../../renderer/services/crossAgentMentions', () => ({
	planCrossAgentMentions: () => null,
}));

import {
	deliverFileReview,
	fileReviewPath,
	runRemoteFileReviewCommand,
} from '../../../renderer/services/fileReview';
import { fileReviewKey, useFileReviewStore } from '../../../renderer/stores/fileReviewStore';
import { anchorForFileLines, type FileComment } from '../../../renderer/utils/fileReviewComments';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

const FILE = '/proj/docs/plan.md';
const DOC = ['# Plan', 'Ship the parser.', 'Then the CLI.'].join('\n');
const KEY = fileReviewKey('agent-1', FILE);

const readFile = vi.fn(async (..._args: unknown[]): Promise<string | null> => DOC);

function seed(overrides: Partial<Session> = {}): void {
	const target = createMockSession({
		id: 'agent-1',
		name: 'Builder',
		cwd: '/proj',
		aiTabs: [createMockAITab({ id: 'tab-a', name: 'Alpha', inputValue: '' })],
		unifiedTabOrder: [{ type: 'ai', id: 'tab-a' }],
		activeTabId: 'tab-a',
		executionQueue: [],
		...overrides,
	});
	useSessionStore.setState({ sessions: [target], activeSessionId: 'agent-1' });
}

function comment(id: string, line: number, body = 'Fix it.'): FileComment {
	const anchor = anchorForFileLines({ content: DOC, path: 'docs/plan.md', startLine: line })!;
	return { ...anchor, id, body };
}

const queued = () => useSessionStore.getState().sessions[0].executionQueue;

beforeEach(() => {
	useFileReviewStore.setState({ commentsByKey: {}, draftsByKey: {}, discardsByKey: {} });
	readFile.mockClear();
	readFile.mockImplementation(async () => DOC);
	// The shared setup mocks window.maestro.fs; point its readFile at this file.
	vi.mocked(window.maestro.fs.readFile).mockImplementation(readFile);
	seed();
});

describe('fileReviewPath', () => {
	it("is relative under the agent's folder and absolute outside it", () => {
		expect(fileReviewPath('/proj/docs/plan.md', '/proj')).toBe('docs/plan.md');
		expect(fileReviewPath('/elsewhere/x.md', '/proj')).toBe('/elsewhere/x.md');
	});
});

describe('fileReviewKey', () => {
	it('keeps one review per agent, file, and host', () => {
		expect(fileReviewKey('a', FILE)).not.toBe(fileReviewKey('b', FILE));
		expect(fileReviewKey('a', FILE, 'host')).not.toBe(fileReviewKey('a', FILE));
	});
});

describe('deliverFileReview', () => {
	it('queues current comments as one prompt and forgets only what it sent', () => {
		const store = useFileReviewStore.getState();
		store.addComment(KEY, comment('keep', 2, 'Name the parser.'));
		// Written against a line that now reads differently: outdated.
		store.addComment(KEY, { ...comment('stale', 3), lineContents: ['Then the TUI.'] });

		const result = deliverFileReview({
			sessionId: 'agent-1',
			key: KEY,
			content: DOC,
			mode: 'send',
			background: true,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.delivered.map((c) => c.id)).toEqual(['keep']);
		expect(result.outdated.map((c) => c.id)).toEqual(['stale']);
		expect(result.prompt).toContain('`docs/plan.md:2`');
		expect(result.prompt).toContain('Name the parser.');
		expect(queued()).toHaveLength(1);
		expect(useFileReviewStore.getState().commentsByKey[KEY].map((c) => c.id)).toEqual(['stale']);
	});

	it('refuses, and keeps everything, when every comment is outdated', () => {
		useFileReviewStore.getState().addComment(KEY, comment('c', 2));
		const result = deliverFileReview({
			sessionId: 'agent-1',
			key: KEY,
			content: 'rewritten',
			mode: 'send',
		});
		expect(result.ok).toBe(false);
		expect(queued()).toHaveLength(0);
		expect(useFileReviewStore.getState().commentsByKey[KEY]).toHaveLength(1);
	});
});

describe('runRemoteFileReviewCommand (maestro-cli file-review)', () => {
	it('adds a comment quoted from the file on disk, under the key the File Preview reads', async () => {
		const result = await runRemoteFileReviewCommand({
			action: 'add',
			sessionId: 'agent-1',
			file: 'docs/plan.md',
			startLine: 2,
			endLine: 3,
			body: 'Merge these.',
		});
		expect(result.success).toBe(true);
		expect(result.file).toBe(FILE);
		expect(result.comment?.location).toBe('docs/plan.md:2-3');
		expect(readFile).toHaveBeenCalledWith(FILE, undefined);
		expect(useFileReviewStore.getState().commentsByKey[KEY][0].lineContents).toEqual([
			'Ship the parser.',
			'Then the CLI.',
		]);
	});

	it('refuses lines past the end of the file', async () => {
		const result = await runRemoteFileReviewCommand({
			action: 'add',
			sessionId: 'agent-1',
			file: FILE,
			startLine: 9,
			body: 'x',
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain('3 lines');
	});

	it('reports a file it cannot read', async () => {
		readFile.mockImplementation(async () => null);
		const result = await runRemoteFileReviewCommand({
			action: 'list',
			sessionId: 'agent-1',
			file: FILE,
		});
		expect(result).toEqual({ success: false, error: `Could not read ${FILE}` });
	});

	it('lists with outdated flags, edits, removes, clears, and sends through the tray path', async () => {
		const store = useFileReviewStore.getState();
		store.addComment(KEY, comment('a', 2));
		store.addComment(KEY, { ...comment('b', 3), lineContents: ['old text'] });

		const listed = await runRemoteFileReviewCommand({
			action: 'list',
			sessionId: 'agent-1',
			file: FILE,
		});
		expect(listed.comments?.map((c) => [c.id, c.outdated])).toEqual([
			['a', false],
			['b', true],
		]);

		const edited = await runRemoteFileReviewCommand({
			action: 'edit',
			sessionId: 'agent-1',
			file: FILE,
			commentId: 'a',
			body: 'Reworded.',
		});
		expect(edited.comment?.body).toBe('Reworded.');
		const outdatedEdit = await runRemoteFileReviewCommand({
			action: 'edit',
			sessionId: 'agent-1',
			file: FILE,
			commentId: 'b',
			body: 'x',
		});
		expect(outdatedEdit.success).toBe(false);

		const sent = await runRemoteFileReviewCommand({
			action: 'send',
			sessionId: 'agent-1',
			file: FILE,
			background: true,
		});
		expect(sent.delivered?.map((c) => c.id)).toEqual(['a']);
		expect(sent.outdated?.map((c) => c.id)).toEqual(['b']);
		expect(sent.prompt).toContain('Reworded.');

		const removed = await runRemoteFileReviewCommand({
			action: 'remove',
			sessionId: 'agent-1',
			file: FILE,
			commentId: 'b',
		});
		expect(removed.success).toBe(true);
		store.addComment(KEY, comment('c', 1));
		const cleared = await runRemoteFileReviewCommand({
			action: 'clear',
			sessionId: 'agent-1',
			file: FILE,
		});
		expect(cleared.cleared).toBe(1);
		expect(useFileReviewStore.getState().commentsByKey[KEY]).toBeUndefined();
	});

	it('refuses a terminal agent and an unknown one', async () => {
		seed({ toolType: 'terminal' });
		const terminal = await runRemoteFileReviewCommand({
			action: 'list',
			sessionId: 'agent-1',
			file: FILE,
		});
		expect(terminal.success).toBe(false);
		const missing = await runRemoteFileReviewCommand({
			action: 'list',
			sessionId: 'nope',
			file: FILE,
		});
		expect(missing.error).toContain('Agent not found');
	});
});
