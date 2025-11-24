import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as pty from 'node-pty';

interface ProcessConfig {
  sessionId: string;
  toolType: string;
  cwd: string;
  command: string;
  args: string[];
  requiresPty?: boolean; // Whether this agent needs a pseudo-terminal
  prompt?: string; // For batch mode agents like Claude (passed as CLI argument)
}

interface ManagedProcess {
  sessionId: string;
  toolType: string;
  ptyProcess?: pty.IPty;
  childProcess?: ChildProcess;
  cwd: string;
  pid: number;
  isTerminal: boolean;
  isBatchMode?: boolean; // True for agents that run in batch mode (exit after response)
  jsonBuffer?: string; // Buffer for accumulating JSON output in batch mode
}

export class ProcessManager extends EventEmitter {
  private processes: Map<string, ManagedProcess> = new Map();

  /**
   * Spawn a new process for a session
   */
  spawn(config: ProcessConfig): { pid: number; success: boolean } {
    const { sessionId, toolType, cwd, command, args, requiresPty, prompt } = config;

    // For batch mode with prompt, append prompt to args
    const finalArgs = prompt ? [...args, prompt] : args;

    // Determine if this should use a PTY:
    // - If toolType is 'terminal', always use PTY for full shell emulation
    // - If requiresPty is true, use PTY for AI agents that need TTY (like Claude Code)
    // - Batch mode (with prompt) never uses PTY
    const usePty = (toolType === 'terminal' || requiresPty === true) && !prompt;
    const isTerminal = toolType === 'terminal';

    try {
      if (usePty) {
        // Use node-pty for terminal mode or AI agents that require PTY
        let ptyCommand: string;
        let ptyArgs: string[];

        if (isTerminal) {
          // Full shell emulation for terminal mode
          ptyCommand = process.platform === 'win32' ? 'powershell.exe' : 'bash';
          ptyArgs = [];
        } else {
          // Spawn the AI agent directly with PTY support
          ptyCommand = command;
          ptyArgs = finalArgs;
        }

        const ptyProcess = pty.spawn(ptyCommand, ptyArgs, {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: cwd,
          env: process.env as any,
        });

        const managedProcess: ManagedProcess = {
          sessionId,
          toolType,
          ptyProcess,
          cwd,
          pid: ptyProcess.pid,
          isTerminal: true,
        };

        this.processes.set(sessionId, managedProcess);

        // Handle output
        ptyProcess.onData((data) => {
          console.log(`[ProcessManager] PTY onData for session ${sessionId} (PID ${ptyProcess.pid}):`, data.substring(0, 100));
          this.emit('data', sessionId, data);
        });

        ptyProcess.onExit(({ exitCode }) => {
          console.log(`[ProcessManager] PTY onExit for session ${sessionId}:`, exitCode);
          this.emit('exit', sessionId, exitCode);
          this.processes.delete(sessionId);
        });

        console.log(`[ProcessManager] PTY process created:`, {
          sessionId,
          toolType,
          isTerminal,
          requiresPty: requiresPty || false,
          pid: ptyProcess.pid,
          command: ptyCommand,
          args: ptyArgs,
          cwd
        });

        return { pid: ptyProcess.pid, success: true };
      } else {
        // Use regular child_process for AI tools (including batch mode)
        const childProcess = spawn(command, finalArgs, {
          cwd,
          env: process.env,
          shell: false, // Explicitly disable shell to prevent injection
        });

        const isBatchMode = !!prompt;

        const managedProcess: ManagedProcess = {
          sessionId,
          toolType,
          childProcess,
          cwd,
          pid: childProcess.pid || -1,
          isTerminal: false,
          isBatchMode,
          jsonBuffer: isBatchMode ? '' : undefined,
        };

        this.processes.set(sessionId, managedProcess);

        // Handle stdout
        childProcess.stdout?.on('data', (data: Buffer) => {
          const output = data.toString();

          if (isBatchMode) {
            // In batch mode, accumulate JSON output
            managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + output;
          } else {
            // In interactive mode, emit data immediately
            this.emit('data', sessionId, output);
          }
        });

        // Handle stderr
        childProcess.stderr?.on('data', (data: Buffer) => {
          this.emit('data', sessionId, `[stderr] ${data.toString()}`);
        });

        // Handle exit
        childProcess.on('exit', (code) => {
          if (isBatchMode && managedProcess.jsonBuffer) {
            // Parse JSON response from batch mode
            try {
              const jsonResponse = JSON.parse(managedProcess.jsonBuffer);

              // Emit the result text
              if (jsonResponse.result) {
                this.emit('data', sessionId, jsonResponse.result);
              }

              // Emit session_id if present
              if (jsonResponse.session_id) {
                this.emit('session-id', sessionId, jsonResponse.session_id);
              }

              // Emit full response for debugging
              console.log('[ProcessManager] Batch mode JSON response:', {
                sessionId,
                hasResult: !!jsonResponse.result,
                hasSessionId: !!jsonResponse.session_id,
                sessionIdValue: jsonResponse.session_id
              });
            } catch (error) {
              console.error('[ProcessManager] Failed to parse JSON response:', error);
              // Emit raw buffer as fallback
              this.emit('data', sessionId, managedProcess.jsonBuffer);
            }
          }

          this.emit('exit', sessionId, code || 0);
          this.processes.delete(sessionId);
        });

        childProcess.on('error', (error) => {
          this.emit('data', sessionId, `[error] ${error.message}`);
          this.processes.delete(sessionId);
        });

        return { pid: childProcess.pid || -1, success: true };
      }
    } catch (error: any) {
      console.error('Failed to spawn process:', error);
      return { pid: -1, success: false };
    }
  }

