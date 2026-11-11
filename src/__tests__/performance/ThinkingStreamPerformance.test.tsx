/**
 * @file ThinkingStreamPerformance.test.tsx
 * @description Performance tests for the Show Thinking feature with large streams
 *
 * Task 6.5 - Test performance with large thinking streams (10-50KB+ per response):
 * - RAF throttling efficiency for rapid chunk arrivals
 * - Memory usage during large stream accumulation
 * - UI responsiveness with 10KB, 25KB, and 50KB+ thinking content
 * - Chunk batching effectiveness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme, LogEntry, Session, AITab } from '../../renderer/types';

import { createMockTheme } from '../helpers/mockTheme';
import { GrokOutputParser } from '../../shared/maestro-lib/parsers/grok-output-parser';
import {
	GROK_SYNTHETIC_LINES_PER_ROUND,
	GROK_SYNTHETIC_ROUNDS,
	GROK_SYNTHETIC_SESSION_ID,
	grokSyntheticStream,
} from '../helpers/grokSyntheticStream';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Generate a large thinking stream content of specified size
 * Simulates Codex reasoning tokens which can be very verbose
 */
const generateThinkingContent = (sizeKb: number): string => {
	const targetBytes = sizeKb * 1024;
	const reasoningPatterns = [
		'Let me analyze this step by step. ',
		'First, I need to understand the context. ',
		'Looking at the code structure, I can see that ',
		'The implementation requires considering several factors: ',
		'Based on my analysis, the approach should be ',
		'Examining the dependencies and their interactions... ',
		'This function handles the core logic for ',
		'The data flow follows this pattern: ',
		'Considering edge cases such as null values and errors... ',
		'The optimal solution would involve ',
	];

	let content = '';
	let patternIndex = 0;

	while (content.length < targetBytes) {
		content += reasoningPatterns[patternIndex % reasoningPatterns.length];
		patternIndex++;
	}

	return content.slice(0, targetBytes);
};

/**
 * Split content into chunks of varying sizes (simulating real streaming)
 */
const splitIntoChunks = (content: string, avgChunkSize: number): string[] => {
	const chunks: string[] = [];
	let position = 0;

	while (position < content.length) {
		// Vary chunk size by ±50% to simulate real network conditions
		const variation = 0.5 + Math.random();
		const chunkSize = Math.floor(avgChunkSize * variation);
		chunks.push(content.slice(position, position + chunkSize));
		position += chunkSize;
	}

	return chunks;
};

// Create mock theme

// Mock the thinking chunk handler logic (extracted from App.tsx)
interface ThinkingChunkBuffer {
	buffer: Map<string, string>;
	rafId: number | null;
}

const createThinkingChunkHandler = (
	onUpdate: (sessionId: string, tabId: string, content: string) => void
) => {
	const state: ThinkingChunkBuffer = {
		buffer: new Map(),
		rafId: null,
	};

	const handleChunk = (sessionId: string, tabId: string, content: string) => {
		const bufferKey = `${sessionId}:${tabId}`;
		const existingContent = state.buffer.get(bufferKey) || '';
		state.buffer.set(bufferKey, existingContent + content);

		if (state.rafId === null) {
			state.rafId = requestAnimationFrame(() => {
				const chunksToProcess = new Map(state.buffer);
				state.buffer.clear();
				state.rafId = null;

				for (const [key, bufferedContent] of chunksToProcess) {
					const [sid, tid] = key.split(':');
					onUpdate(sid, tid, bufferedContent);
				}
			});
		}
	};

	const cleanup = () => {
		if (state.rafId !== null) {
			cancelAnimationFrame(state.rafId);
			state.rafId = null;
		}
		state.buffer.clear();
	};

	return { handleChunk, cleanup, getBufferSize: () => state.buffer.size };
};

// ============================================================================
// Performance Test Component
// ============================================================================

interface ThinkingDisplayProps {
	logs: LogEntry[];
	theme: Theme;
}

