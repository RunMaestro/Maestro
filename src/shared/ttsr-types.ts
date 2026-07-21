/**
 * Time-Traveling Stream Rules (TTSR) - shared rule schema and the Gate A
 * per-agent capability matrix.
 *
 * TTSR watches an agent's live output stream and, when a rule's `condition`
 * (regex) or `astCondition` (ast-grep pattern) matches, interrupts the
 * in-flight turn and reinjects a corrective `<system-interrupt>` turn.
 *
 * Everything here is serializable so the same shapes can travel over IPC to
 * the renderer. Compiled regexes live on {@link LoadedTtsrRule}, which is
 * main-process only.
 */

import { AGENT_IDS, type AgentId } from './agentIds';

// ── Rule enums ───────────────────────────────────────────────────────────────

/** Which stream a rule is allowed to match against. */
export const TTSR_SCOPES = ['text', 'thinking', 'tool:edit', 'tool:write'] as const;
export type TtsrScope = (typeof TTSR_SCOPES)[number];

/**
 * Whether a match aborts the in-flight turn.
 * - `never`: always defer to a `<system-reminder>` on the next prompt
 * - `prose-only`: interrupt only on text/thinking matches
 * - `tool-only`: interrupt only on tool-source matches
 * - `always`: interrupt on any match
 */
export const TTSR_INTERRUPT_MODES = ['never', 'prose-only', 'tool-only', 'always'] as const;
export type TtsrInterruptMode = (typeof TTSR_INTERRUPT_MODES)[number];

/**
 * How often a rule may re-fire within one conversation.
 * - `once`: fire a single time per provider session
 * - `after-gap`: re-fire only once `repeatGap` turns have elapsed
 */
export const TTSR_REPEAT_MODES = ['once', 'after-gap'] as const;
export type TtsrRepeatMode = (typeof TTSR_REPEAT_MODES)[number];

/**
 * What happens to the aborted turn's partial output.
 * - `keep`: SIGINT the process, let the provider commit the partial turn
 * - `discard`: hard-kill before commit (best-effort; Maestro cannot edit an
 *   external provider's transcript, see the plan's fidelity gaps)
 */
export const TTSR_CONTEXT_MODES = ['keep', 'discard'] as const;
export type TtsrContextMode = (typeof TTSR_CONTEXT_MODES)[number];

/** Narrow an unknown (persisted setting, IPC payload) to a {@link TtsrContextMode}. */
export function isTtsrContextMode(value: unknown): value is TtsrContextMode {
	return TTSR_CONTEXT_MODES.includes(value as TtsrContextMode);
}

/** Default scopes when a rule does not declare any. */
export const DEFAULT_TTSR_SCOPES: TtsrScope[] = ['text', 'thinking'];

/** Default turn gap for `repeatMode: after-gap` rules. */
export const DEFAULT_TTSR_REPEAT_GAP = 3;

// ── Rule shape ───────────────────────────────────────────────────────────────

/**
 * A normalized, validated TTSR rule. One per `.maestro/rules/*.md` file.
 * Serializable - safe to send over IPC.
 */
export interface TtsrRule {
	/** Unique rule name. Derived from the filename when frontmatter omits it. */
	name: string;
	/** Human-readable summary shown in the rules list. */
	description: string;
	/** Regex sources, OR'd. Every entry compiled successfully. */
	condition: string[];
	/** ast-grep patterns, OR'd. Only matched against edit/write tool content. */
	astCondition: string[];
	/** Streams this rule may match. */
	scope: TtsrScope[];
	/** Path gate for tool-source matches. Empty means "any path". */
	globs: string[];
	interruptMode: TtsrInterruptMode;
	repeatMode: TtsrRepeatMode;
	/** Turns that must elapse before an `after-gap` rule re-fires. */
	repeatGap: number;
	/** Agents this rule applies to. Defaulted from the Gate A capability matrix. */
	agents: AgentId[];
	/** Markdown body - becomes the `<system-interrupt>` / `<system-reminder>` payload. */
	content: string;
	/** Project-relative source path, e.g. `.maestro/rules/no-console-log.md`. */
	path: string;
}

/** A {@link TtsrRule} with its regexes pre-compiled. Main-process only. */
export interface LoadedTtsrRule extends TtsrRule {
	compiledCondition: RegExp[];
}

/** Per-project TTSR settings, read from the `.maestro/ttsr.yaml` mapping. */
export interface TtsrProjectSettings {
	/** Project-level master switch. AND'd with the global `ttsrEnabled` setting. */
	enabled: boolean;
	/** Rule names disabled for this project. */
	disabledRules: string[];
	/** Teardown mode used when a rule interrupts a turn. */
	contextMode: TtsrContextMode;
}

