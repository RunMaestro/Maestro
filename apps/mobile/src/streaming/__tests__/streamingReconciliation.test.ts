/**
 * Tests for streaming message reconciliation
 *
 * Verifies the core M1 streaming logic:
 * - Assistant text (SESSION_OUTPUT) appends to buffer
 * - Tool events render as discrete items, NOT buffer appends
 * - session_state_change to idle commits buffer to history
 */

import {
	streamingReducer,
	createInitialState,
	selectStreamingContent,
	selectIsStreaming,
	selectCommittedMessages,
	type StreamingState,
	type StreamingAction,
} from '../reconcileStreamingMessage';

describe('streamingReconciliation', () => {
	describe('initial state', () => {
		it('creates empty initial state', () => {
			const state = createInitialState();
			expect(state.messages).toEqual([]);
			expect(state.streamingBuffer).toBe('');
			expect(state.streamingMessageId).toBeNull();
			expect(state.isGenerating).toBe(false);
		});
	});

	describe('SESSION_OUTPUT events', () => {
		it('creates streaming message on first AI output', () => {
			const state = createInitialState();
			const action: StreamingAction = {
				type: 'SESSION_OUTPUT',
				data: 'Hello',
				source: 'ai',
				timestamp: 1000,
			};

			const next = streamingReducer(state, action);

			expect(next.messages).toHaveLength(1);
			expect(next.messages[0].role).toBe('assistant');
			expect(next.messages[0].content).toBe(''); // Placeholder, actual content in buffer
			expect(next.streamingBuffer).toBe('Hello');
			expect(next.streamingMessageId).toBe('assistant-1000');
			expect(next.isGenerating).toBe(true);
		});

		it('appends to buffer on subsequent AI output', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'Hello',
				source: 'ai',
				timestamp: 1000,
			});

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: ' world',
				source: 'ai',
				timestamp: 1001,
			});

			expect(state.messages).toHaveLength(1); // Still just one message
			expect(state.streamingBuffer).toBe('Hello world');
		});

		it('accumulates multiple chunks correctly', () => {
			let state = createInitialState();
			const chunks = ['I ', 'am ', 'streaming ', 'text.'];

			for (let i = 0; i < chunks.length; i++) {
				state = streamingReducer(state, {
					type: 'SESSION_OUTPUT',
					data: chunks[i],
					source: 'ai',
					timestamp: 1000 + i,
				});
			}

			expect(state.streamingBuffer).toBe('I am streaming text.');
		});

		it('ignores terminal output in AI chat', () => {
			const state = createInitialState();
			const action: StreamingAction = {
				type: 'SESSION_OUTPUT',
				data: 'terminal stuff',
				source: 'terminal',
				timestamp: 1000,
			};

			const next = streamingReducer(state, action);

			expect(next.messages).toHaveLength(0);
			expect(next.streamingBuffer).toBe('');
			expect(next.streamingMessageId).toBeNull();
		});
	});

	describe('TOOL_EVENT events', () => {
		it('adds tool event as discrete message, not buffer append', () => {
			let state = createInitialState();

			// Start streaming some text
			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'Let me help...',
				source: 'ai',
				timestamp: 1000,
			});

			// Tool event arrives
			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'tool-123',
				toolName: 'ReadFile',
				status: 'running',
			});

			// Should have 2 messages: streaming + tool
			expect(state.messages).toHaveLength(2);
			expect(state.messages[1].id).toBe('tool-tool-123');
			expect(state.messages[1].content).toBe('Running: ReadFile');

			// Buffer should be unchanged
			expect(state.streamingBuffer).toBe('Let me help...');
		});

		it('updates existing tool message on status change', () => {
			let state = createInitialState();

			// Tool starts running
			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'tool-456',
				toolName: 'Write',
				status: 'running',
			});

			expect(state.messages[0].content).toBe('Running: Write');

			// Tool completes
			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'tool-456',
				toolName: 'Write',
				status: 'completed',
			});

			expect(state.messages).toHaveLength(1); // Still one message
			expect(state.messages[0].content).toBe('Completed: Write');
		});

		it('renders error status correctly', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'tool-789',
				toolName: 'Execute',
				status: 'error',
			});

			expect(state.messages[0].content).toBe('Error: Execute');
		});

		it('handles multiple concurrent tools', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'tool-a',
				toolName: 'Read',
				status: 'running',
			});

			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'tool-b',
				toolName: 'Search',
				status: 'running',
			});

			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'tool-a',
				toolName: 'Read',
				status: 'completed',
			});

			expect(state.messages).toHaveLength(2);
			expect(state.messages[0].content).toBe('Completed: Read');
			expect(state.messages[1].content).toBe('Running: Search');
		});
	});

	describe('SESSION_STATE_CHANGE to idle', () => {
		it('commits streaming buffer to message history', () => {
			let state = createInitialState();

			// Stream some content
			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'Final answer.',
				source: 'ai',
				timestamp: 1000,
			});

			expect(state.messages[0].content).toBe(''); // Placeholder

			// Session goes idle
			state = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'idle',
			});

			expect(state.messages[0].content).toBe('Final answer.');
			expect(state.streamingBuffer).toBe('');
			expect(state.streamingMessageId).toBeNull();
			expect(state.isGenerating).toBe(false);
		});

		it('commits on ready state as well', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'Done.',
				source: 'ai',
				timestamp: 2000,
			});

			state = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'ready',
			});

			expect(state.messages[0].content).toBe('Done.');
			expect(state.isGenerating).toBe(false);
		});

		it('handles idle with no buffer gracefully', () => {
			const state = createInitialState();

			const next = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'idle',
			});

			expect(next.messages).toHaveLength(0);
			expect(next.isGenerating).toBe(false);
		});

		it('sets isGenerating true on running state', () => {
			const state = createInitialState();

			const next = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'running',
			});

			expect(next.isGenerating).toBe(true);
		});

		it('sets isGenerating true on busy state', () => {
			const state = createInitialState();

			const next = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'busy',
			});

			expect(next.isGenerating).toBe(true);
		});
	});

	describe('USER_INPUT events', () => {
		it('adds user message to history', () => {
			const state = createInitialState();

			const next = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'Hello!',
				timestamp: 5000,
			});

			expect(next.messages).toHaveLength(1);
			expect(next.messages[0].id).toBe('user-5000');
			expect(next.messages[0].role).toBe('user');
			expect(next.messages[0].content).toBe('Hello!');
		});

		it('interleaves user and assistant messages', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'Question?',
				timestamp: 1000,
			});

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'Answer.',
				source: 'ai',
				timestamp: 2000,
			});

			state = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'idle',
			});

			state = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'Follow-up?',
				timestamp: 3000,
			});

			expect(state.messages).toHaveLength(3);
			expect(state.messages[0].role).toBe('user');
			expect(state.messages[1].role).toBe('assistant');
			expect(state.messages[2].role).toBe('user');
		});
	});

	describe('CLEAR action', () => {
		it('resets to initial state', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'test',
				timestamp: 1000,
			});

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'response',
				source: 'ai',
				timestamp: 2000,
			});

			state = streamingReducer(state, { type: 'CLEAR' });

			expect(state).toEqual(createInitialState());
		});
	});

	describe('selectors', () => {
		it('selectStreamingContent returns buffer content', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'streaming...',
				source: 'ai',
				timestamp: 1000,
			});

			expect(selectStreamingContent(state)).toBe('streaming...');
		});

		it('selectIsStreaming returns true when streaming', () => {
			let state = createInitialState();
			expect(selectIsStreaming(state)).toBe(false);

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'x',
				source: 'ai',
				timestamp: 1000,
			});

			expect(selectIsStreaming(state)).toBe(true);
		});

		it('selectCommittedMessages excludes in-flight streaming message', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'test',
				timestamp: 1000,
			});

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'partial...',
				source: 'ai',
				timestamp: 2000,
			});

			const committed = selectCommittedMessages(state);
			expect(committed).toHaveLength(1);
			expect(committed[0].role).toBe('user');
		});

		it('selectCommittedMessages includes all after commit', () => {
			let state = createInitialState();

			state = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'test',
				timestamp: 1000,
			});

			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'done',
				source: 'ai',
				timestamp: 2000,
			});

			state = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'idle',
			});

			const committed = selectCommittedMessages(state);
			expect(committed).toHaveLength(2);
		});
	});

	describe('complex sequences', () => {
		it('handles full conversation with tools', () => {
			let state = createInitialState();

			// User asks a question
			state = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'Read my file',
				timestamp: 1000,
			});

			// Assistant starts responding
			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'Let me read that...',
				source: 'ai',
				timestamp: 2000,
			});

			// Tool starts
			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'read-1',
				toolName: 'Read',
				status: 'running',
			});

			// Tool completes
			state = streamingReducer(state, {
				type: 'TOOL_EVENT',
				toolId: 'read-1',
				toolName: 'Read',
				status: 'completed',
			});

			// More streaming output
			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: ' Here is the content.',
				source: 'ai',
				timestamp: 3000,
			});

			// Session goes idle
			state = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'idle',
			});

			expect(state.messages).toHaveLength(3);
			expect(state.messages[0].role).toBe('user');
			expect(state.messages[1].role).toBe('assistant');
			expect(state.messages[1].content).toBe('Let me read that... Here is the content.');
			expect(state.messages[2].content).toBe('Completed: Read');
			expect(state.isGenerating).toBe(false);
		});

		it('handles multiple conversation turns', () => {
			let state = createInitialState();

			// Turn 1
			state = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'Hello',
				timestamp: 1000,
			});
			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: 'Hi there!',
				source: 'ai',
				timestamp: 2000,
			});
			state = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'idle',
			});

			// Turn 2
			state = streamingReducer(state, {
				type: 'USER_INPUT',
				command: 'How are you?',
				timestamp: 3000,
			});
			state = streamingReducer(state, {
				type: 'SESSION_OUTPUT',
				data: "I'm doing well!",
				source: 'ai',
				timestamp: 4000,
			});
			state = streamingReducer(state, {
				type: 'SESSION_STATE_CHANGE',
				state: 'idle',
			});

			expect(state.messages).toHaveLength(4);
			expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		});
	});
});
