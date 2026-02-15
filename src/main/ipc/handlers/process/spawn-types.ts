/**
 * IPC payload for `process:spawn`.
 * Supports agent-specific argument builders for batch mode, JSON output,
 * resume, read-only mode, and YOLO mode.
 */
export interface SpawnProcessConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	shell?: string;
	images?: string[]; // Base64 data URLs for images
	// Stdin prompt delivery modes
	sendPromptViaStdin?: boolean; // If true, send prompt via stdin as JSON (for stream-json compatible agents)
	sendPromptViaStdinRaw?: boolean; // If true, send prompt via stdin as raw text (for OpenCode, Codex, etc.)
	// Agent-specific spawn options (used to build args via agent config)
	agentSessionId?: string; // For session resume
	readOnlyMode?: boolean; // For read-only/plan mode
	modelId?: string; // For model selection
	yoloMode?: boolean; // For YOLO/full-access mode (bypasses confirmations)
	permissionMode?: 'full' | 'standard' | 'readonly'; // 3-way permission mode (overrides readOnlyMode/yoloMode)
	// Per-session overrides (take precedence over agent-level config)
	sessionCustomPath?: string; // Session-specific custom path
	sessionCustomArgs?: string; // Session-specific custom args
	sessionCustomEnvVars?: Record<string, string>; // Session-specific env vars
	sessionCustomModel?: string; // Session-specific model selection
	sessionCustomEffort?: string; // Session-specific effort/reasoning level
	sessionCustomContextWindow?: number; // Session-specific context window size
	// Per-session SSH remote config (takes precedence over agent-level SSH config)
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	// Account multiplexing
	accountId?: string; // Account to use for this session
	// Batch Mode (Claude Code only). When true and a maestro-p binary resolves,
	// the spawner picks between maestro-p (Time Limits / Max plan) and
	// claude --print (API Limits) based on the latest usage snapshot.
	enableMaestroP?: boolean;
	// Refines the Adaptive opt-in: 'interactive' always drives the maestro-p
	// TUI, 'dynamic' (default) auto-switches to API when over the usage
	// limit. Authoritative value is read from the persisted session; this is
	// only a fallback for callers that pass it inline.
	maestroPMode?: 'interactive' | 'dynamic';
	// Optional override for the maestro-p binary path. When unset/empty, the
	// spawner falls back to the bundled maestro-p script.
	maestroPPath?: string;
	// System prompt delivery (separate from user message for token efficiency)
	appendSystemPrompt?: string; // System prompt to pass via --append-system-prompt or embed in prompt
	// Stats tracking options
	querySource?: 'user' | 'auto'; // Whether this query is user-initiated or from Auto Run
	tabId?: string; // Tab ID for multi-tab tracking
}
