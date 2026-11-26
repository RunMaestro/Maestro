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
 * The same synopsis turn writes a finished turn's History entry (`summarizeTurn`, P8), as the
 * desktop's exit synopsis does (`runExitSynopsis`), so `/history` and a turn's entry share the
 * last-synopsis time and the one-writer hold.
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
import type { HistoryEntry, ToolType, UsageStats } from '../../types';
import { discoverClaudeSkills } from '../agents/claude-skills';
import type { AgentRepository } from '../agents/repository';
import type { RuleContext } from '../agents/rules';
import { logger } from '../host';
import type { MaestroPaths } from '../paths/resolve';
import { estimateContextUsage } from '../parsers/usage-aggregator';
import { createPromptLoaderFor } from '../prompts/load';
import type { AgentRecord, AITabRecord } from '../store/records';
import type { LogEntryRecord } from '../store/transcript';
import type { HistoryWriter } from '../turns/history';
import type { TurnSummaryHandoff } from '../turns/record-turn';
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

/** What one synopsis turn came to (`synopsize`). */
type SynopsisOutcome =
	| { kind: 'gone' }
	| { kind: 'no-session' }
	| { kind: 'failed' }
	| { kind: 'nothing' }
	| { kind: 'written'; shortSummary: string };

export interface RuntimeBuiltinCommands {
	/**
	 * Run `command` for the tab. Resolves when it has finished writing; never rejects (a failure is
	 * written to the tab, as the desktop writes it).
	 */
	run(agentId: string, tabId: string, command: MaestroBuiltinCommand): Promise<void>;
	/**
	 * Write a finished turn's History entry from a synopsis turn, once the tab is free. Resolves when
	 * it is written or skipped; never rejects.
	 */
	summarizeTurn(request: TurnSummaryHandoff): Promise<void>;
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

	/**
	 * Write a line to the tab and tell clients. `replacing`: the progress line this command wrote
	 * earlier, whose text this one takes over (same id and time), as the desktop's `/history`
	 * replaces "Generating history synopsis..." with its outcome instead of adding a second line.
	 */
	async function write(
		agentId: string,
		tabId: string,
		source: 'system' | 'user',
		text: string,
		replacing?: LogEntryRecord
	): Promise<LogEntryRecord | undefined> {
		const entry: LogEntryRecord = replacing
			? { ...replacing, text }
			: { id: rules.newId(), timestamp: deps.now(), source, text };
		const written = replacing
			? await repository.replaceTranscriptEntry(agentId, tabId, entry)
			: await repository.appendTranscript(agentId, tabId, [entry]);
		if (!written.ok) {
			logger.warn(
				`A command's transcript entry was not written: ${written.error.message}`,
				LOG_CONTEXT
			);
			return undefined;
		}
		options.transcriptChanged(agentId, tabId, entry);
		return entry;
	}

