/**
 * Streaming module - Pure functions for message reconciliation
 *
 * This module exports the core streaming logic extracted from useSessionChat
 * for testability and potential reuse.
 */

export {
	streamingReducer,
	createInitialState,
	selectStreamingContent,
	selectIsStreaming,
	selectCommittedMessages,
	type StreamingState,
	type StreamingAction,
} from './reconcileStreamingMessage';
