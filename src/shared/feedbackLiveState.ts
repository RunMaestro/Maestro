/**
 * Live app state for the Feedback chat's self-diagnosis.
 *
 * The interview agent can run `maestro-cli` and read the log, but the state a
 * bug report usually hinges on (an Auto Run parked on an error, a usage-limit
 * pause waiting on the resume coordinator, an Agent Resilience retry counting
 * down) lives only in the renderer's in-memory stores. Main reads it straight
 * out of its own renderer (`webContents.executeJavaScript` on the global named
 * below) when the chat opens and again when the issue is filed, so the agent
 * starts the interview already knowing what is wrong instead of asking.
 *
 * Read-only by construction: the renderer hook only reads stores, and
 * everything here is counters, flags, states, and ages. The one free-text field
 * (`AgentErrorState.message`) is redacted in main with the support package's
 * `sanitizeLogMessage` before it reaches the prompt, and never reaches the
 * public issue at all.
 */

import type { AutoRunDebugSnapshot } from './debugPackage';
import { formatDurationCompact } from './duration';

/** Global the renderer installs and main evaluates. */
export const FEEDBACK_LIVE_STATE_GLOBAL = '__maestroFeedbackLiveState';

export interface FeedbackLiveAgentError {
	type: string;
	recoverable: boolean;
	/** True while new messages are blocked until the error is resolved. */
	paused: boolean;
	/** True for a usage / rate / credit limit the resume coordinator owns. */
	limit: boolean;
	/** Time since the error fired. */
	ageMs: number;
	/** Time until the provider said the limit window reopens, when it said. */
	limitResetInMs?: number;
	/** Resume probes already made against this limit pause. */
	resumeAttempts?: number;
	/** Provider's message. Redacted in main; prompt only, never the issue. */
	message?: string;
}

export interface FeedbackLiveAgent {
	id: string;
	/** Display name. Prompt only (the agent is local); omitted from the issue. */
	name: string;
	provider: string;
	state: string;
	sshRemote: boolean;
	error?: FeedbackLiveAgentError;
	autoRun?: AutoRunDebugSnapshot & { elapsedMs?: number; idleMs?: number };
	/** The fallback that clicks Resume after an ordinary mid-run failure. */
	autoResume?: {
		attempts: number;
		maxAttempts: number;
		nextResumeInMs: number | null;
		exhausted: boolean;
	};
	/** Agent Resilience retries pending on this agent's tabs. */
	retries?: Array<{ strategy: string; status: string; attempt: number; nextRetryInMs: number }>;
	queuedMessages: number;
}

/** What one renderer reports. */
export interface FeedbackRendererLiveState {
	capturedAt: number;
	agentCount: number;
	/** Only agents with something worth looking at; the rest are just counted. */
	agents: FeedbackLiveAgent[];
	/** Every agent's Auto Run counters, for the support package. */
	autoRunSnapshots: AutoRunDebugSnapshot[];
	settings: {
		autoResumeOnLimit: boolean;
		autoResumeCheckIntervalHours: number;
		autoResumeGiveUpDays: number;
	};
}

export interface FeedbackLogLine {
	timestamp: number;
	level: string;
	context?: string;
	message: string;
}

/** The merged result main hands to the prompt, the CLI, and the issue. */
export interface FeedbackLiveDiagnosis {
	capturedAt: number;
	/** False when no renderer answered (no window, or the hook timed out). */
	rendererAvailable: boolean;
	agentCount: number;
	agents: FeedbackLiveAgent[];
	autoRunSnapshots: AutoRunDebugSnapshot[];
	settings?: FeedbackRendererLiveState['settings'];
	/** Recent warn/error log lines, redacted. Includes renderer console errors. */
	recentProblems: FeedbackLogLine[];
}

const fmt = (ms: number) => formatDurationCompact(Math.max(0, ms));

function describeAutoRun(run: NonNullable<FeedbackLiveAgent['autoRun']>): string {
	const parts = [
		run.isRunning ? 'running' : run.isStopping ? 'stopping' : 'not running',
		run.processingState ? `phase=${run.processingState}` : '',
		`tasks ${run.completedTasksAcrossAllDocs}/${run.totalTasksAcrossAllDocs}`,
		`doc ${run.currentDocumentIndex + 1}/${run.documentCount}`,
		run.errorPaused ? 'PAUSED ON ERROR' : '',
		run.hasError ? `error=${run.errorType ?? 'unknown'}` : '',
		run.loopEnabled ? `loop ${run.loopIteration}${run.maxLoops ? `/${run.maxLoops}` : ''}` : '',
		run.idleMs !== undefined ? `last activity ${fmt(run.idleMs)} ago` : '',
	];
	return parts.filter(Boolean).join(', ');
}

