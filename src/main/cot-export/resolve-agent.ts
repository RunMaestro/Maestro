/**
 * Chain of thought export: which agent, if any, a process belongs to.
 *
 * Every process Maestro spawns has a session id, and that id is the only thing
 * the `spawn`, `parsed-event`, and `exit` events carry. This module reads it
 * and answers two questions: is this process an agent turn the person asked
 * for, and which Maestro agent (and tab) did it run as? Anything that is not
 * such a turn resolves to `null`, and nothing is recorded for it.
 *
 * The table below is the decision for every shape of session id that reaches
 * `ProcessManager.spawn`. It was built from the spawn sites in
 * `src/renderer` (every `window.maestro.process.spawn` caller goes through the
 * `process:spawn` handler, which keeps the id the renderer chose) and in
 * `src/main` (`processManager.spawn` callers).
 *
 *   Shape                                         Minted by                          Decision
 *   --------------------------------------------  ---------------------------------  ----------------
 *   <agent>-ai-<tab>[-fp-<n>]                     useInputProcessing, agentStore     interactive
 *                                                 (queued items), useRemoteHandlers,
 *                                                 useForkConversation,
 *                                                 useMergeTransferHandlers
 *   <agent>-ai                                    older spawn paths                  interactive
 *   <agent>-batch-<n>                             useAgentExecution (Auto Run task)  auto-run
 *   group-chat-<chat>-participant-<name>-<tail>   group-chat-agent, router           group-chat
 *   group-chat-<chat>-moderator-<n>               group-chat-router                  null (not an agent)
 *   <agent>-synopsis-<n>                          useAgentExecution (exit synopsis)  null (Maestro prompt)
 *   <agent>-cue-assist-<n>                        useCueAiChat                       null (Maestro prompt)
 *   groomer-<uuid>                                context-groomer: AI command mode,  null (Maestro prompt)
 *                                                 Director's Notes, context
 *                                                 grooming and merge
 *   tab-naming-<uuid>                             ipc/handlers/tabNaming             null (Maestro prompt)
 *   feedback-<ts>-<rand>                          feedbackConversation               null (Maestro prompt)
 *   wizard-<ts>-<rand>, wizard-gen-<ts>-<rand>    Wizard conversationManager,        null (Maestro prompt)
 *   inline-wizard-<ts>-<rand>,                    phaseGenerator, inline wizard
 *   inline-wizard-gen-<ts>-<rand>                 conversation and generation
 *   cross-agent-<requestId>                       cross-agent-router (a consult)     consult (see below)
 *   <agent>-terminal, <agent>-terminal-<tab>      terminal tabs (a PTY, not a turn)  null
 *   cue-run-<runId>                               listed by process:getActive only;  null (Cue hook)
 *                                                 Cue runs never go through
 *                                                 ProcessManager
 *
 * Three decisions in that table need a reason:
 *
 * - A consult (`cross-agent-*`) is a turn of the agent that ANSWERS. Its
 *   process id carries no agent id, only the request id, so the two agents
 *   come from the consult router's list of consults in flight
 *   (`getConsultParties`). The turn is recorded under the answering agent
 *   with `origin: 'consult'`, and `consultedBy` names the agent that asked.
 *   A consult the router no longer lists resolves to null.
 * - A group chat participant is matched to its agent BY NAME, with the same
 *   conservative rule the router uses to pick the agent the participant runs
 *   as (`findSessionForParticipantName`). The participant record's `agentId`
 *   is the PROVIDER TYPE (`claude-code`), not a Maestro agent id, so it cannot
 *   name the agent. It is used as a check instead: if the matched agent runs a
 *   different provider than the participant was created with, the name now
 *   belongs to some other agent, and the turn is not recorded rather than
 *   filed under the wrong chain.
 * - Unknown shapes are null, not guesses. A shape this table does not list
 *   writes one debug line (once per shape) so a new spawn site shows up in the
 *   log instead of silently going unrecorded or silently being recorded.
 *
 * This resolver reads ids only. It never sees a prompt, a cwd, or a config.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import {
	REGEX_AI_SUFFIX,
	REGEX_AI_TAB_ID,
	REGEX_BATCH_SESSION,
	REGEX_MODERATOR_SESSION,
	REGEX_SYNOPSIS_SESSION,
} from '../constants';
import { parseParticipantSessionId } from '../group-chat/session-parser';
import { CROSS_AGENT_SESSION_PREFIX } from '../../shared/crossAgentTypes';
import { findSessionForParticipantName } from '../../shared/group-chat-types';
import type { CotTurnOrigin } from '../../shared/cotExport/types';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'Stores';

// ============================================================================
// Contract
// ============================================================================

/** The agent a process turn is recorded under. */
export interface CotTarget {
	/** Maestro's id for the agent, the key of the config store. */
	agentId: string;
	origin: CotTurnOrigin;
	/** The AI tab the turn belongs to. Only an interactive turn has one. */
	tabId?: string;
	/** The agent whose question the turn answers. Only a consult has one. */
	consultedBy?: string;
}

