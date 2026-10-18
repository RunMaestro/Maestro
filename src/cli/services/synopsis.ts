// Synopsis turn for the CLI.
// One cheap turn, resumed on a finished provider session, that summarizes it
// for a History entry. `send` and Auto Run (`playbook`, `run-doc`) both record
// their turns through it, so the two cannot drift on which model the synopsis
// runs on or on what counts as a usable one.

import type { SessionInfo } from '../../shared/types';
import { spawnAgent } from './agent-spawner';
import { captureCliRun, settlementFromAgentResult } from './agent-run-capture';
import { getCliPrompt } from './prompt-loader';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { cheapResumeTurnSettings } from '../../shared/modelTiers';
import { isFailedSynopsisResponse, parseSynopsis } from '../../shared/synopsis';

export interface CliSynopsisRequest {
	/** Label for the agent-run ledger, e.g. `cli:send-synopsis`. */
	source: string;
	/**
	 * Model and effort the summarized turn ran at, when they differ from the
	 * agent's own (a `--model` run override, a document model hint).
	 */
	model?: string;
	effort?: string;
	/** True when the summarized turn was read-only. */
	readOnlyMode?: boolean;
	/** Stops the synopsis turn, e.g. on Ctrl+C. */
	signal?: AbortSignal;
}

export interface CliSynopsis {
	shortSummary: string;
	fullSynopsis: string;
}

/**
 * Ask the agent to summarize the session it just finished a turn on.
 *
 * Returns `null` when there is nothing usable: the turn failed, printed only a
 * provider error (`isFailedSynopsisResponse`), or reported NOTHING_TO_REPORT.
 * The caller then keeps its own summary, so a failed synopsis is never written
 * to History as if it described the work.
 */
export async function requestCliSynopsis(
	session: SessionInfo,
	agentSessionId: string,
	request: CliSynopsisRequest
): Promise<CliSynopsis | null> {
	// A synopsis is a throwaway summarization of work that already happened, so
	// it runs at the bottom of both ladders regardless of what the turn ran at,
	// short of shrinking the context window the resumed transcript has to fit.
	// Safe because the synopsis is a leaf: the agentSessionId it returns is
	// discarded, so the downgrade cannot follow the conversation onward.
	const turn = cheapResumeTurnSettings(session.toolType, {
		model: request.model ?? session.customModel,
		effort: request.effort ?? session.customEffort,
	});

	const result = await captureCliRun(
		{
			sessionId: agentSessionId,
			toolType: session.toolType,
			cwd: session.cwd,
			source: request.source,
		},
		async () =>
			spawnAgent(
				session.toolType,
				session.cwd,
				await getCliPrompt(PROMPT_IDS.AUTORUN_SYNOPSIS),
				agentSessionId,
				{
					// A read-only turn stays read-only. The synopsis resumes the same
					// session, so without this a read-only turn is followed by one that
					// holds full permissions.
					readOnlyMode: request.readOnlyMode,
					customModel: turn.model,
					customEffort: turn.effort,
					customArgs: session.customArgs,
					additionalDirectories: session.additionalDirectories,
					customEnvVars: session.customEnvVars,
					requiredSecrets: session.requiredSecrets,
					sshRemoteConfig: session.sessionSshRemoteConfig,
					// A synopsis is never someone typing, whatever turn it summarizes.
					querySource: 'auto',
					// Honor the agent's Claude token source for the synopsis turn too.
					enableMaestroP: session.enableMaestroP,
					maestroPMode: session.maestroPMode,
					maestroPPath: session.maestroPPath,
					signal: request.signal,
				}
			),
		settlementFromAgentResult
	);

	const text = result.response;
	if (!result.success || !text || isFailedSynopsisResponse(text, session.toolType)) {
		return null;
	}
	const parsed = parseSynopsis(text);
	if (parsed.nothingToReport) {
		return null;
	}
	return { shortSummary: parsed.shortSummary, fullSynopsis: parsed.fullSynopsis };
}
