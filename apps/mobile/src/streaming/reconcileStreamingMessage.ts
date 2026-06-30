/**
 * Streaming message reconciliation logic
 *
 * This module extracts the core M1 streaming logic from the useSessionChat hook
 * into pure, testable functions. These functions determine how incoming WebSocket
 * events are reconciled into chat messages:
 *
 * 1. session_output (source: 'ai') - appends text to the streaming buffer
 * 2. tool_event - renders as discrete list items, NOT buffer appends
 * 3. session_state_change (to idle) - commits buffer to message history
 *
 * The reconciliation is implemented as a reducer pattern for testability.
 */

import type { ChatMessage } from '../components/chat/types';

// ============================================================================
// Types
// ============================================================================

export interface StreamingState {
	/** Current messages in the chat */
	messages: ChatMessage[];
	/** In-flight streaming buffer content */
	streamingBuffer: string;
	/** ID of the current streaming assistant message, if any */
	streamingMessageId: string | null;
	/** Whether the assistant is currently generating */
	isGenerating: boolean;
}

export type StreamingAction =
	| {
			type: 'SESSION_OUTPUT';
			data: string;
			source: 'ai' | 'terminal';
			timestamp: number;
	  }
	| {
			type: 'TOOL_EVENT';
			toolId: string;
			toolName: string;
			status: 'running' | 'completed' | 'error';
	  }
	| {
			type: 'SESSION_STATE_CHANGE';
			state: 'idle' | 'ready' | 'running' | 'busy';
	  }
	| {
			type: 'USER_INPUT';
			command: string;
			timestamp: number;
	  }
	| {
			type: 'CLEAR';
	  };

// ============================================================================
// Initial State
// ============================================================================

export function createInitialState(): StreamingState {
	return {
		messages: [],
		streamingBuffer: '',
		streamingMessageId: null,
		isGenerating: false,
	};
}

// ============================================================================
// Reducer
// ============================================================================

/**
 * Reconciles streaming events into chat message state.
 *
 * Key behaviors:
 * - SESSION_OUTPUT (ai): Creates streaming message on first chunk, appends to buffer on subsequent
 * - TOOL_EVENT: Adds/updates tool status as discrete messages (not buffer appends)
 * - SESSION_STATE_CHANGE (idle/ready): Commits streaming buffer to final message
 * - USER_INPUT: Adds user message to history
 * - CLEAR: Resets all state
 */
export function streamingReducer(state: StreamingState, action: StreamingAction): StreamingState {
	switch (action.type) {
		case 'SESSION_OUTPUT': {
			// Ignore terminal output in AI chat
			if (action.source !== 'ai') {
				return state;
			}

			// If no streaming message exists, create one
			if (!state.streamingMessageId) {
				const messageId = `assistant-${action.timestamp}`;
				return {
					...state,
					messages: [...state.messages, { id: messageId, role: 'assistant', content: '' }],
					streamingBuffer: action.data,
					streamingMessageId: messageId,
					isGenerating: true,
				};
			}

			// Append to existing buffer
			return {
				...state,
				streamingBuffer: state.streamingBuffer + action.data,
			};
		}

		case 'TOOL_EVENT': {
			const toolMessageId = `tool-${action.toolId}`;
			const toolContent =
				action.status === 'running'
					? `Running: ${action.toolName}`
					: action.status === 'completed'
						? `Completed: ${action.toolName}`
						: `Error: ${action.toolName}`;

			// Check if tool message already exists
			const existingIdx = state.messages.findIndex((m) => m.id === toolMessageId);

			if (existingIdx >= 0) {
				// Update existing tool message
				const updated = [...state.messages];
				updated[existingIdx] = {
					...updated[existingIdx],
					content: toolContent,
				};
				return {
					...state,
					messages: updated,
				};
			}

			// Add new tool message (does NOT append to streaming buffer)
			return {
				...state,
				messages: [
					...state.messages,
					{ id: toolMessageId, role: 'assistant', content: toolContent },
				],
			};
		}

		case 'SESSION_STATE_CHANGE': {
			if (action.state === 'idle' || action.state === 'ready') {
				// Commit streaming buffer to final message
				if (state.streamingMessageId && state.streamingBuffer) {
					const finalContent = state.streamingBuffer;
					const msgId = state.streamingMessageId;

					const updated = state.messages.map((m) =>
						m.id === msgId ? { ...m, content: finalContent } : m
					);

					return {
						...state,
						messages: updated,
						streamingBuffer: '',
						streamingMessageId: null,
						isGenerating: false,
					};
				}

				// No buffer to commit, just stop generating
				return {
					...state,
					isGenerating: false,
				};
			}

			if (action.state === 'running' || action.state === 'busy') {
				return {
					...state,
					isGenerating: true,
				};
			}

			return state;
		}

		case 'USER_INPUT': {
			const messageId = `user-${action.timestamp}`;
			return {
				...state,
				messages: [...state.messages, { id: messageId, role: 'user', content: action.command }],
			};
		}

		case 'CLEAR': {
			return createInitialState();
		}

		default:
			return state;
	}
}

// ============================================================================
// Selectors
// ============================================================================

/**
 * Returns the current streaming buffer content for UI display.
 * The actual message in state has empty content while streaming;
 * the buffer provides the live text.
 */
export function selectStreamingContent(state: StreamingState): string {
	return state.streamingBuffer;
}

/**
 * Returns true if a streaming message is in progress.
 */
export function selectIsStreaming(state: StreamingState): boolean {
	return state.streamingMessageId !== null;
}

/**
 * Returns only committed messages (excludes the in-flight streaming placeholder).
 */
export function selectCommittedMessages(state: StreamingState): ChatMessage[] {
	if (!state.streamingMessageId) {
		return state.messages;
	}
	return state.messages.filter((m) => m.id !== state.streamingMessageId);
}