const ThinkingDisplay: React.FC<ThinkingDisplayProps> = ({ logs, theme }) => {
	const thinkingLogs = logs.filter((l) => l.source === 'thinking');

	return (
		<div data-testid="thinking-display">
			{thinkingLogs.map((log) => (
				<div
					key={log.id}
					data-testid="thinking-entry"
					className="px-4 py-2 text-sm font-mono border-l-2"
					style={{
						color: theme.colors.textDim,
						borderColor: theme.colors.accentText,
						backgroundColor: `${theme.colors.accentText}05`,
						opacity: 0.85,
					}}
				>
					<div className="flex items-center gap-2 mb-1">
						<span
							className="text-[10px] px-1.5 py-0.5 rounded"
							style={{
								backgroundColor: `${theme.colors.accentText}20`,
								color: theme.colors.accentText,
							}}
						>
							thinking
						</span>
					</div>
					<div className="whitespace-pre-wrap" data-testid="thinking-content">
						{log.text}
					</div>
				</div>
			))}
		</div>
	);
};

// ============================================================================
// Tests
// ============================================================================

describe('ThinkingStreamPerformance', () => {
	let mockRaf: (callback: FrameRequestCallback) => number;
	let mockCancelRaf: (id: number) => void;
	let rafCallbacks: Map<number, FrameRequestCallback>;
	let rafIdCounter: number;

	beforeEach(() => {
		vi.useFakeTimers();

		// Set up RAF mock with control over when frames execute
		rafCallbacks = new Map();
		rafIdCounter = 0;

		mockRaf = vi.fn((callback: FrameRequestCallback) => {
			const id = ++rafIdCounter;
			rafCallbacks.set(id, callback);
			return id;
		});

		mockCancelRaf = vi.fn((id: number) => {
			rafCallbacks.delete(id);
		});

		// Replace global functions
		global.requestAnimationFrame = mockRaf;
		global.cancelAnimationFrame = mockCancelRaf;
	});

	afterEach(() => {
		vi.useRealTimers();
		rafCallbacks.clear();
	});

	// Helper to flush all pending RAF callbacks
	const flushRafCallbacks = () => {
		const callbacks = Array.from(rafCallbacks.values());
		rafCallbacks.clear();
		const timestamp = performance.now();
		callbacks.forEach((cb) => cb(timestamp));
	};

	describe('RAF Throttling Efficiency', () => {
		it('should batch multiple rapid chunk arrivals into single RAF callback', () => {
			const updates: Array<{ sessionId: string; tabId: string; content: string }> = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((sessionId, tabId, content) =>
				updates.push({ sessionId, tabId, content })
			);

			// Simulate 100 rapid chunks arriving within the same frame
			const chunks = splitIntoChunks(generateThinkingContent(10), 100);

			for (const chunk of chunks) {
				handleChunk('session-1', 'tab-1', chunk);
			}

			// Before RAF fires, no updates should have happened
			expect(updates.length).toBe(0);
			expect(mockRaf).toHaveBeenCalledTimes(1); // Only one RAF scheduled

			// Execute the RAF callback
			flushRafCallbacks();

			// All chunks should be batched into a single update
			expect(updates.length).toBe(1);
			expect(updates[0].content.length).toBeGreaterThan(chunks.length * 50); // Batched content

			cleanup();
		});

		it('should handle chunks for multiple sessions simultaneously', () => {
			const updates: Array<{ sessionId: string; tabId: string; content: string }> = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((sessionId, tabId, content) =>
				updates.push({ sessionId, tabId, content })
			);

			// Send chunks to 3 different sessions
			handleChunk('session-1', 'tab-1', 'Content for session 1');
			handleChunk('session-2', 'tab-1', 'Content for session 2');
			handleChunk('session-3', 'tab-1', 'Content for session 3');
			handleChunk('session-1', 'tab-1', ' - more content'); // Additional for session 1

			expect(mockRaf).toHaveBeenCalledTimes(1);

			flushRafCallbacks();

			// Should have 3 updates (one per session)
			expect(updates.length).toBe(3);

			const session1Update = updates.find((u) => u.sessionId === 'session-1');
			expect(session1Update?.content).toBe('Content for session 1 - more content');

			cleanup();
		});

		it('should not schedule new RAF while one is pending', () => {
			const updates: Array<{ sessionId: string; tabId: string; content: string }> = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((sessionId, tabId, content) =>
				updates.push({ sessionId, tabId, content })
			);

			// Send many chunks
			for (let i = 0; i < 1000; i++) {
				handleChunk('session-1', 'tab-1', `chunk-${i} `);
			}

			// Should only have one RAF scheduled despite 1000 chunks
			expect(mockRaf).toHaveBeenCalledTimes(1);

			flushRafCallbacks();

			expect(updates.length).toBe(1);
			expect(updates[0].content).toContain('chunk-0');
			expect(updates[0].content).toContain('chunk-999');

			cleanup();
		});
	});

	describe('Large Stream Handling', () => {
		it('should handle 10KB thinking stream efficiently', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((_sid, _tid, content) =>
				updates.push(content)
			);

			const content = generateThinkingContent(10);
			const chunks = splitIntoChunks(content, 256); // Average 256 bytes per chunk

			const startTime = performance.now();

			for (const chunk of chunks) {
				handleChunk('session-1', 'tab-1', chunk);
			}

			flushRafCallbacks();

			const elapsed = performance.now() - startTime;

			// Performance assertion: should process 10KB in under 100ms
			expect(elapsed).toBeLessThan(100);
			expect(updates.length).toBe(1);
			expect(updates[0].length).toBe(content.length);

			cleanup();
		});

		it('should handle 25KB thinking stream efficiently', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((_sid, _tid, content) =>
				updates.push(content)
			);

			const content = generateThinkingContent(25);
			const chunks = splitIntoChunks(content, 512);

			const startTime = performance.now();

			for (const chunk of chunks) {
				handleChunk('session-1', 'tab-1', chunk);
			}

			flushRafCallbacks();

			const elapsed = performance.now() - startTime;

			// Performance assertion: should process 25KB in under 150ms
			expect(elapsed).toBeLessThan(150);
			expect(updates.length).toBe(1);
			expect(updates[0].length).toBe(content.length);

			cleanup();
		});

		it('should handle 50KB thinking stream (Codex reasoning) efficiently', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((_sid, _tid, content) =>
				updates.push(content)
			);

			const content = generateThinkingContent(50);
			const chunks = splitIntoChunks(content, 1024);

			const startTime = performance.now();

			for (const chunk of chunks) {
				handleChunk('session-1', 'tab-1', chunk);
			}

			flushRafCallbacks();

			const elapsed = performance.now() - startTime;

			// Performance assertion: should process 50KB in under 200ms
			expect(elapsed).toBeLessThan(200);
			expect(updates.length).toBe(1);
			expect(updates[0].length).toBe(content.length);

			cleanup();
		});

		it('should handle 100KB+ extreme stream without hanging', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((_sid, _tid, content) =>
				updates.push(content)
			);

			const content = generateThinkingContent(100);
			const chunks = splitIntoChunks(content, 2048);

			const startTime = performance.now();

			for (const chunk of chunks) {
				handleChunk('session-1', 'tab-1', chunk);
			}

			flushRafCallbacks();

			const elapsed = performance.now() - startTime;

			// Performance assertion: should process 100KB in under 500ms
			expect(elapsed).toBeLessThan(500);
			expect(updates.length).toBe(1);
			expect(updates[0].length).toBe(content.length);

			cleanup();
		});
	});

	describe('Memory Efficiency', () => {
		it('should clear buffer after processing', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup, getBufferSize } = createThinkingChunkHandler(
				(_sid, _tid, content) => updates.push(content)
			);

			handleChunk('session-1', 'tab-1', 'test content');
			expect(getBufferSize()).toBe(1);

			flushRafCallbacks();

			expect(getBufferSize()).toBe(0);

			cleanup();
		});

		it('should cleanup properly on unmount', () => {
			const { handleChunk, cleanup } = createThinkingChunkHandler(() => {});

			// Schedule some chunks
			handleChunk('session-1', 'tab-1', 'test');

			// Cleanup before RAF fires
			cleanup();

			// RAF should have been cancelled
			expect(mockCancelRaf).toHaveBeenCalled();
		});

		it('should not accumulate memory with repeated stream cycles', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup, getBufferSize } = createThinkingChunkHandler(
				(_sid, _tid, content) => updates.push(content)
			);

			// Simulate multiple complete stream cycles
			for (let cycle = 0; cycle < 10; cycle++) {
				const content = generateThinkingContent(5);
				const chunks = splitIntoChunks(content, 512);

				for (const chunk of chunks) {
					handleChunk('session-1', 'tab-1', chunk);
				}

				flushRafCallbacks();

				// Buffer should be empty after each cycle
				expect(getBufferSize()).toBe(0);
			}

			expect(updates.length).toBe(10);

			cleanup();
		});
	});

	describe('UI Rendering Performance', () => {
		it('should render 10KB thinking content without performance issues', () => {
			const theme = createMockTheme();
			const content = generateThinkingContent(10);
			const logs: LogEntry[] = [
				{
					id: 'thinking-1',
					timestamp: Date.now(),
					source: 'thinking',
					text: content,
				},
			];

			const startTime = performance.now();

			const { container } = render(
				<LayerStackProvider>
					<ThinkingDisplay logs={logs} theme={theme} />
				</LayerStackProvider>
			);

			const elapsed = performance.now() - startTime;

			// Should render in under 100ms
			expect(elapsed).toBeLessThan(100);

			const thinkingContent = screen.getByTestId('thinking-content');
			expect(thinkingContent.textContent?.length).toBe(content.length);
		});

		it('should render 50KB thinking content without hanging', () => {
			const theme = createMockTheme();
			const content = generateThinkingContent(50);
			const logs: LogEntry[] = [
				{
					id: 'thinking-1',
					timestamp: Date.now(),
					source: 'thinking',
					text: content,
				},
			];

			const startTime = performance.now();

			render(
				<LayerStackProvider>
					<ThinkingDisplay logs={logs} theme={theme} />
				</LayerStackProvider>
			);

			const elapsed = performance.now() - startTime;

			// Should render in under 500ms even for large content
			expect(elapsed).toBeLessThan(500);
		});

		it('should handle incremental content updates efficiently', async () => {
			const theme = createMockTheme();
			const logs: LogEntry[] = [
				{
					id: 'thinking-1',
					timestamp: Date.now(),
					source: 'thinking',
					text: 'Initial content',
				},
			];

			const { rerender } = render(
				<LayerStackProvider>
					<ThinkingDisplay logs={logs} theme={theme} />
				</LayerStackProvider>
			);

			// Simulate incremental updates (like streaming)
			const updateTimes: number[] = [];

			for (let i = 0; i < 20; i++) {
				const startTime = performance.now();

				// Append more content
				logs[0].text += generateThinkingContent(1);

				rerender(
					<LayerStackProvider>
						<ThinkingDisplay logs={[{ ...logs[0] }]} theme={theme} />
					</LayerStackProvider>
				);

				updateTimes.push(performance.now() - startTime);
			}

			// Average update time should be under 50ms
			const avgTime = updateTimes.reduce((a, b) => a + b, 0) / updateTimes.length;
			expect(avgTime).toBeLessThan(50);
		});
	});

	describe('Chunk Batching Edge Cases', () => {
		it('should handle empty chunks gracefully', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((_sid, _tid, content) =>
				updates.push(content)
			);

			handleChunk('session-1', 'tab-1', '');
			handleChunk('session-1', 'tab-1', 'actual content');
			handleChunk('session-1', 'tab-1', '');

			flushRafCallbacks();

			expect(updates.length).toBe(1);
			expect(updates[0]).toBe('actual content');

			cleanup();
		});

		it('should handle very small chunks (1-5 bytes) efficiently', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((_sid, _tid, content) =>
				updates.push(content)
			);

			const content = generateThinkingContent(5);

			// Split into very small chunks (simulating character-by-character streaming)
			for (let i = 0; i < content.length; i++) {
				handleChunk('session-1', 'tab-1', content[i]);
			}

			expect(mockRaf).toHaveBeenCalledTimes(1); // Still just one RAF

			flushRafCallbacks();

			expect(updates.length).toBe(1);
			expect(updates[0]).toBe(content);

			cleanup();
		});

		it('should handle interleaved chunks from multiple tabs', () => {
			const updates: Array<{ sessionId: string; tabId: string; content: string }> = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((sessionId, tabId, content) =>
				updates.push({ sessionId, tabId, content })
			);

			// Interleave chunks from different tabs
			for (let i = 0; i < 100; i++) {
				handleChunk('session-1', `tab-${i % 3}`, `chunk-${i} `);
			}

			flushRafCallbacks();

			// Should have 3 updates (one per tab)
			expect(updates.length).toBe(3);

			// Verify each tab got its chunks
			const tab0Update = updates.find((u) => u.tabId === 'tab-0');
			const tab1Update = updates.find((u) => u.tabId === 'tab-1');
			const tab2Update = updates.find((u) => u.tabId === 'tab-2');

			expect(tab0Update?.content).toContain('chunk-0');
			expect(tab1Update?.content).toContain('chunk-1');
			expect(tab2Update?.content).toContain('chunk-2');

			cleanup();
		});
	});

	describe('Stress Testing', () => {
		it('should handle sustained high-frequency chunk arrivals', () => {
			const updates: string[] = [];
			const { handleChunk, cleanup } = createThinkingChunkHandler((_sid, _tid, content) =>
				updates.push(content)
			);

			// Simulate 10 seconds of sustained streaming at 60fps
			// Each frame gets 10 chunks
			const framesCount = 600; // 10 seconds at 60fps
			const chunksPerFrame = 10;

			const startTime = performance.now();

			for (let frame = 0; frame < framesCount; frame++) {
				for (let chunk = 0; chunk < chunksPerFrame; chunk++) {
					handleChunk('session-1', 'tab-1', `frame-${frame}-chunk-${chunk} `);
				}

				// Flush RAF to simulate frame completion
				flushRafCallbacks();
			}

			const elapsed = performance.now() - startTime;

			// Should process all frames in reasonable time (under 5 seconds with fake timers)
			expect(elapsed).toBeLessThan(5000);
			expect(updates.length).toBe(framesCount);

			cleanup();
		});

		it('should maintain consistency under concurrent session load', () => {
			const updates: Map<string, string[]> = new Map();
			const { handleChunk, cleanup } = createThinkingChunkHandler((sessionId, _tabId, content) => {
				const sessionUpdates = updates.get(sessionId) || [];
				sessionUpdates.push(content);
				updates.set(sessionId, sessionUpdates);
			});

			const sessionCount = 10;
			const chunksPerSession = 100;

			// Send chunks to many sessions
			for (let chunk = 0; chunk < chunksPerSession; chunk++) {
				for (let session = 0; session < sessionCount; session++) {
					handleChunk(`session-${session}`, 'tab-1', `s${session}c${chunk} `);
				}

				// Flush every 10 chunks
				if ((chunk + 1) % 10 === 0) {
					flushRafCallbacks();
				}
			}

			// Final flush
			flushRafCallbacks();

			// Each session should have received all its chunks
			for (let session = 0; session < sessionCount; session++) {
				const sessionUpdates = updates.get(`session-${session}`);
				expect(sessionUpdates).toBeDefined();

				// Combine all updates for this session
				const fullContent = sessionUpdates!.join('');
				expect(fullContent).toContain(`s${session}c0`);
				expect(fullContent).toContain(`s${session}c99`);
			}

			cleanup();
		});
	});

	describe('synthetic Grok stream (real parser, frame-batched updates)', () => {
		/**
		 * Drives a bounded synthetic Grok turn (src/__tests__/helpers/grokSyntheticStream.ts)
		 * through the real GrokOutputParser and the frame batcher above, one frame
		 * per round. Every assertion is a count (frames scheduled, commits, events,
		 * bytes) over a workload of known size, so none of it depends on how fast
		 * the machine is.
		 */
		const GROK_TAB = 'tab-grok';

		interface GrokStreamHarness {
			handler: ReturnType<typeof createThinkingChunkHandler>;
			toolEvents: number;
			openTools: Set<string>;
			sessionId: string | null;
			usage: ReturnType<GrokOutputParser['extractUsage']>;
			feedRound: (lines: string[]) => void;
		}

		const createGrokHarness = (
			onUpdate: (sessionId: string, tabId: string, content: string) => void
		): GrokStreamHarness => {
			const parser = new GrokOutputParser();
			const handler = createThinkingChunkHandler(onUpdate);
			const harness: GrokStreamHarness = {
				handler,
				toolEvents: 0,
				openTools: new Set(),
				sessionId: null,
				usage: null,
				feedRound: (lines) => {
					for (const raw of lines) {
						const event = parser.parseJsonLine(raw.trimEnd());
						if (!event) continue;
						if (event.type === 'text' && event.isPartial && event.text) {
							// Reasoning and answer text go to separate buffer keys,
							// as the renderer keeps them in separate log entries.
							handler.handleChunk(event.isReasoning ? 'thinking' : 'answer', GROK_TAB, event.text);
						} else if (event.type === 'tool_use' && event.toolCallId) {
							harness.toolEvents++;
							const status = (event.toolState as { status?: string } | undefined)?.status;
							if (status === 'running') harness.openTools.add(event.toolCallId);
							else harness.openTools.delete(event.toolCallId);
						} else if (event.type === 'result') {
							harness.sessionId = parser.extractSessionId(event);
							harness.usage = parser.extractUsage(event);
						}
					}
				},
			};
			return harness;
		};

		const roundsOf = (lines: string[], rounds: number): string[][] =>
			Array.from({ length: rounds }, (_, i) =>
				lines.slice(i * GROK_SYNTHETIC_LINES_PER_ROUND, (i + 1) * GROK_SYNTHETIC_LINES_PER_ROUND)
			);

		const GrokStreamView: React.FC<{
			subscribe: (push: (key: string, content: string) => void) => void;
			onCommit: () => void;
		}> = ({ subscribe, onCommit }) => {
			const [thinking, setThinking] = React.useState('');
			const [answer, setAnswer] = React.useState('');
			React.useEffect(() => {
				subscribe((key, content) =>
					key === 'thinking'
						? setThinking((prev) => prev + content)
						: setAnswer((prev) => prev + content)
				);
			}, [subscribe]);
			return (
				<React.Profiler id="grok-stream" onRender={onCommit}>
					<div data-testid="grok-thinking">{thinking}</div>
					<div data-testid="grok-answer">{answer}</div>
				</React.Profiler>
			);
		};

		it('commits once per frame however many deltas a frame carries, with stable final text', () => {
			const stream = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS);
			let push: (key: string, content: string) => void = () => {};
			let commits = 0;
			render(
				<GrokStreamView
					subscribe={(fn) => {
						push = fn;
					}}
					onCommit={() => {
						commits++;
					}}
				/>
			);
			const commitsAtMount = commits;
			const harness = createGrokHarness((key, _tab, content) => push(key, content));

			const rounds = roundsOf(stream.lines, stream.rounds);
			for (const round of rounds) {
				harness.feedRound(round);
				act(() => {
					flushRafCallbacks();
				});
				expect(harness.handler.getBufferSize()).toBe(0); // bounded: nothing left buffered
			}
			harness.feedRound(stream.lines.slice(rounds.length * GROK_SYNTHETIC_LINES_PER_ROUND));

			// One animation frame per round, though each round carried a thought
			// delta, a text delta and four tool or usage lines.
			expect(mockRaf).toHaveBeenCalledTimes(stream.rounds);
			// One commit per frame: React batches the two state updates a frame
			// makes, so commits grow with frames, not with deltas.
			expect(commits - commitsAtMount).toBe(stream.rounds);

			expect(screen.getByTestId('grok-answer').textContent).toBe(stream.answer);
			expect(screen.getByTestId('grok-thinking').textContent?.length).toBe(stream.thoughtBytes);

			// Every tool badge opened and settled; none is retained.
			expect(harness.toolEvents).toBe(2 * stream.rounds);
			expect(harness.openTools.size).toBe(0);

			// Final usage and native identity come from the end event alone.
			expect(harness.sessionId).toBe(GROK_SYNTHETIC_SESSION_ID);
			expect(harness.usage).toMatchObject({
				inputTokens: 100 * stream.rounds,
				outputTokens: 20 * stream.rounds,
				cacheReadTokens: 50 * stream.rounds,
				reasoningTokens: 5 * stream.rounds,
			});

			harness.handler.cleanup();
		});

		it('doubling the stream doubles frames and buffered bytes, never squares them', () => {
			const measure = (rounds: number) => {
				const stream = grokSyntheticStream(rounds);
				const updates: string[] = [];
				const harness = createGrokHarness((_key, _tab, content) => updates.push(content));
				const rafBefore = (mockRaf as ReturnType<typeof vi.fn>).mock.calls.length;
				for (const round of roundsOf(stream.lines, stream.rounds)) {
					harness.feedRound(round);
					flushRafCallbacks();
				}
				harness.handler.cleanup();
				return {
					frames: (mockRaf as ReturnType<typeof vi.fn>).mock.calls.length - rafBefore,
					updates: updates.length,
					bytes: updates.reduce((sum, chunk) => sum + chunk.length, 0),
					inputBytes: stream.answer.length + stream.thoughtBytes,
				};
			};
			const small = measure(GROK_SYNTHETIC_ROUNDS / 2);
			const large = measure(GROK_SYNTHETIC_ROUNDS);

			// Each update carries only that frame's new bytes, so the delivered
			// total equals the input exactly at both sizes.
			expect(small.bytes).toBe(small.inputBytes);
			expect(large.bytes).toBe(large.inputBytes);
			expect(large.frames).toBe(2 * small.frames);
			// Two keys (thinking, answer) per frame.
			expect(large.updates).toBe(2 * large.frames);
			expect(small.updates).toBe(2 * small.frames);
		});

		it('cancellation mid-stream drops the pending frame at once and delivers nothing after', () => {
			const stream = grokSyntheticStream(GROK_SYNTHETIC_ROUNDS, { end: null });
			const updates: string[] = [];
			const harness = createGrokHarness((_key, _tab, content) => updates.push(content));
			const rounds = roundsOf(stream.lines, stream.rounds);
			const half = stream.rounds / 2;

			for (const round of rounds.slice(0, half)) {
				harness.feedRound(round);
				flushRafCallbacks();
			}
			const deliveredBeforeStop = updates.length;
			// The next round arrives, then the user presses Stop before it is drawn.
			harness.feedRound(rounds[half]);
			expect(harness.handler.getBufferSize()).toBeGreaterThan(0);
			harness.handler.cleanup();

			// Responsive: the pending frame is cancelled synchronously, the buffer
			// is released, and a frame that fires late has nothing to deliver.
			expect(mockCancelRaf).toHaveBeenCalledTimes(1);
			expect(harness.handler.getBufferSize()).toBe(0);
			flushRafCallbacks();
			expect(updates).toHaveLength(deliveredBeforeStop);
			expect(deliveredBeforeStop).toBe(2 * half);
			// No end event was read, so no identity or usage was invented.
			expect(harness.sessionId).toBeNull();
			expect(harness.usage).toBeNull();
		});
	});
});
