import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	removeEmptyMaestroDir,
	removeEmptyPromptsDir,
} from '../../../main/cue/config/cue-config-repository';

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

function createProjectRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-config-'));
	temporaryRoots.push(root);
	return root;
}

describe('Cue empty-directory cleanup on disk', () => {
	it('removes an empty prompts directory on the real filesystem', () => {
		const projectRoot = createProjectRoot();
		const promptsDir = path.join(projectRoot, '.maestro', 'prompts');
		fs.mkdirSync(promptsDir, { recursive: true });

		expect(removeEmptyPromptsDir(projectRoot)).toBe(true);
		expect(fs.existsSync(promptsDir)).toBe(false);
	});

	it('leaves a non-empty prompts directory on the real filesystem', () => {
		const projectRoot = createProjectRoot();
		const promptsDir = path.join(projectRoot, '.maestro', 'prompts');
		fs.mkdirSync(promptsDir, { recursive: true });
		fs.writeFileSync(path.join(promptsDir, 'user-file.txt'), 'keep');

		expect(removeEmptyPromptsDir(projectRoot)).toBe(false);
		expect(fs.existsSync(promptsDir)).toBe(true);
	});

	it('removes an empty Maestro directory on the real filesystem', () => {
		const projectRoot = createProjectRoot();
		const maestroDir = path.join(projectRoot, '.maestro');
		fs.mkdirSync(maestroDir);

		expect(removeEmptyMaestroDir(projectRoot)).toBe(true);
		expect(fs.existsSync(maestroDir)).toBe(false);
	});
});
