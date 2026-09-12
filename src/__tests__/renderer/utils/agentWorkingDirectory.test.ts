/**
 * Moving an agent to a new working directory must move every path field
 * together (#1565, #1566): an agent whose `cwd` moved but whose `projectRoot`
 * did not runs in one directory while its Files panel lists another.
 */
import { describe, it, expect } from 'vitest';
import {
	isSameDirectory,
	rebasePathOntoRoot,
	withWorkingDirectory,
	workingDirectoryChangeBlocker,
} from '../../../renderer/utils/agentWorkingDirectory';
import { createMockSession } from '../../helpers/mockSession';

describe('withWorkingDirectory', () => {
	const base = () =>
		createMockSession({
			cwd: '/projects/old',
			fullPath: '/projects/old',
			shellCwd: '/projects/old',
			projectRoot: '/projects/old',
			autoRunFolderPath: '/projects/old/.maestro/playbooks',
		});

	it('moves every path field to the new directory', () => {
		const moved = withWorkingDirectory(base(), '/projects/new');

		expect(moved.cwd).toBe('/projects/new');
		expect(moved.fullPath).toBe('/projects/new');
		expect(moved.shellCwd).toBe('/projects/new');
		expect(moved.projectRoot).toBe('/projects/new');
		expect(moved.autoRunFolderPath).toBe('/projects/new/.maestro/playbooks');
	});

	it('leaves an Auto Run folder that lives outside the project where the user put it', () => {
		const session = { ...base(), autoRunFolderPath: '/shared/playbooks' };

		expect(withWorkingDirectory(session, '/projects/new').autoRunFolderPath).toBe(
			'/shared/playbooks'
		);
	});

	it('clears state that describes the old directory so it reloads from the new one', () => {
		const session = {
			...base(),
			fileTree: [{ name: 'stale.ts', type: 'file' }],
			fileExplorerExpanded: ['src'],
			fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 1 } as any,
			isGitRepo: true,
			gitBranches: ['main'],
		};

		const moved = withWorkingDirectory(session, '/projects/new');

		expect(moved.fileTree).toEqual([]);
		expect(moved.fileExplorerExpanded).toEqual([]);
		expect(moved.fileTreeStats).toBeUndefined();
		// Git polling re-detects a repo for sessions marked false.
		expect(moved.isGitRepo).toBe(false);
		expect(moved.gitBranches).toBeUndefined();
	});

	it('puts down a file tree load that was in flight for the old directory', () => {
		const session = {
			...base(),
			fileTreeLoading: true,
			fileTreeLoadingProgress: { directoriesScanned: 3, filesFound: 40, currentDirectory: 'src' },
		};

		const moved = withWorkingDirectory(session, '/projects/new');

		// With the flag down the auto-loader starts a fresh, newer-sequenced load,
		// and the old request discards its result as stale instead of writing
		// the previous project's tree into the moved agent.
		expect(moved.fileTreeLoading).toBe(false);
		expect(moved.fileTreeLoadingProgress).toBeUndefined();
	});

	it('forgets the remote cwd the agent reported in the old directory', () => {
		const session = {
			...base(),
			sshRemoteId: 'remote-1',
			remoteCwd: '/projects/old/src',
		};

		expect(withWorkingDirectory(session, '/projects/new').remoteCwd).toBeUndefined();
	});

	it('moves the SSH working directory override for a remote agent', () => {
		const session = {
			...base(),
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/projects/old',
			},
		};

		expect(withWorkingDirectory(session, '/projects/new').sessionSshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/projects/new',
		});
	});

	it('does not invent an override for an agent that runs locally', () => {
		const ssh = { enabled: false, remoteId: null, shareHistoryToProjectDir: true };
		const session = { ...base(), sessionSshRemoteConfig: ssh };

		expect(withWorkingDirectory(session, '/projects/new').sessionSshRemoteConfig).toBe(ssh);
	});

	it('returns the same session for a blank or unchanged directory', () => {
		const session = base();

		expect(withWorkingDirectory(session, '   ')).toBe(session);
		expect(withWorkingDirectory(session, '/projects/old/')).toBe(session);
	});

	it('treats a terminal `cd` as unchanged, since shellCwd moves on its own', () => {
		const session = { ...base(), shellCwd: '/projects/old/src' };

		expect(withWorkingDirectory(session, '/projects/old')).toBe(session);
	});

	it('repairs an agent whose cwd moved while projectRoot stayed behind', () => {
		const split = {
			...base(),
			cwd: '/projects/new',
			fullPath: '/projects/new',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/projects/new',
			},
		};

		const repaired = withWorkingDirectory(split, '/projects/old');

		expect(repaired).not.toBe(split);
		expect(repaired.cwd).toBe('/projects/old');
		expect(repaired.fullPath).toBe('/projects/old');
		expect(repaired.sessionSshRemoteConfig?.workingDirOverride).toBe('/projects/old');
	});
});

