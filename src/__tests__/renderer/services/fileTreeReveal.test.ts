/**
 * @file fileTreeReveal.test.ts
 * @description A clicked path can be a folder: the read must say so instead of
 * failing on EISDIR, and the reveal must expand and select the folder's row in
 * the Files panel using the tree's own relative keys.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	fileTreeRelativePath,
	readPathForOpen,
	revealPathInFileTree,
} from '../../../renderer/services/fileTreeReveal';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { createMockSession } from '../../helpers/mockSession';

beforeEach(() => {
	(window as any).maestro = {
		...(window as any).maestro,
		fs: {
			readFile: vi.fn().mockResolvedValue('content'),
			stat: vi.fn().mockResolvedValue({ modifiedAt: '2024-01-01T00:00:00Z', isDirectory: false }),
		},
	};
	useSessionStore.setState({ sessions: [], activeSessionId: null });
	useUIStore.setState({ rightPanelOpen: false, activeRightTab: 'history', activeFocus: 'main' });
});

describe('fileTreeRelativePath', () => {
	const session = createMockSession({ projectRoot: '/test/project', cwd: '/test/project' });

	it('returns the path relative to the tree root', () => {
		expect(fileTreeRelativePath(session, '/test/project/a/b')).toBe('a/b');
	});

	it('returns an empty string for the root itself, with or without a trailing slash', () => {
		expect(fileTreeRelativePath(session, '/test/project')).toBe('');
		expect(fileTreeRelativePath(session, '/test/project/')).toBe('');
	});

	it('rejects paths outside the root, including a sibling sharing its prefix', () => {
		expect(fileTreeRelativePath(session, '/elsewhere/a')).toBeNull();
		expect(fileTreeRelativePath(session, '/test/project-old/a')).toBeNull();
	});

	it('falls back to cwd when there is no projectRoot', () => {
		const s = createMockSession({ projectRoot: undefined as any, cwd: '/work' });
		expect(fileTreeRelativePath(s, '/work/x')).toBe('x');
	});

	it('normalizes Windows separators for a local agent', () => {
		const s = createMockSession({ projectRoot: 'C:\\proj', cwd: 'C:\\proj' });
		expect(fileTreeRelativePath(s, 'C:\\proj\\docs\\beta')).toBe('docs/beta');
	});
});

describe('readPathForOpen', () => {
	it('reports a directory without surfacing the EISDIR read failure', async () => {
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({ isDirectory: true } as any);
		vi.mocked(window.maestro.fs.readFile).mockRejectedValue(new Error('EISDIR'));

		await expect(readPathForOpen('/test/project/dir')).resolves.toEqual({ kind: 'directory' });
	});

	it('returns file content and modification time', async () => {
		await expect(readPathForOpen('/test/project/a.md', 'remote-1')).resolves.toEqual({
			kind: 'file',
			content: 'content',
			lastModified: new Date('2024-01-01T00:00:00Z').getTime(),
		});
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/test/project/a.md', 'remote-1');
	});

	it('returns null when the read was cancelled', async () => {
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue(null as any);
		await expect(readPathForOpen('/test/project/a.md')).resolves.toBeNull();
	});

	it('propagates a read failure for a real file', async () => {
		vi.mocked(window.maestro.fs.stat).mockRejectedValue(
			Object.assign(new Error('x'), { code: 'ENOENT' })
		);
		vi.mocked(window.maestro.fs.readFile).mockRejectedValue(new Error('ENOENT'));
		await expect(readPathForOpen('/test/project/gone.md')).rejects.toThrow('ENOENT');
	});
});

describe('revealPathInFileTree', () => {
	it('expands every ancestor and the folder, queues the jump, and focuses the Files tab', () => {
		const session = createMockSession({ id: 's1', fileExplorerExpanded: ['other'] });
		useSessionStore.setState({ sessions: [session], activeSessionId: 's1' });

		expect(revealPathInFileTree('s1', '/test/project/Course Content/_beta', { focus: true })).toBe(
			true
		);

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.fileExplorerExpanded).toEqual([
			'other',
			'Course Content',
			'Course Content/_beta',
		]);
		expect(updated.pendingJumpPath).toBe('Course Content/_beta');
		const ui = useUIStore.getState();
		expect(ui.rightPanelOpen).toBe(true);
		expect(ui.activeRightTab).toBe('files');
		expect(ui.activeFocus).toBe('right');
	});

	it('leaves the view alone without focus', () => {
		const session = createMockSession({ id: 's1' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 's1' });

		revealPathInFileTree('s1', '/test/project/src');

		expect(useSessionStore.getState().sessions[0].pendingJumpPath).toBe('src');
		expect(useUIStore.getState().rightPanelOpen).toBe(false);
		expect(useUIStore.getState().activeFocus).toBe('main');
	});

	it('refuses a path outside the tree or an unknown agent', () => {
		const session = createMockSession({ id: 's1' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 's1' });

		expect(revealPathInFileTree('s1', '/elsewhere')).toBe(false);
		expect(revealPathInFileTree('nope', '/test/project/src')).toBe(false);
		expect(useSessionStore.getState().sessions[0].pendingJumpPath).toBeUndefined();
	});
});
