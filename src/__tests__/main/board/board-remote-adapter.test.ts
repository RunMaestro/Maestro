import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findPortableShell } from '../../helpers/portableShell';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import {
	probeBoardRemoteRepository,
	readBoardRemoteInput,
	type BoardRemoteTransport,
} from '../../../main/board/board-remote-source';
import type { SshRemoteConfig } from '../../../shared/types';
import { readBinaryFileRemoteAsBase64 } from '../../../main/utils/remote-fs';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { execGitReadOnly } from '../../../main/utils/remote-git';

const isolation = createBoardIsolationFixture();
const config: SshRemoteConfig = {
	id: 'one',
	name: 'Fixture',
	host: 'fixture.invalid',
	username: 'fixture',
	privateKeyPath: '',
	port: 22,
	enabled: true,
};

it('uses existing SSH file adapter and real local child/Git processes with quoted paths, preserving original bytes', async () => {
	try {
		const localRoot = path.join(isolation.sources.one, "repo 'quoted' $literal");
		fs.mkdirSync(path.join(localRoot, '.maestro'), { recursive: true });
		execFileSync('git', ['init', '--quiet', localRoot]);
		const original = Buffer.concat([Buffer.from('boards: []\n'), Buffer.from([255])]);
		const input = path.join(localRoot, '.maestro/board.yaml');
		fs.writeFileSync(input, original);
		// Git for Windows supplies the POSIX shell. Ask it for its own physical
		// path instead of passing a native drive path as an SSH source identity.
		const shell = findPortableShell();
		expect(shell).toBeDefined();
		const physical = await execFileNoThrow(shell!, ['-c', 'pwd -P'], localRoot);
		expect(physical.exitCode, physical.stderr).toBe(0);
		const root = physical.stdout.trim();
		expect(path.posix.isAbsolute(root)).toBe(true);
		expect(path.posix.basename(root)).toBe("repo 'quoted' $literal");
		const sshCalls: string[][] = [];
		const remote: BoardRemoteTransport = {
			config: (id) => (id === config.id ? config : undefined),
			read: (file, cfg) => {
				expect(file).toBe(path.posix.join(root, '.maestro/board.yaml'));
				expect(cfg).toBe(config);
				return readBinaryFileRemoteAsBase64(file, cfg, {
					buildSshArgs: (sshConfig) => {
						expect(sshConfig).toBe(config);
						return [`${sshConfig.username}@${sshConfig.host}`];
					},
					execSsh: (binary, args, stdin) => {
						expect(binary).toBeTruthy();
						expect(args).toHaveLength(2);
						expect(args[0]).toBe('fixture@fixture.invalid');
						expect(stdin).toBeUndefined();
						sshCalls.push([...args]);
						// Execute the adapter's actual command, including its quoting.
						return execFileNoThrow(shell!, ['-c', args[1]], localRoot);
					},
				});
			},
			shell: (command, cfg, options) => {
				expect(command).toBe('pwd -P');
				expect(cfg).toBe(config);
				expect(options?.cwd).toBe(root);
				return execFileNoThrow(shell!, ['-c', command], localRoot);
			},
			git: async (args, localCwd, cfg, cwd) => {
				expect(args).toEqual(['rev-parse', '--show-toplevel', '--absolute-git-dir']);
				expect(localCwd).toBe('');
				expect(cfg).toBe(config);
				expect(cwd).toBe(root);
				const result = await execGitReadOnly(args, localRoot);
				expect(result.exitCode, result.stderr).toBe(0);
				const gitPaths = result.stdout.trim().split(/\r?\n/);
				expect(gitPaths).toHaveLength(2);
				// Native Git reports drive paths on Windows. Resolve each actual
				// reported directory through the shell, as a POSIX SSH host would.
				const physicalPaths = [];
				for (const gitPath of gitPaths) {
					const resolved = await execFileNoThrow(
						shell!,
						['-c', 'cd -P -- "$1" && pwd -P', 'board-git-path', gitPath],
						localRoot
					);
					expect(resolved.exitCode, resolved.stderr).toBe(0);
					physicalPaths.push(resolved.stdout.trim());
				}
				return { ...result, stdout: physicalPaths.join('\n') + '\n' };
			},
		};
		expect(await readBoardRemoteInput('one', root, '.maestro/board.yaml', remote)).toEqual(
			original
		);
		expect(sshCalls).toEqual([
			[
				'fixture@fixture.invalid',
				`base64 < '${path.posix.join(root, '.maestro/board.yaml').replaceAll("'", "'\\''")}'`,
			],
		]);
		expect(JSON.parse(await probeBoardRemoteRepository('one', root, root, remote))).toEqual({
			remoteId: 'one',
			root,
			cwd: root,
			physical: root,
			git: `${root}\n${root}/.git`,
		});
		expect(fs.readFileSync(input)).toEqual(original);
	} finally {
		await isolation.cleanup();
	}
});
