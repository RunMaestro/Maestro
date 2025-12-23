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
const createMockTheme = (): Theme => ({
  id: 'test-theme',
  name: 'Test Theme',
  mode: 'dark',
  colors: {
    bgMain: '#1a1a1a',
    bgPanel: '#252525',
    bgActivity: '#2d2d2d',
    textMain: '#ffffff',
    textDim: '#888888',
    accent: '#0066ff',
    accentText: '#4488ff',
    accentForeground: '#ffffff',
    border: '#333333',
    highlight: '#0066ff33',
    success: '#00aa00',
    warning: '#ffaa00',
    error: '#ff0000',
  },
});

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
  const thinkingLogs = logs.filter(l => l.source === 'thinking');

  return (
    <div data-testid="thinking-display">
      {thinkingLogs.map(log => (
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
                color: theme.colors.accentText
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
    callbacks.forEach(cb => cb(timestamp));
  };

  describe('RAF Throttling Efficiency', () => {
    it('should batch multiple rapid chunk arrivals into single RAF callback', () => {
      const updates: Array<{ sessionId: string; tabId: string; content: string }> = [];
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (sessionId, tabId, content) => updates.push({ sessionId, tabId, content })
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (sessionId, tabId, content) => updates.push({ sessionId, tabId, content })
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

      const session1Update = updates.find(u => u.sessionId === 'session-1');
      expect(session1Update?.content).toBe('Content for session 1 - more content');

      cleanup();
    });

    it('should not schedule new RAF while one is pending', () => {
      const updates: Array<{ sessionId: string; tabId: string; content: string }> = [];
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (sessionId, tabId, content) => updates.push({ sessionId, tabId, content })
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (_sid, _tid, content) => updates.push(content)
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (_sid, _tid, content) => updates.push(content)
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (_sid, _tid, content) => updates.push(content)
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (_sid, _tid, content) => updates.push(content)
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        () => {}
      );

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
      const logs: LogEntry[] = [{
        id: 'thinking-1',
        timestamp: Date.now(),
        source: 'thinking',
        text: content,
      }];

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
      const logs: LogEntry[] = [{
        id: 'thinking-1',
        timestamp: Date.now(),
        source: 'thinking',
        text: content,
      }];

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
      const logs: LogEntry[] = [{
        id: 'thinking-1',
        timestamp: Date.now(),
        source: 'thinking',
        text: 'Initial content',
      }];

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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (_sid, _tid, content) => updates.push(content)
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (_sid, _tid, content) => updates.push(content)
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (sessionId, tabId, content) => updates.push({ sessionId, tabId, content })
      );

      // Interleave chunks from different tabs
      for (let i = 0; i < 100; i++) {
        handleChunk('session-1', `tab-${i % 3}`, `chunk-${i} `);
      }

      flushRafCallbacks();

      // Should have 3 updates (one per tab)
      expect(updates.length).toBe(3);

      // Verify each tab got its chunks
      const tab0Update = updates.find(u => u.tabId === 'tab-0');
      const tab1Update = updates.find(u => u.tabId === 'tab-1');
      const tab2Update = updates.find(u => u.tabId === 'tab-2');

      expect(tab0Update?.content).toContain('chunk-0');
      expect(tab1Update?.content).toContain('chunk-1');
      expect(tab2Update?.content).toContain('chunk-2');

      cleanup();
    });
  });

  describe('Stress Testing', () => {
    it('should handle sustained high-frequency chunk arrivals', () => {
      const updates: string[] = [];
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (_sid, _tid, content) => updates.push(content)
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
      const { handleChunk, cleanup } = createThinkingChunkHandler(
        (sessionId, _tabId, content) => {
          const sessionUpdates = updates.get(sessionId) || [];
          sessionUpdates.push(content);
          updates.set(sessionId, sessionUpdates);
        }
      );

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
});
