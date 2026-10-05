/**
 * Every app-dependent verb reports an absent desktop app the same way: one
 * message, `code: MAESTRO_NOT_RUNNING` in JSON, and exit 3 (`ExitCode.NotRunning`).
 *
 * Each row drives a real verb with arguments valid enough to reach its bridge
 * call, and the bridge fails the way `MaestroClient.connect()` does when there
 * is no app. A catch that re-words the error or flattens it to a string before
 * it reaches the exit-code mapping fails here - which is exactly how a dozen
 * verbs used to exit 1 with five different spellings of the same condition.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { dataDir, notRunning } = vi.hoisted(() => {
	const nodeFs = require('fs') as typeof import('fs');
	const nodeOs = require('os') as typeof import('os');
	const nodePath = require('path') as typeof import('path');
	const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'maestro-not-running-'));
	process.env.MAESTRO_USER_DATA = dir;
	return { dataDir: dir, notRunning: { reason: 'no-discovery-file' as const } };
});

vi.mock('../../cli/services/maestro-client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../cli/services/maestro-client')>();
	const fail = () => Promise.reject(new actual.MaestroNotRunningError(notRunning.reason));
	class AbsentClient {
		connect = fail;
		sendCommand = fail;
		disconnect(): void {}
	}
	return {
		...actual,
		MaestroClient: AbsentClient,
		withMaestroClient: vi.fn(fail),
		resolveSessionId: () => 'agent-1',
		resolveTargetSessionId: () => 'agent-1',
	};
});

vi.mock('../../cli/services/storage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../cli/services/storage')>();
	const session = {
		id: 'agent-1',
		name: 'Agent One',
		toolType: 'claude-code',
		cwd: dataDir,
		fullPath: dataDir,
		projectRoot: dataDir,
	};
	return {
		...actual,
		resolveAgentId: () => 'agent-1',
		resolveGroupId: () => 'group-1',
		getSessionById: (id: string) => (id === 'agent-1' ? session : undefined),
		readSessions: () => [session],
		readActiveAgentId: () => 'agent-1',
	};
});

// `pianola orchestrate` loads its plan before it connects; the connect failure
// exits before the plan is read, so any saved plan will do.
vi.mock('../../cli/services/pianola-store', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../cli/services/pianola-store')>();
	return { ...actual, getPianolaPlan: () => ({ id: 'plan-1', tasks: [] }) };
});

import { MAESTRO_NOT_RUNNING_MESSAGE } from '../../cli/services/maestro-not-running';
import { focusAgent, switchMode } from '../../cli/commands/agent-control';
import {
	autoRunFolder,
	autoRunStatus,
	stopAutoRun,
	resetAutoRunTasks,
} from '../../cli/commands/auto-run-control';
import { autoRun } from '../../cli/commands/auto-run';
import { setBookmark } from '../../cli/commands/bookmark';
import { cadenzaClose } from '../../cli/commands/cadenza';
import { createAgent } from '../../cli/commands/create-agent';
import { createGroup } from '../../cli/commands/create-group';
import { createWorktree } from '../../cli/commands/create-worktree';
import { cueActivity, cueEnable } from '../../cli/commands/cue-control';
import { cueList } from '../../cli/commands/cue-list';
import {
	cuePipelineGet,
	cuePipelineList,
	cuePipelineRemove,
} from '../../cli/commands/cue-pipeline';
import { cueTrigger } from '../../cli/commands/cue-trigger';
import { directorNotesSynopsis } from '../../cli/commands/director-notes-synopsis';
import { dispatch } from '../../cli/commands/dispatch';
import { encoreSet } from '../../cli/commands/encore';
import {
	feedbackAuth,
	feedbackSearch,
	feedbackSubmit,
	feedbackSubscribe,
} from '../../cli/commands/feedback';
import { gistCreate } from '../../cli/commands/gist';
import { gloss } from '../../cli/commands/gloss';
import { goalRun } from '../../cli/commands/goal-run';
import {
	groupChatList,
	groupChatSend,
	groupChatStart,
	groupChatStatus,
	groupChatStop,
} from '../../cli/commands/group-chat';
import { listTerminals } from '../../cli/commands/list-terminals';
import {
	marketplaceImport,
	marketplaceList,
	marketplaceShow,
} from '../../cli/commands/marketplace';
import { movementClear, movementInspect, movementState } from '../../cli/commands/movement';
import { notifyFlash } from '../../cli/commands/notify-flash';
import { notifyToast } from '../../cli/commands/notify-toast';
import { closeBrowser, openBrowser } from '../../cli/commands/open-browser';
import { openFile } from '../../cli/commands/open-file';
import { openGraph } from '../../cli/commands/open-graph';
import { openModal } from '../../cli/commands/open-modal';
import { openTerminal } from '../../cli/commands/open-terminal';
import { pianolaWatch } from '../../cli/commands/pianola';
import { pianolaOrchestrate } from '../../cli/commands/pianola-orchestrate';
import { profilingStart, profilingStatus, profilingStop } from '../../cli/commands/profiling';
import { queueList, queueRemove } from '../../cli/commands/queue';
import { readTerminal } from '../../cli/commands/read-terminal';
import { refreshAutoRun } from '../../cli/commands/refresh-auto-run';
import { refreshFiles } from '../../cli/commands/refresh-files';
import { removeAgent } from '../../cli/commands/remove-agent';
import { removeGroup } from '../../cli/commands/remove-group';
import { removePlaybook } from '../../cli/commands/remove-playbook';
import { renameAgent } from '../../cli/commands/rename-agent';
import { renameGroup } from '../../cli/commands/rename-group';
import { sendTerminal } from '../../cli/commands/send-terminal';
import { sessionList, sessionShow } from '../../cli/commands/session';
import { setTheme } from '../../cli/commands/set-theme';
import { snoozeList, snoozeTabCommand } from '../../cli/commands/snooze';
import { stats, statsQuery } from '../../cli/commands/stats';
import { status } from '../../cli/commands/status';
import { supportPackage } from '../../cli/commands/support-package';
import { tabClose, tabNew, tabRename, tabShow } from '../../cli/commands/tab';
import { themeSet } from '../../cli/commands/theme';
import { updateAgent } from '../../cli/commands/update-agent';
import { updateGroup } from '../../cli/commands/update-group';
import { ask } from '../../cli/commands/ask';
import { GLOSS_LEVELS } from '../../shared/themeGloss';

class ExitSignal extends Error {
	constructor(readonly code: number | undefined) {
		super(`exit ${code}`);
	}
}

/** How a verb prints its JSON failure, where that differs from the default. */
interface Row {
	name: string;
	run: (json: boolean) => Promise<unknown>;
	/** Prints JSON whatever `--json` says (dispatch, session, queue, gist). */
	jsonOnly?: boolean;
	/** Has no `--json` at all. */
	humanOnly?: boolean;
	/** Prints its human report on stdout (status is a report, not an error). */
	humanOnStdout?: boolean;
	/** Writes its JSON failure to stderr (stats, director-notes synopsis). */
	jsonOnStderr?: boolean;
	/** Extra fields the verb's error envelope always carries. */
	envelope?: Record<string, unknown>;
	/** JSONL verbs report `message` rather than `error`. */
	jsonlMessage?: boolean;
}