/** The fields of an agent this module reads. */
export interface CotResolverSession {
	id: string;
	name: string;
	/** Provider type, for example `claude-code`. */
	toolType: string;
}

/** The field of a group chat participant this module reads. */
export interface CotResolverParticipant {
	/** The participant's PROVIDER TYPE, not a Maestro agent id. */
	agentId: string;
}

export interface CotResolverDeps {
	/** Every agent Maestro knows, read at the moment of the call. */
	getSessions: () => readonly CotResolverSession[];
	/**
	 * The participant of a group chat, or nothing when the chat or the
	 * participant is gone. The real source reads the chat's metadata file, so it
	 * may be asynchronous.
	 */
	getGroupChatParticipant: (
		groupChatId: string,
		participantName: string
	) =>
		| Promise<CotResolverParticipant | null | undefined>
		| CotResolverParticipant
		| null
		| undefined;
	/**
	 * The agent that asks and the agent that answers in a consult that is in
	 * flight, by the consult's request id; or null when there is none. Answered
	 * from memory, with no wait. Without it no consult is recorded.
	 */
	getConsultParties?: (
		requestId: string
	) => { sourceSessionId: string; targetSessionId: string } | null;
}

/** What a session id says about the process, before any lookup. */
export type CotSessionShape =
	| { kind: 'agent-turn'; origin: 'interactive'; agentId: string; tabId?: string }
	| { kind: 'agent-turn'; origin: 'auto-run'; agentId: string }
	| { kind: 'group-chat-participant'; groupChatId: string; participantName: string }
	| { kind: 'consult'; requestId: string }
	/** Known, and not an agent turn the person asked for. */
	| { kind: 'internal' }
	/** Not in the table in the module header. */
	| { kind: 'unknown' };

// ============================================================================
// Classification
// ============================================================================

/**
 * Prefixes of ids Maestro mints for its own work. None of them starts an
 * agent id: agent ids are generated UUIDs.
 */
const INTERNAL_PREFIXES = [
	'groomer-',
	'tab-naming-',
	'feedback-',
	'inline-wizard-',
	'wizard-',
	'cue-run-',
] as const;

const REGEX_CUE_ASSIST_SESSION = /-cue-assist-\d+$/;
const REGEX_TERMINAL_SESSION = /-terminal(?:-.+)?$/;
const REGEX_BARE_AI_SESSION = /-ai$/;

/**
 * Read a process session id. Pure: it looks at the id and nothing else, and
 * it does not check that the agent exists.
 */
export function classifyCotSessionId(processSessionId: string): CotSessionShape {
	if (processSessionId.startsWith('group-chat-')) {
		const participant = parseParticipantSessionId(processSessionId);
		if (participant) {
			return {
				kind: 'group-chat-participant',
				groupChatId: participant.groupChatId,
				participantName: participant.participantName,
			};
		}
		// A moderator is not an agent: it is Maestro's own coordinator.
		return REGEX_MODERATOR_SESSION.test(processSessionId)
			? { kind: 'internal' }
			: { kind: 'unknown' };
	}

	if (processSessionId.startsWith(CROSS_AGENT_SESSION_PREFIX)) {
		const requestId = processSessionId.slice(CROSS_AGENT_SESSION_PREFIX.length);
		return requestId === '' ? { kind: 'unknown' } : { kind: 'consult', requestId };
	}

	if (INTERNAL_PREFIXES.some((prefix) => processSessionId.startsWith(prefix))) {
		return { kind: 'internal' };
	}

	// Suffix shapes. The order matters only in that the Maestro-prompt shapes
	// and terminals are decided before the `-ai-` rule, so an odd tab id can
	// never pull one of them into a recorded turn.
	if (
		REGEX_SYNOPSIS_SESSION.test(processSessionId) ||
		REGEX_CUE_ASSIST_SESSION.test(processSessionId) ||
		REGEX_TERMINAL_SESSION.test(processSessionId)
	) {
		return { kind: 'internal' };
	}

	if (REGEX_BATCH_SESSION.test(processSessionId)) {
		return {
			kind: 'agent-turn',
			origin: 'auto-run',
			agentId: processSessionId.replace(REGEX_BATCH_SESSION, ''),
		};
	}

	const tab = processSessionId.match(REGEX_AI_TAB_ID);
	if (tab) {
		return {
			kind: 'agent-turn',
			origin: 'interactive',
			agentId: processSessionId.replace(REGEX_AI_SUFFIX, ''),
			tabId: tab[1],
		};
	}

	if (REGEX_BARE_AI_SESSION.test(processSessionId)) {
		return {
			kind: 'agent-turn',
			origin: 'interactive',
			agentId: processSessionId.replace(REGEX_BARE_AI_SESSION, ''),
		};
	}

	return { kind: 'unknown' };
}

