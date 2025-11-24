/**
 * Process management service
 * Wraps IPC calls to main process for process operations
 */

export interface ProcessConfig {
  cwd: string;
  command: string;
  args: string[];
  isTerminal: boolean;
}

export interface ProcessDataHandler {
  (sessionId: string, data: string): void;
}

export interface ProcessExitHandler {
  (sessionId: string, code: number): void;
}

export interface ProcessSessionIdHandler {
  (sessionId: string, claudeSessionId: string): void;
}

export const processService = {
  /**
   * Spawn a new process
   */
  async spawn(sessionId: string, config: ProcessConfig): Promise<void> {
    try {
      await window.maestro.process.spawn(sessionId, config);
    } catch (error) {
      console.error('Process spawn error:', error);
      throw error;
    }
  },

  /**
   * Write data to process stdin
   */
  async write(sessionId: string, data: string): Promise<void> {
    try {
      await window.maestro.process.write(sessionId, data);
    } catch (error) {
      console.error('Process write error:', error);
      throw error;
    }
  },

  /**
   * Kill a process
   */
  async kill(sessionId: string): Promise<void> {
    try {
      await window.maestro.process.kill(sessionId);
    } catch (error) {
      console.error('Process kill error:', error);
      throw error;
    }
  },

  /**
   * Resize PTY terminal
   */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    try {
      await window.maestro.process.resize(sessionId, cols, rows);
    } catch (error) {
      console.error('Process resize error:', error);
      throw error;
    }
  },

  /**
   * Register handler for process data events
   */
  onData(handler: ProcessDataHandler): () => void {
    return window.maestro.process.onData(handler);
  },

  /**
   * Register handler for process exit events
   */
  onExit(handler: ProcessExitHandler): () => void {
    return window.maestro.process.onExit(handler);
  },

  /**
   * Register handler for session-id events (batch mode)
   */
  onSessionId(handler: ProcessSessionIdHandler): () => void {
    return window.maestro.process.onSessionId(handler);
  }
};
