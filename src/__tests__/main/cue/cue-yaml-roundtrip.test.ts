/**
 * End-to-end YAML roundtrip tests for cue-config-repository.
 *
 * These exercise the file-system layer directly (NO mocks) against a real
 * temp directory so we catch bugs in path resolution, directory creation,
 * and orphan pruning that module-level mocks would hide.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	deleteCueConfigFile,
	pruneOrphanedPromptFiles,
	readCueConfigFile,
	resolveCueConfigPath,
	writeCueConfigFile,
	writeCuePromptFile,
} from '../../../main/cue/config/cue-config-repository';

let projectRoot = '';

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-roundtrip-'));
});

afterEach(() => {
	if (projectRoot && fs.existsSync(projectRoot)) {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
});

describe('cue YAML roundtrip', () => {
	it('write → read returns the exact content with a single trip', () => {
		const content =
			'subscriptions:\n  - name: test-sub\n    event: time.heartbeat\n    interval_minutes: 5\n';
		writeCueConfigFile(projectRoot, content);

		const result = readCueConfigFile(projectRoot);
		expect(result).not.toBeNull();
		expect(result!.raw).toBe(content);
	});

	it('write creates .maestro/ directory if missing', () => {
		const maestroDir = path.join(projectRoot, '.maestro');
		expect(fs.existsSync(maestroDir)).toBe(false);

		writeCueConfigFile(projectRoot, 'subscriptions: []');

		expect(fs.existsSync(maestroDir)).toBe(true);
		expect(fs.existsSync(path.join(maestroDir, 'cue.yaml'))).toBe(true);
	});

	it('roundtrip preserves UTF-8 characters including emoji and CJK', () => {
		const content = 'subscriptions:\n  - name: "テスト 🎌 中文"\n    event: time.heartbeat\n';
		writeCueConfigFile(projectRoot, content);
		const result = readCueConfigFile(projectRoot);
		expect(result!.raw).toBe(content);
	});

	it('readCueConfigFile returns null when no config exists', () => {
		expect(readCueConfigFile(projectRoot)).toBeNull();
	});

	it('resolveCueConfigPath prefers canonical over legacy when both exist', () => {
		const legacyPath = path.join(projectRoot, 'maestro-cue.yaml');
		const canonicalDir = path.join(projectRoot, '.maestro');
		fs.mkdirSync(canonicalDir, { recursive: true });
		fs.writeFileSync(legacyPath, 'legacy', 'utf-8');
		fs.writeFileSync(path.join(canonicalDir, 'cue.yaml'), 'canonical', 'utf-8');

		const resolved = resolveCueConfigPath(projectRoot);
		expect(resolved).toBe(path.join(canonicalDir, 'cue.yaml'));
	});

	it('falls back to legacy path when canonical is missing', () => {
		const legacyPath = path.join(projectRoot, 'maestro-cue.yaml');
		fs.writeFileSync(legacyPath, 'legacy: true', 'utf-8');

		const result = readCueConfigFile(projectRoot);
		expect(result!.raw).toBe('legacy: true');
		expect(result!.filePath).toBe(legacyPath);
	});

	it('deleteCueConfigFile removes the file and returns true', () => {
		writeCueConfigFile(projectRoot, 'subscriptions: []');
		expect(deleteCueConfigFile(projectRoot)).toBe(true);
		expect(readCueConfigFile(projectRoot)).toBeNull();
	});

	it('deleteCueConfigFile returns false when no file exists', () => {
		expect(deleteCueConfigFile(projectRoot)).toBe(false);
	});
});

describe('cue prompt-file roundtrip', () => {
	it('writes a .md prompt file and reads it back', () => {
		const rel = '.maestro/prompts/sub-1.md';
		writeCuePromptFile(projectRoot, rel, 'body content');
		const full = path.join(projectRoot, rel);
		expect(fs.readFileSync(full, 'utf-8')).toBe('body content');
	});

	it('creates nested subdirectories under .maestro/prompts/', () => {
		writeCuePromptFile(projectRoot, '.maestro/prompts/nested/deep/sub.md', 'body');
		expect(fs.existsSync(path.join(projectRoot, '.maestro/prompts/nested/deep/sub.md'))).toBe(true);
	});

	it('rejects absolute paths', () => {
		expect(() => writeCuePromptFile(projectRoot, '/etc/passwd.md', 'evil')).toThrow(
			/relativePath must be relative/
		);
	});

	it('rejects paths that escape the prompts directory', () => {
		expect(() =>
			writeCuePromptFile(projectRoot, '.maestro/prompts/../../escape.md', 'evil')
		).toThrow(/resolves outside the prompts directory/);
	});

	it('rejects non-.md files', () => {
		expect(() => writeCuePromptFile(projectRoot, '.maestro/prompts/payload.sh', 'evil')).toThrow(
			/must end with .md/
		);
	});
});

describe('orphan prompt file pruning', () => {
	it('removes .md files not in the keep-set', () => {
		writeCuePromptFile(projectRoot, '.maestro/prompts/keep.md', 'keep');
		writeCuePromptFile(projectRoot, '.maestro/prompts/drop.md', 'drop');

		const removed = pruneOrphanedPromptFiles(projectRoot, ['.maestro/prompts/keep.md']);

		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain('drop.md');
		expect(fs.existsSync(path.join(projectRoot, '.maestro/prompts/keep.md'))).toBe(true);
		expect(fs.existsSync(path.join(projectRoot, '.maestro/prompts/drop.md'))).toBe(false);
	});

	it('preserves non-.md files (only markdown is managed)', () => {
		// Someone may have dropped a README.txt or similar next to prompts —
		// pruning should not touch anything that isn't a .md file, since only
		// .md files are produced by the prompt-file writer.
		writeCuePromptFile(projectRoot, '.maestro/prompts/referenced.md', 'x');
		const extraPath = path.join(projectRoot, '.maestro/prompts/other.txt');
		fs.writeFileSync(extraPath, 'keep me', 'utf-8');

		const removed = pruneOrphanedPromptFiles(projectRoot, ['.maestro/prompts/referenced.md']);

		expect(removed).toHaveLength(0);
		expect(fs.existsSync(extraPath)).toBe(true);
	});

	it('returns empty array when prompts directory does not exist', () => {
		expect(pruneOrphanedPromptFiles(projectRoot, [])).toEqual([]);
	});

	it('handles nested subdirectories under prompts/', () => {
		writeCuePromptFile(projectRoot, '.maestro/prompts/a/keep.md', 'keep');
		writeCuePromptFile(projectRoot, '.maestro/prompts/b/drop.md', 'drop');

		const removed = pruneOrphanedPromptFiles(projectRoot, ['.maestro/prompts/a/keep.md']);
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain(path.join('b', 'drop.md'));
	});

	it('skips absolute paths in the keep-set', () => {
		// Ensures the keep-set filter matches the writer contract (reject
		// absolute paths) and doesn't accidentally protect a file via a weird
		// absolute entry that wouldn't hit the path.resolve check.
		writeCuePromptFile(projectRoot, '.maestro/prompts/one.md', 'x');
		const removed = pruneOrphanedPromptFiles(projectRoot, ['/absolute/ignored.md']);
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain('one.md');
	});
});

describe('yaml + prompt-file full roundtrip', () => {
	it('write YAML + prompt files → read back → same data', () => {
		const yaml = [
			'subscriptions:',
			'  - name: morning',
			'    event: time.scheduled',
			'    prompt_file: .maestro/prompts/morning.md',
			'  - name: output-prompt',
			'    event: agent.completed',
			'    prompt_file: .maestro/prompts/output.md',
			'    output_prompt_file: .maestro/prompts/output-phase2.md',
			'',
		].join('\n');

		writeCueConfigFile(projectRoot, yaml);
		writeCuePromptFile(projectRoot, '.maestro/prompts/morning.md', 'morning body');
		writeCuePromptFile(projectRoot, '.maestro/prompts/output.md', 'output body');
		writeCuePromptFile(projectRoot, '.maestro/prompts/output-phase2.md', 'phase-2 body');

		// Roundtrip YAML
		expect(readCueConfigFile(projectRoot)!.raw).toBe(yaml);

		// All prompts on disk
		expect(fs.readFileSync(path.join(projectRoot, '.maestro/prompts/morning.md'), 'utf-8')).toBe(
			'morning body'
		);
		expect(fs.readFileSync(path.join(projectRoot, '.maestro/prompts/output.md'), 'utf-8')).toBe(
			'output body'
		);
		expect(
			fs.readFileSync(path.join(projectRoot, '.maestro/prompts/output-phase2.md'), 'utf-8')
		).toBe('phase-2 body');

		// Simulate deleting one subscription and pruning — only referenced files remain
		const removed = pruneOrphanedPromptFiles(projectRoot, [
			'.maestro/prompts/morning.md',
			'.maestro/prompts/output.md',
		]);
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain('output-phase2.md');
		expect(fs.existsSync(path.join(projectRoot, '.maestro/prompts/output-phase2.md'))).toBe(false);
	});

	it('overwriting YAML+prompts preserves the rest of .maestro/', () => {
		// User may have unrelated files (e.g. director-notes, other tooling)
		// in .maestro/ — we must not blow them away.
		const maestroDir = path.join(projectRoot, '.maestro');
		fs.mkdirSync(maestroDir, { recursive: true });
		fs.writeFileSync(path.join(maestroDir, 'director-notes.md'), 'notes', 'utf-8');

		writeCueConfigFile(projectRoot, 'subscriptions: []');
		writeCuePromptFile(projectRoot, '.maestro/prompts/x.md', 'body');

		expect(fs.readFileSync(path.join(maestroDir, 'director-notes.md'), 'utf-8')).toBe('notes');
	});
});
