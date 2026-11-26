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
	/**
	 * Hold the tab's provider session for a synopsis once no turn runs on it: a send to the tab, and
	 * another synopsis, wait until the answer is called. Rejects when the host is closing.
	 */
	reserveTabSession(agentId: string, tabId: string): Promise<() => void>;
	/** The command wrote `entry` to the tab's transcript, outside any turn: tell the clients. */
	transcriptChanged(agentId: string, tabId: string, entry: LogEntryRecord): void;
	/** The home directory the user's own skills live under. Default: this process's. */
	homeDir?(): string;
}

export interface RuntimeBuiltinCommands {
	/**
	 * Run `command` for the tab. Resolves when it has finished writing; never rejects (a failure is
	 * written to the tab, as the desktop writes it).
	 */
	run(agentId: string, tabId: string, command: MaestroBuiltinCommand): Promise<void>;
	/**
	 * Stop the `/history` synopses of an agent's tab, of every tab of the agent (no `tabId`), or of
	 * every agent (no `agentId`): a tab that closes, an agent that is removed, and a host that shuts
	 * down or is fenced leave no synopsis running or about to start.
	 */
	stop(agentId?: string, tabId?: string): void;
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
	/** The stop signal of each tab's synopsis in flight, by `slotKey`. */
	const inFlight = new Map<
		string,
		{ agentId: string; tabId: string; controller: AbortController }
	>();
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
		options.transcriptChanged(agentId, tabId, entry);
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
		let release: (() => void) | undefined;
		const key = slotKey(agentId, tabId);
		const controller = new AbortController();
		try {
			// One writer per provider session: the synopsis holds it once the tab's turn has ended,
			// and a send waits for the hold.
			release = await options.reserveTabSession(agentId, tabId);
			inFlight.set(key, { agentId, tabId, controller });
			// What the wait may have changed: the turn that ran can have moved the tab to a new
			// session, which is the conversation to summarize.
			const current = repository.getTab(agentId, tabId);
			const record = repository.getAgent(agentId);
			const sessionNow =
				current && typeof current.agentSessionId === 'string' && current.agentSessionId
					? current.agentSessionId
					: undefined;
			if (!record || !current) return;
			if (!sessionNow) {
				await write(agentId, tabId, 'system', HISTORY_COMMAND_TEXT.noSession);
				return;
			}
			const lastSynopsisTime =
				lastSynopsisAt.get(slotKey(agentId, tabId)) ??
				(typeof current.lastSynopsisTime === 'number' ? current.lastSynopsisTime : undefined);
			const toolType = record.toolType as ToolType;
			const cheap = cheapResumeTurnSettings(toolType, {
				model: str(current.customModel) ?? str(record.customModel),
				effort: str(current.customEffort) ?? str(record.customEffort),
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
				resumeSessionId: sessionNow,
				model: cheap.model,
				effort: cheap.effort,
				signal: controller.signal,
			});
			// Stopped (the tab closed, the host is going): nothing more is written for it.
			if (controller.signal.aborted) return;
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
				agentSessionId: sessionNow,
				sessionId: agentId,
				projectPath: typeof record.cwd === 'string' ? record.cwd : '',
				...(str(current.name) ? { sessionName: str(current.name) } : {}),
				...(result.usageStats ? { usageStats: result.usageStats } : {}),
				...(context !== null ? { contextUsage: context } : {}),
				elapsedTimeMs: historySynopsisElapsedMs(
					{
						lastSynopsisTime,
						createdAt: typeof current.createdAt === 'number' ? current.createdAt : undefined,
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
		} finally {
			if (inFlight.get(key)?.controller === controller) inFlight.delete(key);
			release?.();
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
		stop(agentId, tabId) {
			for (const entry of inFlight.values()) {
				if (agentId !== undefined && entry.agentId !== agentId) continue;
				if (tabId !== undefined && entry.tabId !== tabId) continue;
				entry.controller.abort();
			}
		},
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
