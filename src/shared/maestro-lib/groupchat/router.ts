/**
 * @file groupchat/router.ts
 * @description The group chat engine: message routing for the Group Chat feature.
 *
 * Routes messages between:
 * - User -> Moderator
 * - Moderator -> Participants (via @mentions)
 * - Participants -> Moderator
 *
 * It also owns the round's progression. Nothing in here waits for a turn: a
 * surface reports each finished turn through `turnEnded`, and the engine decides
 * what comes next (route the moderator's text, mark a participant, start the
 * synthesis). The desktop reports from its process exit listener; the headless
 * runtime reports from the outcome of the turn it ran.
 *
 * Everything the engine reaches outside itself for is an input (`GroupChatEngineOptions`):
 * storage, the UI event sink, the agent directory, prompts, the power block, and
 * the turn clock. Per call, a `GroupChatLauncher` says how to start a turn.
 * No Electron, and nothing from `src/main`, `src/renderer`, or `src/cli`.
 */

import * as os from 'os';
import * as path from 'path';
import { createIdleWatchdog, type IdleWatchdog } from '../control/idle-watchdog';
import {
	type GroupChatHistoryEntry,
	type GroupChatMessage as GroupChatRoomMessage,
	GROUP_CHAT_USER_NAME,
	extractAllMentions,
	findUniqueMentionMatch,
	getMentionNameForContext,
	getMentionMatchPriority,
	stripUnmatchedTrailingClosers,
	normalizeMentionName,
	requiresIdleParticipants,
	stripMarkdownFormatting,
} from '../../group-chat-types';
import { FALLBACK_CONTEXT_WINDOW } from '../../agentConstants';
import { getClaudeTokenMode } from '../../claudeTokenMode';
import type { UsageStats } from '../../types';
import { buildAgentArgs, applyAgentConfigOverrides } from '../launch/agent-args';
import { calculateContextTokens } from '../parsers/usage-aggregator';
import { logger, captureException } from '../host';
import { appendToLog, readLog, saveImage } from './log';
import { createGroupChatModerators, type GroupChatProcessControl } from './moderator';
import { createGroupChatParticipants } from './participants';
import { createSessionRecovery, needsSessionRecovery } from './session-recovery';
import {
	GROUP_CHAT_PREFIX,
	REGEX_MODERATOR_SESSION_TIMESTAMP,
	parseModeratorSessionId,
	parseParticipantSessionId,
} from './session-ids';
import { extractFirstSentence, type GroupChatStore } from './storage';
import { GROUP_CHAT_MODERATOR_NAME, resolveGroupChatTurnKey } from './turn-metrics';
import type { GroupChatTurnMetrics } from './turn-metrics';
import type {
	GroupChatAgentDirectory,
	GroupChatEventSink,
	GroupChatLauncher,
	GroupChatParticipant,
	GroupChatPromptId,
	GroupChatSessionInfo,
	GroupChatTurnEnd,
	GroupChatTurnRunner,
} from './types';

export type { GroupChatSessionInfo } from './types';

const LOG_CONTEXT = '[GroupChatRouter]';

/**
 * Non-customizable protocol that connects moderator text to actual participant
 * processes. Keep this in the runtime prompt builder rather than the bundled
 * moderator prompt: users may have an older customized prompt, but routing still
 * depends on literal @mentions in every version.
 */
const MODERATOR_ROUTING_PROTOCOL = `## Required Routing Protocol

Participant work starts only when your response contains a literal \`@AgentName\` token matching a name in Current Participants. Describing a handoff in prose does not start an agent.

- If you want a participant to act now, include that participant's exact \`@AgentName\` and an actionable request in this response.
- Never claim that work was assigned, dispatched, addressed, or started unless the same response contains the matching \`@AgentName\`. Without it, zero participant processes start.
- When the user explicitly @mentions participants and asks them to work, relay an actionable request to each intended participant with its exact \`@AgentName\`. Do not merely acknowledge the assignments.
- If you are returning a final answer to the user, use no participant @mentions.

Before responding, verify that every participant you claim is working has a literal matching @mention in your response.`;

function isModeratorInactiveAutoAddRace(error: unknown, groupChatId: string): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.message ===
		`Moderator must be active before adding participants to group chat: ${groupChatId}`
	);
}

/**

 *
 * This is a silence budget, not a duration cap: it is restarted by every chunk
 * the participant emits (see `noteGroupChatActivity`). It used to be a plain
 * wall-clock timer armed at dispatch, which cannot tell a working agent from a
 * wedged one - a participant was declared dead at the ten-minute mark while its
 * transcript showed 19-41 events per minute straight through the cutoff, and the
 * room was told nothing had been implemented while the process went on to commit
 * four changes and start a push.
 *
 * It is also the value forwarded to maestro-p as `--max-wait`, which is itself an
 * idle budget - so the router's supervision and the wrapper's now agree in KIND
 * as well as in number. They did not before.
 */
const PARTICIPANT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Absolute ceiling on one participant turn, regardless of how chatty it is
 * (30 minutes). A participant stuck in a tool loop emits output forever and can
 * never satisfy the idle budget, so silence alone cannot bound the run. Same
 * split, and the same value, as a cross-agent consult.
 */
const PARTICIPANT_MAX_DURATION_MS = 30 * 60 * 1000;

/** How long the moderator may stay SILENT before it is treated as timed out (10 minutes). */
const MODERATOR_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

/** Absolute ceiling on one moderator turn (30 minutes). See PARTICIPANT_MAX_DURATION_MS. */
const MODERATOR_MAX_DURATION_MS = 30 * 60 * 1000;

interface PendingExplicitParticipantHandoff {
	message: string;
	participantNames: string[];
	readOnly: boolean;
	savedImageFilenames?: string[];
	retryAttempted: boolean;
}

interface ModeratorRoutingRetry {
	previousResponse: string;
	participantNames: string[];
	savedImageFilenames?: string[];
}

/**
 * Extracts @mentions from text that match known participants.
 * Supports hyphenated names matching participants with spaces.
 * Handles markdown-formatted mentions (e.g. **@name**, _@name_).
 *
 * @param text - The text to search for mentions
 * @param participants - List of valid participants
 * @returns Array of participant names that were mentioned (using original names, not hyphenated)
 */
export function extractMentions(text: string, participants: GroupChatParticipant[]): string[] {
	const mentions: string[] = [];
	for (const mentionedName of extractAllMentions(text)) {
		const matchingParticipant = findUniqueMentionMatch(mentionedName, participants, (p) => p.name);
		if (matchingParticipant && !mentions.includes(matchingParticipant.name)) {
			mentions.push(matchingParticipant.name);
		}
	}
	return mentions;
}

export function findSessionForParticipantName(
	participantName: string,
	sessions: readonly GroupChatSessionInfo[]
): GroupChatSessionInfo | undefined {
	// This receives a persisted participant name, not a user-typed mention, so it
	// must match the originating session conservatively. Priority-1 ("safe folded")
	// matches collapse bracket styles (e.g. "Review Bot [Linux]" vs
	// "Review Bot (Linux)") and could borrow the wrong session's cwd / custom args /
	// SSH config. Only accept exact (4), legacy (3), or safe-normalized (2) matches,
	// and bail on ties so an ambiguous lookup never silently picks one.
	let bestPriority = 0;
	let bestMatches: GroupChatSessionInfo[] = [];

	for (const session of sessions) {
		const priority = getMentionMatchPriority(participantName, session.name);
		if (priority < 2) continue;

		if (priority > bestPriority) {
			bestPriority = priority;
			bestMatches = [session];
			continue;
		}

		if (priority === bestPriority) {
			bestMatches.push(session);
		}
	}

	return bestMatches.length === 1 ? bestMatches[0] : undefined;
}

/**
 * Resolve a moderator/user @mention to the session that should be auto-added.
 *
 * Resolves against existing participants AND available (non-terminal) sessions
 * together so a weak (safe-folded) participant match can't shadow a stronger
 * (exact/legacy) session match, e.g. an existing "Review Bot [Linux]"
 * participant must not block auto-adding a mentioned "Review Bot (Linux)"
 * session. Returns the session to add, or undefined when the mention is already
 * an existing participant or resolves ambiguously (a tie refuses to route).
 */
function resolveSessionToAutoAdd(
	mentionedName: string,
	existingParticipantNames: ReadonlySet<string>,
	sessions: readonly GroupChatSessionInfo[]
): GroupChatSessionInfo | undefined {
	type Candidate = { name: string; session: GroupChatSessionInfo | null };
	const candidates: Candidate[] = [
		...Array.from(existingParticipantNames, (name): Candidate => ({ name, session: null })),
		...sessions
			.filter((s) => s.toolType !== 'terminal')
			.map((s): Candidate => ({ name: s.name, session: s })),
	];
	const best = findUniqueMentionMatch(mentionedName, candidates, (c) => c.name);
	return best?.session ?? undefined;
}

// Re-exported for existing callers; the parser lives in shared so the CLI/web
// start path mentions agents exactly the way this router reads them.
export { extractAllMentions };

/**
 * Extracts !autorun directives from moderator output.
 * Matches `!autorun @AgentName` patterns.
 *
 * @param text - The moderator's message text
 * @returns Object with autorun participant names and cleaned message text
 */
export interface AutoRunDirective {
	participantName: string;
	/** Specific filename to run, if specified (e.g. `!autorun @Agent:plan.md`). When present,
	 *  only that document is executed instead of all docs in the folder. */
	filename?: string;
}

