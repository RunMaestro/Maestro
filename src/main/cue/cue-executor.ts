/**
 * Cue Executor — orchestrates background agent process execution when Cue
 * triggers fire.
 *
 * Thin orchestrator that composes three single-responsibility modules:
 * - CueTemplateContextBuilder: builds templateContext.cue from event payload
 * - CueSpawnBuilder: constructs a SpawnSpec from session/agent/SSH config
 * - CueProcessLifecycle: spawns the process, captures output, enforces timeout
 *
 * Also contains recordCueHistoryEntry (pure data transformation).
 */

import * as crypto from 'crypto';
import type { CueEvent, CueRunResult, CueSubscription } from './cue-types';
import type { HistoryEntry, SessionInfo, ToolType } from '../../shared/types';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import { buildCueTemplateContext } from './cue-template-context-builder';
import { buildSpawnSpec } from './cue-spawn-builder';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import {
	runProcess,
	stopProcess,
	getActiveProcessMap,
	getProcessList,
} from './cue-process-lifecycle';
import { getOutputParser } from '../parsers';
// Re-export types that external consumers use
export type { CueProcessInfo } from './cue-process-lifecycle';
export type { SpawnSpec } from './cue-spawn-builder';

const MAX_HISTORY_RESPONSE_LENGTH = 10000;

/** Configuration for executing a Cue-triggered prompt */
export interface CueExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	promptPath: string;
	toolType: string;
	projectRoot: string;
	templateContext: TemplateContext;
	timeoutMs: number;
	sshRemoteConfig?: { enabled: boolean; remoteId: string | null };
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	customEffort?: string;
	onLog: (level: string, message: string) => void;
	/** Optional SSH settings store for SSH remote execution */
	sshStore?: SshRemoteSettingsStore;
	/** Optional agent-level config values (from agent config store) */
	agentConfigValues?: Record<string, unknown>;
}

/**
 * Extract clean human-readable text from agent stdout.
 * For agents that output JSON/NDJSON (like OpenCode --format json), parses each
 * line and collects text from 'result' events. Falls back to raw stdout when no
 * parser is available or no result-text events are found (e.g. plain-text agents).
 */
function extractCleanStdout(rawStdout: string, toolType: string): string {
	if (!rawStdout.trim()) {
		return rawStdout;
	}

	const parser = getOutputParser(toolType as ToolType);
	if (!parser) {
		return rawStdout;
	}

	const resultParts: string[] = [];
	const assistantTextByMessage = new Map<string, string>();
	const assistantTextWithoutId: string[] = [];
	for (const line of rawStdout.split('\n')) {
		if (!line.trim()) continue;
		const event = parser.parseJsonLine(line);
		if (event?.type === 'result' && event.text) {
			resultParts.push(event.text);
		} else if (event?.type === 'text' && event.text) {
			// Track assistant text per message ID to avoid duplication from
			// streaming chunks. Each chunk for the same message ID carries the
			// full text so far, so we keep only the latest (longest) version.
			const raw = event.raw as { message?: { id?: string } } | undefined;
			const msgId = raw?.message?.id;
			if (msgId) {
				const existing = assistantTextByMessage.get(msgId);
				if (!existing || event.text.length > existing.length) {
					assistantTextByMessage.set(msgId, event.text);
				}
			} else {
				assistantTextWithoutId.push(event.text);
			}
		}
	}

	// Prefer explicit result text, fall back to assistant message text
	if (resultParts.length > 0) {
		return resultParts.join('\n');
	}
	if (assistantTextByMessage.size > 0 || assistantTextWithoutId.length > 0) {
		return [...assistantTextByMessage.values(), ...assistantTextWithoutId].join('\n');
	}
	return rawStdout;
}

/**
 * Execute a Cue-triggered prompt by spawning an agent process.
 *
 * Orchestrates: template context → variable substitution → spawn spec → process.
 */
