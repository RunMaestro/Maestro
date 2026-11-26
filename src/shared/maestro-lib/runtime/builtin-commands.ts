/**
 * Maestro's own `/history` and `/skills`, run by a headless host for one of its tabs (M5).
 *
 * A desktop host runs these in its renderer (`useWizardHandlers`) when a Federation client sends
 * the typed text for a hosted agent's tab. A headless host has no renderer, so its runtime runs
 * them here, over the same shared pieces, and the tab reads as a local agent's does:
 *
 * | Piece | Shared with the desktop |
 * | --- | --- |
 * | What counts as one, and which run from a remote send | `parseMaestroBuiltinCommand`, `runsOutsideComposer` |
 * | The words written to the tab, the synopsis prompt, the elapsed time | `maestroBuiltinCommandText.ts` |
 * | Reading the synopsis | `parseSynopsis` |
 * | The synopsis turn's model and effort | `cheapResumeTurnSettings` |
 * | The skills a project has, and their table | `discoverClaudeSkills`, `formatClaudeSkillsMessage` |
 *
 * Differences that are the transport, not the result: the transcript is append-only here, so
 * `/history` writes its outcome as a second system entry after "Generating history synopsis...",
 * where the desktop rewrites the first. A synopsis resumes the tab's provider session, so it waits
 * for a turn running on the tab to end, and a send to the tab waits for it (one writer per session,
 * as `awaitSynopsisWriters` keeps on the desktop).
 */

import * as os from 'os';
import {
	formatClaudeSkillsMessage,
	HISTORY_COMMAND_TEXT,
	historySynopsisElapsedMs,
	historySynopsisPrompt,
	skillsCommandErrorText,
} from '../../maestroBuiltinCommandText';
import type { MaestroBuiltinCommand } from '../../maestroBuiltinCommands';
import { cheapResumeTurnSettings } from '../../modelTiers';
import { PROMPT_IDS } from '../../promptDefinitions';
import { parseSynopsis } from '../../synopsis';
import type { ToolType } from '../../types';
import { discoverClaudeSkills } from '../agents/claude-skills';
import type { AgentRepository } from '../agents/repository';
import type { RuleContext } from '../agents/rules';
import { logger } from '../host';
import type { MaestroPaths } from '../paths/resolve';
import { estimateContextUsage } from '../parsers/usage-aggregator';
import { createPromptLoaderFor } from '../prompts/load';
import type { LogEntryRecord } from '../store/transcript';
import type { HistoryWriter } from '../turns/history';
import type { StatsRecorder } from '../turns/stats';
import { createAutoRunTurnRunner } from './autorun-turns';
import type { ProcessRegistry } from './processes';
import type { RuntimeTurnDeps, RuntimeTurnOptions } from './turns';

const LOG_CONTEXT = '[RuntimeBuiltinCommands]';

/**
 * The registry slot a tab's `/history` synopsis runs under. Beside the tab, not on it: the tab does
 * not read busy for a background synopsis (it does not on a desktop), but a send to the tab sees
 * the slot and waits.
 */
export function synopsisProcessSlot(tabId: string): string {
	return `synopsis:${tabId}`;
}

export interface RuntimeBuiltinCommandsOptions {
	paths: MaestroPaths;
	repository: AgentRepository;
	registry: ProcessRegistry;
	historyWriter: HistoryWriter;
	statsRecorder: Pick<StatsRecorder, 'recordQuery'>;
	host: RuntimeTurnOptions;
	deps: Pick<RuntimeTurnDeps, 'runAgentTurn' | 'probeBinary' | 'readGitBranch' | 'now'>;
	rules: Pick<RuleContext, 'newId'>;
	/** Resolves once no turn runs on the tab. */
	whenTabIdle(agentId: string, tabId: string): Promise<void>;
	/** The tab's transcript grew outside a turn: tell the clients to read it again. */
	transcriptChanged(agentId: string, tabId: string): void;
	/** The home directory the user's own skills live under. Default: this process's. */
	homeDir?(): string;
}

export interface RuntimeBuiltinCommands {
	/**
	 * Run `command` for the tab. Resolves when it has finished writing; never rejects (a failure is
	 * written to the tab, as the desktop writes it).
	 */
	run(agentId: string, tabId: string, command: MaestroBuiltinCommand): Promise<void>;
}