  /**
   * Write data to a process's stdin
   */
  write(sessionId: string, data: string): boolean {
    const process = this.processes.get(sessionId);
    if (!process) {
      console.error(`[ProcessManager] write() - No process found for session: ${sessionId}`);
      return false;
    }

    console.log('[ProcessManager] write() - Process info:', {
      sessionId,
      toolType: process.toolType,
      isTerminal: process.isTerminal,
      pid: process.pid,
      hasPtyProcess: !!process.ptyProcess,
      hasChildProcess: !!process.childProcess,
      hasStdin: !!process.childProcess?.stdin,
      dataLength: data.length,
      dataPreview: data.substring(0, 50)
    });

    try {
      if (process.isTerminal && process.ptyProcess) {
        console.log(`[ProcessManager] Writing to PTY process (PID ${process.pid})`);
        process.ptyProcess.write(data);
        return true;
      } else if (process.childProcess?.stdin) {
        console.log(`[ProcessManager] Writing to child process stdin (PID ${process.pid})`);
        process.childProcess.stdin.write(data);
        return true;
      }
      console.error(`[ProcessManager] No valid input stream for session: ${sessionId}`);
      return false;
    } catch (error) {
      console.error('Failed to write to process:', error);
      return false;
    }
  }

  /**
   * Resize terminal (for pty processes)
   */
  resize(sessionId: string, cols: number, rows: number): boolean {
    const process = this.processes.get(sessionId);
    if (!process || !process.isTerminal || !process.ptyProcess) return false;

    try {
      process.ptyProcess.resize(cols, rows);
      return true;
    } catch (error) {
      console.error('Failed to resize terminal:', error);
      return false;
    }
  }

  /**
   * Kill a specific process
   */
  kill(sessionId: string): boolean {
    const process = this.processes.get(sessionId);
    if (!process) return false;

    try {
      if (process.isTerminal && process.ptyProcess) {
        process.ptyProcess.kill();
      } else if (process.childProcess) {
        process.childProcess.kill('SIGTERM');
      }
      this.processes.delete(sessionId);
      return true;
    } catch (error) {
      console.error('Failed to kill process:', error);
      return false;
    }
  }

  /**
   * Kill all managed processes
   */
  killAll(): void {
    for (const [sessionId] of this.processes) {
      this.kill(sessionId);
    }
  }

  /**
   * Get all active processes
   */
  getAll(): ManagedProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get a specific process
   */
  get(sessionId: string): ManagedProcess | undefined {
    return this.processes.get(sessionId);
  }
}
