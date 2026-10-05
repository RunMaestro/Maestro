// The CLI's side of the library Auto Run engine (src/shared/maestro-lib/autorun).
//
// `runPlaybook` and `runGoal` in the library do the looping; everything they touch outside
// themselves is a port. This builds those ports from the CLI modules the engine used to import
// directly: `spawnAgent` wrapped in `captureCliRun` for turns, the sync document helpers, the
// CLI's History and group readers, the prompt loader, and `cli-activity.json`.
//
// Turn options are kept field for field as the CLI passed them before the move. Task and synopsis
// turns carry `querySource: 'auto'`, the Claude token source, and the agent's additional
// directories; goal turns carry none of the three (the desktop's goal turns do, which is a known
// gap in `Plans/maestro-tui-autorun-engine.md`, F6, not something to fix inside a move).

import type { SessionInfo } from '../../shared/types';
import type {
	AutoRunDeps,
	AutoRunTurnRequest,
	AutoRunTurnResult,
} from '../../shared/maestro-lib/autorun/engine-types';
import { registerCliActivity, unregisterCliActivity } from '../../shared/cli-activity';
import { logger } from '../../main/utils/logger';
import {
	spawnAgent,
	readDocAndCountTasks,
	readDocAndGetTasks,
	uncheckAllTasks,
	writeDoc,
	type SpawnAgentOptions,
} from './agent-spawner';
import { captureCliRun, settlementFromAgentResult } from './agent-run-capture';
import { getGitBranch, isGitRepo } from './git-utils';
import { getCliPrompt, getCliTaskSelectionBlock } from './prompt-loader';
import { addHistoryEntry, readGroups, readHistory } from './storage';
import { prepareMaestroSystemPromptCli } from './system-prompt';

/** The Claude token source and the other settings every task and synopsis turn honors. */
function autoRunTurnOptions(session: SessionInfo): SpawnAgentOptions {
	return {
		customArgs: session.customArgs,
		additionalDirectories: session.additionalDirectories,
		customEnvVars: session.customEnvVars,
		sshRemoteConfig: session.sessionSshRemoteConfig,
		// This is Auto Run, not someone typing. Marks the turn so delegation
		// reporting downstream of the spawn does not count it as hands-on work.
		querySource: 'auto',
		enableMaestroP: session.enableMaestroP,
		maestroPMode: session.maestroPMode,
		maestroPPath: session.maestroPPath,
	};
}

/** What a goal turn carries: the overrides and SSH, without the Auto Run extras (F6). */
function goalTurnOptions(session: SessionInfo): SpawnAgentOptions {
	return {
		customArgs: session.customArgs,
		customEnvVars: session.customEnvVars,
		sshRemoteConfig: session.sessionSshRemoteConfig,
	};
}

export function createCliAutoRunDeps(session: SessionInfo): AutoRunDeps {
	// Built once per run by `turns.prepare()`, then sent with every task and goal iteration.
	let appendSystemPrompt: string | undefined;

	const turn = (
		request: AutoRunTurnRequest,
		capture: { sessionId: string; source: string; prompt?: string },
		options: SpawnAgentOptions
	): Promise<AutoRunTurnResult> =>
		captureCliRun(
			{
				sessionId: capture.sessionId,
				toolType: session.toolType,
				cwd: session.cwd,
				...(capture.prompt !== undefined ? { prompt: capture.prompt } : {}),
				source: capture.source,
			},
			() =>
				spawnAgent(session.toolType, session.cwd, request.prompt, request.resumeSessionId, {
					customModel: request.model,
					customEffort: request.effort,
					...options,
					signal: request.signal,
				}),
			settlementFromAgentResult
		);

	return {
		turns: {
			async prepare() {
				appendSystemPrompt = await prepareMaestroSystemPromptCli(session);
			},
			run(request) {
				switch (request.purpose) {
					case 'task':
						return turn(
							request,
							{ sessionId: session.id, source: 'cli:autorun', prompt: request.prompt },
							{ ...autoRunTurnOptions(session), appendSystemPrompt }
						);
					case 'synopsis':
						// A resume into the session that already holds the system prompt:
						// re-sending it would waste tokens.
						return turn(
							request,
							{
								sessionId: request.resumeSessionId ?? session.id,
								source: 'cli:autorun-synopsis',
							},
							autoRunTurnOptions(session)
						);
					case 'goal-iteration':
						return turn(
							request,
							{ sessionId: session.id, source: 'cli:goal', prompt: request.prompt },
							{ ...goalTurnOptions(session), appendSystemPrompt }
						);
					case 'goal-handoff':
						return turn(
							request,
							{
								sessionId: request.resumeSessionId ?? session.id,
								source: 'cli:goal-synopsis',
								prompt: request.prompt,
							},
							{ ...goalTurnOptions(session), appendSystemPrompt }
						);
				}
			},
		},
		documents: {
			read(folder, name) {
				const { content, taskCount } = readDocAndCountTasks(folder, name);
				return { content, unchecked: taskCount };
			},
			readTasks: (folder, name) => readDocAndGetTasks(folder, name),
			write: (folder, file, content) => writeDoc(folder, file, content),
			uncheckAll: (content) => uncheckAllTasks(content),
		},
		history: {
			append: (entry) => addHistoryEntry(entry),
			readAll: (agentId) => readHistory(undefined, agentId),
		},
		prompts: {
			get: (id) => getCliPrompt(id),
			taskSelectionBlock: (mode, segment) => getCliTaskSelectionBlock(mode, segment),
		},
		environment: {
			gitBranch: (cwd) => getGitBranch(cwd),
			isGitRepo: (cwd) => isGitRepo(cwd),
			groupName: (groupId) => readGroups().find((g) => g.id === groupId)?.name,
		},
		activity: {
			begin: (entry) =>
				registerCliActivity({
					sessionId: entry.agentId,
					playbookId: entry.playbookId,
					playbookName: entry.playbookName,
					startedAt: entry.startedAt,
					pid: process.pid,
				}),
			end: (agentId) => unregisterCliActivity(agentId),
		},
		clock: { now: () => Date.now() },
		log: {
			autorun: (message, context, data) => logger.autorun(message, context, data),
			warn: (message, context, data) => logger.warn(message, context, data),
		},
	};
}
