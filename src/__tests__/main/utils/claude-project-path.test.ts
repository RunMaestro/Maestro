import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getClaudeProjectDir, getClaudeProjectsDir } from '../../../main/utils/claude-project-path';

const temporaryHomes: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryHomes.splice(0).map((directory) => fs.rm(directory, { recursive: true }))
	);
});

describe('Claude project directory paths', () => {
	it.each([
		['Windows drive and backslashes', 'C:\\Users\\Ada', 'C:\\work\\Maestro', 'C--work-Maestro'],
		['Windows drive and forward slashes', 'C:\\Users\\Ada', 'C:/work/Maestro', 'C--work-Maestro'],
		['Unicode home and project path', 'C:\\Users\\Åsa', 'C:\\work\\Mæstro', 'C--work-M-stro'],
		[
			'remote root encoding',
			'/Users/ada',
			'/remote/workspace/Maestro',
			'-remote-workspace-Maestro',
		],
	])('preserves the existing %s project encoding', (_name, homeDir, projectPath, encodedPath) => {
		expect(getClaudeProjectsDir(homeDir)).toBe(path.join(homeDir, '.claude', 'projects'));
		expect(getClaudeProjectDir(projectPath, homeDir)).toBe(
			path.join(homeDir, '.claude', 'projects', encodedPath)
		);
	});

	it('finds an existing legacy-encoded project directory on the real filesystem', async () => {
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-claude-home-'));
		temporaryHomes.push(homeDir);
		const projectDir = getClaudeProjectDir('C:\\legacy\\Mæstro', homeDir);
		const sessionFile = path.join(projectDir, 'existing-session.jsonl');
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(sessionFile, '{"type":"user"}\n');

		await expect(fs.readFile(sessionFile, 'utf-8')).resolves.toContain('user');
	});
});