describe('rebasePathOntoRoot', () => {
	it('keeps Windows separators', () => {
		expect(
			rebasePathOntoRoot('C:\\work\\old\\.maestro\\playbooks', 'C:\\work\\old', 'C:\\work\\new')
		).toBe('C:\\work\\new\\.maestro\\playbooks');
	});

	it('matches a Windows root regardless of case', () => {
		expect(
			rebasePathOntoRoot('c:\\Work\\Old\\.maestro\\playbooks', 'C:\\work\\old', 'C:\\work\\new')
		).toBe('C:\\work\\new\\.maestro\\playbooks');
	});

	it('keeps POSIX paths case-sensitive', () => {
		expect(rebasePathOntoRoot('/Projects/Old/docs', '/projects/old', '/projects/new')).toBe(
			'/Projects/Old/docs'
		);
	});

	it('does not treat a sibling that shares a name prefix as inside the root', () => {
		expect(rebasePathOntoRoot('/projects/old-archive/docs', '/projects/old', '/projects/new')).toBe(
			'/projects/old-archive/docs'
		);
	});

	it('moves a bare root onto a bare root without losing the separator', () => {
		expect(rebasePathOntoRoot('C:\\', 'C:\\', 'D:\\')).toBe('D:\\');
		expect(rebasePathOntoRoot('C:\\work', 'C:\\', 'D:\\')).toBe('D:\\work');
		expect(rebasePathOntoRoot('/', '/', '/projects/new')).toBe('/projects/new');
	});

	it('moves a folder out from under a bare root', () => {
		expect(rebasePathOntoRoot('/.maestro/playbooks', '/', '/projects/new')).toBe(
			'/projects/new/.maestro/playbooks'
		);
		expect(rebasePathOntoRoot('C:\\.maestro\\playbooks', 'C:\\', 'D:\\work')).toBe(
			'D:\\work\\.maestro\\playbooks'
		);
	});
});

describe('isSameDirectory', () => {
	it('ignores a trailing separator', () => {
		expect(isSameDirectory('/projects/old/', '/projects/old')).toBe(true);
	});

	it('ignores case on Windows paths only', () => {
		expect(isSameDirectory('C:\\Work\\Old', 'c:/work/old')).toBe(true);
		expect(isSameDirectory('/Projects/Old', '/projects/old')).toBe(false);
	});

	it('treats a missing path as different from a real one', () => {
		expect(isSameDirectory(undefined, '/projects/old')).toBe(false);
	});
});

describe('workingDirectoryChangeBlocker', () => {
	it('allows an idle agent', () => {
		expect(workingDirectoryChangeBlocker({ state: 'idle', aiPid: 0 })).toBeNull();
	});

	it('refuses while the agent is busy or its process is alive', () => {
		expect(workingDirectoryChangeBlocker({ state: 'busy', aiPid: 0 })).toMatch(/Stop the agent/);
		// A connecting agent is already starting in its current directory.
		expect(workingDirectoryChangeBlocker({ state: 'connecting', aiPid: 0 })).toMatch(
			/Stop the agent/
		);
		expect(workingDirectoryChangeBlocker({ state: 'idle', aiPid: 4242 })).toMatch(/Stop the agent/);
	});
});
