import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

export function findPortableShell(): string | undefined {
	const candidates = ['sh'];
	if (process.platform === 'win32') {
		const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
		if (git.status === 0) {
			let directory = path.resolve(git.stdout.trim());
			while (path.dirname(directory) !== directory) {
				for (const relative of ['usr/bin/sh.exe', 'bin/sh.exe']) {
					const executable = path.join(directory, relative);
					if (existsSync(executable)) candidates.unshift(executable);
				}
				directory = path.dirname(directory);
			}
		}
	}
	return candidates.find(
		(candidate) => spawnSync(candidate, ['-c', 'exit 0'], { timeout: 5000 }).status === 0
	);
}