export async function executeCuePrompt(config: CueExecutionConfig): Promise<CueRunResult> {
	const { runId, session, subscription, event, promptPath, templateContext, timeoutMs, onLog } =
		config;

	const startedAt = new Date().toISOString();
	const startTime = Date.now();

	// Helper to build a failed result
	const failedResult = (message: string): CueRunResult => ({
		runId,
		sessionId: session.id,
		sessionName: session.name,
		subscriptionName: subscription.name,
		event,
		status: 'failed',
		stdout: '',
		stderr: message,
		exitCode: null,
		durationMs: Date.now() - startTime,
		startedAt,
		endedAt: new Date().toISOString(),
	});

	// 1. Validate prompt content
	const trimmedPrompt = promptPath?.trim();
	if (!trimmedPrompt) {
		const message = `Cue subscription "${subscription.name}" has no prompt content (prompt_file may have failed to load at config time)`;
		onLog('error', message);
		return failedResult(message);
	}

	// 2. Build template context and substitute variables
	templateContext.cue = buildCueTemplateContext(event, subscription, runId);
	const substitutedPrompt = substituteTemplateVariables(trimmedPrompt, templateContext);

	// 3. Build spawn spec (agent args, SSH wrapping, etc.)
	const buildResult = await buildSpawnSpec(config, substitutedPrompt);
	if (!buildResult.ok) {
		onLog('error', buildResult.message);
		return failedResult(buildResult.message);
	}

	const { spec } = buildResult;

	// Log SSH remote usage
	if (spec.sshRemoteUsed) {
		onLog('cue', `[CUE] Using SSH remote: ${spec.sshRemoteUsed.name || spec.sshRemoteUsed.host}`);
	}

	// 4. Execute the process
	onLog(
		'cue',
		`[CUE] Executing run ${runId}: "${subscription.name}" → ${spec.command} (${event.type})`
	);

	const sshActuallyUsed = !!spec.sshRemoteUsed;
	const processResult = await runProcess(runId, spec, {
		toolType: config.toolType,
		timeoutMs,
		sshRemoteEnabled: sshActuallyUsed,
		sshStdinScript: sshActuallyUsed ? spec.sshStdinScript : undefined,
		stdinPrompt: sshActuallyUsed ? spec.stdinPrompt : undefined,
		onLog,
	});

	// 5. Assemble final result
	return {
		runId,
		sessionId: session.id,
		sessionName: session.name,
		subscriptionName: subscription.name,
		event,
		status: processResult.status,
		stdout: extractCleanStdout(processResult.stdout, config.toolType),
		stderr: processResult.stderr,
		exitCode: processResult.exitCode,
		durationMs: Date.now() - startTime,
		startedAt,
		endedAt: new Date().toISOString(),
	};
}

/**
 * Stop a running Cue process by runId.
 * Delegates to the process lifecycle module.
 */
export function stopCueRun(runId: string): boolean {
	return stopProcess(runId);
}

/**
 * Get the map of currently active processes (for testing/monitoring).
 * Delegates to the process lifecycle module.
 */
export function getActiveProcesses(): ReturnType<typeof getActiveProcessMap> {
	return getActiveProcessMap();
}

/**
 * Get serializable info about active Cue processes (for Process Monitor).
 * Delegates to the process lifecycle module.
 */
export function getCueProcessList(): import('./cue-process-lifecycle').CueProcessInfo[] {
	return getProcessList();
}

/**
 * Construct a HistoryEntry for a completed Cue run.
 *
 * Follows the same pattern as Auto Run's history recording with type: 'AUTO',
 * but uses type: 'CUE' and populates Cue-specific fields.
 */
export function recordCueHistoryEntry(result: CueRunResult, session: SessionInfo): HistoryEntry {
	const fullResponse =
		result.stdout.length > MAX_HISTORY_RESPONSE_LENGTH
			? result.stdout.substring(0, MAX_HISTORY_RESPONSE_LENGTH)
			: result.stdout;

	return {
		id: crypto.randomUUID(),
		type: 'CUE',
		timestamp: Date.now(),
		summary: `[CUE] "${result.subscriptionName}" (${result.event.type})`,
		fullResponse: fullResponse || undefined,
		projectPath: session.projectRoot || session.cwd,
		sessionId: session.id,
		sessionName: session.name,
		success: result.status === 'completed',
		elapsedTimeMs: result.durationMs,
		cueTriggerName: result.subscriptionName,
		cueEventType: result.event.type,
		cueSourceSession: result.event.payload.sourceSession
			? String(result.event.payload.sourceSession)
			: undefined,
	};
}
