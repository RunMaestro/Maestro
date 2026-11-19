import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({
	DEFAULT_BATCH_PROMPT: 'DEFAULT PROMPT',
}));

let nextId = 0;
vi.mock('../../../../renderer/utils/ids', () => ({
	generateId: () => `id-${++nextId}`,
}));

import {
	buildPlaybookBatchRunConfig,
	playbookBatchDocuments,
	playbookEffectivePrompt,
} from '../../../../renderer/hooks/batch/playbookRunConfig';
import type { Playbook } from '../../../../shared/types';

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'pb-1',
		name: 'Refactor',
		createdAt: 0,
		updatedAt: 0,
		documents: [
			{ filename: 'refactor/one', resetOnCompletion: false },
			{ filename: 'refactor/progress', resetOnCompletion: true },
		],
		loopEnabled: true,
		maxLoops: 10,
		prompt: 'Do the work for [PR_URL].',
		...overrides,
	};
}

describe('playbookBatchDocuments', () => {
	it('gives every entry a fresh id and marks repeats as duplicates', () => {
		nextId = 0;
		const entries = playbookBatchDocuments({
			documents: [
				{ filename: 'a', resetOnCompletion: false },
				{ filename: 'b', resetOnCompletion: true },
				{ filename: 'a', resetOnCompletion: false },
			],
		});
		expect(entries).toEqual([
			{ id: 'id-1', filename: 'a', resetOnCompletion: false, isDuplicate: false },
			{ id: 'id-2', filename: 'b', resetOnCompletion: true, isDuplicate: false },
			{ id: 'id-3', filename: 'a', resetOnCompletion: false, isDuplicate: true },
		]);
	});

	it('marks documents absent from the folder as missing only when the folder is given', () => {
		const playbook = makePlaybook();
		expect(playbookBatchDocuments(playbook)[0]).not.toHaveProperty('isMissing');
		const entries = playbookBatchDocuments(playbook, ['refactor/one']);
		expect(entries.map((entry) => entry.isMissing)).toEqual([false, true]);
	});
});

describe('playbookEffectivePrompt', () => {
	it('falls back to the default Auto Run prompt when the playbook has none', () => {
		expect(playbookEffectivePrompt({ prompt: '' })).toBe('DEFAULT PROMPT');
		expect(playbookEffectivePrompt({ prompt: '   \n' })).toBe('DEFAULT PROMPT');
		expect(playbookEffectivePrompt({ prompt: 'Mine' })).toBe('Mine');
	});
});

describe('buildPlaybookBatchRunConfig', () => {
	it('builds the run the panel would start for the record, tagged with its launch source', () => {
		const config = buildPlaybookBatchRunConfig(
			makePlaybook({
				parameterOverlay: [{ name: 'PR_URL', type: 'url', required: true }],
				provenance: {
					kind: 'marketplace',
					marketplaceId: 'development-refactor',
					targetFolderName: 'refactor',
					importedAt: 0,
					documentHashes: {},
				},
			}),
			{
				ownerSessionId: 'agent-1',
				launchSource: 'exchange',
				parameterValues: { PR_URL: 'https://github.com/o/r/pull/1' },
			}
		);
		expect(config).toMatchObject({
			prompt: 'Do the work for [PR_URL].',
			loopEnabled: true,
			maxLoops: 10,
			taskSelectionMode: 'task',
			launchSource: 'exchange',
			playbook: {
				id: 'pb-1',
				ownerSessionId: 'agent-1',
				marketplaceId: 'development-refactor',
				parameterOverlay: [{ name: 'PR_URL', type: 'url', required: true }],
				parameterValues: { PR_URL: 'https://github.com/o/r/pull/1' },
			},
		});
		expect(config.documents.map((doc) => doc.filename)).toEqual([
			'refactor/one',
			'refactor/progress',
		]);
		expect(config.documents[1].resetOnCompletion).toBe(true);
		expect(config).not.toHaveProperty('worktreeTarget');
		expect(config).not.toHaveProperty('goalConfig');
	});

	it('sends no loop bound for a playbook that does not loop, and keeps its task mode', () => {
		const config = buildPlaybookBatchRunConfig(
			makePlaybook({ loopEnabled: false, maxLoops: 4, taskSelectionMode: 'document' }),
			{ ownerSessionId: 'agent-1', launchSource: 'panel' }
		);
		expect(config.maxLoops).toBeNull();
		expect(config.taskSelectionMode).toBe('document');
		expect(config.launchSource).toBe('panel');
	});
});
