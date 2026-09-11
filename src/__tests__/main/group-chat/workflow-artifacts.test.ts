/**
 * @file workflow-artifacts.test.ts
 * @description Filesystem tests for run-scoped Group Chat workflow artifacts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let mockUserDataPath: string;
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			throw new Error(`Unknown path name: ${name}`);
		}),
	},
}));

vi.mock('electron-store', () => ({
	default: class MockStore {
		get() {
			return undefined;
		}
		set() {}
	},
}));

import {
	clearWorkflowRunDir,
	ensureWorkflowRunDir,
	getWorkflowRunDir,
	sweepWorkflowRunDirs,
	writeStageArtifact,
} from '../../../main/group-chat/workflow-artifacts';

describe('workflow-artifacts', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = path.join(
			os.tmpdir(),
			`workflow-artifacts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await fs.mkdir(testDir, { recursive: true });
		mockUserDataPath = testDir;
	});

	afterEach(async () => {
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors.
		}
		vi.clearAllMocks();
	});

	it('creates and returns the run directory', async () => {
		const runDir = await ensureWorkflowRunDir('chat-1', 'run-1');

		expect(runDir).toBe(path.join(testDir, 'group-chats', 'chat-1', 'workflow-runs', 'run-1'));
		expect((await fs.stat(runDir)).isDirectory()).toBe(true);
	});

	it('writes artifacts under the run and stage using filesystem-safe participant names', async () => {
		const cases = [
			{ participantName: 'Review Agent', fileName: 'Review Agent.md' },
			{ participantName: 'frontend/reviewer', fileName: 'frontend-reviewer.md' },
			{ participantName: 'レビュー担当 🎼', fileName: 'レビュー担当 🎼.md' },
		];

		for (const testCase of cases) {
			const artifactPath = await writeStageArtifact({
				groupChatId: 'chat-1',
				runId: 'run-1',
				stageId: 'stage-2',
				participantName: testCase.participantName,
				content: `Output from ${testCase.participantName}`,
			});

			expect(artifactPath).toBe(
				path.join(getWorkflowRunDir('chat-1', 'run-1'), 'stage-2', testCase.fileName)
			);
			expect(await fs.readFile(artifactPath, 'utf-8')).toBe(
				`Output from ${testCase.participantName}`
			);
		}
	});

	it('overwrites a repeat write from the same participant in the same stage', async () => {
		const options = {
			groupChatId: 'chat-1',
			runId: 'run-1',
			stageId: 'stage-1',
			participantName: 'Builder',
		};
		const firstPath = await writeStageArtifact({ ...options, content: 'first version' });
		const secondPath = await writeStageArtifact({ ...options, content: 'replacement version' });

		expect(secondPath).toBe(firstPath);
		expect(await fs.readFile(secondPath, 'utf-8')).toBe('replacement version');
	});

	it('clears a missing run directory without failing', async () => {
		await expect(clearWorkflowRunDir('missing-chat', 'missing-run')).resolves.toBeUndefined();
	});

	it('sweeps workflow run directories across multiple chats', async () => {
		const runDirs = [
			await ensureWorkflowRunDir('chat-1', 'run-1'),
			await ensureWorkflowRunDir('chat-2', 'run-2'),
		];
		const preservedDir = path.join(testDir, 'group-chats', 'chat-1', 'images');
		await fs.mkdir(preservedDir, { recursive: true });

		await sweepWorkflowRunDirs();

		for (const runDir of runDirs) {
			await expect(fs.access(runDir)).rejects.toMatchObject({ code: 'ENOENT' });
		}
		expect((await fs.stat(preservedDir)).isDirectory()).toBe(true);
	});
});
