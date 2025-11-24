import { execFileNoThrow } from './utils/execFile';

export interface AgentConfig {
  id: string;
  name: string;
  binaryName: string;
  command: string;
  args: string[];
  available: boolean;
  path?: string;
}

const AGENT_DEFINITIONS: Omit<AgentConfig, 'available' | 'path'>[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    binaryName: 'claude',
    command: 'claude',
    args: [],
  },
  {
    id: 'aider-gemini',
    name: 'Aider (Gemini)',
    binaryName: 'aider',
    command: 'aider',
    args: ['--model', 'gemini/gemini-2.0-flash-exp'],
  },
  {
    id: 'qwen-coder',
    name: 'Qwen Coder',
    binaryName: 'qwen-coder',
    command: 'qwen-coder',
    args: [],
  },
  {
    id: 'cli',
    name: 'CLI Terminal',
    binaryName: 'bash',
    command: 'bash',
    args: [],
  },
];

export class AgentDetector {
  private cachedAgents: AgentConfig[] | null = null;

  /**
   * Detect which agents are available on the system
   */
  async detectAgents(): Promise<AgentConfig[]> {
    if (this.cachedAgents) {
      return this.cachedAgents;
    }

    const agents: AgentConfig[] = [];

    for (const agentDef of AGENT_DEFINITIONS) {
      const detection = await this.checkBinaryExists(agentDef.binaryName);

      agents.push({
        ...agentDef,
        available: detection.exists,
        path: detection.path,
      });
    }

    this.cachedAgents = agents;
    return agents;
  }

  /**
   * Check if a binary exists in PATH
   */
  private async checkBinaryExists(binaryName: string): Promise<{ exists: boolean; path?: string }> {
    try {
      // Use 'which' on Unix-like systems, 'where' on Windows
      const command = process.platform === 'win32' ? 'where' : 'which';
      const result = await execFileNoThrow(command, [binaryName]);

      if (result.exitCode === 0 && result.stdout.trim()) {
        return {
          exists: true,
          path: result.stdout.trim().split('\n')[0], // First match
        };
      }

      return { exists: false };
    } catch (error) {
      return { exists: false };
    }
  }

  /**
   * Get a specific agent by ID
   */
  async getAgent(agentId: string): Promise<AgentConfig | null> {
    const agents = await this.detectAgents();
    return agents.find(a => a.id === agentId) || null;
  }

  /**
   * Clear the cache (useful if PATH changes)
   */
  clearCache(): void {
    this.cachedAgents = null;
  }
}