// ============================================================================
// Resolution
// ============================================================================

/** Shapes already logged, so each unknown shape costs one line. */
const loggedUnknownShapes = new Set<string>();
const MAX_LOGGED_SHAPES = 100;

/** The id with its changing parts blanked, so one shape is one key. */
function shapeKey(processSessionId: string): string {
	return processSessionId
		.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<uuid>')
		.replace(/\d{4,}/g, '<n>');
}

function noteUnknownShape(processSessionId: string): void {
	const key = shapeKey(processSessionId);
	if (loggedUnknownShapes.has(key) || loggedUnknownShapes.size >= MAX_LOGGED_SHAPES) return;
	loggedUnknownShapes.add(key);
	logger.debug(`Process id shape not recognized: ${key}`, LOG_CONTEXT);
}

/** Forget which shapes were logged. For tests. */
export function __resetCotResolverLogForTests(): void {
	loggedUnknownShapes.clear();
}

/**
 * The agent a shape points at, from the agents in memory. `undefined` for a
 * shape that is not an agent turn, and for an agent Maestro does not have.
 *
 * The agents are asked for only when the shape is an agent turn: reading them
 * is a store read, and most processes Maestro starts are not agent turns.
 */
function agentOfShape(
	shape: CotSessionShape,
	deps: Pick<CotResolverDeps, 'getSessions' | 'getConsultParties'>
): CotResolverSession | undefined {
	switch (shape.kind) {
		case 'agent-turn':
			return deps.getSessions().find((session) => session.id === shape.agentId);
		case 'group-chat-participant':
			return findSessionForParticipantName(shape.participantName, deps.getSessions());
		case 'consult': {
			const answering = deps.getConsultParties?.(shape.requestId)?.targetSessionId;
			return answering ? deps.getSessions().find((session) => session.id === answering) : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * The agent a process turn WOULD be recorded under, from what is in memory:
 * no read and no wait. `null` when the process is not an agent turn.
 *
 * This is the half of `resolveCotTarget` that can answer at the moment a
 * process starts, which is when "is this agent recorded?" has to be decided. A
 * turn of an agent that is not recorded then costs this lookup and nothing
 * more.
 *
 * `resolveCotTarget` can still answer `null` for the same process (a group
 * chat participant whose provider no longer matches its agent), so the answer
 * here is a candidate, never a final decision to record.
 */
export function peekCotAgentId(
	processSessionId: string,
	deps: Pick<CotResolverDeps, 'getSessions' | 'getConsultParties'>
): string | null {
	const shape = classifyCotSessionId(processSessionId);
	if (shape.kind === 'unknown') noteUnknownShape(processSessionId);
	return agentOfShape(shape, deps)?.id ?? null;
}

/**
 * Work out whom a process turn belongs to.
 *
 * Returns `null` for anything that is not an agent turn the person asked for,
 * for an agent Maestro no longer has, and for a group chat participant that
 * cannot be tied to exactly one agent. It rejects only when a dependency does,
 * and the caller decides what that means.
 *
 * Only a group chat participant costs more than a lookup in memory: the chat's
 * metadata file is read once. A caller that routes events by process id must
 * hold the events of that process until this settles.
 */
export async function resolveCotTarget(
	processSessionId: string,
	deps: CotResolverDeps
): Promise<CotTarget | null> {
	const shape = classifyCotSessionId(processSessionId);
	if (shape.kind === 'unknown') noteUnknownShape(processSessionId);

	const agent = agentOfShape(shape, deps);
	if (!agent) return null;

	switch (shape.kind) {
		case 'agent-turn':
			return shape.origin === 'interactive'
				? { agentId: agent.id, origin: 'interactive', tabId: shape.tabId }
				: { agentId: agent.id, origin: 'auto-run' };

		case 'group-chat-participant': {
			const participant = await deps.getGroupChatParticipant(
				shape.groupChatId,
				shape.participantName
			);
			if (!participant || participant.agentId !== agent.toolType) return null;
			return { agentId: agent.id, origin: 'group-chat' };
		}

		case 'consult': {
			// Asked again: the consult can have settled since `agentOfShape` looked.
			const parties = deps.getConsultParties?.(shape.requestId);
			if (!parties || parties.targetSessionId !== agent.id) return null;
			return { agentId: agent.id, origin: 'consult', consultedBy: parties.sourceSessionId };
		}

		default:
			return null;
	}
}
