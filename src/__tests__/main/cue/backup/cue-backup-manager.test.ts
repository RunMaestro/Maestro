import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import {
	createCueBackup,
	deleteCueBackup,
	getCueBackupDiffStatus,
	inspectCueBackup,
	listCueBackups,
	readCueBackupFile,
	readLiveCueFile,
	restoreCueBackupAll,
	restoreCueBackupFile,
} from '../../../../main/cue/backup/cue-backup-manager';
import { cueBackupStatusKey } from '../../../../shared/cue-backup-types';

const zipFixtures = vi.hoisted(() => ({
	files: new Map<string, Map<string, string>>(),
}));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(),
		getVersion: vi.fn(() => '0.17.1-test'),
	},
}));

vi.mock('adm-zip', () => {
	class MockAdmZip {
		private entries = new Map<string, string>();

		constructor(filePath?: string) {
			if (filePath) {
				this.entries = new Map(zipFixtures.files.get(filePath) ?? []);
			}
		}

		addFile(name: string, data: Buffer | string) {
			this.entries.set(name, Buffer.isBuffer(data) ? data.toString('utf-8') : data);
		}

		writeZip(filePath: string) {
			const fs = require('fs') as typeof import('fs');
			const path = require('path') as typeof import('path');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, 'mock zip', 'utf-8');
			zipFixtures.files.set(filePath, new Map(this.entries));
		}

		getEntry(name: string) {
			if (!this.entries.has(name)) return null;
			const data = this.entries.get(name) ?? '';
			return {
				header: { size: Buffer.byteLength(data, 'utf-8') },
				getData: () => Buffer.from(data, 'utf-8'),
			};
		}
	}

	return { default: MockAdmZip };
});

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

describe('cue-backup-manager', () => {
	let tempRoot: string;
	let userData: string;
	let workspace: string;

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-backup-'));
		userData = path.join(tempRoot, 'user-data');
		workspace = path.join(tempRoot, 'workspace');
		vi.mocked(app.getPath).mockReturnValue(userData);
		zipFixtures.files.clear();

		fs.mkdirSync(path.join(workspace, '.maestro', 'prompts'), { recursive: true });
		fs.writeFileSync(path.join(workspace, '.maestro', 'cue.yaml'), 'mode: live\n', 'utf-8');
		fs.writeFileSync(
			path.join(workspace, '.maestro', 'prompts', 'review.md'),
			'# Review\n',
			'utf-8'
		);
		fs.writeFileSync(
			path.join(workspace, '.maestro', 'prompts', 'scratch.txt'),
			'ignore me\n',
			'utf-8'
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	function writeBackupFixture() {
		const backupDir = path.join(userData, 'cue-backups');
		const filePath = path.join(backupDir, 'cue-backup-fixture.zip');
		const manifest = {
			version: 1,
			createdAt: '2026-06-18T12:00:00.000Z',
			appVersion: '0.17.1-test',
			workspaces: [
				{
					id: 'workspace-1',
					cwd: workspace,
					agents: [{ id: 'agent-1', name: 'Codex', toolType: 'codex' }],
					files: [
						{ relativePath: 'cue.yaml', size: 'mode: live\n'.length },
						{ relativePath: 'prompts/review.md', size: '# Review\n'.length },
					],
				},
			],
		};

		fs.mkdirSync(backupDir, { recursive: true });
		const zip = new AdmZip();
		zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
		zip.addFile('workspaces/workspace-1/cue.yaml', Buffer.from('mode: live\n'));
		zip.addFile('workspaces/workspace-1/prompts/review.md', Buffer.from('# Review\n'));
		zip.writeZip(filePath);

		return { filePath, manifest };
	}

	it('creates Cue backup summaries from distinct workspaces', async () => {
		const summary = await createCueBackup([
			{
				id: 'agent-1',
				name: 'Codex',
				toolType: 'codex',
				cwd: workspace,
			},
			{
				id: 'agent-2',
				name: 'Claude',
				toolType: 'claude-code',
				projectRoot: workspace,
			},
		] as any);

		expect(summary.fileName).toMatch(/^cue-backup-.*\.zip$/);
		expect(fs.existsSync(summary.filePath)).toBe(true);
		expect(summary.manifest.appVersion).toBe('0.17.1-test');
		expect(summary.manifest.workspaces).toHaveLength(1);

		const [workspaceEntry] = summary.manifest.workspaces;
		expect(workspaceEntry.cwd).toBe(workspace);
		expect(workspaceEntry.agents).toEqual([
			{ id: 'agent-1', name: 'Codex', toolType: 'codex' },
			{ id: 'agent-2', name: 'Claude', toolType: 'claude-code' },
		]);
		expect(workspaceEntry.files.map((file) => file.relativePath).sort()).toEqual([
			'cue.yaml',
			'prompts/review.md',
		]);
	});

	it('lists, inspects, reads, restores, diffs, and deletes Cue backup zips', () => {
		const { filePath, manifest } = writeBackupFixture();
		const [workspaceEntry] = manifest.workspaces;
		const fixtureZip = new AdmZip(filePath);

		expect(fixtureZip.getEntry('manifest.json')?.getData().toString('utf-8')).toContain(
			'"workspaces"'
		);

		expect(listCueBackups().map((item) => item.filePath)).toEqual([filePath]);
		expect(inspectCueBackup(filePath).workspaces[0].id).toBe(workspaceEntry.id);
		expect(readCueBackupFile(filePath, workspaceEntry.id, 'cue.yaml')).toBe('mode: live\n');
		expect(readCueBackupFile(filePath, workspaceEntry.id, 'missing.md')).toBeNull();
		expect(readLiveCueFile(workspace, 'cue.yaml')).toBe('mode: live\n');

		expect(getCueBackupDiffStatus(filePath)).toEqual({
			[cueBackupStatusKey(workspaceEntry.id, 'cue.yaml')]: 'unchanged',
			[cueBackupStatusKey(workspaceEntry.id, 'prompts/review.md')]: 'unchanged',
		});

		fs.writeFileSync(path.join(workspace, '.maestro', 'cue.yaml'), 'mode: changed\n', 'utf-8');
		fs.rmSync(path.join(workspace, '.maestro', 'prompts', 'review.md'));

		expect(getCueBackupDiffStatus(filePath)).toEqual({
			[cueBackupStatusKey(workspaceEntry.id, 'cue.yaml')]: 'changed',
			[cueBackupStatusKey(workspaceEntry.id, 'prompts/review.md')]: 'missing-live',
		});

		restoreCueBackupFile(filePath, workspaceEntry.id, 'cue.yaml');
		expect(readLiveCueFile(workspace, 'cue.yaml')).toBe('mode: live\n');

		const restored = restoreCueBackupAll(filePath);
		expect(restored).toEqual({ written: 2, skipped: [] });
		expect(readLiveCueFile(workspace, 'prompts/review.md')).toBe('# Review\n');

		deleteCueBackup(filePath);
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('guards backup paths and invalid restores', () => {
		const { filePath } = writeBackupFixture();

		expect(() => inspectCueBackup(path.join(tempRoot, 'outside.zip'))).toThrow(
			'Backup path must be inside the cue-backups directory'
		);
		expect(() => readLiveCueFile(workspace, '../escape.md')).toThrow(
			'Unsupported backup relative path'
		);
		expect(() => restoreCueBackupFile(filePath, 'missing-workspace', 'cue.yaml')).toThrow(
			'Workspace missing-workspace not found in backup'
		);
	});
});
