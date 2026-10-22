/**
 * A playbook saved by `maestro-cli auto-run --save-as` must run in the CLI
 * runner. The CLI sends absolute `.md` paths; the desktop converts them with
 * `resolveAutoRunDocumentNames()` before saving. This drives that output
 * through `runPlaybook()` against real files, with the real document readers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionInfo, Playbook } from '../../../shared/types';
import type { JsonlEvent } from '../../../cli/output/jsonl';

// The run reads the git branch for its history entry; keep it off the host repo.
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const execFileSync = vi.fn(() => 'main');
	return { ...actual, execFileSync, default: { ...actual, execFileSync } };
});
vi.mock('../../../cli/services/agent-spawner', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/agent-spawner')>()),
	spawnAgent: vi.fn(),
}));
vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn().mockResolvedValue('Default Auto Run prompt'),
	getCliTaskSelectionBlock: vi.fn().mockResolvedValue('SELECTION BLOCK'),
}));
vi.mock('../../../cli/services/storage', () => ({
	addHistoryEntry: vi.fn(),
	readGroups: vi.fn(() => []),
	readHistory: vi.fn(() => []),
}));
vi.mock('../../../shared/cli-activity', () => ({
	registerCliActivity: vi.fn(),
	updateCliActivity: vi.fn(),
	unregisterCliActivity: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		toast: vi.fn(),
		autorun: vi.fn(),
	},
}));

import { runPlaybook } from '../../../cli/services/batch-processor';
import { spawnAgent } from '../../../cli/services/agent-spawner';
import { resolveAutoRunDocumentNames } from '../../../shared/autoRunDocumentPaths';

const session: SessionInfo = {
	id: 'session-1',
	name: 'Worker',
	toolType: 'claude-code',
	cwd: '/tmp',
	projectRoot: '/tmp',
};

async function collect(generator: AsyncGenerator<JsonlEvent>): Promise<JsonlEvent[]> {
	const events: JsonlEvent[] = [];
	for await (const event of generator) events.push(event);
	return events;
}

function playbookWith(documents: Playbook['documents']): Playbook {
	return { id: 'pb-1', name: 'X', prompt: 'Do it', documents, loopEnabled: false };
}

describe('saved playbook round trip', () => {
	let folder: string;
	let absolutePaths: string[];

	beforeEach(() => {
		folder = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-playbook-'));
		fs.mkdirSync(path.join(folder, 'some-folder'));
		absolutePaths = [
			path.join(folder, 'some-folder', 'DOC-01.md'),
			path.join(folder, 'some-folder', 'DOC-02.md'),
		];
		fs.writeFileSync(absolutePaths[0], '# One\n- [ ] first\n- [ ] second\n- [x] done\n');
		fs.writeFileSync(absolutePaths[1], '# Two\n- [ ] third\n');
	});

	afterEach(() => {
		fs.rmSync(folder, { recursive: true, force: true });
	});

	it('dry-runs a playbook saved from absolute paths and finds every task', async () => {
		const resolved = resolveAutoRunDocumentNames(
			absolutePaths.map((filename) => ({ filename, resetOnCompletion: false })),
			folder
		);
		if ('error' in resolved) throw new Error(resolved.error);
		expect(resolved.documents.map((d) => d.filename)).toEqual([
			'some-folder/DOC-01',
			'some-folder/DOC-02',
		]);

		const events = await collect(
			runPlaybook(session, playbookWith(resolved.documents), folder, { dryRun: true })
		);

		expect(events.find((e) => e.type === 'error')).toBeUndefined();
		expect(events.filter((e) => e.type === 'task_preview').map((e) => e.task)).toEqual([
			'first',
			'second',
			'third',
		]);
		expect(spawnAgent).not.toHaveBeenCalled();
	});

	// The shape the broken save produced. It must name the files it cannot
	// read, not report "No unchecked tasks".
	it('names the documents it cannot find instead of reporting no tasks', async () => {
		const events = await collect(
			runPlaybook(
				session,
				playbookWith(absolutePaths.map((filename) => ({ filename, resetOnCompletion: false }))),
				folder,
				{ dryRun: true }
			)
		);

		const error = events.find((e) => e.type === 'error');
		expect(error?.code).toBe('DOCUMENT_NOT_FOUND');
		expect(error?.message).toContain('2 of 2 playbook documents not found');
		expect(error?.message).toContain(`${folder}/${absolutePaths[0]}.md`);
	});

	it('names only the missing document when the rest exist', async () => {
		const events = await collect(
			runPlaybook(
				session,
				playbookWith([
					{ filename: 'some-folder/DOC-01', resetOnCompletion: false },
					{ filename: 'some-folder/GONE', resetOnCompletion: false },
				]),
				folder,
				{ dryRun: true }
			)
		);

		const error = events.find((e) => e.type === 'error');
		expect(error?.code).toBe('DOCUMENT_NOT_FOUND');
		expect(error?.message).toContain('1 of 2');
		expect(error?.message).toContain(`${folder}/some-folder/GONE.md`);
		expect(events.some((e) => e.type === 'task_preview')).toBe(false);
	});
});
