/**
 * Provider Integration Tests
 *
 * These tests verify that each supported AI provider (Claude Code, Codex, OpenCode)
 * works correctly end-to-end:
 * 1. Initial message → get response + session ID
 * 2. Follow-up message with session resume → get response
 * 3. Image input handling (for agents that support it)
 *
 * REQUIREMENTS:
 * - These tests require the actual provider CLIs to be installed
 * - They make real API calls and may incur costs
 *
 * These tests are SKIPPED by default. To run them:
 *   RUN_INTEGRATION_TESTS=true npm run test:integration
 *
 * IMPORTANT: These tests mirror the actual argument building logic from:
 * - src/main/agent-detector.ts (agent definitions with arg builders)
 * - src/main/ipc/handlers/process.ts (IPC spawn handler)
 * - src/main/process-manager.ts (ProcessManager.spawn)
 *
 * If those files change, these tests should be updated to match.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAgentCapabilities } from '../../main/agent-capabilities';

const execAsync = promisify(exec);

// Path to test image fixture
const TEST_IMAGE_PATH = path.join(__dirname, '../fixtures/maestro-test-image.png');

// Skip integration tests by default - they make real API calls and may incur costs.
// Set RUN_INTEGRATION_TESTS=true to enable them.
const SKIP_INTEGRATION = process.env.RUN_INTEGRATION_TESTS !== 'true';

// Timeout for provider responses (providers can be slow)
const PROVIDER_TIMEOUT = 120_000; // 2 minutes

// Test directory
const TEST_CWD = process.cwd();

interface ProviderConfig {
  name: string;
  /** Agent ID matching agent-detector.ts (e.g., 'claude-code', 'codex') */
  agentId: string;
  command: string;
  /** Check if the provider CLI is available */
  checkCommand: string;
  /**
   * Build args for initial message (no session).
   * These should mirror the logic in:
   * - agent-detector.ts (base args, batchModePrefix, batchModeArgs, jsonOutputArgs, etc.)
   * - process.ts IPC handler (arg assembly order)
   * - process-manager.ts (--input-format stream-json for images)
   */
  buildInitialArgs: (prompt: string, options?: { images?: string[] }) => string[];
  /** Build args for message with image (file path) - for agents that use file-based image args */
  buildImageArgs?: (prompt: string, imagePath: string) => string[];
  /** Build stdin content for stream-json mode (for Claude Code) */
  buildStreamJsonInput?: (prompt: string, imageBase64: string, mediaType: string) => string;
  /** Build args for follow-up message (with session) */
  buildResumeArgs: (sessionId: string, prompt: string) => string[];
  /** Parse session ID from output */
  parseSessionId: (output: string) => string | null;
  /** Parse response text from output */
  parseResponse: (output: string) => string | null;
  /** Check if output indicates success */
  isSuccessful: (output: string, exitCode: number) => boolean;
  /** Parse tools array from init event */
  parseTools?: (output: string) => string[] | null;
  /** Parse tool execution events from output */
  parseToolExecutions?: (output: string) => Array<{ name: string; status?: string; input?: unknown; output?: unknown }>;
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: 'Claude Code',
    agentId: 'claude-code',
    command: 'claude',
    checkCommand: 'claude --version',
    /**
     * Mirrors agent-detector.ts Claude Code definition:
     *   args: ['--print', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions']
     *
     * And process-manager.ts spawn() logic for images:
     *   if (hasImages && prompt && capabilities.supportsStreamJsonInput) {
     *     finalArgs = [...args, '--input-format', 'stream-json'];
     *   }
     */
    buildInitialArgs: (prompt: string, options?: { images?: string[] }) => {
      const baseArgs = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
      ];

      const hasImages = options?.images && options.images.length > 0;
      const capabilities = getAgentCapabilities('claude-code');

      if (hasImages && capabilities.supportsStreamJsonInput) {
        // With images: add --input-format stream-json (prompt sent via stdin)
        return [...baseArgs, '--input-format', 'stream-json'];
      } else {
        // Without images: prompt as CLI argument
        return [...baseArgs, '--', prompt];
      }
    },
    buildResumeArgs: (sessionId: string, prompt: string) => [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--resume', sessionId,
      '--',
      prompt,
    ],
    parseSessionId: (output: string) => {
      // Claude outputs session_id in JSON lines
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          if (json.session_id) return json.session_id;
        } catch { /* ignore non-JSON lines */ }
      }
      return null;
    },
    parseResponse: (output: string) => {
      // Claude outputs result in JSON lines
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          if (json.type === 'result' && json.result) return json.result;
        } catch { /* ignore non-JSON lines */ }
      }
      return null;
    },
    isSuccessful: (output: string, exitCode: number) => {
      return exitCode === 0;
    },
    /**
     * Build stream-json input for Claude Code with image.
     * This mirrors buildStreamJsonMessage() in process-manager.ts
     */
    buildStreamJsonInput: (prompt: string, imageBase64: string, mediaType: string) => {
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      };
      return JSON.stringify(message);
    },
    /**
     * Parse tools array from Claude Code init event.
     * Claude outputs: {"type":"system","subtype":"init","tools":["Task","Bash",...]}
     */
    parseTools: (output: string) => {
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          if (json.type === 'system' && json.subtype === 'init' && Array.isArray(json.tools)) {
            return json.tools;
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return null;
    },
    /**
     * Parse tool execution events from Claude Code output.
     * Claude outputs tool_use blocks in assistant messages:
     * {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{...}}]}}
     */
    parseToolExecutions: (output: string) => {
      const executions: Array<{ name: string; status?: string; input?: unknown; output?: unknown }> = [];
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          // Handle assistant messages with tool_use blocks
          if (json.type === 'assistant' && json.message?.content) {
            const content = json.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_use' && block.name) {
                  executions.push({
                    name: block.name,
                    status: 'running',
                    input: block.input,
                  });
                }
              }
            }
          }
          // Handle tool_result in user messages (completion of tool)
          if (json.type === 'user' && json.message?.content) {
            const content = json.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result') {
                  executions.push({
                    name: `tool_result:${block.tool_use_id}`,
                    status: block.is_error ? 'error' : 'complete',
                    output: block.content,
                  });
                }
              }
            }
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return executions;
    },
  },
  {
    name: 'Codex',
    agentId: 'codex',
    command: 'codex',
    checkCommand: 'codex --version',
    /**
     * Mirrors agent-detector.ts Codex definition:
     *   batchModePrefix: ['exec']
     *   batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
     *   jsonOutputArgs: ['--json']
     *   workingDirArgs: (dir) => ['-C', dir]
     *
     * And process-manager.ts spawn() logic for images:
     *   if (hasImages && prompt && capabilities.supportsStreamJsonInput) {
     *     // Only for agents that support stream-json input (NOT Codex)
     *   }
     *
     * This tests that Codex does NOT get --input-format stream-json
     */
    buildInitialArgs: (prompt: string, options?: { images?: string[] }) => {
      // Codex arg order from process.ts IPC handler:
      // 1. batchModePrefix: ['exec']
      // 2. base args: [] (empty for Codex)
      // 3. batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
      // 4. jsonOutputArgs: ['--json']
      // 5. workingDirArgs: ['-C', dir]
      // 6. prompt via '--' separator (process-manager.ts)

      const args = [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--json',
        '-C', TEST_CWD,
      ];

      // IMPORTANT: This mirrors process-manager.ts logic
      // Codex does NOT support --input-format stream-json (supportsStreamJsonInput: false)
      // So even with images, we use the regular prompt-as-argument approach
      const hasImages = options?.images && options.images.length > 0;
      const capabilities = getAgentCapabilities('codex');

      if (hasImages && capabilities.supportsStreamJsonInput) {
        // Codex would add --input-format here, but supportsStreamJsonInput is false
        // This branch should NEVER execute for Codex
        throw new Error('Codex should not support stream-json input - capability misconfigured');
      }

      // Regular batch mode - prompt as CLI arg
      return [...args, '--', prompt];
    },
    buildResumeArgs: (sessionId: string, prompt: string) => [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--json',
      '-C', TEST_CWD,
      'resume', sessionId,
      '--',
      prompt,
    ],
    parseSessionId: (output: string) => {
      // Codex outputs thread_id in thread.started events
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          if (json.type === 'thread.started' && json.thread_id) {
            return json.thread_id;
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return null;
    },
    parseResponse: (output: string) => {
      // Codex outputs item.completed events with item.type === 'agent_message'
      const responses: string[] = [];
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
            // agent_message item has text field directly
            if (json.item.text) {
              responses.push(json.item.text);
            }
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return responses.length > 0 ? responses.join('\n') : null;
    },
    isSuccessful: (output: string, exitCode: number) => {
      // Codex may exit with 0 even on success, check for turn.completed
      if (exitCode !== 0) return false;
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          if (json.type === 'turn.completed') return true;
        } catch { /* ignore */ }
      }
      return false;
    },
    /**
     * Build args with image file path for Codex.
     * Mirrors agent-detector.ts: imageArgs: (imagePath) => ['-i', imagePath]
     */
    buildImageArgs: (prompt: string, imagePath: string) => [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--json',
      '-C', TEST_CWD,
      '-i', imagePath,
      '--',
      prompt,
    ],
    /**
     * Parse tools from Codex init event.
     * Codex outputs tools in thread.started event or session.started
     * Note: Codex may not expose tools array in the same way as Claude
     */
    parseTools: (output: string) => {
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          // Codex may include tools in thread.started or separate event
          if (json.tools && Array.isArray(json.tools)) {
            return json.tools;
          }
          // Try extracting from session config if present
          if (json.type === 'session.started' && json.session?.tools) {
            return json.session.tools;
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return null;
    },
    /**
     * Parse tool execution events from Codex output.
     * Codex outputs: {"type":"item.completed","item":{"type":"tool_call","name":"shell",...}}
     */
    parseToolExecutions: (output: string) => {
      const executions: Array<{ name: string; status?: string; input?: unknown; output?: unknown }> = [];
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          // Handle tool_call items
          if (json.type === 'item.completed' && json.item?.type === 'tool_call') {
            executions.push({
              name: json.item.name || json.item.tool || 'unknown',
              status: 'running',
              input: json.item.arguments || json.item.input,
            });
          }
          // Handle tool_result items
          if (json.type === 'item.completed' && json.item?.type === 'tool_result') {
            executions.push({
              name: `tool_result:${json.item.tool_call_id || json.item.id}`,
              status: json.item.error ? 'error' : 'complete',
              output: json.item.output || json.item.content,
            });
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return executions;
    },
  },
  {
    name: 'OpenCode',
    agentId: 'opencode',
    command: 'opencode',
    checkCommand: 'opencode --version',
    /**
     * Mirrors agent-detector.ts OpenCode definition:
     *   batchModePrefix: ['run']
     *   jsonOutputArgs: ['--format', 'json']
     *
     * And process-manager.ts spawn() logic for images:
     *   OpenCode does NOT support --input-format stream-json (supportsStreamJsonInput: false)
     *   It uses -f, --file flag instead for images
     */
    buildInitialArgs: (prompt: string, options?: { images?: string[] }) => {
      // OpenCode arg order from process.ts IPC handler:
      // 1. batchModePrefix: ['run']
      // 2. base args: [] (empty for OpenCode)
      // 3. jsonOutputArgs: ['--format', 'json']
      // 4. Optional: --model provider/model (from OPENCODE_MODEL env var)
      // 5. prompt via '--' separator (process-manager.ts)

      const args = [
        'run',
        '--format', 'json',
      ];

      // Allow overriding model via OPENCODE_MODEL env var
      // e.g., OPENCODE_MODEL=google/gemini-2.5-flash
      const model = process.env.OPENCODE_MODEL;
      if (model) {
        args.push('--model', model);
      }

      // IMPORTANT: This mirrors process-manager.ts logic
      // OpenCode does NOT support --input-format stream-json (supportsStreamJsonInput: false)
      const hasImages = options?.images && options.images.length > 0;
      const capabilities = getAgentCapabilities('opencode');

      if (hasImages && capabilities.supportsStreamJsonInput) {
        // OpenCode would add --input-format here, but supportsStreamJsonInput is false
        // This branch should NEVER execute for OpenCode
        throw new Error('OpenCode should not support stream-json input - capability misconfigured');
      }

      // Regular batch mode - prompt as CLI arg
      return [...args, '--', prompt];
    },
    buildResumeArgs: (sessionId: string, prompt: string) => {
      const args = [
        'run',
        '--format', 'json',
      ];

      // Allow overriding model via OPENCODE_MODEL env var
      const model = process.env.OPENCODE_MODEL;
      if (model) {
        args.push('--model', model);
      }

      args.push('--session', sessionId, '--', prompt);
      return args;
    },
    parseSessionId: (output: string) => {
      // OpenCode outputs sessionID in events (step_start, text, step_finish)
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          if (json.sessionID) {
            return json.sessionID;
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return null;
    },
    parseResponse: (output: string) => {
      // OpenCode outputs text events with part.text
      const responses: string[] = [];
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          if (json.type === 'text' && json.part?.text) {
            responses.push(json.part.text);
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return responses.length > 0 ? responses.join('') : null;
    },
    isSuccessful: (output: string, exitCode: number) => {
      return exitCode === 0;
    },
    /**
     * Build args with image file path for OpenCode.
     * Mirrors agent-detector.ts: imageArgs: (imagePath) => ['-f', imagePath]
     *
     * Uses vision-capable model. Defaults to ollama/qwen3-vl but can be overridden
     * with OPENCODE_VISION_MODEL env var.
     */
    buildImageArgs: (prompt: string, imagePath: string) => [
      'run',
      '--format', 'json',
      '--model', process.env.OPENCODE_VISION_MODEL || 'ollama/qwen3-vl',
      '-f', imagePath,
      '--',
      prompt,
    ],
    /**
     * Parse tools from OpenCode init event.
     * OpenCode may expose available tools in step_start or init events
     */
    parseTools: (output: string) => {
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          // Check for tools array in any event
          if (json.tools && Array.isArray(json.tools)) {
            return json.tools;
          }
          // OpenCode may include tools in part metadata
          if (json.part?.tools && Array.isArray(json.part.tools)) {
            return json.part.tools;
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return null;
    },
    /**
     * Parse tool execution events from OpenCode output.
     * OpenCode outputs: {"type":"tool_use","part":{"tool":"Read","state":{"status":"running",...}}}
     */
    parseToolExecutions: (output: string) => {
      const executions: Array<{ name: string; status?: string; input?: unknown; output?: unknown }> = [];
      for (const line of output.split('\n')) {
        try {
          const json = JSON.parse(line);
          // Handle tool_use events
          if (json.type === 'tool_use' && json.part) {
            executions.push({
              name: json.part.tool || json.part.name || 'unknown',
              status: json.part.state?.status || 'running',
              input: json.part.state?.input,
              output: json.part.state?.output,
            });
          }
        } catch { /* ignore non-JSON lines */ }
      }
      return executions;
    },
  },
];

/**
 * Check if a provider CLI is available
 */
async function isProviderAvailable(provider: ProviderConfig): Promise<boolean> {
  try {
    await execAsync(provider.checkCommand);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a provider command and capture output
 * @param stdinContent - Optional content to write to stdin before closing (for stream-json mode)
 */
function runProvider(
  provider: ProviderConfig,
  args: string[],
  cwd: string = TEST_CWD,
  stdinContent?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(provider.command, args, {
      cwd,
      env: { ...process.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // If we have stdin content, write it and then close
    if (stdinContent) {
      proc.stdin?.write(stdinContent + '\n');
    }
    // Close stdin to signal EOF (prevents processes waiting for input)
    proc.stdin?.end();

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    proc.on('error', (err) => {
      stderr += err.message;
      resolve({
        stdout,
        stderr,
        exitCode: 1,
      });
    });
  });
}

describe.skipIf(SKIP_INTEGRATION)('Provider Integration Tests', () => {
  // Run each provider's tests
  for (const provider of PROVIDERS) {
    describe(provider.name, () => {
      let providerAvailable = false;

      beforeAll(async () => {
        providerAvailable = await isProviderAvailable(provider);
        if (!providerAvailable) {
          console.log(`⚠️  ${provider.name} CLI not available, tests will be skipped`);
        }
      });

      it('should send initial message and receive session ID', async () => {
        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }
        const prompt = 'Say "hello" and nothing else. Be extremely brief.';
        const args = provider.buildInitialArgs(prompt);

        console.log(`\n🚀 Running: ${provider.command} ${args.join(' ')}`);

        const result = await runProvider(provider, args);

        console.log(`📤 Exit code: ${result.exitCode}`);
        console.log(`📤 Stdout (first 500 chars): ${result.stdout.substring(0, 500)}`);
        if (result.stderr) {
          console.log(`📤 Stderr: ${result.stderr.substring(0, 300)}`);
        }

        // Check for success
        expect(
          provider.isSuccessful(result.stdout, result.exitCode),
          `${provider.name} should complete successfully`
        ).toBe(true);

        // Parse session ID
        const sessionId = provider.parseSessionId(result.stdout);
        console.log(`📋 Session ID: ${sessionId}`);
        expect(sessionId, `${provider.name} should return a session ID`).toBeTruthy();

        // Parse response
        const response = provider.parseResponse(result.stdout);
        console.log(`💬 Response: ${response?.substring(0, 200)}`);
        expect(response, `${provider.name} should return a response`).toBeTruthy();
      }, PROVIDER_TIMEOUT);

      it('should resume session with follow-up message', async () => {
        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }
        // First, send initial message to get session ID
        const initialPrompt = 'Remember the number 42. Say only "Got it."';
        const initialArgs = provider.buildInitialArgs(initialPrompt);

        console.log(`\n🚀 Initial: ${provider.command} ${initialArgs.join(' ')}`);

        const initialResult = await runProvider(provider, initialArgs);

        expect(
          provider.isSuccessful(initialResult.stdout, initialResult.exitCode),
          `${provider.name} initial message should succeed`
        ).toBe(true);

        const sessionId = provider.parseSessionId(initialResult.stdout);
        console.log(`📋 Got session ID: ${sessionId}`);
        expect(sessionId, `${provider.name} should return session ID`).toBeTruthy();

        // Now send follow-up with session resume
        const followUpPrompt = 'What number did I ask you to remember? Reply with just the number.';
        const resumeArgs = provider.buildResumeArgs(sessionId!, followUpPrompt);

        console.log(`\n🔄 Resume: ${provider.command} ${resumeArgs.join(' ')}`);

        const resumeResult = await runProvider(provider, resumeArgs);

        console.log(`📤 Exit code: ${resumeResult.exitCode}`);
        console.log(`📤 Stdout (first 500 chars): ${resumeResult.stdout.substring(0, 500)}`);
        if (resumeResult.stderr) {
          console.log(`📤 Stderr: ${resumeResult.stderr.substring(0, 300)}`);
        }

        expect(
          provider.isSuccessful(resumeResult.stdout, resumeResult.exitCode),
          `${provider.name} resume should succeed`
        ).toBe(true);

        const response = provider.parseResponse(resumeResult.stdout);
        console.log(`💬 Response: ${response?.substring(0, 200)}`);
        expect(response, `${provider.name} should return a response`).toBeTruthy();

        // The response should contain "42" since we asked it to remember that
        expect(
          response?.includes('42'),
          `${provider.name} should remember the number 42 from session context`
        ).toBe(true);
      }, PROVIDER_TIMEOUT * 2); // Double timeout for two calls

      it('should build valid args when images option is provided', () => {
        // This test verifies that the buildInitialArgs correctly handles the image capability check
        // It mirrors the bug fix in process-manager.ts where --input-format stream-json was being
        // added unconditionally to all agents, but only Claude Code supports it.
        //
        // This test runs synchronously (no API calls) and validates that:
        // 1. Claude Code: adds --input-format stream-json when images are present
        // 2. Codex/OpenCode: does NOT add --input-format (they use different image flags)

        const prompt = 'Test prompt';
        const fakeImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

        // Build args with images
        const argsWithImages = provider.buildInitialArgs(prompt, { images: [fakeImage] });

        console.log(`\n🖼️  ${provider.name} args with images: ${argsWithImages.join(' ')}`);

        // Verify the args don't contain --input-format unless the agent supports it
        const capabilities = getAgentCapabilities(provider.agentId);
        const hasInputFormat = argsWithImages.includes('--input-format');

        if (capabilities.supportsStreamJsonInput) {
          // Claude Code should have --input-format stream-json
          expect(hasInputFormat, `${provider.name} should include --input-format when it supports stream-json input`).toBe(true);
          expect(argsWithImages.includes('stream-json'), `${provider.name} should use stream-json format`).toBe(true);
          // Should NOT have the prompt as an arg (it's sent via stdin)
          expect(argsWithImages.includes(prompt), `${provider.name} should not include prompt in args when using stream-json input`).toBe(false);
        } else {
          // Codex, OpenCode should NOT have --input-format
          expect(hasInputFormat, `${provider.name} should NOT include --input-format (supportsStreamJsonInput: false)`).toBe(false);
          // Should have the prompt as an arg
          expect(argsWithImages.includes(prompt), `${provider.name} should include prompt in args`).toBe(true);
        }

        // Compare with args without images
        const argsWithoutImages = provider.buildInitialArgs(prompt);
        console.log(`📝 ${provider.name} args without images: ${argsWithoutImages.join(' ')}`);

        // Without images, no agent should have --input-format
        const hasInputFormatWithoutImages = argsWithoutImages.includes('--input-format');
        expect(hasInputFormatWithoutImages, `${provider.name} should not include --input-format without images`).toBe(false);
      });

      it('should separate thinking/streaming content from final response', async () => {
        // This test verifies that streaming text events (which may contain thinking/reasoning)
        // are properly separated from the final response text.
        //
        // For thinking models (Claude 3.7+, OpenAI o-series, OpenCode with reasoning):
        // - Streaming text events with isPartial=true contain reasoning/thinking
        // - Final result message contains the clean response
        //
        // This validates the fix in process-manager.ts that stopped emitting partial
        // text to 'data' channel (which was showing thinking in main output).

        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }

        // Use a prompt that might trigger reasoning/thinking
        const prompt = 'What is 17 * 23? Show only the final answer as a number.';
        const args = provider.buildInitialArgs(prompt);

        console.log(`\n🧠 Testing thinking/streaming separation for ${provider.name}`);
        console.log(`🚀 Running: ${provider.command} ${args.join(' ')}`);

        const result = await runProvider(provider, args);

        console.log(`📤 Exit code: ${result.exitCode}`);

        // Parse all the different event types from the output
        const events = {
          textPartial: [] as string[],  // Streaming text chunks
          textFinal: [] as string[],    // Final text/result
          thinking: [] as string[],     // Explicit thinking blocks
          result: [] as string[],       // Result messages
        };

        for (const line of result.stdout.split('\n')) {
          try {
            const json = JSON.parse(line);

            // Claude Code events
            if (json.type === 'assistant' && json.message?.content) {
              const content = json.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'thinking' && block.thinking) {
                    events.thinking.push(block.thinking);
                  }
                  if (block.type === 'text' && block.text) {
                    events.textFinal.push(block.text);
                  }
                }
              }
            }
            if (json.type === 'result' && json.result) {
              events.result.push(json.result);
            }

            // OpenCode events
            if (json.type === 'text' && json.part?.text) {
              events.textPartial.push(json.part.text);
            }
            if (json.type === 'step_finish' && json.part?.reason === 'stop') {
              // OpenCode final - accumulated text becomes result
              events.result.push('step_finish:stop');
            }

            // Codex events
            if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
              if (json.item.text) {
                events.textFinal.push(json.item.text);
              }
            }
          } catch { /* ignore non-JSON lines */ }
        }

        console.log(`📊 Event counts:`);
        console.log(`   - textPartial (streaming): ${events.textPartial.length}`);
        console.log(`   - textFinal: ${events.textFinal.length}`);
        console.log(`   - thinking blocks: ${events.thinking.length}`);
        console.log(`   - result messages: ${events.result.length}`);

        // Verify we got a response
        expect(
          provider.isSuccessful(result.stdout, result.exitCode),
          `${provider.name} should complete successfully`
        ).toBe(true);

        const response = provider.parseResponse(result.stdout);
        console.log(`💬 Parsed response: ${response?.substring(0, 200)}`);
        expect(response, `${provider.name} should return a response`).toBeTruthy();

        // The response should contain the answer (391)
        expect(
          response?.includes('391'),
          `${provider.name} should calculate 17 * 23 = 391. Got: "${response}"`
        ).toBe(true);

        // If there are thinking blocks, verify they're not mixed into the final response
        if (events.thinking.length > 0) {
          console.log(`🧠 Found ${events.thinking.length} thinking blocks`);
          // Thinking content should NOT appear in the final result
          for (const thinkingText of events.thinking) {
            const thinkingPreview = thinkingText.substring(0, 100);
            // Final response should not literally contain the thinking text
            // (unless it's a very short common phrase)
            if (thinkingText.length > 50) {
              expect(
                !response?.includes(thinkingText),
                `Final response should not contain thinking block verbatim: "${thinkingPreview}..."`
              ).toBe(true);
            }
          }
        }
      }, PROVIDER_TIMEOUT);

      it('should generate valid synopsis for history', async () => {
        // This test verifies that synopsis generation works correctly for history entries.
        // It tests the flow: task completion → synopsis request → parseable response
        //
        // This validates:
        // 1. Session resume works for synopsis requests
        // 2. Response format matches expected **Summary:**/**Details:** structure
        // 3. parseSynopsis correctly extracts summary (no template placeholders)

        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }

        // First, do a task that we can summarize
        const taskPrompt = 'Create a simple function called "add" that adds two numbers. Just describe it, don\'t write code.';
        const taskArgs = provider.buildInitialArgs(taskPrompt);

        console.log(`\n📝 Testing synopsis generation for ${provider.name}`);
        console.log(`🚀 Task: ${provider.command} ${taskArgs.join(' ')}`);

        const taskResult = await runProvider(provider, taskArgs);

        expect(
          provider.isSuccessful(taskResult.stdout, taskResult.exitCode),
          `${provider.name} task should succeed`
        ).toBe(true);

        const sessionId = provider.parseSessionId(taskResult.stdout);
        console.log(`📋 Session ID: ${sessionId}`);
        expect(sessionId, `${provider.name} should return session ID`).toBeTruthy();

        // Now request a synopsis (this is what happens when a task completes)
        const synopsisPrompt = `Provide a brief synopsis of what you just accomplished in this task using this exact format:

**Summary:** [1-2 sentences describing the key outcome]

**Details:** [A paragraph with more specifics about what was done]

Rules:
- Be specific about what was actually accomplished.
- Focus only on meaningful work that was done.`;

        const synopsisArgs = provider.buildResumeArgs(sessionId!, synopsisPrompt);

        console.log(`🔄 Synopsis: ${provider.command} ${synopsisArgs.join(' ')}`);

        const synopsisResult = await runProvider(provider, synopsisArgs);

        console.log(`📤 Exit code: ${synopsisResult.exitCode}`);

        expect(
          provider.isSuccessful(synopsisResult.stdout, synopsisResult.exitCode),
          `${provider.name} synopsis should succeed`
        ).toBe(true);

        const synopsisResponse = provider.parseResponse(synopsisResult.stdout);
        console.log(`💬 Synopsis response:\n${synopsisResponse?.substring(0, 500)}`);
        expect(synopsisResponse, `${provider.name} should return synopsis`).toBeTruthy();

        // Import and use the actual parseSynopsis function
        const { parseSynopsis } = await import('../../shared/synopsis');
        const parsed = parseSynopsis(synopsisResponse!);

        console.log(`📊 Parsed synopsis:`);
        console.log(`   - shortSummary: ${parsed.shortSummary.substring(0, 100)}`);
        console.log(`   - fullSynopsis length: ${parsed.fullSynopsis.length}`);

        // Verify the summary is NOT a template placeholder
        const templatePlaceholders = [
          '[1-2 sentences',
          '[A paragraph',
          '... (1-2 sentences)',
          '... then blank line',
        ];

        for (const placeholder of templatePlaceholders) {
          expect(
            !parsed.shortSummary.includes(placeholder),
            `${provider.name} summary should not contain template placeholder "${placeholder}". Got: "${parsed.shortSummary}"`
          ).toBe(true);
        }

        // Summary should be meaningful (not just default fallback)
        expect(
          parsed.shortSummary !== 'Task completed',
          `${provider.name} should generate actual summary, not just fallback "Task completed"`
        ).toBe(true);

        // Summary should mention something related to the task
        const summaryLower = parsed.shortSummary.toLowerCase();
        const hasRelevantContent =
          summaryLower.includes('add') ||
          summaryLower.includes('function') ||
          summaryLower.includes('number') ||
          summaryLower.includes('describ');

        expect(
          hasRelevantContent,
          `${provider.name} summary should be relevant to the task. Got: "${parsed.shortSummary}"`
        ).toBe(true);
      }, PROVIDER_TIMEOUT * 2);

      it('should respect read-only mode flag', async () => {
        // This test verifies that read-only mode is properly supported.
        // Read-only mode should prevent the agent from making changes.
        //
        // For agents that support read-only:
        // - Claude Code: uses --plan flag
        // - Other agents may not support this yet

        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }

        const capabilities = getAgentCapabilities(provider.agentId);
        if (!capabilities.supportsReadOnlyMode) {
          console.log(`Skipping: ${provider.name} does not support read-only mode`);
          return;
        }

        // Build args with read-only flag
        // This mirrors how agent-detector.ts builds readOnlyArgs
        let readOnlyArgs: string[];
        if (provider.agentId === 'claude-code') {
          // NOTE: Claude Code uses --permission-mode plan (not --plan)
          // as defined in agent-detector.ts readOnlyArgs
          readOnlyArgs = [
            '--print',
            '--verbose',
            '--output-format', 'stream-json',
            '--permission-mode', 'plan',  // Read-only flag for Claude Code
            '--',
            'What files are in this directory? Just list them briefly.',
          ];
        } else {
          // Other providers would have their own read-only args
          console.log(`⚠️  Read-only args not configured for ${provider.name}`);
          return;
        }

        console.log(`\n🔒 Testing read-only mode for ${provider.name}`);
        console.log(`🚀 Running: ${provider.command} ${readOnlyArgs.join(' ')}`);

        const result = await runProvider(provider, readOnlyArgs);

        console.log(`📤 Exit code: ${result.exitCode}`);
        console.log(`📤 Stdout (first 500 chars): ${result.stdout.substring(0, 500)}`);

        expect(
          provider.isSuccessful(result.stdout, result.exitCode),
          `${provider.name} read-only mode should succeed`
        ).toBe(true);

        const response = provider.parseResponse(result.stdout);
        console.log(`💬 Response: ${response?.substring(0, 200)}`);
        expect(response, `${provider.name} should return a response in read-only mode`).toBeTruthy();
      }, PROVIDER_TIMEOUT);

      it('should detect and classify error patterns correctly', async () => {
        // This test verifies that error detection works correctly.
        // We test error pattern matching directly (no API calls) since forcing
        // real errors (like auth failures) would require invalid credentials.
        //
        // This validates:
        // 1. Error patterns are registered for the agent
        // 2. Pattern matching correctly classifies error types
        // 3. Error messages and recoverability are correctly assigned

        const { getErrorPatterns, matchErrorPattern } = await import('../../main/parsers/error-patterns');
        const patterns = getErrorPatterns(provider.agentId);

        console.log(`\n⚠️  Testing error detection for ${provider.name}`);

        // Test authentication errors
        const authErrors = [
          'Error: invalid api key provided',
          'Authentication failed: unauthorized',
          'Please run `claude login` to authenticate',
        ];

        let authMatches = 0;
        for (const errLine of authErrors) {
          const match = matchErrorPattern(patterns, errLine);
          if (match?.type === 'auth_expired') {
            authMatches++;
            console.log(`   ✓ Auth error detected: "${errLine.substring(0, 40)}..." → ${match.message}`);
          }
        }
        console.log(`   📊 Auth patterns: ${authMatches}/${authErrors.length} matched`);

        // Test rate limit errors
        const rateLimitErrors = [
          'Rate limit exceeded. Please wait.',
          'Error 429: Too many requests',
          'Quota exceeded for this billing period',
        ];

        let rateMatches = 0;
        for (const errLine of rateLimitErrors) {
          const match = matchErrorPattern(patterns, errLine);
          if (match?.type === 'rate_limited') {
            rateMatches++;
            console.log(`   ✓ Rate limit detected: "${errLine.substring(0, 40)}..." → ${match.message}`);
          }
        }
        console.log(`   📊 Rate limit patterns: ${rateMatches}/${rateLimitErrors.length} matched`);

        // Test token/context errors
        const tokenErrors = [
          'Context window exceeded: too many tokens',
          'Maximum tokens reached for this model',
          'Input is too large for context window',
        ];

        let tokenMatches = 0;
        for (const errLine of tokenErrors) {
          const match = matchErrorPattern(patterns, errLine);
          if (match?.type === 'token_exhaustion') {
            tokenMatches++;
            console.log(`   ✓ Token exhaustion detected: "${errLine.substring(0, 40)}..." → ${match.message}`);
          }
        }
        console.log(`   📊 Token patterns: ${tokenMatches}/${tokenErrors.length} matched`);

        // Test network errors
        const networkErrors = [
          'ECONNREFUSED: connection refused',
          'Request timed out after 30s',
          'Network error: socket hang up',
        ];

        let networkMatches = 0;
        for (const errLine of networkErrors) {
          const match = matchErrorPattern(patterns, errLine);
          if (match?.type === 'network_error') {
            networkMatches++;
            console.log(`   ✓ Network error detected: "${errLine.substring(0, 40)}..." → ${match.message}`);
          }
        }
        console.log(`   📊 Network patterns: ${networkMatches}/${networkErrors.length} matched`);

        // Verify error patterns exist for this agent
        const hasPatterns = Object.keys(patterns).length > 0;
        expect(
          hasPatterns,
          `${provider.name} should have registered error patterns`
        ).toBe(true);

        // At least some patterns should match for common error types
        const totalMatches = authMatches + rateMatches + tokenMatches + networkMatches;
        console.log(`   📊 Total pattern matches: ${totalMatches}`);

        // Each agent should recognize at least some error patterns
        expect(
          totalMatches >= 2,
          `${provider.name} should match at least 2 error patterns (matched: ${totalMatches})`
        ).toBe(true);
      });

      it('should handle forced error gracefully', async () => {
        // This test verifies that errors from the agent are properly handled.
        // We force an error by using an invalid argument/flag.
        //
        // This validates:
        // 1. Agent returns non-zero exit code on error
        // 2. Error output is captured in stderr or stdout
        // 3. Error can be parsed and classified

        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }

        // Use an invalid argument to force an error
        let errorArgs: string[];
        if (provider.agentId === 'claude-code') {
          // Claude Code: use an invalid flag
          errorArgs = ['--invalid-flag-that-does-not-exist-12345'];
        } else if (provider.agentId === 'codex') {
          // Codex: use invalid subcommand
          errorArgs = ['invalid-command-12345'];
        } else if (provider.agentId === 'opencode') {
          // OpenCode: use invalid flag
          errorArgs = ['run', '--invalid-flag-12345'];
        } else {
          console.log(`⚠️  Error forcing not configured for ${provider.name}`);
          return;
        }

        console.log(`\n💥 Testing forced error handling for ${provider.name}`);
        console.log(`🚀 Running: ${provider.command} ${errorArgs.join(' ')}`);

        const result = await runProvider(provider, errorArgs);

        console.log(`📤 Exit code: ${result.exitCode}`);
        console.log(`📤 Stdout: ${result.stdout.substring(0, 300)}`);
        console.log(`📤 Stderr: ${result.stderr.substring(0, 300)}`);

        // Agent should return non-zero exit code on error
        expect(
          result.exitCode !== 0,
          `${provider.name} should return non-zero exit code on error`
        ).toBe(true);

        // There should be some error output
        const hasErrorOutput = result.stderr.length > 0 || result.stdout.length > 0;
        expect(
          hasErrorOutput,
          `${provider.name} should produce error output`
        ).toBe(true);

        console.log(`   ✓ Error handled: exit code ${result.exitCode}`);
      }, PROVIDER_TIMEOUT);

      it('should process image and identify text content', async () => {
        // This test verifies that images are properly passed to the provider and processed.
        // It uses a test image containing the word "Maestro" and asks the provider to
        // identify the text. This validates the full image processing pipeline.
        //
        // For agents that support image input (supportsImageInput: true):
        // - Claude Code: Uses --input-format stream-json with base64 via stdin
        // - Codex: Uses -i <file> flag
        // - OpenCode: Uses -f <file> flag

        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }

        const capabilities = getAgentCapabilities(provider.agentId);
        if (!capabilities.supportsImageInput) {
          console.log(`Skipping: ${provider.name} does not support image input`);
          return;
        }

        // Verify test image exists
        if (!fs.existsSync(TEST_IMAGE_PATH)) {
          console.log(`⚠️  Test image not found at ${TEST_IMAGE_PATH}, skipping`);
          return;
        }

        const prompt = 'What word is shown in this image? Reply with ONLY the single word shown, nothing else.';

        console.log(`\n🖼️  Testing image processing for ${provider.name}`);
        console.log(`📁 Image path: ${TEST_IMAGE_PATH}`);

        let result: { stdout: string; stderr: string; exitCode: number };

        if (capabilities.supportsStreamJsonInput && provider.buildStreamJsonInput) {
          // Claude Code: Use stream-json input with base64 image via stdin
          const imageBuffer = fs.readFileSync(TEST_IMAGE_PATH);
          const imageBase64 = imageBuffer.toString('base64');
          const mediaType = 'image/png';

          const args = provider.buildInitialArgs(prompt, { images: ['placeholder'] });
          const stdinContent = provider.buildStreamJsonInput(prompt, imageBase64, mediaType);

          console.log(`🚀 Running: ${provider.command} ${args.join(' ')}`);
          console.log(`📥 Sending ${imageBase64.length} bytes of base64 image data via stdin`);

          result = await runProvider(provider, args, TEST_CWD, stdinContent);
        } else if (provider.buildImageArgs) {
          // Codex/OpenCode: Use file-based image args

          const args = provider.buildImageArgs(prompt, TEST_IMAGE_PATH);

          console.log(`🚀 Running: ${provider.command} ${args.join(' ')}`);

          result = await runProvider(provider, args);
        } else {
          console.log(`⚠️  ${provider.name} has no image args builder, skipping`);
          return;
        }

        console.log(`📤 Exit code: ${result.exitCode}`);
        console.log(`📤 Stdout (first 1000 chars): ${result.stdout.substring(0, 1000)}`);
        if (result.stderr) {
          console.log(`📤 Stderr: ${result.stderr.substring(0, 500)}`);
        }

        // Check for success
        expect(
          provider.isSuccessful(result.stdout, result.exitCode),
          `${provider.name} image processing should complete successfully`
        ).toBe(true);

        // Parse and verify response contains "Maestro"
        const response = provider.parseResponse(result.stdout);
        console.log(`💬 Response: ${response}`);
        expect(response, `${provider.name} should return a response`).toBeTruthy();

        // The response should contain "Maestro" (case-insensitive)
        const responseContainsMaestro = response?.toLowerCase().includes('maestro');
        expect(
          responseContainsMaestro,
          `${provider.name} should identify "Maestro" in the image. Got: "${response}"`
        ).toBe(true);
      }, PROVIDER_TIMEOUT);

      it('should enumerate available tools from init event', async () => {
        // This test verifies that the provider exposes its available tools
        // in the init/startup event. This is important for UI features that
        // show what capabilities the agent has.
        //
        // Claude Code: {"type":"system","subtype":"init","tools":["Task","Bash","Read",...]}
        // Codex: may include tools in session.started or thread config
        // OpenCode: may include tools in step_start or init events

        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }

        if (!provider.parseTools) {
          console.log(`Skipping: ${provider.name} does not have parseTools implemented`);
          return;
        }

        const prompt = 'Say "hi" briefly.';
        const args = provider.buildInitialArgs(prompt);

        console.log(`\n🔧 Testing tool enumeration for ${provider.name}`);
        console.log(`🚀 Running: ${provider.command} ${args.join(' ')}`);

        const result = await runProvider(provider, args);

        console.log(`📤 Exit code: ${result.exitCode}`);

        // Parse tools from output
        const tools = provider.parseTools(result.stdout);
        console.log(`🔧 Tools found: ${tools ? tools.length : 0}`);
        if (tools && tools.length > 0) {
          console.log(`   Sample tools: ${tools.slice(0, 10).join(', ')}${tools.length > 10 ? '...' : ''}`);
        }

        // Check for success first
        expect(
          provider.isSuccessful(result.stdout, result.exitCode),
          `${provider.name} should complete successfully`
        ).toBe(true);

        // Claude Code definitely exposes tools, others may not
        if (provider.agentId === 'claude-code') {
          expect(tools, `${provider.name} should expose tools array`).toBeTruthy();
          expect(tools!.length, `${provider.name} should have multiple tools`).toBeGreaterThan(5);

          // Verify common tools are present
          const expectedTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
          for (const tool of expectedTools) {
            expect(
              tools!.includes(tool),
              `${provider.name} should have ${tool} tool`
            ).toBe(true);
          }
        } else {
          // For other providers, just log what we found
          console.log(`   ℹ️  ${provider.name} tools parsing may need adjustment based on actual output format`);
        }
      }, PROVIDER_TIMEOUT);

      it('should emit tool execution events when using tools', async () => {
        // This test verifies that when an agent uses a tool (like reading a file),
        // the output contains parseable tool execution events that Maestro can
        // use to show tool activity in the UI.
        //
        // We ask the agent to read a known file (package.json) which should trigger
        // tool usage events in the output stream.

        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }

        if (!provider.parseToolExecutions) {
          console.log(`Skipping: ${provider.name} does not have parseToolExecutions implemented`);
          return;
        }

        // Ask to read package.json - this should trigger a Read/file tool
        const prompt = 'Read the package.json file in the current directory and tell me the project name. Be brief.';
        const args = provider.buildInitialArgs(prompt);

        console.log(`\n🔨 Testing tool execution for ${provider.name}`);
        console.log(`🚀 Running: ${provider.command} ${args.join(' ')}`);

        const result = await runProvider(provider, args);

        console.log(`📤 Exit code: ${result.exitCode}`);

        // Check for success
        expect(
          provider.isSuccessful(result.stdout, result.exitCode),
          `${provider.name} should complete successfully`
        ).toBe(true);

        // Parse tool executions
        const executions = provider.parseToolExecutions(result.stdout);
        console.log(`🔨 Tool executions found: ${executions.length}`);
        for (const exec of executions.slice(0, 5)) {
          console.log(`   - ${exec.name} (${exec.status || 'unknown status'})`);
        }

        // Verify we got tool execution events
        expect(
          executions.length,
          `${provider.name} should have tool execution events when reading a file`
        ).toBeGreaterThan(0);

        // Verify at least one tool looks like a file read operation
        const hasReadTool = executions.some(exec => {
          const name = exec.name.toLowerCase();
          return name.includes('read') || 
                 name.includes('file') || 
                 name.includes('cat') ||
                 name.includes('glob') ||
                 name.includes('fs');
        });

        // Also check for result containing project name (maestro)
        const response = provider.parseResponse(result.stdout);
        console.log(`💬 Response: ${response?.substring(0, 200)}`);

        const responseHasProjectName = response?.toLowerCase().includes('maestro');
        expect(
          responseHasProjectName,
          `${provider.name} should have read package.json and found project name. Got: "${response?.substring(0, 100)}"`
        ).toBe(true);

        // Log whether we found a read-like tool (informational, not a hard failure for all providers)
        if (hasReadTool) {
          console.log(`   ✓ Found file read tool in executions`);
        } else {
          console.log(`   ⚠️  No obvious file read tool found - tool names may differ by provider`);
        }
      }, PROVIDER_TIMEOUT);

      it('should track tool execution state transitions', async () => {
        // This test verifies that tool execution events include state information
        // (running, complete, error) that Maestro can use to show tool progress.
        //
        // We ask the agent to perform multiple tool operations and verify
        // that we can parse the state of each tool execution.

        if (!providerAvailable) {
          console.log(`Skipping: ${provider.name} not available`);
          return;
        }

        if (!provider.parseToolExecutions) {
          console.log(`Skipping: ${provider.name} does not have parseToolExecutions implemented`);
          return;
        }

        // Ask to do multiple operations that trigger tools
        const prompt = 'List the files in the current directory using the Glob or Bash tool, then read the README.md file. Be very brief in your response.';
        const args = provider.buildInitialArgs(prompt);

        console.log(`\n📊 Testing tool state tracking for ${provider.name}`);
        console.log(`🚀 Running: ${provider.command} ${args.join(' ')}`);

        const result = await runProvider(provider, args);

        console.log(`📤 Exit code: ${result.exitCode}`);

        // Check for success
        expect(
          provider.isSuccessful(result.stdout, result.exitCode),
          `${provider.name} should complete successfully`
        ).toBe(true);

        // Parse tool executions
        const executions = provider.parseToolExecutions(result.stdout);
        console.log(`📊 Tool executions found: ${executions.length}`);

        // Analyze state distribution
        const states = {
          running: 0,
          complete: 0,
          error: 0,
          unknown: 0,
        };

        for (const exec of executions) {
          const status = exec.status?.toLowerCase() || 'unknown';
          if (status.includes('run') || status === 'running') {
            states.running++;
          } else if (status.includes('complete') || status === 'complete' || status === 'success') {
            states.complete++;
          } else if (status.includes('error') || status === 'error' || status === 'failed') {
            states.error++;
          } else {
            states.unknown++;
          }
          console.log(`   - ${exec.name}: ${exec.status || 'no status'}`);
        }

        console.log(`📊 State distribution: running=${states.running}, complete=${states.complete}, error=${states.error}, unknown=${states.unknown}`);

        // Verify we got multiple tool executions (list + read = at least 2)
        expect(
          executions.length,
          `${provider.name} should have multiple tool executions for list + read operations`
        ).toBeGreaterThanOrEqual(1); // At least 1, some providers may batch

        // Verify response mentions something from the directory or README
        const response = provider.parseResponse(result.stdout);
        console.log(`💬 Response: ${response?.substring(0, 300)}`);
        expect(response, `${provider.name} should return a response`).toBeTruthy();
      }, PROVIDER_TIMEOUT * 2); // Double timeout for multi-tool operations
    });
  }
});

