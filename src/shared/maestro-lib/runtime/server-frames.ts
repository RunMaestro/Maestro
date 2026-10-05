/**
 * The frames a detached host pushes: runtime events in the shapes the desktop's WebSocket bridge
 * sends, so `createWsMaestroClient` reads a headless host exactly as it reads a desktop.
 *
 * Pure: an event in, frames out, no socket. It is the inverse of what the client does with a frame
 * (`client/bridge-frames.ts` and `ws-client.ts`): a turn event becomes the `process:*` channel the
 * desktop would have raised for `<agentId>-ai-<tabId>`, a run's progress becomes the flat
 * `autorun_state` projection, and an agent change becomes `sessions:lifecycleSync`.
 */

import type { AutoRunBroadcastState } from '../../autoRunBroadcast';
import type { AutoRunProgress } from '../autorun/progress';
import type { AutoRunRunEvent } from '../autorun/run-tracker';
import type { MaestroEvent, TurnEvent } from '../client/types';
import type { GroupChatEvent, GroupChatRecord } from '../groupchat/chat';

export type Frame = Record<string, unknown>;

/** The desktop's process id for an agent's AI tab, which is what the client parses back. */
export function tabProcessId(agentId: string, tabId: string): string {
	return `${agentId}-ai-${tabId}`;
}

/** A `bridge.event`: the desktop's IPC event channel, carried as a frame. */
function bridgeEvent(channel: string, ...args: unknown[]): Frame {
	return { type: 'bridge.event', channel, args };
}

/** Parsed progress back to the flat shape the host pushes. The inverse of `parseAutoRunProgress`. */
export function progressToWire(progress: AutoRunProgress): AutoRunBroadcastState {
	const { pause, goal } = progress;
	return {
		isRunning: progress.isRunning,
		isStopping: progress.isStopping,
		totalTasks: progress.currentDocTasksTotal,
		completedTasks: progress.currentDocTasksDone,
		currentTaskIndex: progress.currentDocTasksDone,
		totalDocuments: progress.documents.length,
		currentDocumentIndex: progress.currentDocumentIndex,
		totalTasksAcrossAllDocs: progress.tasksTotal,
		completedTasksAcrossAllDocs: progress.tasksDone,
		documents: progress.documents,
		currentDocTasksTotal: progress.currentDocTasksTotal,
		currentDocTasksCompleted: progress.currentDocTasksDone,
		loopEnabled: progress.loopEnabled,
		loopIteration: progress.loopIteration,
		...(progress.startTime !== undefined ? { startTime: progress.startTime } : {}),
		...(progress.worktreeBranch ? { worktreeBranch: progress.worktreeBranch } : {}),
		...(pause
			? {
					errorPaused: true,
					errorMessage: pause.message,
					errorType: pause.type,
					errorRecoverable: pause.recoverable,
					...(pause.taskDescription ? { errorTaskDescription: pause.taskDescription } : {}),
					...(pause.documentIndex !== undefined ? { errorDocumentIndex: pause.documentIndex } : {}),
				}
			: {}),
		...(goal
			? {
					goalMode: true,
					...(goal.percent !== undefined ? { goalProgress: goal.percent } : {}),
					...(goal.rationale ? { goalRationale: goal.rationale } : {}),
					...(goal.iteration !== undefined ? { goalIteration: goal.iteration } : {}),
				}
			: {}),
	};
}

/** The `autorun_state` frame for a run's wire state, or the `null` that clears it. */
export function autoRunStateFrame(agentId: string, state: AutoRunBroadcastState | null): Frame {
	return { type: 'autorun_state', sessionId: agentId, state };
}

/**
 * What a client folds a tool call from: the desktop's `process:tool-execution` payload, where the
 * call's status rides inside `state`. The runtime's `detail` is that state, minus a status it keeps
 * on the call itself.
 */
function toolPayload(tool: {
	id?: string;
	name: string;
	status: string;
	detail?: unknown;
	parentId?: string;
}): Record<string, unknown> {
	const detail =
		typeof tool.detail === 'object' && tool.detail !== null && !Array.isArray(tool.detail)
			? (tool.detail as Record<string, unknown>)
			: {};
	return {
		toolName: tool.name,
		state: { ...detail, status: tool.status },
		...(tool.id ? { toolCallId: tool.id } : {}),
		...(tool.parentId ? { parentToolUseId: tool.parentId } : {}),
	};
}

/** Remembers which tab turns already reported an error, so an outcome does not report it twice. */
export interface FrameState {
	erroredTurns: Set<string>;
}

export function createFrameState(): FrameState {
	return { erroredTurns: new Set() };
}

