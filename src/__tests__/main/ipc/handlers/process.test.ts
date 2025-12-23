/**
 * Tests for the process IPC handlers
 *
 * These tests verify the process lifecycle management API:
 * - spawn: Start a new process for a session
 * - write: Send input to a process
 * - interrupt: Send SIGINT to a process
 * - kill: Terminate a process
 * - resize: Resize PTY dimensions
 * - getActiveProcesses: List all running processes
 * - runCommand: Execute a single command and capture output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerProcessHandlers, ProcessHandlerDependencies } from '../../../../main/ipc/handlers/process';

// Mock electron's ipcMain
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the agent-args utilities
vi.mock('../../../../main/utils/agent-args', () => ({
  buildAgentArgs: vi.fn((agent, opts) => opts.baseArgs || []),
  applyAgentConfigOverrides: vi.fn((agent, args, opts) => ({
    args,
    modelSource: 'none' as const,
    customArgsSource: 'none' as const,
    customEnvSource: 'none' as const,
    effectiveCustomEnvVars: undefined,
  })),
  getContextWindowValue: vi.fn(() => 0),
}));

// Mock node-pty (required for process-manager but not directly used in these tests)
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

describe('process IPC handlers', () => {
  let handlers: Map<string, Function>;
  let mockProcessManager: {
    spawn: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    runCommand: ReturnType<typeof vi.fn>;
  };
  let mockAgentDetector: {
    getAgent: ReturnType<typeof vi.fn>;
  };
  let mockAgentConfigsStore: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  let mockSettingsStore: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  let deps: ProcessHandlerDependencies;

  beforeEach(() => {
    // Clear mocks
    vi.clearAllMocks();

    // Create mock process manager
    mockProcessManager = {
      spawn: vi.fn(),
      write: vi.fn(),
      interrupt: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      getAll: vi.fn(),
      runCommand: vi.fn(),
    };

    // Create mock agent detector
    mockAgentDetector = {
      getAgent: vi.fn(),
    };

    // Create mock config store
    mockAgentConfigsStore = {
      get: vi.fn().mockReturnValue({}),
      set: vi.fn(),
    };

    // Create mock settings store
    mockSettingsStore = {
      get: vi.fn().mockImplementation((key, defaultValue) => defaultValue),
      set: vi.fn(),
    };

    // Create dependencies
    deps = {
      getProcessManager: () => mockProcessManager as any,
      getAgentDetector: () => mockAgentDetector as any,
      agentConfigsStore: mockAgentConfigsStore as any,
      settingsStore: mockSettingsStore as any,
    };

    // Capture all registered handlers
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    // Register handlers
    registerProcessHandlers(deps);
  });

  afterEach(() => {
    handlers.clear();
  });

  describe('registration', () => {
    it('should register all process handlers', () => {
      const expectedChannels = [
        'process:spawn',
        'process:write',
        'process:interrupt',
        'process:kill',
        'process:resize',
        'process:getActiveProcesses',
        'process:runCommand',
      ];

      for (const channel of expectedChannels) {
        expect(handlers.has(channel)).toBe(true);
      }
      expect(handlers.size).toBe(expectedChannels.length);
    });
  });

  describe('process:spawn', () => {
    it('should spawn PTY process with correct args', async () => {
      const mockAgent = {
        id: 'claude-code',
        name: 'Claude Code',
        requiresPty: true,
        path: '/usr/local/bin/claude',
      };

      mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
      mockProcessManager.spawn.mockReturnValue({ pid: 12345, success: true });

      const handler = handlers.get('process:spawn');
      const result = await handler!({} as any, {
        sessionId: 'session-1',
        toolType: 'claude-code',
        cwd: '/test/project',
        command: 'claude',
        args: ['--print', '--verbose'],
      });

      expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('claude-code');
      expect(mockProcessManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          toolType: 'claude-code',
          cwd: '/test/project',
          command: 'claude',
          requiresPty: true,
        })
      );
      expect(result).toEqual({ pid: 12345, success: true });
    });

    it('should return pid on successful spawn', async () => {
      const mockAgent = { id: 'terminal', requiresPty: true };

      mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
      mockProcessManager.spawn.mockReturnValue({ pid: 99999, success: true });

      const handler = handlers.get('process:spawn');
      const result = await handler!({} as any, {
        sessionId: 'session-2',
        toolType: 'terminal',
        cwd: '/home/user',
        command: '/bin/zsh',
        args: [],
      });

      expect(result.pid).toBe(99999);
      expect(result.success).toBe(true);
    });

    it('should handle spawn failure', async () => {
      const mockAgent = { id: 'claude-code' };

      mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
      mockProcessManager.spawn.mockReturnValue({ pid: -1, success: false });

      const handler = handlers.get('process:spawn');
      const result = await handler!({} as any, {
        sessionId: 'session-3',
        toolType: 'claude-code',
        cwd: '/test',
        command: 'invalid-command',
        args: [],
      });

      expect(result.pid).toBe(-1);
      expect(result.success).toBe(false);
    });

    it('should pass environment variables to spawn', async () => {
      const mockAgent = {
        id: 'claude-code',
        requiresPty: false,
      };

      mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
      mockProcessManager.spawn.mockReturnValue({ pid: 1000, success: true });

      const handler = handlers.get('process:spawn');
      await handler!({} as any, {
        sessionId: 'session-4',
        toolType: 'claude-code',
        cwd: '/test',
        command: 'claude',
        args: [],
        sessionCustomEnvVars: { API_KEY: 'secret123' },
      });

      expect(mockProcessManager.spawn).toHaveBeenCalled();
    });

    it('should use default shell for terminal sessions', async () => {
      const mockAgent = { id: 'terminal', requiresPty: true };

      mockAgentDetector.getAgent.mockResolvedValue(mockAgent);
      mockSettingsStore.get.mockImplementation((key, defaultValue) => {
        if (key === 'defaultShell') return 'fish';
        return defaultValue;
      });
      mockProcessManager.spawn.mockReturnValue({ pid: 1001, success: true });

      const handler = handlers.get('process:spawn');
      await handler!({} as any, {
        sessionId: 'session-5',
        toolType: 'terminal',
        cwd: '/test',
        command: '/bin/fish',
        args: [],
      });

      expect(mockProcessManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          shell: 'fish',
        })
      );
    });
  });

  describe('process:write', () => {
    it('should write data to process stdin', async () => {
      mockProcessManager.write.mockReturnValue(true);

      const handler = handlers.get('process:write');
      const result = await handler!({} as any, 'session-1', 'hello world\n');

      expect(mockProcessManager.write).toHaveBeenCalledWith('session-1', 'hello world\n');
      expect(result).toBe(true);
    });

    it('should handle invalid session id (no process found)', async () => {
      mockProcessManager.write.mockReturnValue(false);

      const handler = handlers.get('process:write');
      const result = await handler!({} as any, 'invalid-session', 'test');

      expect(mockProcessManager.write).toHaveBeenCalledWith('invalid-session', 'test');
      expect(result).toBe(false);
    });

    it('should handle write to already exited process', async () => {
      mockProcessManager.write.mockReturnValue(false);

      const handler = handlers.get('process:write');
      const result = await handler!({} as any, 'exited-session', 'data');

      expect(result).toBe(false);
    });
  });

  describe('process:kill', () => {
    it('should kill process by session id', async () => {
      mockProcessManager.kill.mockReturnValue(true);

      const handler = handlers.get('process:kill');
      const result = await handler!({} as any, 'session-to-kill');

      expect(mockProcessManager.kill).toHaveBeenCalledWith('session-to-kill');
      expect(result).toBe(true);
    });

    it('should handle already dead process', async () => {
      mockProcessManager.kill.mockReturnValue(false);

      const handler = handlers.get('process:kill');
      const result = await handler!({} as any, 'already-dead-session');

      expect(mockProcessManager.kill).toHaveBeenCalledWith('already-dead-session');
      expect(result).toBe(false);
    });

    it('should return false for non-existent session', async () => {
      mockProcessManager.kill.mockReturnValue(false);

      const handler = handlers.get('process:kill');
      const result = await handler!({} as any, 'non-existent');

      expect(result).toBe(false);
    });
  });

  describe('process:interrupt', () => {
    it('should send SIGINT to process', async () => {
      mockProcessManager.interrupt.mockReturnValue(true);

      const handler = handlers.get('process:interrupt');
      const result = await handler!({} as any, 'session-to-interrupt');

      expect(mockProcessManager.interrupt).toHaveBeenCalledWith('session-to-interrupt');
      expect(result).toBe(true);
    });

    it('should return false for non-existent process', async () => {
      mockProcessManager.interrupt.mockReturnValue(false);

      const handler = handlers.get('process:interrupt');
      const result = await handler!({} as any, 'non-existent');

      expect(result).toBe(false);
    });
  });

  describe('process:resize', () => {
    it('should resize PTY dimensions', async () => {
      mockProcessManager.resize.mockReturnValue(true);

      const handler = handlers.get('process:resize');
      const result = await handler!({} as any, 'terminal-session', 120, 40);

      expect(mockProcessManager.resize).toHaveBeenCalledWith('terminal-session', 120, 40);
      expect(result).toBe(true);
    });

    it('should handle invalid dimensions gracefully', async () => {
      mockProcessManager.resize.mockReturnValue(false);

      const handler = handlers.get('process:resize');
      const result = await handler!({} as any, 'session', -1, -1);

      expect(mockProcessManager.resize).toHaveBeenCalledWith('session', -1, -1);
      expect(result).toBe(false);
    });

    it('should handle invalid session id', async () => {
      mockProcessManager.resize.mockReturnValue(false);

      const handler = handlers.get('process:resize');
      const result = await handler!({} as any, 'invalid-session', 80, 24);

      expect(result).toBe(false);
    });
  });

  describe('process:getActiveProcesses', () => {
    it('should return list of running processes', async () => {
      const mockProcesses = [
        {
          sessionId: 'session-1',
          toolType: 'claude-code',
          pid: 1234,
          cwd: '/project1',
          isTerminal: false,
          isBatchMode: false,
          startTime: 1700000000000,
          command: 'claude',
          args: ['--print'],
        },
        {
          sessionId: 'session-2',
          toolType: 'terminal',
          pid: 5678,
          cwd: '/project2',
          isTerminal: true,
          isBatchMode: false,
          startTime: 1700000001000,
          command: '/bin/zsh',
          args: [],
        },
      ];

      mockProcessManager.getAll.mockReturnValue(mockProcesses);

      const handler = handlers.get('process:getActiveProcesses');
      const result = await handler!({} as any);

      expect(mockProcessManager.getAll).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        sessionId: 'session-1',
        toolType: 'claude-code',
        pid: 1234,
        cwd: '/project1',
        isTerminal: false,
        isBatchMode: false,
        startTime: 1700000000000,
        command: 'claude',
        args: ['--print'],
      });
    });

    it('should return empty array when no processes running', async () => {
      mockProcessManager.getAll.mockReturnValue([]);

      const handler = handlers.get('process:getActiveProcesses');
      const result = await handler!({} as any);

      expect(result).toEqual([]);
    });

    it('should strip non-serializable properties from process objects', async () => {
      const mockProcesses = [
        {
          sessionId: 'session-1',
          toolType: 'claude-code',
          pid: 1234,
          cwd: '/project',
          isTerminal: false,
          isBatchMode: true,
          startTime: 1700000000000,
          command: 'claude',
          args: [],
          // These non-serializable properties should not appear in output
          ptyProcess: { some: 'pty-object' },
          childProcess: { some: 'child-object' },
          outputParser: { parse: () => {} },
        },
      ];

      mockProcessManager.getAll.mockReturnValue(mockProcesses);

      const handler = handlers.get('process:getActiveProcesses');
      const result = await handler!({} as any);

      expect(result[0]).not.toHaveProperty('ptyProcess');
      expect(result[0]).not.toHaveProperty('childProcess');
      expect(result[0]).not.toHaveProperty('outputParser');
      expect(result[0]).toHaveProperty('sessionId');
      expect(result[0]).toHaveProperty('pid');
    });
  });

  describe('process:runCommand', () => {
    it('should execute command and return exit code', async () => {
      mockProcessManager.runCommand.mockResolvedValue({ exitCode: 0 });

      const handler = handlers.get('process:runCommand');
      const result = await handler!({} as any, {
        sessionId: 'session-1',
        command: 'ls -la',
        cwd: '/test/dir',
      });

      expect(mockProcessManager.runCommand).toHaveBeenCalledWith(
        'session-1',
        'ls -la',
        '/test/dir',
        'zsh', // default shell
        {} // shell env vars
      );
      expect(result).toEqual({ exitCode: 0 });
    });

    it('should use custom shell from settings', async () => {
      mockSettingsStore.get.mockImplementation((key, defaultValue) => {
        if (key === 'defaultShell') return 'fish';
        if (key === 'customShellPath') return '';
        if (key === 'shellEnvVars') return { CUSTOM_VAR: 'value' };
        return defaultValue;
      });
      mockProcessManager.runCommand.mockResolvedValue({ exitCode: 0 });

      const handler = handlers.get('process:runCommand');
      await handler!({} as any, {
        sessionId: 'session-1',
        command: 'echo test',
        cwd: '/test',
      });

      expect(mockProcessManager.runCommand).toHaveBeenCalledWith(
        'session-1',
        'echo test',
        '/test',
        'fish',
        { CUSTOM_VAR: 'value' }
      );
    });

    it('should use custom shell path when set', async () => {
      mockSettingsStore.get.mockImplementation((key, defaultValue) => {
        if (key === 'defaultShell') return 'zsh';
        if (key === 'customShellPath') return '/opt/custom/shell';
        if (key === 'shellEnvVars') return {};
        return defaultValue;
      });
      mockProcessManager.runCommand.mockResolvedValue({ exitCode: 0 });

      const handler = handlers.get('process:runCommand');
      await handler!({} as any, {
        sessionId: 'session-1',
        command: 'pwd',
        cwd: '/test',
      });

      expect(mockProcessManager.runCommand).toHaveBeenCalledWith(
        'session-1',
        'pwd',
        '/test',
        '/opt/custom/shell',
        {}
      );
    });

    it('should return non-zero exit code on command failure', async () => {
      mockProcessManager.runCommand.mockResolvedValue({ exitCode: 1 });

      const handler = handlers.get('process:runCommand');
      const result = await handler!({} as any, {
        sessionId: 'session-1',
        command: 'false',
        cwd: '/test',
      });

      expect(result.exitCode).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should throw error when process manager is not available', async () => {
      // Create deps with null process manager
      const nullDeps: ProcessHandlerDependencies = {
        getProcessManager: () => null,
        getAgentDetector: () => mockAgentDetector as any,
        agentConfigsStore: mockAgentConfigsStore as any,
        settingsStore: mockSettingsStore as any,
      };

      // Re-register handlers with null process manager
      handlers.clear();
      registerProcessHandlers(nullDeps);

      const handler = handlers.get('process:write');

      await expect(handler!({} as any, 'session', 'data')).rejects.toThrow('Process manager');
    });

    it('should throw error when agent detector is not available for spawn', async () => {
      // Create deps with null agent detector
      const nullDeps: ProcessHandlerDependencies = {
        getProcessManager: () => mockProcessManager as any,
        getAgentDetector: () => null,
        agentConfigsStore: mockAgentConfigsStore as any,
        settingsStore: mockSettingsStore as any,
      };

      // Re-register handlers with null agent detector
      handlers.clear();
      registerProcessHandlers(nullDeps);

      const handler = handlers.get('process:spawn');

      await expect(handler!({} as any, {
        sessionId: 'session',
        toolType: 'claude-code',
        cwd: '/test',
        command: 'claude',
        args: [],
      })).rejects.toThrow('Agent detector');
    });
  });
});