export function createRuntimeBuiltinCommands(
	options: RuntimeBuiltinCommandsOptions
): RuntimeBuiltinCommands {
	const { repository, rules, deps } = options;
	/**
	 * When `/history` last wrote a synopsis of each tab, so the next covers only what followed. Kept
	 * by this process: the tab record carries a desktop's `lastSynopsisTime`, which seeds it, but the
	 * client wire has no field to write it, so a host restart starts the count again.
	 */
	const lastSynopsisAt = new Map<string, number>();
	const slotKey = (agentId: string, tabId: string) => `${agentId}\u0000${tabId}`;
	let loaderLooked = false;
	let loader: ReturnType<typeof createPromptLoaderFor>;
	const synopsisBasePrompt = (): string => {
		if (!loaderLooked) {
			loaderLooked = true;
			loader = createPromptLoaderFor({
				userDataDir: options.paths.userDataDir,
				...(options.host.bundledPromptsDir
					? { bundledPromptsDir: options.host.bundledPromptsDir }
					: {}),
				...(options.host.moduleDirectory ? { moduleDirectory: options.host.moduleDirectory } : {}),
			});
		}
		return loader?.get(PROMPT_IDS.AUTORUN_SYNOPSIS) ?? '';
	};

	async function write(
		agentId: string,
		tabId: string,
		source: 'system' | 'user',
		text: string
	): Promise<void> {
		const entry: LogEntryRecord = { id: rules.newId(), timestamp: deps.now(), source, text };
		const written = await repository.appendTranscript(agentId, tabId, [entry]);
		if (!written.ok) {
			logger.warn(
				`A command's transcript entry was not written: ${written.error.message}`,
				LOG_CONTEXT
			);
			return;
		}
		options.transcriptChanged(agentId, tabId);
	}

	async function history(agentId: string, tabId: string): Promise<void> {
		const record = repository.getAgent(agentId);
		const tab = repository.getTab(agentId, tabId);
		if (!record || !tab) return;
		const agentSessionId =
			typeof tab.agentSessionId === 'string' && tab.agentSessionId ? tab.agentSessionId : undefined;
		if (!agentSessionId) {
			await write(agentId, tabId, 'system', HISTORY_COMMAND_TEXT.noSession);
			return;
		}
		await write(agentId, tabId, 'system', HISTORY_COMMAND_TEXT.pending);
		try {
			// One writer per provider session: the synopsis resumes it after the tab's turn ends.
			await options.whenTabIdle(agentId, tabId);
			const lastSynopsisTime =
				lastSynopsisAt.get(slotKey(agentId, tabId)) ??
				(typeof tab.lastSynopsisTime === 'number' ? tab.lastSynopsisTime : undefined);
			const toolType = record.toolType as ToolType;
			const cheap = cheapResumeTurnSettings(toolType, {
				model: str(tab.customModel) ?? str(record.customModel),
				effort: str(tab.customEffort) ?? str(record.customEffort),
			});
			const synopsisTime = deps.now();
			const runner = createAutoRunTurnRunner({
				agentId,
				paths: options.paths,
				repository,
				registry: options.registry,
				statsRecorder: options.statsRecorder,
				host: options.host,
				deps,
				onStream: () => undefined,
				processTabId: synopsisProcessSlot(tabId),
			});
			const result = await runner.run({
				purpose: 'synopsis',
				prompt: historySynopsisPrompt(synopsisBasePrompt(), lastSynopsisTime),
				resumeSessionId: agentSessionId,
				model: cheap.model,
				effort: cheap.effort,
			});
			if (!result.success || !result.response) {
				await write(agentId, tabId, 'system', HISTORY_COMMAND_TEXT.failed);
				return;
			}
			const parsed = parseSynopsis(result.response);
			if (parsed.nothingToReport) {
				await write(agentId, tabId, 'system', HISTORY_COMMAND_TEXT.nothingToReport);
				return;
			}
			const context = result.usageStats ? estimateContextUsage(result.usageStats, toolType) : null;
			const appended = await options.historyWriter.append(agentId, {
				id: rules.newId(),
				type: 'AUTO',
				timestamp: synopsisTime,
				summary: parsed.shortSummary,
				fullResponse: parsed.fullSynopsis,
				agentSessionId,
				sessionId: agentId,
				projectPath: typeof record.cwd === 'string' ? record.cwd : '',
				...(str(tab.name) ? { sessionName: str(tab.name) } : {}),
				...(result.usageStats ? { usageStats: result.usageStats } : {}),
				...(context !== null ? { contextUsage: context } : {}),
				elapsedTimeMs: historySynopsisElapsedMs(
					{
						lastSynopsisTime,
						createdAt: typeof tab.createdAt === 'number' ? tab.createdAt : undefined,
					},
					synopsisTime
				),
			});
			if (!appended.ok) throw new Error(appended.message);
			lastSynopsisAt.set(slotKey(agentId, tabId), synopsisTime);
			await write(agentId, tabId, 'system', HISTORY_COMMAND_TEXT.saved(parsed.shortSummary));
		} catch (error) {
			await write(
				agentId,
				tabId,
				'system',
				HISTORY_COMMAND_TEXT.error(error instanceof Error ? error.message : String(error))
			);
		}
	}

	async function skills(agentId: string, tabId: string): Promise<void> {
		const record = repository.getAgent(agentId);
		if (!record || !repository.getTab(agentId, tabId)) return;
		await write(agentId, tabId, 'user', '/skills');
		const projectRoot = str(record.projectRoot) ?? str(record.cwd);
		try {
			if (!projectRoot) throw new Error('The agent has no project folder.');
			const found = await discoverClaudeSkills(projectRoot, (options.homeDir ?? os.homedir)());
			await write(agentId, tabId, 'system', formatClaudeSkillsMessage(found));
		} catch (error) {
			await write(
				agentId,
				tabId,
				'system',
				skillsCommandErrorText(error instanceof Error ? error.message : String(error))
			);
		}
	}

	return {
		async run(agentId, tabId, command) {
			try {
				if (command.name === '/history') await history(agentId, tabId);
				else if (command.name === '/skills') await skills(agentId, tabId);
			} catch (error) {
				logger.warn(
					`${command.name} failed: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				);
			}
		},
	};
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}
