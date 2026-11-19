/**
 * Playbook parameters through the real processTask path.
 *
 * The `[NAME]` answers are substituted in memory only: the agent's prompt gets
 * them (plus the Resolved Configuration table), while the document on disk
 * keeps its `[NAME]` tokens so answers are never burned into the template. A
 * token with no value pauses the run before anything is spawned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	AutoRunPauseError,
	useDocumentProcessor,
	type DocumentProcessorConfig,
} from '../../../../renderer/hooks/batch/useDocumentProcessor';
import { resolvePlaybookParamSpecs } from '../../../../shared/playbookParams';
import { STEERING_BLOCK_START } from '../../../../shared/autorunSteering';
import { createMockSession } from '../../../helpers/mockSession';

const PLAYBOOK_PROMPT = [
	'<!-- CONFIGURE: How many items to process -->',
	'**MAX_ITEMS:** `25`',
	'',
	'<!-- CONFIGURE: Folder to work in -->',
	'**TARGET_DIR:** `{{AGENT_PATH}}`',
	'',
	'Process [MAX_ITEMS] items under [TARGET_DIR].',
].join('\n');

describe('useDocumentProcessor - playbook parameters', () => {
	const disk = { content: '' };
	const onSpawnAgent = vi.fn();
	const readDoc = vi.fn();
	const writeDoc = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		readDoc.mockImplementation(async () => ({ success: true, content: disk.content }));
		writeDoc.mockImplementation(async (_folder: string, _file: string, content: string) => {
			disk.content = content;
			return { success: true };
		});
		onSpawnAgent.mockResolvedValue({ success: true, response: 'Did the thing.' });
		window.maestro = {
			...window.maestro,
			autorun: { ...window.maestro?.autorun, readDoc, writeDoc },
			agentSessions: {
				...window.maestro?.agentSessions,
				registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
			},
		} as typeof window.maestro;
	});

	function config(overrides: Partial<DocumentProcessorConfig> = {}): DocumentProcessorConfig {
		const session = createMockSession({ cwd: '/test/project', fullPath: '/test/project' });
		return {
			folderPath: '/test/project/.maestro/playbooks',
			session,
			gitBranch: 'main',
			loopIteration: 1,
			effectiveCwd: session.cwd,
			customPrompt: PLAYBOOK_PROMPT,
			playbookParams: {
				specs: resolvePlaybookParamSpecs(PLAYBOOK_PROMPT, undefined),
				values: { MAX_ITEMS: '10' },
			},
			...overrides,
		};
	}

	const run = async (cfg: DocumentProcessorConfig) => {
		const { result } = renderHook(() => useDocumentProcessor());
		return result.current.processTask(cfg, 'phase-1', 0, 1, disk.content, { onSpawnAgent });
	};

	it('substitutes [NAME] in memory while the document on disk keeps the token', async () => {
		disk.content = '- [ ] Process [MAX_ITEMS] items on {{GIT_BRANCH}}\n';

		await run(config());

		// The `{{}}` pass is written back, the bracket pass is not.
		expect(writeDoc).toHaveBeenCalledTimes(1);
		expect(writeDoc.mock.calls[0][2]).toBe('- [ ] Process [MAX_ITEMS] items on main\n');
		expect(disk.content).toContain('[MAX_ITEMS]');

		const prompt = onSpawnAgent.mock.calls[0][1] as string;
		// The answer wins over the default; a `{{AGENT_PATH}}` default is expanded.
		expect(prompt).toContain('Process 10 items under /test/project.');
		expect(prompt).not.toContain('[MAX_ITEMS]');
		expect(prompt).not.toContain('[TARGET_DIR]');
		expect(prompt).toContain('## Resolved Configuration');
		expect(prompt).toContain('| `MAX_ITEMS` | 10 |');
		expect(prompt).toContain('| `TARGET_DIR` | /test/project |');
	});

	it('leaves a [NAME] inside a steering note literal', async () => {
		disk.content = '- [ ] Do the thing\n';

		await run(
			config({
				steeringNotes: [{ id: 'n1', text: 'keep [MAX_ITEMS] as typed', timestamp: Date.now() }],
			})
		);

		const prompt = onSpawnAgent.mock.calls[0][1] as string;
		expect(prompt.startsWith(STEERING_BLOCK_START)).toBe(true);
		expect(prompt).toContain('keep [MAX_ITEMS] as typed');
		expect(prompt).toContain('Process 10 items under /test/project.');
	});

	it('pauses without spawning when a token has no value', async () => {
		disk.content = '- [ ] Review [PR_URL]\n';
		const prompt = `${PLAYBOOK_PROMPT}\n\n<!-- CONFIGURE: The pull request -->\n**PR_URL:** \`<UNSET>\`\n`;

		const failure = await run(
			config({
				customPrompt: prompt,
				playbookParams: { specs: resolvePlaybookParamSpecs(prompt, undefined), values: {} },
			})
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(AutoRunPauseError);
		const { agentError } = failure as AutoRunPauseError;
		expect(agentError.type).toBe('parameter_substitution');
		expect(agentError.recoverable).toBe(true);
		expect(agentError.message).toContain('[PR_URL]');
		expect(onSpawnAgent).not.toHaveBeenCalled();
		expect(disk.content).toBe('- [ ] Review [PR_URL]\n');
	});

	it('sends the prompt without a table when the run has no playbook parameters', async () => {
		disk.content = '- [ ] Do the thing\n';

		await run(config({ customPrompt: 'Work the document.', playbookParams: undefined }));

		expect(onSpawnAgent.mock.calls[0][1]).toBe('Work the document.');
	});
});