/** Settings applied when `.maestro/ttsr.yaml` is absent or omits a field. */
export const DEFAULT_TTSR_PROJECT_SETTINGS: TtsrProjectSettings = {
	enabled: true,
	disabledRules: [],
	contextMode: 'keep',
};

// ── Match reporting (IPC-safe) ───────────────────────────────────────────────

/** Minimal rule identity carried in IPC payloads and the activity log. */
export interface TtsrRuleRef {
	name: string;
	/** Project-relative rule file path, e.g. `.maestro/rules/no-console-log.md`. */
	path: string;
}

/**
 * Payload of the `ttsr:matched` push event (observability only - the abort and
 * reinject land in Phase 3 via `ttsr:triggered`).
 */
export interface TtsrMatchedPayload {
	/** Maestro process/session id, `${session.id}-ai-${tabId}`. */
	sessionId: string;
	agentId: AgentId;
	/** Stream the match came from. */
	source: TtsrScope;
	rules: TtsrRuleRef[];
	/** True when at least one fired rule's `interruptMode` permits aborting. */
	willInterrupt: boolean;
	/** Edited file path, for tool-source matches. */
	filePath?: string;
}

/**
 * Payload of the `ttsr:abortPending` push event, emitted the instant main
 * signals the in-flight process and before it has exited.
 *
 * This is the renderer's `ttsrAbortPending` flag from the plan: the exit that
 * follows is a TTSR abort, not a failed or completed turn, so exit handling
 * must not fail the turn, dispatch the next queued item, or clear the tab's
 * busy state. The corrective spawn arrives moments later on `ttsr:triggered`.
 */
export interface TtsrAbortPendingPayload {
	/** Maestro process/session id, `${session.id}-ai-${tabId}`. */
	sessionId: string;
	/** AI tab the aborted turn belonged to, when the spawn carried one. */
	tabId?: string;
	agentId: AgentId;
	/** Rules that forced the abort. */
	rules: TtsrRuleRef[];
	/** `keep` interrupted (SIGINT); `discard` hard-killed. */
	contextMode: TtsrContextMode;
}

/**
 * Payload of the `ttsr:triggered` push event: everything the renderer needs to
 * spawn the corrective turn without re-deriving main-process state (Gate B).
 *
 * The main engine owns `providerSessionId` (captured from the agent's
 * `session-id` event) and `originalGoal` (the prompt recorded by the TTSR spawn
 * registry - `ManagedProcess` keeps none), so both travel in the payload.
 */
export interface TtsrTriggeredPayload {
	/** Maestro process/session id, `${session.id}-ai-${tabId}`. */
	sessionId: string;
	/** AI tab the aborted turn belonged to, when the spawn carried one. */
	tabId?: string;
	/** Drives `resumeArgs` shape and the tier/degradation choice. */
	agentId: AgentId;
	/** Rules that fired, for the injection template and the activity log. */
	rules: TtsrRuleRef[];
	/** Rendered `<system-interrupt>` block(s) - the corrective turn's prompt. */
	injectionPrompt: string;
	/**
	 * `resume` re-attaches to the aborted conversation; `fresh` is the degraded
	 * path for agents that only emit their session id on the final event.
	 */
	mode: 'resume' | 'fresh';
	/** Required when `mode === 'resume'`; passed as `agentSessionId` on respawn. */
	providerSessionId?: string;
	/** Prompt that started the aborted turn. Restated verbatim on `fresh`. */
	originalGoal: string;
	/** Teardown that was used: `keep` interrupted, `discard` hard-killed. */
	contextMode: TtsrContextMode;
}

// ── Gate A: per-agent capability matrix ──────────────────────────────────────

/**
 * Detection tier, straight from the plan's Gate A:
 * - `A`: live mid-turn abort possible
 * - `B`: detection only lands at end-of-turn (or at tool-call time)
 * - `C`: raw/unstructured stream, out of scope for v1
 */
export type TtsrTier = 'A' | 'B' | 'C';

/** How much edit content the agent's parser surfaces for AST matching. */
export type TtsrAstSupport = 'full' | 'partial' | 'none';

/** Whether an aborted turn can be resumed against the same provider session. */
export type TtsrResumeSupport = 'clean' | 'degraded' | 'none';

export interface TtsrAgentCapability {
	tier: TtsrTier;
	/** Prose partials reach `handleParsedEvent` mid-turn. */
	liveProse: boolean;
	/** Thinking partials reach `handleParsedEvent` mid-turn. */
	liveThinking: boolean;
	/** Final accumulated text is available at turn end (Tier B fallback). */
	endOfTurnText: boolean;
	/** Tool-call events carry a file path. */
	toolEvents: boolean;
	/** Edit/write content available for ast-grep. */
	ast: TtsrAstSupport;
	/** The in-flight process can be interrupted. */
	interrupt: boolean;
	/**
	 * `clean` - provider session id is emitted early, so the corrective turn
	 * can `--resume`. `degraded` - id only lands on the final event, so the
	 * corrective turn respawns fresh with the original goal restated.
	 */
	resume: TtsrResumeSupport;
}

