/**
 * Maestro Library - Public Entry Point
 *
 * This module exports the stable public API of maestro-lib.
 * All library clients should import from here, not from deep module paths.
 *
 * Internal modules (bin/, test utilities) are not exported.
 */

// Paths and configuration
export * from './paths/userDataDir';
export * from './paths/resolve';
export * from './paths/syncPath';
export * from './paths/doctor';
export * from './paths/complete';

// Desktop bridge: find the running desktop (cli-server.json) and talk to it
export * from './client/discovery';
export * from './client/bridge-connection';

// The client interface the TUI programs against, and its WebSocket implementation
export * from './client/types';
export { createWsMaestroClient } from './client/ws-client';

// Store files (read-only)
export * from './store/corrupt-store';
export * from './store/records';
export * from './store/read-stores';
export * from './store/read-history';
export * from './store/transcript';
export * from './store/agent-tree';
export * from './store/tab-display';

// Provider display names (a provider this build does not know still gets a label)
export { getAgentDisplayName, AGENT_AUTOSELECT_ORDER } from '../agentMetadata';

export type { AgentError, SshRemoteConfig, ThinkingMode, ToolType, UsageStats } from '../types';
export { asThinkingMode } from '../types';

// Provider swap: park and restore provider-specific tab and agent state (PS-5)
export * from './agents/providerSwap';

// Auto Run: the folder, document scanners, and validation both engines and the TUI read alike
export * from '../markdownTaskScan';
export * from '../autorunMarkers';
export { PLAYBOOKS_DIR } from '../maestro-paths';
export * from './autorun/documents';
export * from './autorun/last-run';
export * from './autorun/launch';
export * from './autorun/progress';
export * from './autorun/run-tracker';
export * from './autorun/templates';
export * from './autorun/validate';

// Group chats: the record, its events and reducer, and the create rules (GC-1 to GC-4)
export * from './groupchat/chat';

// Agent form rules, shared with the desktop so a TUI form and the Edit dialog cannot disagree
export { defaultAgentNameForPath, projectNameFromPath } from '../projectIdentity';
export {
	isSameDirectory,
	rebasePathOntoRoot,
	workingDirectoryChangeBlocker,
} from '../agentWorkingDirectory';
export {
	isBlankEnvKey,
	isBlankEnvValue,
	isSecretEnvKey,
	maskEnvValue,
	stripBlankEnvVars,
} from '../agentEnvironment';

// One-line tool call descriptions ("Read src/App.tsx"), shared with the desktop activity feed
export * from '../toolActivityLabel';

// Timestamp, token, and cost display, shared so every surface shows a figure the same way
export {
	formatTimestamp,
	formatTokensCompact,
	formatCost,
	formatElapsedTimeColon,
} from '../formatters';

// Context window sizing, shared so a status line and the desktop gauge size the same window
export { getContextWindowForAgent } from '../agentConstants';

// Fuzzy matching, shared with the desktop renderer (its utils/search.ts re-exports the same module)
export * from '../fuzzyMatch';

// Launch and argument building
export * from './launch/launch-plan';
export * from './launch/prompt-delivery';
export * from './launch/agent-args';
export * from './launch/env';
export * from './launch/interactive-mode';
export * from './launch/ssh-remote-resolver';
export * from './launch/path-prober';
export * from './launch/shell-escape';
export * from './launch/cwd';
export * from './launch/spawn-path';
export * from './launch/ssh-spawn-wrapper';
export * from './launch/ssh-command-builder';
export * from './launch/ssh-path';
export * from './launch/windows-command';
export * from './launch/claude-mode-selector';
export * from './launch/exec-file';
export * from './launch/getShellPath';
export * from './launch/image-refs';

// Output parsing
export * from './parsers/index';
export * from './parsers/agent-output-parser';
export * from './parsers/parser-factory';
export * from './parsers/usage-aggregator';
export * from './parsers/claude-output-parser';
export * from './parsers/codex-output-parser';
export * from './parsers/copilot-output-parser';
export * from './parsers/antigravity-output-parser';
export * from './parsers/grok-output-parser';
export * from './parsers/opencode-output-parser';
export * from './parsers/factory-droid-output-parser';
export * from './parsers/pi-output-parser';
export * from './parsers/omp-output-parser';
export * from './parsers/qwen-output-parser';
export * from './parsers/terminal-filter';
export * from './parsers/error-patterns';

// Provider definitions and capabilities
export * from './providers/definitions';
export * from './providers/capabilities';

// Streaming and turn contract
export * from './streaming/buffered-line-reader';
export * from './streaming/turn-outcome';
export * from './streaming/usage-accumulator';
export * from './streaming/usage-totals';

// Turn execution
export * from './run/start-turn';
export * from './run/turn-capture';
export * from './run/session';
export * from './run/run-to-completion';

// Process control
export * from './control/termination';
export * from './control/process-tree';
export * from './control/pty-kill';

// Host services
export * from './host';