/**
 * One line per notable agent. `includePrivate` adds the agent's name and the
 * provider's error message, which are fine in a prompt that never leaves the
 * user's machine but not in a public issue.
 */
function describeAgent(agent: FeedbackLiveAgent, label: string, includePrivate: boolean): string[] {
	const head = [`${label} (${agent.provider}${agent.sshRemote ? ', SSH remote' : ''})`];
	head.push(`state=${agent.state}`);
	if (agent.queuedMessages > 0) head.push(`${agent.queuedMessages} queued message(s)`);
	const lines = [`- ${head.join(', ')}`];
	if (agent.error) {
		const e = agent.error;
		const bits = [
			`error=${e.type}`,
			e.limit ? 'usage/rate limit' : '',
			e.recoverable ? 'recoverable' : 'not recoverable',
			e.paused ? 'agent paused' : '',
			`${fmt(e.ageMs)} ago`,
			e.limitResetInMs !== undefined
				? e.limitResetInMs > 0
					? `provider says limit resets in ${fmt(e.limitResetInMs)}`
					: `provider's reset time passed ${fmt(-e.limitResetInMs)} ago`
				: '',
			e.resumeAttempts ? `${e.resumeAttempts} resume probe(s)` : '',
		];
		lines.push(`  - Error: ${bits.filter(Boolean).join(', ')}`);
		if (includePrivate && e.message) lines.push(`  - Error message: ${e.message}`);
	}
	if (agent.autoRun) lines.push(`  - Auto Run: ${describeAutoRun(agent.autoRun)}`);
	if (agent.autoResume) {
		const r = agent.autoResume;
		lines.push(
			`  - Auto Run auto-resume: ${r.attempts}/${r.maxAttempts} attempts${
				r.exhausted
					? ', gave up (needs a human)'
					: r.nextResumeInMs !== null
						? `, next resume in ${fmt(r.nextResumeInMs)}`
						: ''
			}`
		);
	}
	for (const retry of agent.retries ?? []) {
		lines.push(
			`  - Agent Resilience retry: ${retry.strategy}, ${retry.status}, attempt ${retry.attempt}, next in ${fmt(retry.nextRetryInMs)}`
		);
	}
	return lines;
}

function describeSettings(settings: FeedbackRendererLiveState['settings']): string {
	return `Auto-resume on limit: ${settings.autoResumeOnLimit ? 'on' : 'OFF'}, checks every ${
		settings.autoResumeCheckIntervalHours
	}h, gives up after ${settings.autoResumeGiveUpDays}d`;
}

/** The prompt section: everything, names and redacted messages included. */
export function formatLiveDiagnosisForPrompt(diagnosis: FeedbackLiveDiagnosis): string {
	if (!diagnosis.rendererAvailable && diagnosis.recentProblems.length === 0) {
		return 'Not available (the app window did not answer). Use `maestro-cli` and the log instead.';
	}
	const lines: string[] = [];
	if (diagnosis.rendererAvailable) {
		lines.push(
			`${diagnosis.agentCount} agent(s); ${diagnosis.agents.length} with something notable (busy, errored, paused, retrying, queued, or running Auto Run). The rest are idle and healthy.`
		);
		for (const agent of diagnosis.agents) {
			lines.push(...describeAgent(agent, `"${agent.name}"`, true));
		}
		if (diagnosis.settings) lines.push(`- ${describeSettings(diagnosis.settings)}`);
	} else {
		lines.push('Agent state: not available (the app window did not answer).');
	}
	if (diagnosis.recentProblems.length > 0) {
		lines.push('', 'Recent warnings and errors (redacted, oldest first):');
		for (const line of diagnosis.recentProblems) {
			const time = new Date(line.timestamp).toISOString();
			lines.push(
				`- ${time} ${line.level.toUpperCase()}${line.context ? ` [${line.context}]` : ''} ${line.message}`
			);
		}
	}
	return lines.join('\n');
}

/**
 * The public issue section: no names, no messages, no paths - providers,
 * states, error types, counters, and ages only. Empty when nothing is notable,
 * so a feature request does not grow a diagnostics block.
 */
export function formatLiveDiagnosisForIssue(diagnosis: FeedbackLiveDiagnosis): string {
	if (!diagnosis.rendererAvailable || diagnosis.agents.length === 0) return '';
	const lines = [
		`Captured by the app when the issue was filed. ${diagnosis.agentCount} agent(s), ${diagnosis.agents.length} notable:`,
	];
	diagnosis.agents.forEach((agent, i) => {
		lines.push(...describeAgent(agent, `Agent ${i + 1}`, false));
	});
	if (diagnosis.settings) lines.push(`- ${describeSettings(diagnosis.settings)}`);
	return lines.join('\n');
}