const UNSUPPORTED: TtsrAgentCapability = {
	tier: 'C',
	liveProse: false,
	liveThinking: false,
	endOfTurnText: false,
	toolEvents: false,
	ast: 'none',
	interrupt: false,
	resume: 'none',
};

/**
 * Gate A. Verified against each agent's parser in `src/main/parsers/`, not
 * inferred from `src/main/agents/capabilities.ts` - the parser is what
 * actually determines which streams TTSR can observe.
 *
 * Agents absent from the plan's scope table (gemini-cli, qwen3-coder, hermes,
 * pi, omp) are marked unsupported rather than guessed at; they gain support
 * when their parser surface is verified the same way.
 */
export const TTSR_AGENT_CAPABILITIES: Record<AgentId, TtsrAgentCapability> = {
	'claude-code': {
		tier: 'A',
		liveProse: true,
		liveThinking: true,
		endOfTurnText: true,
		toolEvents: true,
		ast: 'full',
		interrupt: true,
		resume: 'clean',
	},
	codex: {
		tier: 'A',
		liveProse: true,
		liveThinking: true,
		endOfTurnText: true,
		toolEvents: true,
		ast: 'partial',
		interrupt: true,
		resume: 'clean',
	},
	opencode: {
		tier: 'B',
		liveProse: false,
		liveThinking: false,
		endOfTurnText: true,
		toolEvents: true,
		ast: 'full',
		interrupt: true,
		resume: 'clean',
	},
	'factory-droid': {
		tier: 'A',
		liveProse: true,
		liveThinking: false,
		endOfTurnText: true,
		toolEvents: false,
		ast: 'none',
		interrupt: true,
		resume: 'clean',
	},
	'copilot-cli': {
		tier: 'A',
		liveProse: true,
		liveThinking: true,
		endOfTurnText: true,
		toolEvents: true,
		ast: 'full',
		interrupt: true,
		resume: 'degraded',
	},
	grok: {
		tier: 'A',
		liveProse: true,
		liveThinking: true,
		endOfTurnText: true,
		toolEvents: false,
		ast: 'none',
		interrupt: true,
		resume: 'degraded',
	},
	// Raw PTY only, and not a resumable conversation. Excluded from v1.
	terminal: UNSUPPORTED,
	'gemini-cli': UNSUPPORTED,
	'qwen3-coder': UNSUPPORTED,
	hermes: UNSUPPORTED,
	pi: UNSUPPORTED,
	omp: UNSUPPORTED,
};

/** Agent ids TTSR supports at all (any detection mode). */
export const TTSR_SUPPORTED_AGENTS: AgentId[] = AGENT_IDS.filter((id) => {
	const cap = TTSR_AGENT_CAPABILITIES[id];
	return cap.tier !== 'C' && cap.interrupt;
});

/** True when the agent can observe prose/thinking (live or at turn end). */
export function supportsTtsrProse(agentId: AgentId): boolean {
	const cap = TTSR_AGENT_CAPABILITIES[agentId];
	return cap.liveProse || cap.liveThinking || cap.endOfTurnText;
}

/** True when the agent surfaces edit/write content ast-grep can run against. */
export function supportsTtsrAst(agentId: AgentId): boolean {
	const cap = TTSR_AGENT_CAPABILITIES[agentId];
	return cap.toolEvents && cap.ast !== 'none';
}

/**
 * Default `agents` set for a rule that omits the field: every supported agent
 * whose control surface can actually evaluate the rule's declared match modes.
 *
 * An `astCondition` rule therefore never defaults onto factory-droid or grok
 * (no tool events), and a tool-scoped rule never defaults onto terminal.
 */
export function defaultTtsrAgentsForRule(input: {
	condition: string[];
	astCondition: string[];
	scope: TtsrScope[];
}): AgentId[] {
	const needsAst = input.astCondition.length > 0;
	const needsTool = input.scope.some((s) => s.startsWith('tool:'));
	const needsProse = input.condition.length > 0 && input.scope.some((s) => !s.startsWith('tool:'));

	return TTSR_SUPPORTED_AGENTS.filter((id) => {
		if (needsAst && !supportsTtsrAst(id)) return false;
		if (needsTool && !TTSR_AGENT_CAPABILITIES[id].toolEvents) return false;
		if (needsProse && !supportsTtsrProse(id)) return false;
		return true;
	});
}