const j = (json: boolean) => ({ json });
let docPath = '';

const rows: Row[] = [
	// runAgentCommand family
	{ name: 'rename-agent', run: (json) => renameAgent('agent-1', 'New', j(json)) },
	{ name: 'remove-playbook', run: (json) => removePlaybook('agent-1', 'pb-1', j(json)) },
	{ name: 'focus-agent', run: (json) => focusAgent('agent-1', j(json)) },
	{ name: 'switch-mode', run: (json) => switchMode('agent-1', 'ai', j(json)) },
	// failCommand family
	{ name: 'auto-run stop', run: (json) => stopAutoRun('agent-1', j(json)) },
	{ name: 'auto-run status', run: (json) => autoRunStatus('agent-1', j(json)) },
	{ name: 'auto-run reset', run: (json) => resetAutoRunTasks('agent-1', 'doc.md', j(json)) },
	{ name: 'auto-run folder', run: (json) => autoRunFolder('agent-1', dataDir, j(json)) },
	{ name: 'bookmark', run: (json) => setBookmark('agent-1', true, j(json)) },
	{ name: 'create-group', run: (json) => createGroup('Group', j(json)) },
	{ name: 'encore enable', run: (json) => encoreSet('directorNotes', true, j(json)) },
	{ name: 'gloss', run: (json) => gloss(GLOSS_LEVELS[0], j(json)) },
	{ name: 'rename-group', run: (json) => renameGroup('group-1', 'New', j(json)) },
	{ name: 'set-theme', run: (json) => setTheme('dracula', j(json)) },
	{ name: 'snooze list', run: (json) => snoozeList(j(json)) },
	{ name: 'snooze tab', run: (json) => snoozeTabCommand('tab-1', '1h', j(json)) },
	{ name: 'tab new', run: (json) => tabNew({ agent: 'agent-1', json }) },
	{ name: 'tab close', run: (json) => tabClose('tab-1', j(json)) },
	{ name: 'tab rename', run: (json) => tabRename('tab-1', 'New', j(json)) },
	{ name: 'tab show', run: (json) => tabShow('tab-1', j(json)) },
	{ name: 'theme set', run: (json) => themeSet(['bgMain=#000000'], j(json)) },
	{ name: 'update-group', run: (json) => updateGroup('group-1', { name: 'New', json }) },
	// local fail / emitError helpers
	{ name: 'ask', run: (json) => ask('agent-2', 'What?', j(json)) },
	{
		name: 'create-worktree',
		run: (json) => createWorktree({ agent: 'agent-1', branch: 'feature', json }),
	},
	{
		name: 'group-chat start',
		run: (json) => groupChatStart('Chat', { participant: ['agent-1'], json }),
	},
	{ name: 'group-chat send', run: (json) => groupChatSend('chat-1', 'hi', j(json)) },
	{ name: 'group-chat status', run: (json) => groupChatStatus('chat-1', j(json)) },
	{ name: 'group-chat list', run: (json) => groupChatList(j(json)) },
	{ name: 'group-chat stop', run: (json) => groupChatStop('chat-1', j(json)) },
	{ name: 'open-modal', run: (json) => openModal('settings', j(json)) },
	{ name: 'read-terminal', run: (json) => readTerminal({ agent: 'agent-1', json }) },
	{ name: 'remove-group', run: (json) => removeGroup('group-1', j(json)) },
	{ name: 'update-agent', run: (json) => updateAgent('agent-1', { group: 'group-1', json }) },
	{
		name: 'cue pipeline list',
		run: (json) => cuePipelineList(j(json)),
		envelope: { type: 'error' },
	},
	{
		name: 'cue pipeline get',
		run: (json) => cuePipelineGet('p', j(json)),
		envelope: { type: 'error' },
	},
	{
		name: 'cue pipeline remove',
		run: (json) => cuePipelineRemove('p', j(json)),
		envelope: { type: 'error' },
	},
	{ name: 'movement state', run: (json) => movementState(j(json)) },
	{ name: 'movement clear', run: (json) => movementClear(j(json)) },
	{
		name: 'movement inspect',
		run: (json) => movementInspect('m', { json, output: path.join(dataDir, 'shot.png') }),
	},
	{ name: 'stats', run: (json) => stats(j(json)), jsonOnStderr: true },
	{ name: 'stats query', run: (json) => statsQuery('select 1', j(json)), jsonOnStderr: true },
	{ name: 'cadenza close', run: (json) => cadenzaClose('view-1', j(json)) },
	// inline output
	{ name: 'auto-run', run: () => autoRun([docPath], { agent: 'agent-1' }), humanOnly: true },
	{
		name: 'create-agent',
		run: (json) => createAgent('Agent', { cwd: dataDir, type: 'claude-code', json }),
	},
	{ name: 'cue list', run: (json) => cueList(j(json)), envelope: { type: 'error' } },
	{ name: 'cue trigger', run: (json) => cueTrigger('sub', j(json)), envelope: { type: 'error' } },
	{
		name: 'director-notes synopsis',
		run: (json) => directorNotesSynopsis({ format: json ? 'json' : 'markdown' }),
		jsonOnStderr: true,
	},
	{ name: 'list-terminals', run: (json) => listTerminals({ agent: 'agent-1', json }) },
	{ name: 'notify flash', run: (json) => notifyFlash('hi', j(json)) },
	{ name: 'notify toast', run: (json) => notifyToast('title', 'body', j(json)) },
	{ name: 'open-browser', run: (json) => openBrowser('https://example.com', j(json)) },
	{ name: 'close-browser', run: (json) => closeBrowser('tab-1', j(json)) },
	{ name: 'open-file', run: (json) => openFile(docPath, { agent: 'agent-1', json }) },
	{ name: 'open-graph', run: (json) => openGraph([docPath], { agent: 'agent-1', json }) },
	{ name: 'open-terminal', run: (json) => openTerminal({ agent: 'agent-1', json }) },
	{ name: 'profiling start', run: (json) => profilingStart(j(json)) },
	{
		name: 'profiling stop',
		run: (json) => profilingStop({ output: path.join(dataDir, 'trace.zip'), json }),
	},
	{ name: 'profiling status', run: (json) => profilingStatus(j(json)) },
	{ name: 'refresh-auto-run', run: (json) => refreshAutoRun(j(json)) },
	{ name: 'refresh-files', run: (json) => refreshFiles(j(json)) },
	{ name: 'remove-agent', run: (json) => removeAgent('agent-1', j(json)) },
	{ name: 'send-terminal', run: (json) => sendTerminal('ls', { agent: 'agent-1', json }) },
	// former substring classifiers
	{ name: 'dispatch', run: () => dispatch('agent-1', 'hi', {}), jsonOnly: true },
	{ name: 'session list', run: () => sessionList({ json: true }), jsonOnly: true },
	{ name: 'session show', run: () => sessionShow('tab-1', {}), jsonOnly: true },
	{ name: 'queue list', run: () => queueList({}), jsonOnly: true },
	{ name: 'queue remove', run: () => queueRemove('item-1', { agent: 'agent-1' }), jsonOnly: true },
	{ name: 'gist create', run: () => gistCreate('agent-1', {}), jsonOnly: true },
	// already mapped through exitCodeForError
	{ name: 'cue enable', run: (json) => cueEnable('sub', { agent: 'agent-1', json }) },
	{ name: 'cue activity', run: (json) => cueActivity(j(json)) },
	{ name: 'marketplace list', run: (json) => marketplaceList(j(json)) },
	{ name: 'marketplace show', run: (json) => marketplaceShow('pb', j(json)) },
	{
		name: 'marketplace import',
		run: (json) => marketplaceImport('pb', { agent: 'agent-1', json }),
	},
	{ name: 'feedback auth', run: (json) => feedbackAuth(j(json)) },
	{ name: 'feedback search', run: (json) => feedbackSearch('crash', j(json)) },
	{
		name: 'feedback submit',
		run: (json) =>
			feedbackSubmit({ category: 'bug', summary: 's', expected: 'e', actual: 'a', json }),
	},
	{ name: 'feedback subscribe', run: (json) => feedbackSubscribe('12', j(json)) },
	{ name: 'support-package', run: (json) => supportPackage({ output: dataDir, json }) },
	// special cases
	{
		name: 'goal-run --visible',
		run: (json) => goalRun('agent-1', 'Ship it', { visible: true, json }),
		jsonlMessage: true,
	},
	{ name: 'status', run: () => status(), humanOnly: true, humanOnStdout: true },
	{ name: 'pianola watch', run: () => pianolaWatch('tab-1', { once: true }), humanOnly: true },
	{
		name: 'pianola orchestrate',
		run: () => pianolaOrchestrate('plan-1', { once: true }),
		humanOnly: true,
	},
];