/**
 * Standalone test runner for manual testing
 * Run with: npx tsx src/__tests__/integration/provider-integration.test.ts
 */
if (require.main === module) {
  (async () => {
    console.log('🧪 Running Provider Integration Tests (standalone)\n');

    for (const provider of PROVIDERS) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Testing: ${provider.name}`);
      console.log('='.repeat(60));

      const available = await isProviderAvailable(provider);
      if (!available) {
        console.log(`❌ ${provider.name} CLI not available, skipping`);
        continue;
      }

      console.log(`✅ ${provider.name} CLI available`);

      // Test 1: Initial message
      console.log('\n📝 Test 1: Initial message');
      const initialPrompt = 'Say "hello" briefly.';
      const initialArgs = provider.buildInitialArgs(initialPrompt);
      console.log(`Command: ${provider.command} ${initialArgs.join(' ')}`);

      const result1 = await runProvider(provider, initialArgs);
      console.log(`Exit code: ${result1.exitCode}`);

      const sessionId = provider.parseSessionId(result1.stdout);
      const response1 = provider.parseResponse(result1.stdout);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Response: ${response1?.substring(0, 100)}`);

      if (!sessionId) {
        console.log('❌ No session ID returned, cannot test resume');
        continue;
      }

      // Test 2: Resume session
      console.log('\n📝 Test 2: Resume session');
      const resumePrompt = 'Say "goodbye" briefly.';
      const resumeArgs = provider.buildResumeArgs(sessionId, resumePrompt);
      console.log(`Command: ${provider.command} ${resumeArgs.join(' ')}`);

      const result2 = await runProvider(provider, resumeArgs);
      console.log(`Exit code: ${result2.exitCode}`);

      const response2 = provider.parseResponse(result2.stdout);
      console.log(`Response: ${response2?.substring(0, 100)}`);

      if (result2.exitCode === 0 && response2) {
        console.log(`✅ ${provider.name} integration test PASSED`);
      } else {
        console.log(`❌ ${provider.name} integration test FAILED`);
        if (result2.stderr) {
          console.log(`Stderr: ${result2.stderr}`);
        }
      }
    }
  })();
}