function turnFrames(agentId: string, tabId: string, event: TurnEvent, state: FrameState): Frame[] {
	const processId = tabProcessId(agentId, tabId);
	const turnKey = `${agentId}\u0000${tabId}`;
	switch (event.kind) {
		case 'user':
			return [
				bridgeEvent('process:user-input', {
					sessionId: agentId,
					tabId,
					inputMode: 'ai',
					entry: event.entry,
				}),
			];
		case 'session':
			return [bridgeEvent('process:session-id', processId, event.providerSessionId)];
		case 'thinking':
			return [bridgeEvent('process:thinking-chunk', processId, event.text)];
		case 'text':
			return [bridgeEvent('process:data', processId, event.text)];
		case 'tool':
			return [bridgeEvent('process:tool-execution', processId, toolPayload(event.tool))];
		case 'usage':
			return [bridgeEvent('process:usage', processId, event.usage)];
		case 'error':
			state.erroredTurns.add(turnKey);
			return [bridgeEvent('agent:error', processId, event.error)];
		case 'outcome': {
			const frames: Frame[] = [];
			if (event.error && !state.erroredTurns.has(turnKey)) {
				frames.push(bridgeEvent('agent:error', processId, event.error));
			}
			state.erroredTurns.delete(turnKey);
			// A stop reads as a signal exit: the client resolves `interrupted` from it.
			frames.push(
				bridgeEvent(
					'process:exit',
					processId,
					event.exitCode,
					event.outcome === 'interrupted' ? 'SIGINT' : null
				)
			);
			return frames;
		}
		// `started` is learned from the first frame, and a `gap` is the client's own signal.
		case 'started':
		case 'gap':
			return [];
	}
}

/** A run's progress, output, and usage: the flat state frame and the run's own batch process. */
function autoRunFrames(agentId: string, run: AutoRunRunEvent): Frame[] {
	switch (run.kind) {
		case 'state':
			return [autoRunStateFrame(agentId, run.state ? progressToWire(run.state) : null)];
		case 'output':
			return [bridgeEvent('process:data', run.processId, run.text)];
		case 'usage':
			return [bridgeEvent('process:usage', run.processId, run.usage)];
	}
}

/**
 * A chat as the desktop bridge reports it (`get_group_chats`, `get_group_chat_state`): the inverse
 * of `parseGroupChatRecord`. `topic` is the chat's name, the provider rides as `toolType`, and a
 * line's time is epoch ms, which that parser reads as it reads the desktop's ISO strings.
 */
export function groupChatToWire(chat: GroupChatRecord): Frame {
	return {
		id: chat.id,
		topic: chat.name,
		...(chat.moderatorProvider ? { moderatorAgentId: chat.moderatorProvider } : {}),
		participants: chat.participants.map((participant) => ({
			sessionId: participant.sessionId,
			name: participant.name,
			toolType: participant.provider,
		})),
		messages: chat.lines.map((line) => ({
			id: line.id,
			participantId: line.from,
			participantName: line.from,
			content: line.text,
			timestamp: line.at,
			role: line.from === 'user' ? 'user' : 'assistant',
		})),
		isActive: chat.state !== 'idle',
		state: chat.state,
		archived: chat.archived,
	};
}

/**
 * The `groupChat:*` channel a chat event travels on, in the desktop's own shapes: the inverse of
 * `parseGroupChatFrame`. A `gap` is the client's own signal that it missed events, so none is sent.
 */
function groupChatFrames(chatId: string, event: GroupChatEvent): Frame[] {
	switch (event.kind) {
		case 'message':
			return [
				bridgeEvent('groupChat:message', chatId, {
					timestamp: new Date(event.line.at).toISOString(),
					from: event.line.from,
					content: event.line.text,
				}),
			];
		case 'state':
			return [bridgeEvent('groupChat:stateChange', chatId, event.state)];
		case 'participant':
			return [
				bridgeEvent(
					'groupChat:participantState',
					chatId,
					event.name,
					event.working ? 'working' : 'idle'
				),
			];
		case 'participants':
			return [
				bridgeEvent(
					'groupChat:participantsChanged',
					chatId,
					event.participants.map((participant) => ({
						sessionId: participant.sessionId,
						name: participant.name,
						toolType: participant.provider,
						agentId: participant.provider,
					}))
				),
			];
		case 'gap':
			return [];
	}
}

/**
 * The frames one runtime event becomes. Tab events are left out: every tab change is followed by an
 * `agent.updated` carrying the whole agent, which is what a client reads tabs from.
 */
export function framesForEvent(event: MaestroEvent, state: FrameState): Frame[] {
	switch (event.type) {
		case 'agent.added':
		case 'agent.updated':
			return [bridgeEvent('sessions:lifecycleSync', { added: [event.agent], removedIds: [] })];
		case 'agent.removed':
			return [{ type: 'session_removed', sessionId: event.agentId }];
		case 'settings.changed':
			return [bridgeEvent('settings:externalChange')];
		case 'turn':
			return turnFrames(event.agentId, event.tabId, event.event, state);
		case 'autorun':
			return autoRunFrames(event.agentId, event.event);
		case 'groupChat':
			return groupChatFrames(event.chatId, event.event);
		default:
			return [];
	}
}