describe('app-dependent verbs with no desktop app', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeAll(() => {
		docPath = path.join(dataDir, 'doc.md');
		fs.writeFileSync(docPath, '- [ ] task\n');
		// Two verbs sit behind Encore gates read from settings, ahead of the bridge.
		fs.writeFileSync(
			path.join(dataDir, 'maestro-settings.json'),
			JSON.stringify({ encoreFeatures: { directorNotes: true, pianola: true } })
		);
	});

	afterAll(() => {
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new ExitSignal(code as number | undefined);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function runRow(row: Row, json: boolean): Promise<number | undefined> {
		try {
			await row.run(json);
		} catch (error) {
			if (!(error instanceof ExitSignal)) throw error;
		}
		expect(exitSpy).toHaveBeenCalled();
		return exitSpy.mock.calls[0][0] as number | undefined;
	}

	function printed(spy: MockInstance): string[] {
		return spy.mock.calls.map((call) => call.map(String).join(' '));
	}

	describe.each(rows.filter((row) => !row.jsonOnly))('$name (human)', (row) => {
		it('prints the one message on stderr and exits 3', async () => {
			const code = await runRow(row, false);
			expect(code).toBe(3);
			expect(printed(row.humanOnStdout ? logSpy : errorSpy).join('\n')).toContain(
				MAESTRO_NOT_RUNNING_MESSAGE
			);
			expect(printed(logSpy).join('\n')).not.toContain('"success":true');
		});
	});

	describe.each(rows.filter((row) => !row.humanOnly))('$name (json)', (row) => {
		it('prints MAESTRO_NOT_RUNNING with the one message and exits 3', async () => {
			const code = await runRow(row, true);
			expect(code).toBe(3);
			const lines = printed(row.jsonOnStderr ? errorSpy : logSpy);
			const payload = lines
				.map((line) => {
					try {
						return JSON.parse(line) as Record<string, unknown>;
					} catch {
						return null;
					}
				})
				.find((value) => value && value.code === 'MAESTRO_NOT_RUNNING');
			expect(payload, `no MAESTRO_NOT_RUNNING payload in:\n${lines.join('\n')}`).toBeTruthy();
			if (row.jsonlMessage) {
				expect(String(payload!.message)).toContain(MAESTRO_NOT_RUNNING_MESSAGE);
			} else {
				expect(payload).toMatchObject({
					...row.envelope,
					success: false,
					error: MAESTRO_NOT_RUNNING_MESSAGE,
				});
			}
		});
	});
});