export function extractAutoRunDirectives(text: string): {
	autoRunDirectives: AutoRunDirective[];
	/** @deprecated use autoRunDirectives */
	autoRunParticipants: string[];
	cleanedText: string;
} {
	const autoRunDirectives: AutoRunDirective[] = [];
	// Matches: !autorun @AgentName  OR  !autorun @AgentName:filename.md
	const autoRunPattern = /!autorun\s+@([^\s@:,;!?'"<>]+)(?::([^\s,;!?'"<>]+))?/g;
	let match;

	while ((match = autoRunPattern.exec(text)) !== null) {
		const participantName = stripMarkdownFormatting(match[1]);
		if (!participantName) continue;
		// Trim unmatched trailing closers so a directive wrapped in punctuation,
		// e.g. "(!autorun @Agent:plan.md)", yields "plan.md" not "plan.md)" while
		// balanced brackets in names like "Phase-01-(Setup).md" are preserved.
		const filename = match[2] ? stripUnmatchedTrailingClosers(match[2]) || undefined : undefined;
		if (!autoRunDirectives.some((d) => d.participantName === participantName)) {
			autoRunDirectives.push({ participantName, filename });
		}
	}

	// Remove !autorun lines from the message for display
	const cleanedText = text
		.replace(/^.*!autorun\s+@[^\s@:,;!?'"<>]+.*$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return {
		autoRunDirectives,
		autoRunParticipants: autoRunDirectives.map((d) => d.participantName),
		cleanedText,
	};
}

/**
 * Whether a delegation to this agent has to wait because the agent is already
 * working somewhere else.
 *
 * A group chat participant runs as its own process in the AGENT'S working
 * directory, so delegating to an agent the user is talking to directly puts two
 * writers in one repo. `requireIdleParticipants` (on by default) trades a
 * delayed turn for that collision; turning it off is the deliberate override.
 *
 * An agent with no matching Maestro agent can't be probed and is never blocked -
 * "unknown" must not read as "busy", or a participant whose agent was renamed
 * would become permanently unreachable.
 */
function isDelegationBlockedByBusyAgent(
	chat: { requireIdleParticipants?: boolean },
	matchingSession: GroupChatSessionInfo | undefined
): boolean {
	if (!requiresIdleParticipants(chat)) return false;
	return matchingSession?.isBusy === true;
}

/** How often a queued delegation re-checks whether its agent has gone idle. */
const QUEUED_DELEGATION_POLL_MS = 5 * 1000;

/**
 * How long a queued delegation waits for its agent before giving up. Long
 * enough to outlast an ordinary turn the user is having with that agent, short
 * enough that a room can't sit on 'agent-working' forever behind an agent that
 * is wedged.
 */
const QUEUED_DELEGATION_MAX_WAIT_MS = 15 * 60 * 1000;

/** The part of a runner a timeout needs: it only ever stops a turn. */
type TurnStopper = Pick<GroupChatTurnRunner, 'stop'>;

/**
 * True when routing a participant's response failed only because the group chat
 * no longer exists.
 *
 * Participants keep running after the user deletes their group chat, so the exit
 * that fires minutes later routes into a chat `loadGroupChat` can no longer
 * find. That is an expected outcome of a normal user action rather than a defect
 * worth reporting (MAESTRO-M4). Any other routing failure still reaches Sentry.
 */
export function isDeletedGroupChatFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return /^Group chat not found: /i.test(message);
}

/** What the engine is built over. */
export interface GroupChatEngineOptions {
	/** Chat storage. Only the functions the engine calls are required. */
	store: Pick<
		GroupChatStore,
		| 'loadGroupChat'
		| 'updateGroupChat'
		| 'updateParticipant'
		| 'addParticipantToChat'
		| 'removeParticipantFromChatWithResult'
		| 'getParticipant'
		| 'addGroupChatHistoryEntry'
		| 'getGroupChatDir'
	>;
	/** Where UI updates go. Called synchronously and may drop an update the host does not render. */
	events: GroupChatEventSink;
	/** Agents, their settings, and the host's SSH setup. */
	agents: GroupChatAgentDirectory;
	/** The prompt templates a round reads. Throws for an id that does not load. */
	prompts: { get(id: GroupChatPromptId): string };
	/** The sleep-block a running round holds. A host with no sleep blocker passes no-ops. */
	power: { block(reason: string): void; unblock(reason: string): void };
	/** The per-turn clock and usage ledger. The desktop and the runtime each build their own. */
	metrics: GroupChatTurnMetrics;
	/** Id for a new participant record. Defaults to a random UUID. */
	newId?: () => string;
}

/**
 * Creates one group chat engine. Everything that used to be module state in the
 * desktop's router (pending participants, watchdogs, the moderator registry,
 * the delegation queue) is instance state here, so a test or a second host gets
 * its own.
 */
export function createGroupChatEngine(options: GroupChatEngineOptions) {
	const { store, events, agents, prompts, power, metrics } = options;
	const { loadGroupChat, updateParticipant, addGroupChatHistoryEntry, getGroupChatDir } = store;

	const moderators = createGroupChatModerators({ store, prompts, power });
	const {
		getModeratorSessionId,
		isModeratorActive,
		getModeratorSystemPrompt,
		getModeratorSynthesisPrompt,
	} = moderators;
	const participantRegistry = createGroupChatParticipants({
		store,
		prompts,
		isModeratorActive,
		newId: options.newId,
	});
	const {
		addParticipant,
		setActiveParticipantSession,
		clearActiveParticipantSession,
		getParticipantSessionId,
		wasParticipantRecentlyRemoved,
	} = participantRegistry;
	const recovery = createSessionRecovery({ store });

	/**
	 * The moderator turn that is running for each chat, by its FULL process id and the
	 * runner that started it. The registry's `getModeratorSessionId` returns the per-chat
	 * PREFIX every turn appends a timestamp to, and a runner stops exact ids only, so
	 * stopping a moderator by the prefix kills nothing. This is what Stop kills.
	 */
	const runningModeratorTurns = new Map<string, { processId: string; runner: TurnStopper }>();

	/**
	 * Moderator turns that were stopped on purpose. The process exits and is reported
	 * like any other; its output is nobody's answer, so the report is dropped rather
	 * than routed (a stopped turn would otherwise dispatch participants after Stop).
	 */
	const stoppedModeratorTurns = new Set<string>();

	/**
	 * Tracks pending participant responses for each group chat.
	 * When all pending participants have responded, we spawn a moderator synthesis round.
	 * Maps groupChatId -> Set<participantName>
	 */
	const pendingParticipantResponses = new Map<string, Set<string>>();

	/**
	 * Tracks group chats whose next moderator turn is a synthesis round (the moderator
	 * summarizing participant responses). Set when a synthesis process is spawned and
	 * consumed when its output routes back through routeModeratorResponse, so that turn's
	 * history entry is classified as 'synthesis' rather than a regular moderator response.
	 * The moderator runs single-threaded per chat, so a plain groupChatId flag is safe.
	 */
	const pendingSynthesisRounds = new Set<string>();

	/**
	 * Writes a group chat history entry and emits it to the renderer. Centralizes the
	 * add + emit + failure-handling pattern shared by the moderator, participant, and
	 * error history-record sites. History logging is best-effort: a failure here is
	 * reported but never thrown, so it can't break the message flow.
	 *
	 * The entry also closes out the turn's measurement here rather than at each
	 * call site: this is the one place every finished turn passes through, and the
	 * duration and token totals a chat reports are only as complete as the entries
	 * that carry them. Values already on the entry win, so a caller that measured
	 * something itself is never overwritten.
	 */
	async function recordGroupChatHistory(
		groupChatId: string,
		entry: Omit<GroupChatHistoryEntry, 'id'>
	): Promise<void> {
		try {
			const measured = metrics.finish(groupChatId, entry.participantName);
			const historyEntry = await addGroupChatHistoryEntry(groupChatId, {
				...measured,
				...entry,
			});
			events.historyEntry(groupChatId, historyEntry);
			logger.debug(
				`[GroupChatRouter] Added ${entry.type} history entry for ${entry.participantName}: ${entry.summary.substring(0, 50)}...`
			);
		} catch (error) {
			logger.error(`Failed to add history entry for ${entry.participantName}`, LOG_CONTEXT, {
				error,
				groupChatId,
			});
			captureException(error, {
				operation: 'groupChat:addHistory',
				participantName: entry.participantName,
				groupChatId,
			});
			// Don't throw - history logging failure shouldn't break the message flow
		}
	}

	/**
 * Tracks which participants in each group chat were triggered via !autorun directives.
 * Used to gate emitAutoRunBatchComplete so it only fires for autorun participants,

 * Maps groupChatId -> Set<participantName>
 */
	const autoRunParticipantTracker = new Map<string, Set<string>>();

	/**
	 * Tracks per-participant silence budgets.
	 * Maps `${groupChatId}:${participantName}` -> IdleWatchdog
	 * Fires if a participant goes quiet for too long (hung process, lost IPC, etc.)
	 */
	const participantTimeouts = new Map<string, IdleWatchdog>();

	/**
	 * Tracks per-group-chat moderator silence budgets.
	 * Maps groupChatId -> IdleWatchdog
	 * Fires if the moderator process goes quiet and never exits (hang, API stall, etc.)
	 */
	const moderatorTimeouts = new Map<string, IdleWatchdog>();

	/**
	 * Records proof of life for whichever moderator or participant owns `sessionId`,
	 * restarting its silence budget.
	 *
	 * Called by whichever surface already sees every chunk a group chat process emits
	 * (the desktop's liveness listener, a runtime runner on each parsed event) and can
	 * resolve a session id back to a room. Routing liveness through it rather than attaching listeners
	 * here keeps the runner a start/stop interface: the engine never needed to
	 * observe output, and widening it to an EventEmitter for this would put a second
	 * output path beside the buffering one.
	 *
	 * Unknown or non-group-chat session ids are ignored, so the caller can hand over
	 * every chunk it sees without pre-filtering.
	 */
	function noteGroupChatActivity(sessionId: string): void {
		const key = resolveGroupChatTurnKey(sessionId);
		if (!key) return;
		if (key.participantName === GROUP_CHAT_MODERATOR_NAME) {
			moderatorTimeouts.get(key.groupChatId)?.touch();
			return;
		}
		participantTimeouts
			.get(getParticipantTimeoutKey(key.groupChatId, key.participantName))
			?.touch();
	}

	/**
	 * Puts a room back to rest: clears the running state and releases its power
	 * block. These two always belong together - a room left non-idle is reported as
	 * a running chat by `collectActiveOperations` (so quitting warns about work that
	 * finished, and Quit When Idle never fires again), and a leaked power block
	 * keeps the machine awake for the same phantom.
	 *
	 * Every path that decides the room is done goes through here, so no idle
	 * transition can fix half the bug by emitting the state change and leaving the
	 * block held.
	 */
	function settleGroupChatToIdle(groupChatId: string): void {
		events.stateChange(groupChatId, 'idle');
		power.unblock(`groupchat:${groupChatId}`);
	}

	/**
	 * Registers a silence budget for the moderator.
	 * If the moderator goes quiet for MODERATOR_RESPONSE_TIMEOUT_MS (or runs past
	 * MODERATOR_MAX_DURATION_MS while still talking), its process is killed and the
	 * state is force-reset to idle so the chat doesn't hang forever.
	 */
	function setModeratorResponseTimeout(
		groupChatId: string,
		runner?: TurnStopper,
		sessionId?: string
	): void {
		clearModeratorResponseTimeout(groupChatId);

		const giveUp = (reason: string, budgetMs: number): void => {
			moderatorTimeouts.delete(groupChatId);
			console.warn(
				`[GroupChat:Debug] Moderator ${reason} after ${budgetMs / 1000}s for ${groupChatId} - killing and resetting to idle`
			);
			logger.warn('[GroupChat] Moderator timed out - resetting to idle', LOG_CONTEXT, {
				groupChatId,
				reason,
				timeoutMs: budgetMs,
			});

			// Kill before reporting. A timeout that only changes Maestro's state
			// leaves the process running with write access: the room is told the turn
			// failed while the agent it gave up on keeps editing files, committing,
			// and pushing. Reporting a failure and leaving the cause running is worse
			// than either outcome alone.
			// The FULL spawned session id, not `getModeratorSessionId`, which returns the
			// per-chat PREFIX (`group-chat-<id>-moderator`) that every turn appends a
			// timestamp to. ProcessManager.kill looks its map up by exact key, so the
			// prefix silently kills nothing and the timeout goes back to being a report
			// with no teeth.
			killTimedOutSession(sessionId, runner, 'moderator');
			runningModeratorTurns.delete(groupChatId);

			events.message(groupChatId, {
				timestamp: new Date().toISOString(),
				from: 'system',
				content: `⚠️ Moderator ${reason} after ${budgetMs / 60000} minutes and was stopped. Resetting to idle. You can send another message to retry.`,
			});

			events.stateChange(groupChatId, 'idle');
			power.unblock(`groupchat:${groupChatId}`);
		};

		moderatorTimeouts.set(
			groupChatId,
			createIdleWatchdog({
				idleMs: MODERATOR_RESPONSE_TIMEOUT_MS,
				maxMs: MODERATOR_MAX_DURATION_MS,
				onIdle: () => giveUp('went silent', MODERATOR_RESPONSE_TIMEOUT_MS),
				onMax: () => giveUp('exceeded the single-turn limit', MODERATOR_MAX_DURATION_MS),
			})
		);
	}

	/**
	 * Cancels the moderator response timeout (called when the moderator process exits).
	 */
	function clearModeratorResponseTimeout(groupChatId: string): void {
		const watchdog = moderatorTimeouts.get(groupChatId);
		if (watchdog) {
			watchdog.disarm();
			moderatorTimeouts.delete(groupChatId);
		}
	}

	/**
	 * Kills the process behind a turn we have just given up on.
	 *
	 * Best-effort by design: the session may already be gone (that is the ordinary
	 * case for a genuinely dead process), and a kill that throws must not stop the
	 * room from settling back to idle - a timeout whose cleanup half-ran is how a
	 * chat ends up permanently stuck on 'agent-working'.
	 */
	function killTimedOutSession(
		sessionId: string | undefined,
		runner: TurnStopper | undefined,
		label: string
	): void {
		if (!sessionId || !runner) return;
		try {
			runner.stop(sessionId);
		} catch (err) {
			logger.warn(`[GroupChat] Failed to kill timed-out ${label} process`, LOG_CONTEXT, {
				sessionId,
				error: err,
			});
		}
	}

	function getParticipantTimeoutKey(groupChatId: string, participantName: string): string {
		return `${groupChatId}:${participantName}`;
	}

	/**
	 * Registers a silence budget for a participant.
	 * If the participant goes quiet for PARTICIPANT_RESPONSE_TIMEOUT_MS (or runs past
	 * PARTICIPANT_MAX_DURATION_MS while still talking), its process is killed and it is
	 * force-marked as responded so synthesis can proceed and the chat doesn't hang forever.
	 */
	function setParticipantResponseTimeout(
		groupChatId: string,
		participantName: string,
		launcher: GroupChatLauncher | undefined
	): void {
		const key = getParticipantTimeoutKey(groupChatId, participantName);
		// Clear any existing budget for this participant
		participantTimeouts.get(key)?.disarm();

		const giveUp = async (reason: string, budgetMs: number): Promise<void> => {
			participantTimeouts.delete(key);
			const pending = pendingParticipantResponses.get(groupChatId);
			if (!pending?.has(participantName)) return; // Already responded

			console.warn(
				`[GroupChat:Debug] Participant ${participantName} ${reason} after ${budgetMs / 1000}s - killing and force-completing`
			);

			// Kill before reporting - see killTimedOutSession. An Auto Run participant
			// has no group-chat process of its own (the renderer drives the batch under
			// the agent's own session), so there is nothing to kill and nothing is: we
			// must never take down the user's actual agent to settle a room.
			killTimedOutSession(
				getParticipantSessionId(groupChatId, participantName),
				launcher?.runner,
				`participant ${participantName}`
			);

			events.message(groupChatId, {
				timestamp: new Date().toISOString(),
				from: 'system',
				content: `⚠️ @${participantName} ${reason} after ${budgetMs / 60000} minutes and was stopped.`,
			});

			// Log a timeout response so the moderator knows what happened
			try {
				const chat = await loadGroupChat(groupChatId);
				if (chat) {
					await appendToLog(
						chat.logPath,
						participantName,
						`[Stopped - ${reason} after ${budgetMs / 60000} minutes]`
					);
				}
			} catch (err) {
				// Non-critical - synthesize anyway, but log and report so we can diagnose
				logger.error('Failed to log timeout response', LOG_CONTEXT, {
					groupChatId,
					participantName,
					error: err,
				});
				captureException(err, {
					operation: 'groupChat:logTimeoutResponse',
					groupChatId,
					participantName,
				});
			}

			// Reset participant state and force-complete the batch so the AUTO badge
			// and progress bar clear immediately - the batch loop may still be awaiting
			// a process exit that will never come.
			events.participantState(groupChatId, participantName, 'idle');
			// Only emit batch-complete for participants triggered via !autorun, not normal @mentions
			const autoRunSet = autoRunParticipantTracker.get(groupChatId);
			if (autoRunSet?.has(participantName)) {
				events.autoRunBatchComplete(groupChatId, participantName);
				autoRunSet.delete(participantName);
				if (autoRunSet.size === 0) autoRunParticipantTracker.delete(groupChatId);
			}

			// Same close-out as a normal reply, via the shared helper: a timed-out
			// participant still has to leave the pending set, or the room waits forever
			// on a turn that is already over.
			finishParticipantTurn(
				groupChatId,
				participantName,
				launcher,
				'groupChat:spawnSynthesisAfterTimeout'
			);
		};

		// The watchdog's callbacks are sync; `giveUp` is async because it appends to
		// the chat log. A rejection here can only come from the settle path itself, so
		// it is reported rather than left as an unhandled rejection.
		const fire = (reason: string, budgetMs: number): void => {
			giveUp(reason, budgetMs).catch((err) => {
				logger.error('Participant timeout handler failed', LOG_CONTEXT, {
					groupChatId,
					participantName,
					error: err,
				});
				captureException(err, {
					operation: 'groupChat:participantTimeout',
					groupChatId,
					participantName,
				});
				settleGroupChatToIdle(groupChatId);
			});
		};

		participantTimeouts.set(
			key,
			createIdleWatchdog({
				idleMs: PARTICIPANT_RESPONSE_TIMEOUT_MS,
				maxMs: PARTICIPANT_MAX_DURATION_MS,
				onIdle: () => fire('went silent', PARTICIPANT_RESPONSE_TIMEOUT_MS),
				onMax: () => fire('exceeded the single-turn limit', PARTICIPANT_MAX_DURATION_MS),
			})
		);
	}

	/**
	 * Cancels the response timeout for a participant (called when they do respond).
	 */
	function clearParticipantResponseTimeout(groupChatId: string, participantName: string): void {
		const key = getParticipantTimeoutKey(groupChatId, participantName);
		const watchdog = participantTimeouts.get(key);
		if (watchdog) {
			watchdog.disarm();
			participantTimeouts.delete(key);
		}
	}

	/**
	 * Tracks read-only mode state for each group chat.
	 * Set when user sends a message with readOnly flag, cleared on next non-readOnly message.
	 * Maps groupChatId -> boolean
	 */
	const groupChatReadOnlyState = new Map<string, boolean>();

	/**
	 * User turns that explicitly addressed one or more participants. The moderator
	 * must produce an executable handoff for every addressed participant before its
	 * response can be presented as final. One incomplete response gets a correction
	 * turn; a second is rejected with an explicit system error.
	 */
	const pendingExplicitParticipantHandoffs = new Map<string, PendingExplicitParticipantHandoff>();

	/**
	 * Gets the current read-only state for a group chat.
	 */
	function getGroupChatReadOnlyState(groupChatId: string): boolean {
		return groupChatReadOnlyState.get(groupChatId) ?? false;
	}

	/**
	 * Sets the read-only state for a group chat.
	 */
	function setGroupChatReadOnlyState(groupChatId: string, readOnly: boolean): void {
		groupChatReadOnlyState.set(groupChatId, readOnly);
	}

	/**
	 * Clears all pending participants for a group chat (and their timeouts).
	 */
	function clearPendingParticipants(groupChatId: string): void {
		// Stop anything still waiting for a busy agent first: a waiter that wakes up
		// after the pending set is gone would deliver work into a stopped chat.
		cancelQueuedDelegations(groupChatId);
		// Cancel all timeouts for this chat before clearing
		const pending = pendingParticipantResponses.get(groupChatId);
		if (pending) {
			for (const name of pending) {
				clearParticipantResponseTimeout(groupChatId, name);
			}
		}
		pendingParticipantResponses.delete(groupChatId);
		autoRunParticipantTracker.delete(groupChatId);
		pendingExplicitParticipantHandoffs.delete(groupChatId);
	}

	/**
	 * Clears the active task session tracked for a participant.
	 */
	function clearActiveParticipantTaskSession(groupChatId: string, participantName: string): void {
		clearActiveParticipantSession(groupChatId, participantName);
	}

	/**
	 * Marks a participant as having responded (removes from pending, cancels timeout).
	 * Returns true if this was the last pending participant.
	 */
	function markParticipantResponded(groupChatId: string, participantName: string): boolean {
		clearParticipantResponseTimeout(groupChatId, participantName);

		// Clean up autorun tracking for this participant
		const autoRunSet = autoRunParticipantTracker.get(groupChatId);
		if (autoRunSet?.delete(participantName) && autoRunSet.size === 0) {
			autoRunParticipantTracker.delete(groupChatId);
		}

		const pending = pendingParticipantResponses.get(groupChatId);
		if (!pending) return false;

		pending.delete(participantName);

		if (pending.size === 0) {
			pendingParticipantResponses.delete(groupChatId);
			return true; // Last participant responded
		}
		return false;
	}

	/**
	 * Routes a user message to the moderator.
	 *
	 * Spawns a batch process for the moderator to handle this specific message.
	 * The chat history is included in the system prompt for context.
	 *
	 * @param groupChatId - The ID of the group chat
	 * @param message - The message from the user
	 * @param launcher - How to start the moderator's turn (optional; absent logs the message and starts nothing)
	 * @param readOnly - Optional flag indicating read-only mode
	 */
	async function routeUserMessage(
		groupChatId: string,
		message: string,
		launcher?: GroupChatLauncher,
		readOnly?: boolean,
		images?: string[],
		routingRetry?: ModeratorRoutingRetry
	): Promise<void> {
		logger.debug(`[GroupChat:Debug] ========== ROUTE USER MESSAGE ==========`);
		logger.debug(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
		logger.debug(`[GroupChat:Debug] Message length: ${message.length}`);
		logger.debug(`[GroupChat:Debug] Read-only: ${readOnly ?? false}`);
		logger.debug(`[GroupChat:Debug] Has launcher: ${!!launcher}`);

		let chat = await loadGroupChat(groupChatId);
		if (!chat) {
			logger.debug(`[GroupChat:Debug] ERROR: Group chat not found!`);
			throw new Error(`Group chat not found: ${groupChatId}`);
		}

		logger.debug(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);
		logger.debug(
			`[GroupChat:Debug] Current participants: ${chat.participants.map((p) => p.name).join(', ') || '(none)'}`
		);
		logger.debug(`[GroupChat:Debug] Moderator Agent ID: ${chat.moderatorAgentId}`);

		if (!isModeratorActive(groupChatId)) {
			logger.debug(`[GroupChat:Debug] ERROR: Moderator is not active!`);
			throw new Error(`Moderator is not active for group chat: ${groupChatId}`);
		}

		logger.debug(`[GroupChat:Debug] Moderator is active: true`);

		// Auto-add participants mentioned by the user if they match available sessions.
		// A routing retry reuses the already-resolved participant set and must not
		// reinterpret its correction prompt as a new user turn.
		if (!routingRetry && launcher) {
			const userMentions = extractAllMentions(message);
			const sessions = agents.list();
			const existingParticipantNames = new Set(chat.participants.map((p) => p.name));

			for (const mentionedName of userMentions) {
				// Resolve against existing participants AND available sessions together
				// so a weak participant match can't shadow a stronger session match.
				// Returns undefined when the mention is already a participant or
				// resolves ambiguously.
				const matchingSession = resolveSessionToAutoAdd(
					mentionedName,
					existingParticipantNames,
					sessions
				);

				if (matchingSession) {
					try {
						// Use the original session name as the participant name
						const participantName = matchingSession.name;
						logger.debug(
							`[GroupChatRouter] Auto-adding participant @${participantName} from user mention @${mentionedName} (session ${matchingSession.id})`
						);
						await addParticipant(groupChatId, participantName, matchingSession.toolType, {
							customModel: matchingSession.customModel,
							customArgs: matchingSession.customArgs,
							customEnvVars: matchingSession.customEnvVars,
							sshRemoteName: matchingSession.sshRemoteName,
							sshRemoteConfig: matchingSession.sshRemoteConfig,
						});
						existingParticipantNames.add(participantName);

						// Emit participant changed event so UI updates
						const updatedChatForEmit = await loadGroupChat(groupChatId);
						if (updatedChatForEmit) {
							events.participantsChanged(groupChatId, updatedChatForEmit.participants);
						}
					} catch (error) {
						if (isModeratorInactiveAutoAddRace(error, groupChatId)) {
							logger.warn(
								`Skipped auto-adding participant ${mentionedName}: moderator is no longer active`,
								LOG_CONTEXT,
								{ groupChatId }
							);
							continue;
						}
						logger.error(
							`Failed to auto-add participant ${mentionedName} from user mention`,
							LOG_CONTEXT,
							{ error, groupChatId }
						);
						captureException(error, {
							operation: 'groupChat:autoAddParticipant',
							participantName: mentionedName,
							groupChatId,
						});
						// Continue with other participants even if one fails
					}
				}
			}

			// Reload chat to get updated participants list
			chat = await loadGroupChat(groupChatId);
			if (!chat) {
				throw new Error(`Group chat not found after participant update: ${groupChatId}`);
			}
		}

		// Save images to disk and collect filenames for the log
		let savedImageFilenames = routingRetry?.savedImageFilenames;
		if (!routingRetry && images && images.length > 0) {
			savedImageFilenames = [];
			for (const dataUrl of images) {
				// Extract base64 data and extension from data URL
				const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
				if (match) {
					const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
					const buffer = Buffer.from(match[2], 'base64');
					const filename = await saveImage(chat.imagesDir, buffer, `image.${ext}`);
					savedImageFilenames.push(filename);
				}
			}
		}

		// Store the read-only state for this group chat so it can be propagated to participants
		setGroupChatReadOnlyState(groupChatId, readOnly ?? false);

		if (!routingRetry) {
			// Log the message as coming from user (with image filenames if any)
			await appendToLog(chat.logPath, 'user', message, readOnly, savedImageFilenames);

			// Emit message event to renderer so it shows immediately (with original data URLs for display)
			const userMessage: GroupChatRoomMessage = {
				timestamp: new Date().toISOString(),
				from: 'user',
				content: message,
				readOnly,
				...(images && images.length > 0 && { images }),
			};
			events.message(groupChatId, userMessage);

			// Record the prompt itself in history. Every other entry is something an
			// agent did in reaction to this line, so a history without it shows effects
			// with no causes - and the timestamp is what makes a click here jump the
			// transcript back to the message that started the round.
			await recordGroupChatHistory(groupChatId, {
				timestamp: Date.now(),
				summary: extractFirstSentence(message),
				participantName: GROUP_CHAT_USER_NAME,
				participantColor: '#808080',
				type: 'user',
				fullResponse: message,
			});

			const explicitParticipantNames = extractMentions(message, chat.participants);
			if (launcher && explicitParticipantNames.length > 0) {
				pendingExplicitParticipantHandoffs.set(groupChatId, {
					message,
					participantNames: explicitParticipantNames,
					readOnly: readOnly ?? false,
					savedImageFilenames,
					retryAttempted: false,
				});
			} else {
				pendingExplicitParticipantHandoffs.delete(groupChatId);
			}
		}

		// Spawn a batch process for the moderator to handle this message
		// The response will be captured via the process:data event handler in index.ts
		if (launcher) {
			logger.debug(`[GroupChat:Debug] Preparing to spawn moderator batch process...`);
			const sessionIdPrefix = getModeratorSessionId(groupChatId);
			logger.debug(`[GroupChat:Debug] Session ID prefix: ${sessionIdPrefix}`);

			if (sessionIdPrefix) {
				// Create a unique session ID for this message
				const sessionId = `${sessionIdPrefix}-${Date.now()}`;
				logger.debug(`[GroupChat:Debug] Generated full session ID: ${sessionId}`);

				// Resolve the agent configuration to get the executable command
				const agent = await launcher.resolveAgent(chat.moderatorAgentId);
				logger.debug(`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}`);
				logger.debug(`[GroupChat:Debug] Agent available: ${agent?.available ?? false}`);

				if (!agent || !agent.available) {
					logger.debug(`[GroupChat:Debug] ERROR: Agent not available!`);
					throw new Error(`Agent '${chat.moderatorAgentId}' is not available`);
				}

				// Use custom path from moderator config if set, otherwise use resolved path
				const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
				logger.debug(`[GroupChat:Debug] Command to execute: ${command}`);

				// Build participant context
				// Use normalized names (spaces → hyphens) so moderator can @mention them properly
				const participantNamesForMentions = chat.participants.map((p) => p.name);
				const participantContext =
					chat.participants.length > 0
						? chat.participants
								.map((p) => {
									return `- @${getMentionNameForContext(
										p.name,
										participantNamesForMentions
									)} (${p.agentId} session)`;
								})
								.join('\n')
						: '(No agents currently in this group chat)';

				// Build available sessions context (sessions that could be added)
				let availableSessionsContext = '';
				const sessions = agents.list();
				logger.debug(
					`[GroupChat:Debug] Available sessions from callback: ${sessions.map((s) => s.name).join(', ')}`
				);
				const participantNames = new Set(chat.participants.map((p) => p.name));
				const availableSessions = sessions.filter(
					(s) => s.toolType !== 'terminal' && !participantNames.has(s.name)
				);
				if (availableSessions.length > 0) {
					// Use normalized names (spaces → hyphens) so moderator can @mention them properly
					const availableSessionNamesForMentions = [
						...chat.participants.map((p) => p.name),
						...availableSessions.map((s) => s.name),
					];
					availableSessionsContext = `\n\n## Available Maestro Sessions (can be added via @mention):\n${availableSessions.map((s) => `- @${getMentionNameForContext(s.name, availableSessionNamesForMentions)} (${s.toolType})`).join('\n')}`;
				}

				// Build the prompt with context
				const chatHistory = await readLog(chat.logPath);
				logger.debug(`[GroupChat:Debug] Chat history entries: ${chatHistory.length}`);

				const historyContext = chatHistory
					.slice(-20)
					.map((m) => `[${m.from}]: ${m.content}`)
					.join('\n');

				// Build image context if user attached images
				let imageContext = '';
				if (savedImageFilenames && savedImageFilenames.length > 0) {
					const imagePaths = savedImageFilenames.map((f) => path.join(chat.imagesDir, f));
					imageContext = `\n\n## Attached Images (${savedImageFilenames.length}):\nThe user attached ${savedImageFilenames.length} image(s) to this message. The images are saved at:\n${imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}\nPlease read/view these images to understand the user's request. When delegating to agents, mention the image paths so they can view them too.`;
				}

				// Get moderator settings for prompt customization
				const moderatorSettings = { conductorProfile: agents.conductorProfile() };

				// Substitute {{CONDUCTOR_PROFILE}} template variable (global to catch all occurrences)
				const baseSystemPrompt = getModeratorSystemPrompt().replace(
					/\{\{CONDUCTOR_PROFILE\}\}/g,
					moderatorSettings.conductorProfile || '(No conductor profile set)'
				);

				const participantMentionNames = routingRetry?.participantNames.map((name) =>
					getMentionNameForContext(name, participantNamesForMentions)
				);
				const moderatorRequest = routingRetry
					? `## Routing Correction

Your previous response was rejected because it did not contain an executable @mention for every participant explicitly addressed by the user. No participant process started.

Participants explicitly addressed by the user: ${participantMentionNames?.map((name) => `@${name}`).join(', ')}

Reissue the handoff now with a literal matching @mention and an actionable request. Do not claim that work is assigned unless this response contains the mention that starts it.

Original user request:
${message}

Rejected response:
${routingRetry.previousResponse}`
					: message;

				const fullPrompt = `${baseSystemPrompt}

## Current Participants:
${participantContext}${availableSessionsContext}

${MODERATOR_ROUTING_PROTOCOL}

## Chat History:
${historyContext}

## User Request${readOnly ? ' (READ-ONLY MODE - do not make changes)' : ''}:
${moderatorRequest}${imageContext}

## Execution Mode:
${readOnly ? 'READ-ONLY MODE is active. You and all participants can only inspect, analyze, and plan - no file changes allowed.' : 'Participants have FULL READ-WRITE access and can create, modify, and delete files. You are in read-only/plan mode yourself, so delegate all file changes to participants. When the user asks for implementation, specs, or file creation, delegate those tasks to the appropriate participants - they can execute.'}`;

				// Get the base args from the agent configuration
				const args = [...agent.args];
				const agentConfigValues = agents.providerConfig(chat.moderatorAgentId);
				logger.debug(
					`[GroupChat:Debug] agentConfigValues for ${chat.moderatorAgentId}: ${JSON.stringify(agentConfigValues)}`
				);
				const baseArgs = buildAgentArgs(agent, {
					baseArgs: args,
					prompt: fullPrompt,
					cwd: os.homedir(),
					readOnlyMode: true,
				});
				const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
					agentConfigValues,
					sessionCustomModel: chat.moderatorConfig?.customModel,
					sessionCustomArgs: chat.moderatorConfig?.customArgs,
					sessionCustomEnvVars: chat.moderatorConfig?.customEnvVars,
					readOnlyMode: true,
				});

				// For Gemini CLI: only disable workspace sandbox when read-only mode is
				// CLI-enforced. Without hard read-only enforcement, removing the sandbox
				// would give the moderator unsandboxed write capability.
				// The CWD is already set to the group chat folder to avoid "path not in workspace" errors.
				const geminiCanBeUnsandboxed =
					chat.moderatorAgentId === 'gemini-cli' && !!agent.readOnlyCliEnforced;
				const geminiNoSandbox = geminiCanBeUnsandboxed ? ['--no-sandbox'] : [];
				const finalArgs = [...configResolution.args, ...geminiNoSandbox];
				logger.debug(`[GroupChat:Debug] Args: ${JSON.stringify(finalArgs)}`);

				logger.debug(`[GroupChat:Debug] Full prompt length: ${fullPrompt.length} chars`);
				logger.debug(`[GroupChat:Debug] ========== SPAWNING MODERATOR PROCESS ==========`);
				logger.debug(`[GroupChat:Debug] Session ID: ${sessionId}`);
				logger.debug(`[GroupChat:Debug] Tool Type: ${chat.moderatorAgentId}`);
				logger.debug(`[GroupChat:Debug] CWD: ${os.homedir()}`);
				logger.debug(`[GroupChat:Debug] Command: ${command}`);
				logger.debug(
					`[GroupChat:Debug] ReadOnly: true (moderator always read-only), participants readOnly: ${readOnly ?? false}`
				);

				// Spawn the moderator process in batch mode
				try {
					// Emit state change to show moderator is thinking
					events.stateChange(groupChatId, 'moderator-thinking');
					logger.debug(`[GroupChat:Debug] Emitted state change: moderator-thinking`);

					// Start moderator timeout to prevent indefinite hanging
					setModeratorResponseTimeout(groupChatId, launcher.runner, sessionId);
					// Remember the FULL id of the turn that is running: Stop has to kill it by
					// that id, never by the per-chat prefix `getModeratorSessionId` returns.
					runningModeratorTurns.set(groupChatId, { processId: sessionId, runner: launcher.runner });

					// Add power block reason to prevent sleep during group chat activity
					power.block(`groupchat:${groupChatId}`);

					const spawnResult = await launcher.runner.start({
						processId: sessionId,
						providerId: chat.moderatorAgentId,
						agent,
						command,
						args: finalArgs,
						cwd: os.homedir(),
						prompt: fullPrompt,
						customEnvVars:
							configResolution.effectiveCustomEnvVars ??
							agents.providerEnvVars(chat.moderatorAgentId),
						agentConfigValues,
						sshRemoteConfig: chat.moderatorConfig?.sshRemoteConfig,
						tokenMode: getClaudeTokenMode(chat.moderatorConfig, {
							sshEnabled: !!chat.moderatorConfig?.sshRemoteConfig?.enabled,
						}),
						maestroPPath: chat.moderatorConfig?.maestroPPath,
						readOnlyMode: true,
						debugLabel: 'moderator',
						// Match maestro-p's idle budget to the moderator supervising timeout
						// so a still-working moderator isn't killed at maestro-p's 300s default.
						maxWaitSeconds: Math.ceil(MODERATOR_RESPONSE_TIMEOUT_MS / 1000),
					});

					logger.debug(`[GroupChat:Debug] Spawn result: ${JSON.stringify(spawnResult)}`);
					logger.debug(`[GroupChat:Debug] Moderator process spawned successfully`);
					logger.debug(
						`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`
					);
					logger.debug(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);
					logger.debug(`[GroupChat:Debug] =================================================`);
				} catch (error) {
					logger.error(`Failed to spawn moderator for ${groupChatId}`, LOG_CONTEXT, { error });
					captureException(error, { operation: 'groupChat:spawnModerator', groupChatId });
					// The start failed, so no exit will ever clear the budget armed above. Left
					// armed, it fires ten minutes later and tells the room a moderator that never
					// ran "went silent".
					clearModeratorResponseTimeout(groupChatId);
					runningModeratorTurns.delete(groupChatId);
					// Remove power block reason on error since we're going idle
					settleGroupChatToIdle(groupChatId);
					throw new Error(
						`Failed to spawn moderator: ${error instanceof Error ? error.message : String(error)}`
					);
				}
			} else {
				logger.debug(`[GroupChat:Debug] WARNING: No session ID prefix found for moderator`);
			}
		} else {
			logger.debug(`[GroupChat:Debug] WARNING: No launcher provided, skipping spawn`);
		}
	}

	/**
	 * Registers a participant the room is waiting on.
	 *
	 * A turn builds its own set and hands it to the room, which was safe while
	 * every registration happened inside the turn that created it. A delegation
	 * held for a busy agent can register minutes later, by which time the user may
	 * have sent another message and a newer turn may own the room's set - so write
	 * to whichever set is live, not just the one this turn started with. Storing
	 * the stale set instead would drop everyone the newer turn is waiting on.
	 */
	function trackPendingParticipant(
		groupChatId: string,
		turnParticipants: Set<string>,
		participantName: string
	): void {
		turnParticipants.add(participantName);
		const live = pendingParticipantResponses.get(groupChatId);
		if (live && live !== turnParticipants) {
			live.add(participantName);
			return;
		}
		pendingParticipantResponses.set(groupChatId, turnParticipants);
	}

	/**
	 * Cancellation tokens for delegations currently waiting on a busy agent, keyed
	 * by group chat. A waiter is not a timer we can clear by handle - it is a poll
	 * loop - so stopping a chat (see {@link clearPendingParticipants}) flips these
	 * instead, and the loop returns 'cancelled' on its next tick.
	 */
	const queuedDelegationTokens = new Map<string, Set<{ cancelled: boolean }>>();

	/** Stops every delegation still waiting on a busy agent in this chat. */
	function cancelQueuedDelegations(groupChatId: string): void {
		const tokens = queuedDelegationTokens.get(groupChatId);
		if (!tokens) return;
		for (const token of tokens) token.cancelled = true;
		queuedDelegationTokens.delete(groupChatId);
	}

	/**
	 * Blocks until the agent behind a participant stops working, so the request can
	 * be handed over the moment it frees up rather than being dropped.
	 *
	 * Polls the live session callback rather than listening for an exit: "busy" is
	 * a property of the whole agent (any AI tab, an Auto Run, a CLI run), not of one
	 * process, so there is no single event that means "free now".
	 *
	 * Prefers the agent's id over its name - a rename mid-wait must not silently
	 * re-point the wait at a different agent.
	 */
	async function waitForAgentToFree(
		groupChatId: string,
		participantName: string,
		sessionId: string | undefined
	): Promise<{ outcome: 'free' | 'timeout' | 'cancelled'; session?: GroupChatSessionInfo }> {
		const token = { cancelled: false };
		let tokens = queuedDelegationTokens.get(groupChatId);
		if (!tokens) {
			tokens = new Set();
			queuedDelegationTokens.set(groupChatId, tokens);
		}
		tokens.add(token);
		const deadline = Date.now() + QUEUED_DELEGATION_MAX_WAIT_MS;

		try {
			for (;;) {
				if (token.cancelled) return { outcome: 'cancelled' };
				const sessions = agents.list();
				// By id when we have one; otherwise rc's conservative name lookup, never a
				// loose mention match. The session found here is handed to `deliver()`,
				// which spawns in its cwd with its SSH config - a fuzzy hit would run the
				// delegation against a different agent's working directory.
				const session = sessionId
					? sessions.find((s) => s.id === sessionId)
					: findSessionForParticipantName(participantName, sessions);
				// A vanished agent counts as free, matching the delegation rule: an
				// agent we cannot probe is never treated as busy.
				if (session?.isBusy !== true) return { outcome: 'free', session };
				if (Date.now() >= deadline) return { outcome: 'timeout', session };
				await new Promise((resolve) => setTimeout(resolve, QUEUED_DELEGATION_POLL_MS));
			}
		} finally {
			tokens.delete(token);
			if (tokens.size === 0) queuedDelegationTokens.delete(groupChatId);
		}
	}

	/**
	 * Closes out a participant that will never report back (timed out, gave up
	 * waiting, failed to start) and, when it was the last one the room was waiting
	 * on, moves the turn along. Shared by the response timeout and the queued
	 * delegation paths: both have to answer "is the room still working?" the same
	 * way or a chat hangs on 'agent-working'.
	 */
	function finishParticipantTurn(
		groupChatId: string,
		participantName: string,
		launcher: GroupChatLauncher | undefined,
		operation: string
	): void {
		const isLast = markParticipantResponded(groupChatId, participantName);
		if (!isLast) return;
		// The room is done either way. Whether synthesis can run is a separate
		// question from whether the room is still working - folding the two into one
		// condition is what left a timed-out room stuck on 'agent-working' forever.
		if (launcher) {
			spawnModeratorSynthesis(groupChatId, launcher).catch((err) => {
				logger.error('Failed to spawn moderator synthesis', LOG_CONTEXT, {
					error: err,
					groupChatId,
					participantName,
					operation,
				});
				captureException(err, { operation, groupChatId, participantName });
				settleGroupChatToIdle(groupChatId);
			});
		} else {
			settleGroupChatToIdle(groupChatId);
		}
	}

	/** Posts a system line to the chat and to the log the moderator reads back. */
	async function announceToChat(
		groupChatId: string,
		logPath: string,
		content: string
	): Promise<void> {
		// Appended to the log as well as emitted: the moderator reads recent log
		// lines as context, so this is how it learns what happened to the handoff.
		await appendToLog(logPath, 'system', content);
		events.message(groupChatId, {
			timestamp: new Date().toISOString(),
			from: 'system',
			content,
		});
	}

	/**
	 * Tells the chat (and, through the log, the moderator's next turn) which agents
	 * the turn is holding for. Emitted once per moderator turn rather than once per
	 * agent, so a fan-out to three busy agents is one line rather than three.
	 */
	async function reportQueuedForBusyAgents(
		groupChatId: string,
		logPath: string,
		queued: string[]
	): Promise<void> {
		if (queued.length === 0) return;
		const names = queued.map((name) => `@${normalizeMentionName(name)}`).join(', ');
		const content =
			`⏳ Waiting for ${names} - ${queued.length === 1 ? 'that agent is' : 'those agents are'} busy with ` +
			`their own work right now. This chat only engages agents that are free, so the request goes in ` +
			`as soon as they finish. Turn that off in Edit Group Chat to interrupt them instead.`;
		await announceToChat(groupChatId, logPath, content);
	}

	/**
	 * Parks a delegation until the participant's agent goes idle, then delivers it.
	 *
	 * The participant is registered as pending BEFORE the wait starts, so the room
	 * stays on 'agent-working' and the synthesis round waits for a reply that has
	 * not been handed out yet. The wait itself is deliberately not awaited by the
	 * caller: a moderator turn that fans out to a busy agent and a free one must
	 * not hold the free one hostage.
	 */
	function queueDelegationUntilAgentIsFree(opts: {
		groupChatId: string;
		logPath: string;
		participantName: string;
		sessionId: string | undefined;
		participantsToRespond: Set<string>;
		launcher: GroupChatLauncher | undefined;
		deliver: (session: GroupChatSessionInfo | undefined) => Promise<boolean>;
	}): void {
		const { groupChatId, logPath, participantName, participantsToRespond } = opts;

		trackPendingParticipant(groupChatId, participantsToRespond, participantName);
		events.participantState(groupChatId, participantName, 'working');
		if (participantsToRespond.size === 1) {
			events.stateChange(groupChatId, 'agent-working');
		}

		void (async () => {
			const { outcome, session } = await waitForAgentToFree(
				groupChatId,
				participantName,
				opts.sessionId
			);
			// The chat was stopped or deleted while we waited - the pending set is
			// already gone, so there is nothing to close out and nobody to tell.
			if (outcome === 'cancelled') return;

			if (outcome === 'free') {
				try {
					if (await opts.deliver(session)) return;
				} catch (error) {
					logger.error(`Failed to deliver queued delegation to ${participantName}`, LOG_CONTEXT, {
						error,
						groupChatId,
					});
					captureException(error, {
						operation: 'groupChat:deliverQueuedDelegation',
						groupChatId,
						participantName,
					});
				}
				await announceToChat(
					groupChatId,
					logPath,
					`⚠️ @${normalizeMentionName(participantName)} freed up but could not be started.`
				);
			} else {
				await announceToChat(
					groupChatId,
					logPath,
					`⏳ Gave up waiting for @${normalizeMentionName(participantName)} after ` +
						`${QUEUED_DELEGATION_MAX_WAIT_MS / 60000} minutes - that agent is still busy with its own work.`
				);
			}

			events.participantState(groupChatId, participantName, 'idle');
			finishParticipantTurn(
				groupChatId,
				participantName,
				opts.launcher,
				'groupChat:spawnSynthesisAfterQueuedDelegation'
			);
		})();
	}

	/**
	 * Routes a moderator response, forwarding to mentioned agents.
	 *
	 * - Logs the message as coming from 'moderator'
	 * - Extracts @mentions and auto-adds new participants from available sessions
	 * - Forwards message to mentioned participants
	 *
	 * @param groupChatId - The ID of the group chat
	 * @param message - The message from the moderator
	 * @param launcher - How to start participant turns (optional)
	 * @param readOnly - Optional flag indicating read-only mode (propagates to participants)
	 */
	async function routeModeratorResponse(
		groupChatId: string,
		message: string,
		launcher?: GroupChatLauncher,
		readOnly?: boolean
	): Promise<void> {
		logger.debug(`[GroupChat:Debug] ========== ROUTE MODERATOR RESPONSE ==========`);
		logger.debug(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
		logger.debug(`[GroupChat:Debug] Message length: ${message.length}`);
		logger.debug(
			`[GroupChat:Debug] Message preview: "${message.substring(0, 300)}${message.length > 300 ? '...' : ''}"`
		);
		logger.debug(`[GroupChat:Debug] Read-only: ${readOnly ?? false}`);

		// Consume the synthesis flag set by spawnModeratorSynthesis. If set, this moderator
		// turn is the post-round summary and its history entry is classified as 'synthesis'.
		const isSynthesisRound = pendingSynthesisRounds.delete(groupChatId);

		const chat = await loadGroupChat(groupChatId);
		if (!chat) {
			// Benign race: the group chat was deleted while a moderator process was still
			// running. The exit handler routes here on process exit; nothing left to do.
			logger.info(
				`[GroupChat] Skipping moderator routing - chat ${groupChatId} no longer exists`,
				'GroupChatRouter'
			);
			return;
		}

		logger.debug(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);

		// Strip internal !autorun directives from the message before logging/display.
		// These are machine-to-machine commands; storing them in the chat log causes
		// the synthesis moderator to see them in history and potentially re-trigger them.
		const { autoRunDirectives, cleanedText: displayMessage } = extractAutoRunDirectives(message);

		// Only persist/emit the moderator message if it has visible content after stripping directives
		const shouldPersistModeratorMessage = displayMessage.trim().length > 0;

		// The moderator history entry is written at the end of this function, once we know
		// whether this turn delegated work to participants ('delegation'), was a synthesis
		// summary ('synthesis'), or was a plain final response ('response').

		// Extract ALL mentions from the message
		const allMentions = extractAllMentions(message);
		logger.debug(`[GroupChat:Debug] Extracted @mentions: ${allMentions.join(', ') || '(none)'}`);

		const existingParticipantNames = new Set(chat.participants.map((p) => p.name));
		logger.debug(
			`[GroupChat:Debug] Existing participants: ${Array.from(existingParticipantNames).join(', ') || '(none)'}`
		);

		// Check for mentions that aren't already participants but match available sessions
		if (launcher) {
			const sessions = agents.list();
			logger.debug(
				`[GroupChat:Debug] Available sessions for auto-add: ${sessions.map((s) => s.name).join(', ')}`
			);

			for (const mentionedName of allMentions) {
				// Resolve against existing participants AND available sessions together
				// so a weak participant match can't shadow a stronger session match.
				// Returns undefined when the mention is already a participant or
				// resolves ambiguously.
				const matchingSession = resolveSessionToAutoAdd(
					mentionedName,
					existingParticipantNames,
					sessions
				);

				if (matchingSession) {
					// Respect an explicit user removal: a moderator turn that was in
					// flight when the user removed this participant (or any later turn)
					// must not silently re-add them via an @mention (issue #1100). The
					// guard clears once the user re-adds the participant.
					if (wasParticipantRecentlyRemoved(groupChatId, matchingSession.name)) {
						logger.debug(
							`[GroupChatRouter] Skipping auto-add of @${matchingSession.name}: recently removed by user`
						);
						continue;
					}
					try {
						// Use the original session name as the participant name
						const participantName = matchingSession.name;
						logger.debug(
							`[GroupChatRouter] Auto-adding participant @${participantName} from moderator mention @${mentionedName} (session ${matchingSession.id})`
						);
						await addParticipant(groupChatId, participantName, matchingSession.toolType, {
							customModel: matchingSession.customModel,
							customArgs: matchingSession.customArgs,
							customEnvVars: matchingSession.customEnvVars,
							sshRemoteName: matchingSession.sshRemoteName,
							sshRemoteConfig: matchingSession.sshRemoteConfig,
						});
						existingParticipantNames.add(participantName);

						// Emit participant changed event so UI updates
						const updatedChatForEmit = await loadGroupChat(groupChatId);
						if (updatedChatForEmit) {
							events.participantsChanged(groupChatId, updatedChatForEmit.participants);
						}
					} catch (error) {
						if (isModeratorInactiveAutoAddRace(error, groupChatId)) {
							logger.warn(
								`Skipped auto-adding participant ${mentionedName}: moderator is no longer active`,
								LOG_CONTEXT,
								{ groupChatId }
							);
							continue;
						}
						logger.error(`Failed to auto-add participant ${mentionedName}`, LOG_CONTEXT, {
							error,
							groupChatId,
						});
						captureException(error, {
							operation: 'groupChat:autoAddParticipant',
							participantName: mentionedName,
							groupChatId,
						});
						// Continue with other participants even if one fails
					}
				}
			}
		}

		// Now extract mentions that are actual participants (including newly added ones)
		// Reload chat to get updated participants list
		const updatedChat = await loadGroupChat(groupChatId);
		if (!updatedChat) {
			logger.debug(`[GroupChat:Debug] WARNING: Could not reload chat after participant updates`);
			return;
		}

		const mentions = extractMentions(message, updatedChat.participants);
		logger.debug(
			`[GroupChat:Debug] Valid participant mentions found: ${mentions.join(', ') || '(none)'}`
		);

		const pendingExplicitHandoff = pendingExplicitParticipantHandoffs.get(groupChatId);
		// `extractMentions` has already resolved these names against the live participant
		// list. When the user explicitly addressed participants, require the full set:
		// accepting a partial match would silently drop the omitted participant while
		// clearing the pending validation state.
		const hasExecutableHandoff = pendingExplicitHandoff
			? pendingExplicitHandoff.participantNames.every((name) => mentions.includes(name))
			: mentions.length > 0;
		if (pendingExplicitHandoff && !hasExecutableHandoff) {
			const participantMentionNames = pendingExplicitHandoff.participantNames.map((name) =>
				getMentionNameForContext(
					name,
					updatedChat.participants.map((participant) => participant.name)
				)
			);

			if (!pendingExplicitHandoff.retryAttempted && launcher) {
				pendingExplicitHandoff.retryAttempted = true;
				logger.warn(
					'Moderator omitted one or more explicitly addressed participants; retrying once',
					LOG_CONTEXT,
					{
						groupChatId,
						participantNames: pendingExplicitHandoff.participantNames,
					}
				);

				try {
					await routeUserMessage(
						groupChatId,
						pendingExplicitHandoff.message,
						launcher,
						pendingExplicitHandoff.readOnly,
						undefined,
						{
							previousResponse: displayMessage || message,
							participantNames: pendingExplicitHandoff.participantNames,
							savedImageFilenames: pendingExplicitHandoff.savedImageFilenames,
						}
					);
					return;
				} catch (error) {
					logger.error('Failed to spawn moderator routing retry', LOG_CONTEXT, {
						error,
						groupChatId,
					});
					captureException(error, {
						operation: 'groupChat:spawnModeratorRoutingRetry',
						groupChatId,
					});
				}
			}

			pendingExplicitParticipantHandoffs.delete(groupChatId);
			const names = participantMentionNames.map((name) => `@${name}`).join(', ');
			const errorMessage = pendingExplicitHandoff.retryAttempted
				? `⚠️ The moderator still did not produce an executable handoff for ${names} after one retry. No participant processes were started.`
				: `⚠️ The moderator did not produce an executable handoff for ${names}. No participant processes were started.`;
			await announceToChat(groupChatId, updatedChat.logPath, errorMessage);
			await recordGroupChatHistory(groupChatId, {
				timestamp: Date.now(),
				summary: 'Moderator failed to route explicitly addressed participants.',
				participantName: 'Moderator',
				participantColor: '#808080',
				type: 'error',
				fullResponse: displayMessage || message,
			});
			settleGroupChatToIdle(groupChatId);
			return;
		}

		if (hasExecutableHandoff) {
			pendingExplicitParticipantHandoffs.delete(groupChatId);
		}

		if (shouldPersistModeratorMessage) {
			// Persist only after validating an explicitly requested handoff. A prose-only
			// acknowledgement is retried or rejected instead of appearing as a final answer.
			await appendToLog(chat.logPath, 'moderator', displayMessage);
			logger.debug(`[GroupChat:Debug] Message appended to log`);

			const moderatorMessage: GroupChatRoomMessage = {
				timestamp: new Date().toISOString(),
				from: 'moderator',
				content: displayMessage,
			};
			events.message(groupChatId, moderatorMessage);
			logger.debug(`[GroupChat:Debug] Emitted moderator message to renderer`);
		}

		// Track participants that will need to respond for synthesis round
		const participantsToRespond = new Set<string>();
		const autoRunParticipantNames = new Set<string>();

		// Agents whose handoff is parked until they finish what they are doing.
		// Reported once after the delegation loops below.
		const busyQueuedParticipants: string[] = [];

		// Use the !autorun directives already extracted above (same `message` input)
		if (autoRunDirectives.length > 0) {
			logger.debug(
				`[GroupChat:Debug] Found !autorun directives for: ${autoRunDirectives.map((d) => (d.filename ? `${d.participantName}:${d.filename}` : d.participantName)).join(', ')}`
			);
		}

		// Trigger Auto Run for participants via the renderer's batch processor
		// This delegates to the renderer so the full useBatchProcessor pipeline runs:
		// progress indicators, multi-document sequencing, task checking, achievements, etc.
		if (autoRunDirectives.length > 0) {
			logger.debug(`[GroupChat:Debug] ========== TRIGGERING AUTORUN VIA RENDERER ==========`);
			const sessions = agents.list();

			// Hands one Auto Run to the renderer's batch processor. Returns whether it
			// actually started, so a delegation parked behind a busy agent can replay
			// it later and still be closed out if it turns out to be unrunnable.
			const startAutoRunFor = (
				participant: GroupChatParticipant,
				matchingSession: GroupChatSessionInfo | undefined,
				targetFilename: string | undefined
			): boolean => {
				if (!matchingSession?.autoRunFolderPath) {
					console.warn(
						`[GroupChat:Debug] No autoRunFolderPath configured for ${participant.name} - skipping`
					);
					events.message(groupChatId, {
						timestamp: new Date().toISOString(),
						from: 'system',
						content: `⚠️ No Auto Run folder configured for @${participant.name}. Open the agent in Maestro, go to the Auto Run tab, and configure a folder first.`,
					});
					return false;
				}

				// Emit event to renderer - the renderer will call startBatchRun via useBatchProcessor.
				// When the batch completes, the renderer calls groupChat:reportAutoRunComplete which
				// invokes routeAgentResponse to trigger the synthesis round.
				events.participantState(groupChatId, participant.name, 'working');
				// Register in the global pending map BEFORE emitting the trigger event to the renderer.
				// The renderer's batch processor could complete and call reportAutoRunComplete
				// before the post-loop registration - this prevents that race.
				trackPendingParticipant(groupChatId, participantsToRespond, participant.name);
				setParticipantResponseTimeout(groupChatId, participant.name, launcher);
				// Track as autorun so timeout path only emits batch-complete for autorun participants
				if (!autoRunParticipantTracker.has(groupChatId)) {
					autoRunParticipantTracker.set(groupChatId, new Set());
				}
				autoRunParticipantTracker.get(groupChatId)!.add(participant.name);
				// Emit 'agent-working' on first participant so UI indicators activate immediately
				if (participantsToRespond.size === 1) {
					events.stateChange(groupChatId, 'agent-working');
					logger.debug(`[GroupChat:Debug] Emitted state change: agent-working`);
				}
				// Now emit the trigger - renderer will start the batch run
				events.autoRunTriggered(groupChatId, participant.name, targetFilename);
				logger.debug(
					`[GroupChat:Debug] Emitted autoRunTriggered for @${participant.name}${targetFilename ? `:${targetFilename}` : ''} in chat ${groupChatId}`
				);
				return true;
			};

			for (const directive of autoRunDirectives) {
				const { participantName: autoRunName, filename: targetFilename } = directive;
				const participant = findUniqueMentionMatch(
					autoRunName,
					updatedChat.participants,
					(p) => p.name
				);
				if (!participant) {
					console.warn(
						`[GroupChat:Debug] Autorun participant ${autoRunName} not found in chat - skipping`
					);
					events.message(groupChatId, {
						timestamp: new Date().toISOString(),
						from: 'system',
						content: `⚠️ Could not find participant @${autoRunName} for !autorun. Make sure the agent is added to the group chat.`,
					});
					continue;
				}

				// Multiple aliases can resolve to the same canonical participant
				// (e.g. "@CIA-Agent-Super-Cool" and "@CIA-Agent-(Super-Cool)").
				// extractAutoRunDirectives only dedupes raw aliases, so guard here to
				// avoid emitting duplicate autoRunTriggered events for one agent. The set
				// is also what keeps an !autorun target from being spawned a second time
				// as an ordinary @mention below.
				if (autoRunParticipantNames.has(participant.name)) {
					continue;
				}
				autoRunParticipantNames.add(participant.name);

				const matchingSession = findSessionForParticipantName(participant.name, sessions);

				// An Auto Run batch runs INSIDE the user's agent, so a busy agent is an
				// even harder conflict here than a participant spawn is. Hold the batch
				// until that agent is done rather than dropping it.
				if (isDelegationBlockedByBusyAgent(updatedChat, matchingSession)) {
					logger.info(`Queuing !autorun for busy agent @${participant.name}`, LOG_CONTEXT, {
						groupChatId,
					});
					busyQueuedParticipants.push(participant.name);
					queueDelegationUntilAgentIsFree({
						groupChatId,
						logPath: updatedChat.logPath,
						participantName: participant.name,
						sessionId: matchingSession?.id,
						participantsToRespond,
						launcher,
						deliver: async (freedSession) =>
							startAutoRunFor(participant, freedSession ?? matchingSession, targetFilename),
					});
					continue;
				}

				startAutoRunFor(participant, matchingSession, targetFilename);
			}
			logger.debug(`[GroupChat:Debug] =================================================`);
		}

		// Spawn batch processes for each mentioned participant (exclude autorun participants)
		const mentionsToSpawn = mentions.filter((name) => !autoRunParticipantNames.has(name));
		if (launcher && mentionsToSpawn.length > 0) {
			// Captured once: TypeScript does not carry the narrowing above into the
			// delivery closure below, and that closure may also run long after this
			// turn returns, when a queued delegation's agent finally frees up.
			const activeLauncher: GroupChatLauncher = launcher;
			logger.debug(`[GroupChat:Debug] ========== SPAWNING PARTICIPANT AGENTS ==========`);
			logger.debug(`[GroupChat:Debug] Will spawn ${mentionsToSpawn.length} participant agent(s)`);

			// Get available sessions for cwd lookup
			const sessions = agents.list();

			// Get chat history for context
			const chatHistory = await readLog(updatedChat.logPath);
			const historyContext = chatHistory
				.slice(-15)
				.map(
					(m) => `[${m.from}]: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`
				)
				.join('\n');

			// One participant's delegation, from agent resolution through spawn. Lives
			// as a closure so a delegation held back by a busy agent can be replayed
			// verbatim later, once that agent frees up, without re-deriving the whole
			// turn's context. Returns whether the participant was actually started.
			const deliverToParticipant = async (
				participant: GroupChatParticipant,
				matchingSession: GroupChatSessionInfo | undefined,
				cwd: string
			): Promise<boolean> => {
				const participantName = participant.name;
				// Resolve agent configuration
				const agent = await activeLauncher.resolveAgent(participant.agentId);
				logger.debug(
					`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}, available: ${agent?.available ?? false}`
				);

				if (!agent || !agent.available) {
					logger.error(
						`[GroupChat:Debug] ERROR: Agent '${participant.agentId}' not available for ${participantName}`
					);
					return false;
				}

				// Build the prompt with context for this participant
				// Uses template from src/prompts/group-chat-participant-request.md
				const readOnlyNote = readOnly
					? '\n\n**READ-ONLY MODE:** Do not make any file changes. Only analyze, review, or provide information.'
					: '';
				const readOnlyLabel = readOnly ? ' (READ-ONLY MODE)' : '';
				const readOnlyInstruction = readOnly
					? ' Remember: READ-ONLY mode is active, do not modify any files.'
					: ' If you need to perform any actions, do so and report your findings.';

				// Get the group chat folder path for file access permissions
				const groupChatFolder = getGroupChatDir(groupChatId);

				// When the agent's prior session is being resumed (e.g. Copilot's
				// `--resume=<id>`), it already has the full identity/role preamble
				// from the first turn - re-sending it on every moderator turn just
				// burns tokens and confuses the model. Use the slim continuation
				// template in that case; full template only on the first turn or
				// when the agent doesn't support resume.
				const isResume = Boolean(participant.agentSessionId && agent.resumeArgs);
				const promptTemplateId = isResume
					? 'group-chat-participant-continuation'
					: 'group-chat-participant-request';
				const participantPrompt = prompts
					.get(promptTemplateId)
					.replace(/\{\{PARTICIPANT_NAME\}\}/g, participantName)
					.replace(/\{\{GROUP_CHAT_NAME\}\}/g, updatedChat.name)
					.replace(/\{\{READ_ONLY_NOTE\}\}/g, readOnlyNote)
					.replace(/\{\{GROUP_CHAT_FOLDER\}\}/g, groupChatFolder)
					.replace(/\{\{HISTORY_CONTEXT\}\}/g, historyContext)
					.replace(/\{\{READ_ONLY_LABEL\}\}/g, readOnlyLabel)
					.replace(/\{\{MESSAGE\}\}/g, message)
					.replace(/\{\{READ_ONLY_INSTRUCTION\}\}/g, readOnlyInstruction);

				// Create a unique session ID for this batch process
				const sessionId = `group-chat-${groupChatId}-participant-${participantName}-${Date.now()}`;
				logger.debug(`[GroupChat:Debug] Generated session ID: ${sessionId}`);

				const agentConfigValues = agents.providerConfig(participant.agentId);
				// Note: Don't pass modelId to buildAgentArgs - it will be handled by applyAgentConfigOverrides
				// via sessionCustomModel to avoid duplicate --model args
				const baseArgs = buildAgentArgs(agent, {
					baseArgs: [...agent.args],
					prompt: participantPrompt,
					cwd,
					readOnlyMode: readOnly ?? false,
					agentSessionId: participant.agentSessionId,
				});
				const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
					agentConfigValues,
					sessionCustomModel: matchingSession?.customModel,
					sessionCustomArgs: matchingSession?.customArgs,
					sessionCustomEnvVars: matchingSession?.customEnvVars,
					readOnlyMode: readOnly ?? false,
				});

				try {
					// Emit participant state change to show this participant is working
					events.participantState(groupChatId, participantName, 'working');
					logger.debug(`[GroupChat:Debug] Emitted participant state: working`);

					// Log spawn details for debugging
					const spawnCommand = agent.path || agent.command;
					const spawnArgs = configResolution.args;
					logger.debug(`[GroupChat:Debug] Spawn command: ${spawnCommand}`);
					logger.debug(`[GroupChat:Debug] Spawn args: ${JSON.stringify(spawnArgs)}`);
					logger.debug(
						`[GroupChat:Debug] Session customModel: ${matchingSession?.customModel || '(none)'}`
					);
					logger.debug(
						`[GroupChat:Debug] Config model source: ${configResolution.modelSource || 'unknown'}`
					);
					logger.debug(`[GroupChat:Debug] Prompt length: ${participantPrompt.length}`);
					logger.debug(
						`[GroupChat:Debug] CustomEnvVars: ${JSON.stringify(configResolution.effectiveCustomEnvVars || {})}`
					);

					const spawnResult = await launcher.runner.start({
						processId: sessionId,
						providerId: participant.agentId,
						agent,
						command: spawnCommand,
						args: spawnArgs,
						cwd,
						prompt: participantPrompt,
						customEnvVars:
							configResolution.effectiveCustomEnvVars ??
							agents.providerEnvVars(participant.agentId),
						agentConfigValues,
						sshRemoteConfig: matchingSession?.sshRemoteConfig,
						tokenMode: getClaudeTokenMode(matchingSession, {
							sshEnabled: !!matchingSession?.sshRemoteConfig?.enabled,
						}),
						maestroPPath: matchingSession?.maestroPPath,
						readOnlyMode: readOnly ?? false, // Propagate read-only mode from caller
						debugLabel: `participant: ${participantName}`,
						// Match maestro-p's idle budget to the participant supervising timeout
						// so a still-working participant isn't killed at maestro-p's 300s default.
						maxWaitSeconds: Math.ceil(PARTICIPANT_RESPONSE_TIMEOUT_MS / 1000),
					});

					logger.debug(
						`[GroupChat:Debug] Spawn result for ${participantName}: ${JSON.stringify(spawnResult)}`
					);
					// A start that is refused without throwing (an unusable working directory) is
					// still a failed start. Carrying on would register a participant nobody is
					// running and leave the room waiting for it until its silence budget fires.
					if (spawnResult?.success === false) {
						throw new Error(spawnResult.error ?? `Could not start ${participantName}`);
					}
					logger.debug(
						`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`
					);
					logger.debug(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);
					setActiveParticipantSession(groupChatId, participantName, sessionId);

					// Register this participant in the global pending map IMMEDIATELY after spawn.
					// This prevents a race condition where the process exits before the post-loop
					// registration (the exit listener would call markParticipantResponded which checks
					// this map - if the participant isn't registered yet, synthesis never triggers).
					trackPendingParticipant(groupChatId, participantsToRespond, participantName);
					setParticipantResponseTimeout(groupChatId, participantName, activeLauncher);
					// Emit 'agent-working' on first spawn so sidebar and chat indicators update immediately
					if (participantsToRespond.size === 1) {
						events.stateChange(groupChatId, 'agent-working');
						logger.debug(`[GroupChat:Debug] Emitted state change: agent-working`);
					}
					logger.debug(
						`[GroupChat:Debug] Spawned batch process for participant @${participantName} (session ${sessionId}, readOnly=${readOnly ?? false})`
					);
					return true;
				} catch (error) {
					logger.error(`Failed to spawn participant ${participantName}`, LOG_CONTEXT, {
						error,
						groupChatId,
					});
					captureException(error, {
						operation: 'groupChat:spawnParticipant',
						participantName,
						groupChatId,
					});
					// The card was set to 'working' before the start; nothing will ever reset it.
					events.participantState(groupChatId, participantName, 'idle');
					await recordGroupChatHistory(groupChatId, {
						timestamp: Date.now(),
						summary: `Failed to start ${participantName}.`,
						participantName,
						participantColor: participant.color || '#808080',
						type: 'error',
					});
					// Continue with other participants even if one fails
					return false;
				}
			};

			for (const participantName of mentionsToSpawn) {
				logger.debug(`[GroupChat:Debug] --- Spawning participant: @${participantName} ---`);

				// Find the participant info
				const participant = updatedChat.participants.find((p) => p.name === participantName);
				if (!participant) {
					console.warn(
						`[GroupChat:Debug] Participant ${participantName} not found in chat - skipping`
					);
					continue;
				}

				logger.debug(`[GroupChat:Debug] Participant agent ID: ${participant.agentId}`);

				// Find matching session to get cwd
				const matchingSession = findSessionForParticipantName(participantName, sessions);
				const cwd = matchingSession?.cwd || os.homedir();
				logger.debug(`[GroupChat:Debug] CWD for participant: ${cwd}`);

				// Rather than run a second process in a working directory the user's own
				// conversation is already writing to, hold the handoff and deliver it
				// when that agent finishes.
				if (isDelegationBlockedByBusyAgent(updatedChat, matchingSession)) {
					logger.info(`Queuing delegation to busy agent @${participantName}`, LOG_CONTEXT, {
						groupChatId,
					});
					busyQueuedParticipants.push(participantName);
					queueDelegationUntilAgentIsFree({
						groupChatId,
						logPath: updatedChat.logPath,
						participantName,
						sessionId: matchingSession?.id,
						participantsToRespond,
						launcher,
						deliver: (freedSession) =>
							deliverToParticipant(
								participant,
								freedSession ?? matchingSession,
								freedSession?.cwd || cwd
							),
					});
					continue;
				}

				await deliverToParticipant(participant, matchingSession, cwd);
			}
			logger.debug(`[GroupChat:Debug] =================================================`);
		}

		// Tell the chat about anything that is waiting on a busy agent. Done before
		// the lifecycle cleanup below so the note lands in the log ahead of the turn
		// settling, whether or not any other participant was engaged.
		await reportQueuedForBusyAgents(groupChatId, updatedChat.logPath, busyQueuedParticipants);

		// If no actionable participant work was started (all directives invalid/skipped, no mentions),
		// clean up lifecycle state so power blocks don't leak.
		if (participantsToRespond.size === 0) {
			logger.debug(
				`[GroupChat:Debug] No actionable participant work started - moderator response is final`
			);

			// Unknown @tokens should be treated as plain text, not as a system error.
			// Only emit a system warning here when explicit !autorun directives were present
			// but none could be activated.
			// A busy-agent skip already explained itself above; adding this vague retry
			// notice on top of it reads as a second, unrelated failure.
			if (
				autoRunDirectives.length > 0 &&
				mentions.length === 0 &&
				busyQueuedParticipants.length === 0
			) {
				events.message(groupChatId, {
					timestamp: new Date().toISOString(),
					from: 'system',
					content:
						'⚠️ The moderator included !autorun directives but none could be activated. You may need to send another message to retry.',
				});
			}

			events.stateChange(groupChatId, 'idle');
			logger.debug(`[GroupChat:Debug] Emitted state change: idle`);
			power.unblock(`groupchat:${groupChatId}`);
		}

		// Add history entry for the moderator turn now that delegation is known.
		// - synthesis round  -> 'synthesis'
		// - forwarded work to participant(s) -> 'delegation'
		// - otherwise (plain/final response) -> 'response'
		if (shouldPersistModeratorMessage) {
			const moderatorEntryType = isSynthesisRound
				? 'synthesis'
				: participantsToRespond.size > 0
					? 'delegation'
					: 'response';
			await recordGroupChatHistory(groupChatId, {
				timestamp: Date.now(),
				summary: extractFirstSentence(displayMessage),
				participantName: 'Moderator',
				participantColor: '#808080', // Gray for moderator
				type: moderatorEntryType,
				fullResponse: displayMessage,
			});
		}

		// Log final pending state (registration now happens incrementally per-participant above)
		if (participantsToRespond.size > 0) {
			logger.debug(
				`[GroupChat:Debug] Waiting for ${participantsToRespond.size} participant(s) to respond: ${[...participantsToRespond].join(', ')}`
			);
		}
		logger.debug(`[GroupChat:Debug] ===================================================`);
	}

	/**
	 * Routes an agent's response back to the moderator.
	 *
	 * - Logs the message as coming from the participant
	 * - Notifies the moderator of the response
	 *
	 * @param groupChatId - The ID of the group chat
	 * @param participantName - The name of the responding participant
	 * @param message - The message from the participant
	 */
	async function routeAgentResponse(
		groupChatId: string,
		participantName: string,
		message: string
	): Promise<void> {
		logger.debug(`[GroupChat:Debug] ========== ROUTE AGENT RESPONSE ==========`);
		logger.debug(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
		logger.debug(`[GroupChat:Debug] Participant: ${participantName}`);
		logger.debug(`[GroupChat:Debug] Message length: ${message.length}`);
		logger.debug(
			`[GroupChat:Debug] Message preview: "${message.substring(0, 200)}${message.length > 200 ? '...' : ''}"`
		);

		const chat = await loadGroupChat(groupChatId);
		if (!chat) {
			logger.debug(`[GroupChat:Debug] ERROR: Group chat not found!`);
			throw new Error(`Group chat not found: ${groupChatId}`);
		}

		// Verify participant exists
		const participant = chat.participants.find((p) => p.name === participantName);
		if (!participant) {
			logger.debug(`[GroupChat:Debug] ERROR: Participant '${participantName}' not found!`);
			throw new Error(`Participant '${participantName}' not found in group chat`);
		}

		logger.debug(
			`[GroupChat:Debug] Participant verified: ${participantName} (agent: ${participant.agentId})`
		);

		// Log the message as coming from the participant
		await appendToLog(chat.logPath, participantName, message);
		logger.debug(`[GroupChat:Debug] Message appended to log`);

		// Emit message event to renderer so it shows immediately
		const agentMessage: GroupChatRoomMessage = {
			timestamp: new Date().toISOString(),
			from: participantName,
			content: message,
		};
		events.message(groupChatId, agentMessage);

		// Extract summary from first sentence (agents are prompted to start with a summary sentence)
		const summary = extractFirstSentence(message);

		// Update participant stats
		const currentParticipant = participant;
		const newMessageCount = (currentParticipant.messageCount || 0) + 1;

		try {
			await updateParticipant(groupChatId, participantName, {
				lastActivity: Date.now(),
				lastSummary: summary,
				messageCount: newMessageCount,
			});

			// Emit participants changed so UI updates
			const updatedChat = await loadGroupChat(groupChatId);
			if (updatedChat) {
				events.participantsChanged(groupChatId, updatedChat.participants);
			}
		} catch (error) {
			logger.error(`Failed to update participant stats for ${participantName}`, LOG_CONTEXT, {
				error,
				groupChatId,
			});
			captureException(error, {
				operation: 'groupChat:updateParticipantStats',
				participantName,
				groupChatId,
			});
			// Don't throw - stats update failure shouldn't break the message flow
		}

		// Add history entry for this response
		await recordGroupChatHistory(groupChatId, {
			timestamp: Date.now(),
			summary,
			participantName,
			participantColor: participant.color || '#808080', // Default gray if no color assigned
			type: 'response',
			fullResponse: message,
		});

		// Note: The moderator runs in batch mode (one-shot per message), so we can't write to it.
		// Instead, we track pending responses and spawn a synthesis round after all participants respond.
		// The synthesis is triggered from index.ts when the last pending participant exits.
	}

	/**
	 * Spawns a moderator synthesis round to summarize participant responses.
	 * Called from index.ts when the last pending participant has responded.
	 *
	 * @param groupChatId - The ID of the group chat
	 * @param launcher - How to start the synthesis turn
	 */
	async function spawnModeratorSynthesis(
		groupChatId: string,
		launcher: GroupChatLauncher
	): Promise<void> {
		logger.debug(`[GroupChat:Debug] ========== SPAWN MODERATOR SYNTHESIS ==========`);
		logger.debug(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
		logger.debug(`[GroupChat:Debug] All participants have responded, starting synthesis round...`);

		const chat = await loadGroupChat(groupChatId);
		if (!chat) {
			logger.error(`Cannot spawn synthesis - chat not found: ${groupChatId}`, LOG_CONTEXT);
			// Reset UI state and remove power block on early return
			events.stateChange(groupChatId, 'idle');
			power.unblock(`groupchat:${groupChatId}`);
			return;
		}

		logger.debug(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);

		if (!isModeratorActive(groupChatId)) {
			logger.error(
				`Cannot spawn synthesis - moderator not active for: ${groupChatId}`,
				LOG_CONTEXT
			);
			// Reset UI state and remove power block on early return
			events.stateChange(groupChatId, 'idle');
			power.unblock(`groupchat:${groupChatId}`);
			return;
		}

		const sessionIdPrefix = getModeratorSessionId(groupChatId);
		logger.debug(`[GroupChat:Debug] Session ID prefix: ${sessionIdPrefix}`);

		if (!sessionIdPrefix) {
			logger.error(
				`Cannot spawn synthesis - no moderator session ID for: ${groupChatId}`,
				LOG_CONTEXT
			);
			// Reset UI state and remove power block on early return
			events.stateChange(groupChatId, 'idle');
			power.unblock(`groupchat:${groupChatId}`);
			return;
		}

		// Create a unique session ID for this synthesis round
		// Note: We use the regular moderator session ID format (no -synthesis- marker)
		// so the exit handler routes through routeModeratorResponse, which will
		// check for @mentions - if present, route to agents; if not, it's the final response
		const sessionId = `${sessionIdPrefix}-${Date.now()}`;
		logger.debug(`[GroupChat:Debug] Generated synthesis session ID: ${sessionId}`);

		// Resolve the agent configuration
		const agent = await launcher.resolveAgent(chat.moderatorAgentId);
		logger.debug(
			`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}, available: ${agent?.available ?? false}`
		);

		if (!agent || !agent.available) {
			logger.error(`Agent '${chat.moderatorAgentId}' is not available for synthesis`, LOG_CONTEXT);
			// Reset UI state and remove power block on early return
			events.stateChange(groupChatId, 'idle');
			power.unblock(`groupchat:${groupChatId}`);
			return;
		}

		// Use custom path from moderator config if set
		const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
		logger.debug(`[GroupChat:Debug] Command: ${command}`);

		const args = [...agent.args];
		// Build the synthesis prompt with recent chat history
		const chatHistory = await readLog(chat.logPath);
		logger.debug(`[GroupChat:Debug] Chat history entries for synthesis: ${chatHistory.length}`);

		const historyContext = chatHistory
			.slice(-30)
			.map((m) => `[${m.from}]: ${m.content}`)
			.join('\n');

		// Build participant context for potential follow-up @mentions
		// Use normalized names (spaces → hyphens) so moderator can @mention them properly
		const participantNamesForMentions = chat.participants.map((p) => p.name);
		const participantContext =
			chat.participants.length > 0
				? chat.participants
						.map((p) => {
							return `- @${getMentionNameForContext(
								p.name,
								participantNamesForMentions
							)} (${p.agentId} session)`;
						})
						.join('\n')
				: '(No agents currently in this group chat)';

		// Get moderator settings for prompt customization
		const synthModeratorSettings = { conductorProfile: agents.conductorProfile() };
		const synthBasePrompt = getModeratorSystemPrompt().replace(
			/\{\{CONDUCTOR_PROFILE\}\}/g,
			synthModeratorSettings.conductorProfile || '(No conductor profile set)'
		);

		const synthesisPrompt = `${synthBasePrompt}

${getModeratorSynthesisPrompt()}

## Current Participants (you can @mention these for follow-up):
${participantContext}

${MODERATOR_ROUTING_PROTOCOL}

## Recent Chat History (including participant responses):
${historyContext}

## Your Task:
Review the agent responses above. Either:
1. Synthesize into a final answer for the user (NO @mentions, NO !autorun) if the question is fully answered
2. @mention specific agents for follow-up if you need more information

**IMPORTANT: Do NOT include any !autorun directives in this synthesis response.**`;

		const agentConfigValues = agents.providerConfig(chat.moderatorAgentId);
		const baseArgs = buildAgentArgs(agent, {
			baseArgs: args,
			prompt: synthesisPrompt,
			cwd: os.homedir(),
			readOnlyMode: true,
		});
		const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
			agentConfigValues,
			sessionCustomModel: chat.moderatorConfig?.customModel,
			sessionCustomArgs: chat.moderatorConfig?.customArgs,
			sessionCustomEnvVars: chat.moderatorConfig?.customEnvVars,
			readOnlyMode: true,
		});

		// For Gemini CLI: only disable workspace sandbox when read-only mode is
		// CLI-enforced (same rationale as moderator spawn above)
		const geminiCanBeUnsandboxed =
			chat.moderatorAgentId === 'gemini-cli' && !!agent.readOnlyCliEnforced;
		const geminiSynthNoSandbox = geminiCanBeUnsandboxed ? ['--no-sandbox'] : [];
		const finalArgs = [...configResolution.args, ...geminiSynthNoSandbox];
		logger.debug(`[GroupChat:Debug] Args: ${JSON.stringify(finalArgs)}`);

		logger.debug(`[GroupChat:Debug] Synthesis prompt length: ${synthesisPrompt.length} chars`);

		// Spawn the synthesis process
		try {
			logger.debug(`[GroupChat:Debug] Spawning synthesis moderator process...`);
			// Emit state change to show moderator is thinking (synthesizing)
			events.stateChange(groupChatId, 'moderator-thinking');
			logger.debug(`[GroupChat:Debug] Emitted state change: moderator-thinking`);

			// Start moderator timeout to prevent indefinite hanging
			setModeratorResponseTimeout(groupChatId, launcher.runner, sessionId);
			runningModeratorTurns.set(groupChatId, { processId: sessionId, runner: launcher.runner });

			// Mark this turn so routeModeratorResponse classifies its history entry as
			// 'synthesis'. Cleared in the catch below if the spawn never gets off the ground.
			pendingSynthesisRounds.add(groupChatId);

			const spawnResult = await launcher.runner.start({
				processId: sessionId,
				providerId: chat.moderatorAgentId,
				agent,
				command,
				args: finalArgs,
				cwd: os.homedir(),
				prompt: synthesisPrompt,
				customEnvVars:
					configResolution.effectiveCustomEnvVars ?? agents.providerEnvVars(chat.moderatorAgentId),
				agentConfigValues,
				sshRemoteConfig: chat.moderatorConfig?.sshRemoteConfig,
				tokenMode: getClaudeTokenMode(chat.moderatorConfig, {
					sshEnabled: !!chat.moderatorConfig?.sshRemoteConfig?.enabled,
				}),
				maestroPPath: chat.moderatorConfig?.maestroPPath,
				readOnlyMode: true,
				debugLabel: 'synthesis moderator',
				// Match maestro-p's idle budget to the moderator supervising timeout
				// so a still-working synthesis turn isn't killed at maestro-p's 300s default.
				maxWaitSeconds: Math.ceil(MODERATOR_RESPONSE_TIMEOUT_MS / 1000),
			});

			logger.debug(`[GroupChat:Debug] Synthesis spawn result: ${JSON.stringify(spawnResult)}`);
			logger.debug(`[GroupChat:Debug] Synthesis moderator process spawned successfully`);
			logger.debug(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
			logger.debug(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);
			logger.debug(`[GroupChat:Debug] ================================================`);
		} catch (error) {
			logger.error(`Failed to spawn moderator synthesis for ${groupChatId}`, LOG_CONTEXT, {
				error,
			});
			captureException(error, { operation: 'groupChat:spawnSynthesis', groupChatId });
			// Spawn failed before producing output, so no synthesis turn will route back -
			// drop the flag so the next moderator turn isn't mis-tagged as synthesis.
			pendingSynthesisRounds.delete(groupChatId);
			// Nothing was started, so no exit will ever clear the budget armed above (GD23 c)
			clearModeratorResponseTimeout(groupChatId);
			runningModeratorTurns.delete(groupChatId);
			await recordGroupChatHistory(groupChatId, {
				timestamp: Date.now(),
				summary: 'Synthesis round failed to start.',
				participantName: 'Moderator',
				participantColor: '#808080',
				type: 'error',
			});
			// Remove the power block with the state: we're going idle
			settleGroupChatToIdle(groupChatId);
		}
	}

	/**
	 * Re-spawn a participant with session recovery context.
	 *
	 * This is called when a participant's session was not found (deleted out of band).
	 * It builds rich context including the agent's prior statements and re-spawns
	 * the participant to continue the conversation.
	 *
	 * @param groupChatId - The group chat ID
	 * @param participantName - The participant who needs recovery
	 * @param launcher - How to start the recovery turn
	 */
	async function respawnParticipantWithRecovery(
		groupChatId: string,
		participantName: string,
		launcher: GroupChatLauncher
	): Promise<void> {
		logger.debug(`[GroupChat:Debug] ========== RESPAWN WITH RECOVERY ==========`);
		logger.debug(`[GroupChat:Debug] Group Chat: ${groupChatId}`);
		logger.debug(`[GroupChat:Debug] Participant: ${participantName}`);

		// Load the chat and find the participant
		const chat = await loadGroupChat(groupChatId);
		if (!chat) {
			throw new Error(`Group chat not found: ${groupChatId}`);
		}

		const participant = chat.participants.find((p) => p.name === participantName);
		if (!participant) {
			throw new Error(`Participant not found: ${participantName}`);
		}

		// Get the agent configuration
		const agent = await launcher.resolveAgent(participant.agentId);
		if (!agent || !agent.available) {
			throw new Error(`Agent not available: ${participant.agentId}`);
		}

		// Build recovery context with the agent's prior statements
		const recoveryContext = await recovery.buildRecoveryContext(groupChatId, participantName, 30);
		logger.debug(`[GroupChat:Debug] Recovery context length: ${recoveryContext.length}`);

		// Get the read-only state
		const readOnly = getGroupChatReadOnlyState(groupChatId);

		// Get chat history for additional context
		const chatHistory = await readLog(chat.logPath);
		const historyContext = chatHistory
			.slice(-15)
			.map(
				(m) => `[${m.from}]: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`
			)
			.join('\n');

		// Find matching session for cwd
		const sessions = agents.list();
		const matchingSession = findSessionForParticipantName(participantName, sessions);
		const cwd = matchingSession?.cwd || os.homedir();

		// Build the prompt with recovery context
		const readOnlyNote = readOnly
			? '\n\n**READ-ONLY MODE:** Do not make any file changes. Only analyze, review, or provide information.'
			: '';
		const readOnlyLabel = readOnly ? ' (READ-ONLY MODE)' : '';
		const readOnlyInstruction = readOnly
			? ' Remember: READ-ONLY mode is active, do not modify any files.'
			: ' If you need to perform any actions, do so and report your findings.';

		const groupChatFolder = getGroupChatDir(groupChatId);

		// Build the recovery prompt - includes standard prompt plus recovery context
		const basePrompt = prompts
			.get('group-chat-participant-request')
			.replace(/\{\{PARTICIPANT_NAME\}\}/g, participantName)
			.replace(/\{\{GROUP_CHAT_NAME\}\}/g, chat.name)
			.replace(/\{\{READ_ONLY_NOTE\}\}/g, readOnlyNote)
			.replace(/\{\{GROUP_CHAT_FOLDER\}\}/g, groupChatFolder)
			.replace(/\{\{HISTORY_CONTEXT\}\}/g, historyContext)
			.replace(/\{\{READ_ONLY_LABEL\}\}/g, readOnlyLabel)
			.replace(
				/\{\{MESSAGE\}\}/g,
				'Please continue from where you left off based on the recovery context below.'
			)
			.replace(/\{\{READ_ONLY_INSTRUCTION\}\}/g, readOnlyInstruction);

		// Prepend recovery context
		const fullPrompt = `${recoveryContext}\n\n${basePrompt}`;
		logger.debug(`[GroupChat:Debug] Full recovery prompt length: ${fullPrompt.length}`);

		// Create a unique session ID for this recovery spawn
		const sessionId = `group-chat-${groupChatId}-participant-${participantName}-recovery-${Date.now()}`;
		logger.debug(`[GroupChat:Debug] Recovery session ID: ${sessionId}`);

		// Build args - note: no agentSessionId since we're starting fresh
		const agentConfigValues = agents.providerConfig(participant.agentId);
		const baseArgs = buildAgentArgs(agent, {
			baseArgs: [...agent.args],
			prompt: fullPrompt,
			cwd,
			readOnlyMode: readOnly ?? false,
			// No agentSessionId - we're starting fresh after session recovery
		});

		const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
			agentConfigValues,
			sessionCustomModel: matchingSession?.customModel,
			sessionCustomArgs: matchingSession?.customArgs,
			sessionCustomEnvVars: matchingSession?.customEnvVars,
			readOnlyMode: readOnly ?? false,
		});

		// Emit participant state change to show this participant is working
		events.participantState(groupChatId, participantName, 'working');

		// Spawn the recovery process - with SSH wrapping if configured
		logger.debug(`[GroupChat:Debug] Recovery spawn command: ${agent.path || agent.command}`);
		logger.debug(`[GroupChat:Debug] Recovery spawn args count: ${configResolution.args.length}`);

		const spawnResult = await launcher.runner.start({
			processId: sessionId,
			providerId: participant.agentId,
			agent,
			args: configResolution.args,
			cwd,
			prompt: fullPrompt,
			customEnvVars:
				configResolution.effectiveCustomEnvVars ?? agents.providerEnvVars(participant.agentId),
			agentConfigValues,
			sshRemoteConfig: matchingSession?.sshRemoteConfig,
			tokenMode: getClaudeTokenMode(matchingSession, {
				sshEnabled: !!matchingSession?.sshRemoteConfig?.enabled,
			}),
			maestroPPath: matchingSession?.maestroPPath,
			readOnlyMode: readOnly ?? false,
			debugLabel: `recovery of ${participantName}`,
			// Match maestro-p's idle budget to the participant supervising timeout
			// so a still-working recovery turn isn't killed at maestro-p's 300s default.
			maxWaitSeconds: Math.ceil(PARTICIPANT_RESPONSE_TIMEOUT_MS / 1000),
		});

		logger.debug(`[GroupChat:Debug] Recovery spawn result: ${JSON.stringify(spawnResult)}`);
		logger.debug(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
		setActiveParticipantSession(groupChatId, participantName, sessionId);
		logger.debug(`[GroupChat:Debug] =============================================`);
	}
	/**
	 * Stops a chat's moderator: the turn that is running by its FULL process id, then
	 * the registration. Before this existed the registry killed the per-chat prefix,
	 * which no process answers to, so Stop, delete, archive, and a moderator change all
	 * left a running moderator to finish and dispatch participants after it was told to
	 * stop (GD23 a).
	 *
	 * The turn's budget is disarmed with it, and its eventual exit is reported
	 * silently: nobody is waiting for that answer.
	 *
	 * @param control - The process manager the caller holds (optional); still handed the
	 *   registered prefix, as before, so a caller that watches that kill keeps seeing it
	 */
	async function killModerator(
		groupChatId: string,
		control?: Pick<GroupChatProcessControl, 'kill'>
	): Promise<void> {
		const running = runningModeratorTurns.get(groupChatId);
		clearModeratorResponseTimeout(groupChatId);
		if (running) {
			runningModeratorTurns.delete(groupChatId);
			stoppedModeratorTurns.add(running.processId);
			killTimedOutSession(running.processId, running.runner, 'moderator');
		}
		await moderators.killModerator(groupChatId, control);
	}

	// ==========================================================================
	// Progression: a surface reports each finished turn here
	// ==========================================================================

	/** Loads a chat, retrying once for a transient I/O failure. */
	async function loadChatWithRetry(groupChatId: string) {
		try {
			return await loadGroupChat(groupChatId);
		} catch (firstErr) {
			void captureException(firstErr);
			logger.warn('[GroupChat] Chat load failed, retrying once', 'ProcessListener', {
				error: String(firstErr),
				groupChatId,
			});
			// Wait 100ms and retry once for transient I/O issues
			await new Promise((resolve) => setTimeout(resolve, 100));
			return await loadGroupChat(groupChatId);
		}
	}

	/** What the moderator said, read once the turn is over. */
	async function moderatorTurnEnded(
		groupChatId: string,
		end: GroupChatTurnEnd,
		launcher: GroupChatLauncher | undefined
	): Promise<void> {
		logger.debug(`[GroupChat] Moderator exit: groupChatId=${groupChatId}`, 'ProcessListener', {
			sessionId: end.processId,
		});

		// The budget armed for this turn is over with it
		clearModeratorResponseTimeout(groupChatId);
		if (runningModeratorTurns.get(groupChatId)?.processId === end.processId) {
			runningModeratorTurns.delete(groupChatId);
		}
		// A turn the user stopped has nothing to route and nobody to tell
		if (stoppedModeratorTurns.delete(end.processId)) return;

		// Moderator output is only ever acted on when it has text. `rawOutput` says whether
		// the process wrote anything at all, which decides which of the two notices is true.
		const hasOutput = Boolean(end.rawOutput) || Boolean(end.text);
		if (!hasOutput) {
			logger.warn('[GroupChat] Moderator exit with no buffered output', 'ProcessListener', {
				groupChatId,
				sessionId: end.processId,
			});
			events.message(groupChatId, {
				timestamp: new Date().toISOString(),
				from: 'system',
				content: `⚠️ Moderator exited without producing output. You can send another message to retry.`,
			});
			settleGroupChatToIdle(groupChatId);
			return;
		}

		// routeModeratorResponse handles its own state transitions:
		// - 'agent-working' if @mentions start participants
		// - idle if no participant started (a final response)
		// Idle is only set here for the error and empty paths where routing does not run.
		try {
			let text = end.text;
			if (text === undefined) {
				const chat = await loadChatWithRetry(groupChatId);
				text = end.readText?.(chat?.moderatorAgentId) ?? '';
			}
			if (text.trim()) {
				logger.info(
					`[GroupChat] Routing moderator response (${text.length} chars)`,
					'ProcessListener',
					{ groupChatId }
				);
				// Await routing - it manages state transitions internally
				await routeModeratorResponse(
					groupChatId,
					text,
					launcher,
					getGroupChatReadOnlyState(groupChatId)
				);
			} else {
				logger.warn('[GroupChat] Moderator output parsed to empty string', 'ProcessListener', {
					groupChatId,
					rawLength: end.rawOutput?.length ?? 0,
				});
				events.message(groupChatId, {
					timestamp: new Date().toISOString(),
					from: 'system',
					content: `⚠️ Moderator produced no visible output. You can send another message to retry.`,
				});
				settleGroupChatToIdle(groupChatId);
			}
		} catch (err) {
			let parsedTextForLog = '';
			try {
				parsedTextForLog = end.text ?? end.readText?.(undefined) ?? '';
			} catch {
				// Reading the text for a log line must not hide the failure being logged
			}
			logger.error('[GroupChat] Failed to process moderator response', 'ProcessListener', {
				error: String(err),
				groupChatId,
				bufferedLength: end.rawOutput?.length ?? 0,
				parsedTextPreview: parsedTextForLog.substring(0, 500),
				parsedTextLength: parsedTextForLog.length,
			});
			captureException(err, { operation: 'groupChat:processModeratorExit', groupChatId });
			events.message(groupChatId, {
				timestamp: new Date().toISOString(),
				from: 'system',
				content: `⚠️ Failed to process moderator response. You can send another message to retry.`,
			});
			settleGroupChatToIdle(groupChatId);
		}
	}

	/**
	 * Marks a participant as done and, when it was the last one the round was waiting for, starts the
	 * moderator's synthesis.
	 *
	 * "Can synthesis run?" is a different question from "is the room still working?". Gating both on
	 * one condition left the room on 'agent-working' with its power block held whenever the launcher
	 * was missing, so the room settles to idle whether or not a synthesis could start.
	 */
	async function markParticipantDone(
		groupChatId: string,
		participantName: string,
		launcher: GroupChatLauncher | undefined
	): Promise<void> {
		const isLastParticipant = markParticipantResponded(groupChatId, participantName);
		if (!isLastParticipant) return;
		if (launcher) {
			logger.info(
				'[GroupChat] All participants responded, spawning moderator synthesis',
				'ProcessListener',
				{ groupChatId }
			);
			await spawnModeratorSynthesis(groupChatId, launcher).catch((err) => {
				logger.error('[GroupChat] Failed to spawn moderator synthesis', 'ProcessListener', {
					error: String(err),
					groupChatId,
				});
				// Reset to idle so the user is not stuck waiting indefinitely
				settleGroupChatToIdle(groupChatId);
				events.message(groupChatId, {
					timestamp: new Date().toISOString(),
					from: 'system',
					content: `⚠️ Synthesis failed. You can send another message to continue.`,
				});
				captureException(err, { operation: 'groupChat:spawnModeratorSynthesis', groupChatId });
			});
		} else {
			settleGroupChatToIdle(groupChatId);
		}
	}

	/**
	 * A participant's turn is over. Whatever came back is its reply, whatever the exit
	 * code was (B1): a crash or a kill after text still counts as responded. A turn
	 * that returned nothing is closed out silently (B2), so one dead participant never
	 * holds the room.
	 */
	async function participantTurnEnded(
		owner: { groupChatId: string; participantName: string },
		end: GroupChatTurnEnd,
		launcher: GroupChatLauncher | undefined
	): Promise<void> {
		const { groupChatId, participantName } = owner;
		logger.debug(
			`[GroupChat] Participant exit: ${participantName} (groupChatId=${groupChatId})`,
			'ProcessListener',
			{ sessionId: end.processId }
		);

		// Show this participant is done working
		events.participantState(groupChatId, participantName, 'idle');
		clearActiveParticipantSession(groupChatId, participantName);

		// Mark the participant and, when it was the last one, start the synthesis.
		// Called explicitly on each path below (never from a finally): session recovery
		// must NOT mark the participant until the recovery turn ends.
		const markAndMaybeSynthesize = (): Promise<void> =>
			markParticipantDone(groupChatId, participantName, launcher);

		// No output to log, so the participant is done immediately
		const hasOutput = Boolean(end.rawOutput) || Boolean(end.text);
		if (!hasOutput) {
			await markAndMaybeSynthesize();
			return;
		}

		// The chat is loaded inside the error handling (GD23 e): an I/O failure here used
		// to leave the participant unmarked until its silence budget fired
		let providerId: string | undefined;
		let loadError: unknown;
		try {
			const chat = await loadGroupChat(groupChatId);
			providerId = chat?.participants.find((p) => p.name === participantName)?.agentId;
		} catch (err) {
			loadError = err;
		}

		// A session_not_found error is recovered and retried - unless this IS already a
		// recovery turn (no infinite loops)
		const isRecoverySession = end.processId.includes('-recovery-');
		if (
			loadError === undefined &&
			!isRecoverySession &&
			needsSessionRecovery(end.rawOutput ?? end.text ?? '', providerId)
		) {
			logger.info('[GroupChat] Session recovery needed', 'ProcessListener', {
				groupChatId,
				participantName,
			});

			// Clears the stored provider session so the respawn starts fresh
			await recovery.initiateSessionRecovery(groupChatId, participantName);

			if (launcher) {
				// Tell the UI recovery is in progress
				events.message(groupChatId, {
					timestamp: new Date().toISOString(),
					from: 'system',
					content: `Session expired for ${participantName}. Creating a new session...`,
				});
				try {
					await respawnParticipantWithRecovery(groupChatId, participantName, launcher);
					// Not marked yet: the recovery turn's own end marks it
				} catch (respawnErr) {
					void captureException(respawnErr);
					logger.error(
						'[GroupChat] Failed to respawn participant for recovery',
						'ProcessListener',
						{ error: String(respawnErr), participant: participantName }
					);
					events.message(groupChatId, {
						timestamp: new Date().toISOString(),
						from: 'system',
						content: `⚠️ Failed to create new session for ${participantName}: ${String(respawnErr)}`,
					});
					// Recovery failed, so the participant is done
					await markAndMaybeSynthesize();
				}
			} else {
				await markAndMaybeSynthesize();
			}
			return;
		}

		// Normal processing: read the reply and route it
		try {
			if (loadError !== undefined) throw loadError;
			const parsedText = end.text ?? end.readText?.(providerId) ?? '';
			if (parsedText.trim()) {
				// Await the logging before marking: synthesis reads the log, and marking first
				// would let it read before the response is written
				await routeAgentResponse(groupChatId, participantName, parsedText);
			}
			// Mark AFTER routing completes. No text means no response to route: done.
			await markAndMaybeSynthesize();
		} catch (err) {
			if (!isDeletedGroupChatFailure(err)) void captureException(err);
			logger.error(
				'[GroupChat] Failed to load chat for participant output parsing',
				'ProcessListener',
				{ error: String(err), participant: participantName }
			);
			try {
				const parsedText = end.text ?? end.readText?.(undefined) ?? '';
				if (parsedText.trim()) {
					await routeAgentResponse(groupChatId, participantName, parsedText);
				}
				await markAndMaybeSynthesize();
			} catch (routeErr) {
				if (!isDeletedGroupChatFailure(routeErr)) void captureException(routeErr);
				logger.error('[GroupChat] Failed to route agent response', 'ProcessListener', {
					error: String(routeErr),
					participant: participantName,
				});
				// Mark the participant done even after an error (it cannot be retried)
				await markAndMaybeSynthesize();
			}
		}
	}

	/**
	 * A group chat turn has ended: decide what comes next.
	 *
	 * The one entry for a finished turn. A surface reports it once the process is over
	 * and the reply is in hand, and the engine routes a moderator's text, marks a
	 * participant, or starts the synthesis. It never reads an exit code: whether a
	 * participant responded is "did any text come back" (B1).
	 *
	 * Resolves when the work the end triggered (routing, recovery, the synthesis start)
	 * has finished, so a caller that owns a buffer can release it afterwards.
	 *
	 * @param end - The turn that ended
	 * @param launcher - How to start the next turn (absent: the round settles instead)
	 */
	async function turnEnded(end: GroupChatTurnEnd, launcher?: GroupChatLauncher): Promise<void> {
		const moderatorChatId = parseModeratorSessionId(end.processId);
		if (moderatorChatId) {
			await moderatorTurnEnded(moderatorChatId, end, launcher);
			return;
		}

		const participant = parseParticipantSessionId(end.processId);
		if (participant) {
			await participantTurnEnded(participant, end, launcher);
			return;
		}

		// Domain containment: a group-chat-shaped id nothing recognizes is dropped, never
		// treated as an ordinary agent turn.
		logger.warn(
			'[GroupChat] Dropping unrecognized group-chat session exit (containment guard)',
			'ProcessListener',
			{ sessionId: end.processId, exitCode: end.exitCode }
		);
	}

	/**
	 * A participant's Auto Run (started by a `!autorun` directive) ended. The run is another agent
	 * session, so no group chat process exits to report it: the surface that ran it says so here, with
	 * what it amounted to. The summary is logged as the participant's reply, the participant's card
	 * and Auto Run badge are cleared, and the round continues exactly as it does when a participant's
	 * process ends (the last one releases the synthesis).
	 */
	async function autoRunCompleted(
		groupChatId: string,
		participantName: string,
		summary: string,
		launcher?: GroupChatLauncher
	): Promise<void> {
		// Log the autorun summary as the participant's response
		await routeAgentResponse(groupChatId, participantName, summary);

		// Reset participant state to idle (mirrors what the turn end does for regular participants).
		// Without this the participant card stays "Working" because no process exit fires for
		// autorun participants.
		events.participantState(groupChatId, participantName, 'idle');

		// Tell the UI to definitively complete the batch run for this participant, so the AUTO badge
		// and progress bar are always cleared.
		events.autoRunBatchComplete(groupChatId, participantName);

		await markParticipantDone(groupChatId, participantName, launcher);
	}

	// -----------------------------------------------------------------------
	// Observations of a running turn
	//
	// What a surface that watches the process (the desktop's listeners, the headless runner) tells
	// the engine while a turn runs. None of them decides what comes next; that is `turnEnded`.
	// -----------------------------------------------------------------------

	/**
	 * A group chat process announced its provider session id: store it where the chat can resume it,
	 * and tell the UI. A participant's id continues that participant's conversation; a moderator
	 * turn's id (a plain turn, not a synthesis) is the chat's `moderatorAgentSessionId`, which is not
	 * `moderatorSessionId`, the routing prefix.
	 *
	 * Never rejects: a failed write is logged and the round goes on without a resume id.
	 */
	async function sessionAnnounced(processId: string, agentSessionId: string): Promise<void> {
		if (!processId.startsWith(GROUP_CHAT_PREFIX)) return;

		const participant = parseParticipantSessionId(processId);
		if (participant) {
			try {
				const updated = await updateParticipant(
					participant.groupChatId,
					participant.participantName,
					{
						agentSessionId,
					}
				);
				// `updateParticipant` answers the updated chat, so no extra read is needed.
				events.participantsChanged(participant.groupChatId, updated.participants);
			} catch (error) {
				logger.error('[GroupChat] Failed to update participant agentSessionId', LOG_CONTEXT, {
					error: String(error),
					participant: participant.participantName,
				});
			}
			return;
		}

		const moderator = processId.match(REGEX_MODERATOR_SESSION_TIMESTAMP);
		if (moderator) {
			const groupChatId = moderator[1];
			try {
				await store.updateGroupChat(groupChatId, { moderatorAgentSessionId: agentSessionId });
				events.moderatorSessionIdChanged(groupChatId, agentSessionId);
			} catch (error) {
				logger.error('[GroupChat] Failed to update moderator agent session ID', LOG_CONTEXT, {
					error: String(error),
					groupChatId,
				});
			}
		}
	}

	/**
	 * A group chat process reported usage. Folds it into the turn's ledger (the chat's totals need
	 * how many tokens the turn BURNED, which is not the context snapshot below), then updates the
	 * participant's card or the moderator's.
	 *
	 * Context usage is skipped when the total exceeds the window: a multi-tool turn reports values
	 * accumulated over its internal calls, and a percentage over 100 is not a measurement.
	 */
	function usageReported(processId: string, usage: UsageStats): void {
		if (!processId.startsWith(GROUP_CHAT_PREFIX)) return;
		metrics.recordUsage(processId, usage);

		const totalContextTokens = calculateContextTokens(usage);
		const effectiveWindow = usage.contextWindow > 0 ? usage.contextWindow : FALLBACK_CONTEXT_WINDOW;
		const fits = totalContextTokens <= effectiveWindow;

		const participant = parseParticipantSessionId(processId);
		if (participant) {
			const update: { contextUsage?: number; tokenCount?: number; totalCost: number } = {
				totalCost: usage.totalCostUsd,
			};
			if (fits) {
				update.contextUsage = Math.round((totalContextTokens / effectiveWindow) * 100);
				update.tokenCount = totalContextTokens;
			}
			updateParticipant(participant.groupChatId, participant.participantName, update)
				.then((updated) =>
					events.participantsChanged(participant.groupChatId, updated.participants)
				)
				.catch((error) => {
					logger.error('[GroupChat] Failed to update participant usage', LOG_CONTEXT, {
						error: String(error),
						participant: participant.participantName,
					});
				});
		}

		const moderatorChatId = parseModeratorSessionId(processId);
		if (moderatorChatId) {
			// An accumulated total is reported as -1 so the card keeps its previous values; cost always moves.
			events.moderatorUsage(
				moderatorChatId,
				fits
					? {
							contextUsage: Math.round((totalContextTokens / effectiveWindow) * 100),
							totalCost: usage.totalCostUsd,
							tokenCount: totalContextTokens,
						}
					: { contextUsage: -1, totalCost: usage.totalCostUsd, tokenCount: -1 }
			);
		}
	}

	/** A participant's output as it streams, for a peek panel. A moderator's is not shown. */
	function liveOutput(processId: string, chunk: string): void {
		if (!processId.startsWith(GROUP_CHAT_PREFIX)) return;
		const participant = parseParticipantSessionId(processId);
		if (participant) {
			events.participantLiveOutput(participant.groupChatId, participant.participantName, chunk);
		}
	}

	return {
		// Moderator registry
		spawnModerator: moderators.spawnModerator,
		sendToModerator: moderators.sendToModerator,
		killModerator,
		getModeratorSessionId,
		isModeratorActive,
		clearAllModeratorSessions: moderators.clearAllModeratorSessions,
		getModeratorChatLog: moderators.getModeratorChatLog,
		getModeratorSystemPrompt,
		getModeratorSynthesisPrompt,
		// Participant registry
		...participantRegistry,
		// Routing
		routeUserMessage,
		routeModeratorResponse,
		routeAgentResponse,
		spawnModeratorSynthesis,
		respawnParticipantWithRecovery,
		// Progression
		turnEnded,
		autoRunCompleted,
		noteActivity: noteGroupChatActivity,
		sessionAnnounced,
		usageReported,
		liveOutput,
		// Round state
		settleGroupChatToIdle,
		setModeratorResponseTimeout,
		clearModeratorResponseTimeout,
		getGroupChatReadOnlyState,
		clearPendingParticipants,
		clearActiveParticipantTaskSession,
		markParticipantResponded,
	};
}

export type GroupChatEngine = ReturnType<typeof createGroupChatEngine>;
