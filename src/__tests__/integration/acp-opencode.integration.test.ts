/**
 * ACP OpenCode Integration Tests
 *
 * Tests for ACP (Agent Client Protocol) communication with OpenCode.
 * These tests verify that Maestro can communicate with OpenCode via ACP
 * instead of the custom JSON format.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ACPClient } from '../../main/acp/acp-client';
import { acpUpdateToParseEvent, createSessionIdEvent } from '../../main/acp/acp-adapter';
import type { SessionUpdate } from '../../main/acp/types';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';

// Test timeout for ACP operations
const ACP_TIMEOUT = 30000;

// Check if OpenCode is available
function isOpenCodeAvailable(): boolean {
  try {
    execSync('which opencode', { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

// Check if integration tests should run
const SHOULD_RUN = process.env.RUN_INTEGRATION_TESTS === 'true' && isOpenCodeAvailable();

describe.skipIf(!SHOULD_RUN)('ACP OpenCode Integration Tests', () => {
  const TEST_CWD = os.tmpdir();

  describe('ACPClient connection', () => {
    it('should connect to OpenCode via ACP and initialize', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
        clientInfo: {
          name: 'maestro-test',
          version: '0.0.1',
        },
      });

      try {
        const response = await client.connect();

        expect(response.protocolVersion).toBeGreaterThanOrEqual(1);
        expect(client.getIsConnected()).toBe(true);
        expect(client.getAgentInfo()).toBeDefined();

        console.log(`✅ Connected to: ${client.getAgentInfo()?.name} v${client.getAgentInfo()?.version}`);
        console.log(`📋 Protocol version: ${response.protocolVersion}`);
        console.log(`🔧 Capabilities:`, response.agentCapabilities);
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);

    it('should create a new session', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      try {
        await client.connect();
        const session = await client.newSession(TEST_CWD);

        expect(session.sessionId).toBeDefined();
        expect(typeof session.sessionId).toBe('string');
        expect(session.sessionId.length).toBeGreaterThan(0);

        console.log(`✅ Created session: ${session.sessionId}`);
        if (session.modes) {
          console.log(`📋 Available modes: ${session.modes.availableModes.map((m) => m.name).join(', ')}`);
          console.log(`📋 Current mode: ${session.modes.currentModeId}`);
        }
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);

    it('should send a prompt and receive streaming updates', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      const updates: SessionUpdate[] = [];

      try {
        await client.connect();
        const session = await client.newSession(TEST_CWD);

        // Listen for updates
        client.on('session:update', (sessionId, update) => {
          console.log(`📥 Update (${sessionId}):`, JSON.stringify(update).substring(0, 200));
          updates.push(update);
        });

        // Auto-approve permission requests in YOLO mode
        client.on('session:permission_request', (request, respond) => {
          console.log(`🔐 Permission request: ${request.toolCall.title}`);
          // Find the "allow" option and select it
          const allowOption = request.options.find(
            (o) => o.kind === 'allow_once' || o.kind === 'allow_always'
          );
          if (allowOption) {
            respond({ outcome: { selected: { optionId: allowOption.optionId } } });
          } else {
            respond({ outcome: { cancelled: {} } });
          }
        });

        console.log(`🚀 Sending prompt to session ${session.sessionId}...`);
        const response = await client.prompt(session.sessionId, 'Say "hello" and nothing else.');

        expect(response.stopReason).toBeDefined();
        console.log(`✅ Stop reason: ${response.stopReason}`);
        console.log(`📊 Received ${updates.length} updates`);

        // Check we received some text updates
        const textUpdates = updates.filter(
          (u) => 'agent_message_chunk' in u || 'agent_thought_chunk' in u
        );
        expect(textUpdates.length).toBeGreaterThan(0);
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);
  });

  describe('ACP to ParsedEvent adapter', () => {
    it('should convert agent_message_chunk to text event', () => {
      const update: SessionUpdate = {
        agent_message_chunk: {
          content: {
            text: { text: 'Hello, world!' },
          },
        },
      };

      const event = acpUpdateToParseEvent('test-session', update);

      expect(event).toBeDefined();
      expect(event?.type).toBe('text');
      expect(event?.text).toBe('Hello, world!');
      expect(event?.isPartial).toBe(true);
    });

    it('should convert agent_thought_chunk to thinking event', () => {
      const update: SessionUpdate = {
        agent_thought_chunk: {
          content: {
            text: { text: 'Let me think about this...' },
          },
        },
      };

      const event = acpUpdateToParseEvent('test-session', update);

      expect(event).toBeDefined();
      expect(event?.type).toBe('text'); // Mapped to 'text' type since ParsedEvent doesn't have 'thinking'
      expect(event?.text).toBe('[thinking] Let me think about this...');
    });

    it('should convert tool_call to tool_use event', () => {
      const update: SessionUpdate = {
        tool_call: {
          toolCallId: 'tc-123',
          title: 'read_file',
          kind: 'read',
          status: 'in_progress',
          rawInput: { path: '/tmp/test.txt' },
        },
      };

      const event = acpUpdateToParseEvent('test-session', update);

      expect(event).toBeDefined();
      expect(event?.type).toBe('tool_use');
      expect(event?.toolName).toBe('read_file');
      expect((event?.toolState as any)?.id).toBe('tc-123');
      expect((event?.toolState as any)?.status).toBe('running');
    });

    it('should convert tool_call_update with output', () => {
      const update: SessionUpdate = {
        tool_call_update: {
          toolCallId: 'tc-123',
          status: 'completed',
          rawOutput: { content: 'file contents here' },
        },
      };

      const event = acpUpdateToParseEvent('test-session', update);

      expect(event).toBeDefined();
      expect(event?.type).toBe('tool_use');
      expect((event?.toolState as any)?.status).toBe('completed');
      expect((event?.toolState as any)?.output).toEqual({ content: 'file contents here' });
    });

    it('should create session_id event', () => {
      const event = createSessionIdEvent('ses_abc123');

      expect(event.type).toBe('init'); // Mapped to 'init' type since ParsedEvent doesn't have 'session_id'
      expect(event.sessionId).toBe('ses_abc123');
    });
  });

  // ============================================================================
  // ACP Provider Tests - These replace the legacy provider integration tests
  // ============================================================================
  describe('ACP Provider Tests (replacing legacy format)', () => {
    it('should send initial message and receive session ID via ACP', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      try {
        await client.connect();
        const session = await client.newSession(TEST_CWD);

        // Verify session ID format
        expect(session.sessionId).toBeDefined();
        expect(session.sessionId).toMatch(/^ses_[a-zA-Z0-9]+$/);

        console.log(`✅ ACP Session ID: ${session.sessionId}`);

        // Send a prompt
        const response = await client.prompt(session.sessionId, 'Say "hello" and nothing else.');

        expect(response.stopReason).toBe('end_turn');
        console.log(`✅ Response received with stop reason: ${response.stopReason}`);
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);

    it('should resume session with follow-up message via ACP', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      let collectedText = '';

      try {
        await client.connect();
        const session = await client.newSession(TEST_CWD);

        // Listen for text updates - handle both content formats:
        // Format 1: { text: { text: '...' } } (ACP spec)
        // Format 2: { type: 'text', text: '...' } (OpenCode actual)
        client.on('session:update', (_sessionId, update) => {
          if ('agent_message_chunk' in update) {
            const content = update.agent_message_chunk.content as any;
            if (content) {
              // Handle both formats
              if (content.text && typeof content.text === 'object' && 'text' in content.text) {
                collectedText += content.text.text;
              } else if (content.type === 'text' && typeof content.text === 'string') {
                collectedText += content.text;
              }
            }
          }
        });

        console.log(`🚀 Initial message to session ${session.sessionId}`);
        await client.prompt(session.sessionId, 'Remember the number 42. Say only "Got it."');

        // Clear text for next prompt
        collectedText = '';

        console.log(`🔄 Follow-up message to same session`);
        const response = await client.prompt(
          session.sessionId,
          'What number did I ask you to remember? Reply with just the number.'
        );

        expect(response.stopReason).toBe('end_turn');
        console.log(`💬 Response: ${collectedText}`);

        // The response should contain "42"
        expect(collectedText).toContain('42');
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);

    it('should stream text updates via ACP', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      const textChunks: string[] = [];

      try {
        await client.connect();
        const session = await client.newSession(TEST_CWD);

        // Collect streaming text updates - handle both content formats
        client.on('session:update', (_sessionId, update) => {
          if ('agent_message_chunk' in update) {
            const content = update.agent_message_chunk.content as any;
            if (content) {
              // Handle both formats
              if (content.text && typeof content.text === 'object' && 'text' in content.text) {
                textChunks.push(content.text.text);
              } else if (content.type === 'text' && typeof content.text === 'string') {
                textChunks.push(content.text);
              }
            }
          }
        });

        await client.prompt(session.sessionId, 'Count from 1 to 5, one number per line.');

        console.log(`📊 Received ${textChunks.length} text chunks`);
        console.log(`📝 Combined text: ${textChunks.join('')}`);

        // Should have received multiple streaming chunks
        expect(textChunks.length).toBeGreaterThan(0);

        // Combined text should have the numbers
        const combinedText = textChunks.join('');
        expect(combinedText).toContain('1');
        expect(combinedText).toContain('5');
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);

    it('should handle tool calls via ACP', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      const toolCalls: Array<{ name: string; status: string }> = [];

      try {
        await client.connect();
        const session = await client.newSession(TEST_CWD);

        // Track tool calls
        client.on('session:update', (_sessionId, update) => {
          if ('tool_call' in update) {
            toolCalls.push({
              name: update.tool_call.title,
              status: update.tool_call.status || 'unknown',
            });
          }
          if ('tool_call_update' in update) {
            const existing = toolCalls.find((t) => t.name === update.tool_call_update.title);
            if (existing) {
              existing.status = update.tool_call_update.status || 'unknown';
            }
          }
        });

        // Auto-approve any tool permission requests
        client.on('session:permission_request', (request, respond) => {
          console.log(`🔐 Auto-approving: ${request.toolCall.title}`);
          const allowOption = request.options.find(
            (o: { kind: string; optionId: string }) => o.kind === 'allow_once' || o.kind === 'allow_always'
          );
          if (allowOption) {
            respond({ outcome: { selected: { optionId: allowOption.optionId } } });
          } else {
            respond({ outcome: { cancelled: {} } });
          }
        });

        // Request something that might trigger tool use
        await client.prompt(session.sessionId, 'What files are in the current directory? Use ls command.');

        console.log(`🔧 Tool calls observed: ${toolCalls.length}`);
        toolCalls.forEach((tc) => console.log(`   - ${tc.name}: ${tc.status}`));

        // Note: Tool usage depends on agent behavior, so we just verify the mechanism works
        // The test passes if no errors occur
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);

    it('should convert ACP updates to ParsedEvent format', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      const parsedEvents: Array<{ type: string; text?: string }> = [];

      try {
        await client.connect();
        const session = await client.newSession(TEST_CWD);

        // Convert updates to ParsedEvent format
        client.on('session:update', (sessionId, update) => {
          const event = acpUpdateToParseEvent(sessionId, update);
          if (event) {
            parsedEvents.push({ type: event.type, text: event.text });
          }
        });

        await client.prompt(session.sessionId, 'Say "test" and nothing else.');

        console.log(`📊 Parsed ${parsedEvents.length} events:`);
        parsedEvents.forEach((e) => console.log(`   - ${e.type}: ${e.text?.substring(0, 50) || '(no text)'}`));

        // Should have text events
        const textEvents = parsedEvents.filter((e) => e.type === 'text');
        expect(textEvents.length).toBeGreaterThan(0);

        // Should have received "test" somewhere
        const allText = textEvents.map((e) => e.text).join('');
        expect(allText.toLowerCase()).toContain('test');
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);

    it('should handle multiple sessions via ACP', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      try {
        await client.connect();

        // Create first session
        const session1 = await client.newSession(TEST_CWD);
        console.log(`📋 Session 1: ${session1.sessionId}`);

        // Create second session
        const session2 = await client.newSession(TEST_CWD);
        console.log(`📋 Session 2: ${session2.sessionId}`);

        // Sessions should have different IDs
        expect(session1.sessionId).not.toBe(session2.sessionId);

        // Both should be valid session ID format
        expect(session1.sessionId).toMatch(/^ses_/);
        expect(session2.sessionId).toMatch(/^ses_/);
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);

    it('should report available modes via ACP', async () => {
      const client = new ACPClient({
        command: 'opencode',
        args: ['acp'],
        cwd: TEST_CWD,
      });

      try {
        await client.connect();
        const session = await client.newSession(TEST_CWD);

        if (session.modes) {
          console.log(`📋 Available modes: ${session.modes.availableModes.map((m) => m.name).join(', ')}`);
          console.log(`📋 Current mode: ${session.modes.currentModeId}`);

          expect(session.modes.availableModes.length).toBeGreaterThan(0);
          expect(session.modes.currentModeId).toBeDefined();

          // OpenCode typically has 'build' and 'plan' modes
          const modeNames = session.modes.availableModes.map((m) => m.name);
          expect(modeNames).toContain('build');
        } else {
          console.log(`⚠️ No modes reported by agent`);
        }
      } finally {
        client.disconnect();
      }
    }, ACP_TIMEOUT);
  });
});