	/**
	 * One synopsis turn of a tab, for `/history` and for a finished turn's History entry (the desktop
	 * runs both through the same synopsis spawn). It holds the tab's provider session once no turn
	 * runs on it, resumes it on the cheap tier of `settings` (`cheapResumeTurnSettings`), covers
	 * the work since the tab's last synopsis, and appends the entry `buildEntry` makes from it.
	 * Throws when the entry could not be appended.
	 */
	async function synopsize(
		agentId: string,
		tabId: string,
		request: {
			/**
			 * What the summarized work ran at: the tab's settings, or the finished turn's. `null`: the
			 * session cannot be resumed now (the agent left the turn's provider), so no synopsis.
			 */
			settings(record: AgentRecord, tab: AITabRecord): { model?: string; effort?: string } | null;
			/** The session to resume. Default: the tab's session once the hold is taken. */
			resumeSessionId?: string;
			buildEntry(synopsis: {
				record: AgentRecord;
				tab: AITabRecord;
				agentSessionId: string;
				shortSummary: string;
				fullSynopsis: string;
				usageStats?: UsageStats;
				contextUsage?: number;
				synopsisTime: number;
				lastSynopsisTime?: number;
			}): HistoryEntry;
		}
	): Promise<SynopsisOutcome> {
		let release: (() => void) | undefined;
		const key = slotKey(agentId, tabId);
		const controller = new AbortController();
		try {
			// One writer per provider session: the synopsis holds it once the tab's turn has ended,
			// and a send waits for the hold.
			release = await options.reserveTabSession(agentId, tabId);
			inFlight.set(key, { agentId, tabId, controller });
			// What the wait may have changed: the turn that ran can have moved the tab to a new
			// session, which is the conversation `/history` summarizes.
			const current = repository.getTab(agentId, tabId);
			const record = repository.getAgent(agentId);
			if (!record || !current) return { kind: 'gone' };
			const sessionNow =
				request.resumeSessionId ??
				(typeof current.agentSessionId === 'string' && current.agentSessionId
					? current.agentSessionId
					: undefined);
			if (!sessionNow) return { kind: 'no-session' };
			const lastSynopsisTime =
				lastSynopsisAt.get(key) ??
				(typeof current.lastSynopsisTime === 'number' ? current.lastSynopsisTime : undefined);
			const toolType = record.toolType as ToolType;
			const settings = request.settings(record, current);
			if (!settings) return { kind: 'gone' };
			const cheap = cheapResumeTurnSettings(toolType, settings);
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
				...(current.nativeSessionBinding
					? { retainedNativeSessionBinding: current.nativeSessionBinding }
					: {}),
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
			if (controller.signal.aborted) return { kind: 'gone' };
			if (!result.success || !result.response) return { kind: 'failed' };
			const parsed = parseSynopsis(result.response);
			if (parsed.nothingToReport) return { kind: 'nothing' };
			const context = result.usageStats ? estimateContextUsage(result.usageStats, toolType) : null;
			const appended = await options.historyWriter.append(
				agentId,
				request.buildEntry({
					record,
					tab: current,
					agentSessionId: sessionNow,
					shortSummary: parsed.shortSummary,
					fullSynopsis: parsed.fullSynopsis,
					...(result.usageStats ? { usageStats: result.usageStats } : {}),
					...(context !== null ? { contextUsage: context } : {}),
					synopsisTime,
					...(lastSynopsisTime !== undefined ? { lastSynopsisTime } : {}),
				})
			);
			if (!appended.ok) throw new Error(appended.message);
			lastSynopsisAt.set(key, synopsisTime);
			return { kind: 'written', shortSummary: parsed.shortSummary };
		} finally {
			if (inFlight.get(key)?.controller === controller) inFlight.delete(key);
			release?.();
		}
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
		const pending = await write(agentId, tabId, 'system', HISTORY_COMMAND_TEXT.pending);
		// The outcome replaces the progress line, as on the desktop: one line per run (M22).
		const settle = (text: string) => write(agentId, tabId, 'system', text, pending);
		try {
			const outcome = await synopsize(agentId, tabId, {
				settings: (record, current) => ({
					model: str(current.customModel) ?? str(record.customModel),
					effort: str(current.customEffort) ?? str(record.customEffort),
				}),
				buildEntry: (synopsis) => ({
					id: rules.newId(),
					type: 'AUTO',
					timestamp: synopsis.synopsisTime,
					summary: synopsis.shortSummary,
					fullResponse: synopsis.fullSynopsis,
					agentSessionId: synopsis.agentSessionId,
					sessionId: agentId,
					projectPath: typeof synopsis.record.cwd === 'string' ? synopsis.record.cwd : '',
					...(str(synopsis.tab.name) ? { sessionName: str(synopsis.tab.name) } : {}),
					...(synopsis.usageStats ? { usageStats: synopsis.usageStats } : {}),
					...(synopsis.contextUsage !== undefined ? { contextUsage: synopsis.contextUsage } : {}),
					elapsedTimeMs: historySynopsisElapsedMs(
						{
							lastSynopsisTime: synopsis.lastSynopsisTime,
							createdAt:
								typeof synopsis.tab.createdAt === 'number' ? synopsis.tab.createdAt : undefined,
						},
						synopsis.synopsisTime
					),
				}),
			});
			if (outcome.kind === 'no-session') {
				await settle(HISTORY_COMMAND_TEXT.noSession);
			} else if (outcome.kind === 'failed') {
				await settle(HISTORY_COMMAND_TEXT.failed);
			} else if (outcome.kind === 'nothing') {
				await settle(HISTORY_COMMAND_TEXT.nothingToReport);
			} else if (outcome.kind === 'written') {
				await settle(HISTORY_COMMAND_TEXT.saved(outcome.shortSummary));
			}
		} catch (error) {
			await settle(
				HISTORY_COMMAND_TEXT.error(error instanceof Error ? error.message : String(error))
			);
		}
	}

	/**
	 * A finished turn's History entry, from a synopsis turn, as a desktop writes it on exit
	 * (`runExitSynopsis`): the synopsis' short summary and full text, its usage, and the turn's
	 * own fields (`entry`) otherwise. Resumes the turn's session on the cheap tier of the turn's
	 * model and effort. NOTHING_TO_REPORT and a failed synopsis write no entry, as on the desktop
	 * (where a failure is a yellow toast; here it is a host log line).
	 */
	async function summarizeTurn(request: TurnSummaryHandoff): Promise<void> {
		const { agentId, tabId, entry } = request;
		try {
			const outcome = await synopsize(agentId, tabId, {
				// A session belongs to its provider: once the agent moved to another, there is no
				// conversation left to resume for this turn.
				settings: (record) =>
					record.toolType === request.settings.provider
						? {
								...(request.settings.model ? { model: request.settings.model } : {}),
								...(request.settings.effort ? { effort: request.settings.effort } : {}),
							}
						: null,
				...(entry.agentSessionId ? { resumeSessionId: entry.agentSessionId } : {}),
				buildEntry: (synopsis) => {
					const { usageStats: _turnUsage, contextUsage: _turnContext, ...turnFields } = entry;
					return {
						...turnFields,
						timestamp: synopsis.synopsisTime,
						summary: synopsis.shortSummary,
						fullResponse: synopsis.fullSynopsis,
						agentSessionId: synopsis.agentSessionId,
						...(synopsis.usageStats ? { usageStats: synopsis.usageStats } : {}),
						...(synopsis.contextUsage !== undefined ? { contextUsage: synopsis.contextUsage } : {}),
					};
				},
			});
			if (outcome.kind === 'failed') {
				logger.warn('A turn synopsis failed: no History entry was written.', LOG_CONTEXT);
			}
		} catch (error) {
			logger.warn(
				`A turn's History entry was not written: ${error instanceof Error ? error.message : String(error)}`,
				LOG_CONTEXT
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
		summarizeTurn,
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
