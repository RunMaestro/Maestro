/**
 * Decided-flags ledger for the Grok CLI.
 *
 * Every option the pinned help fixture lists
 * (src/__tests__/fixtures/grok/help-<version>/, written by
 * scripts/refresh-grok-help-fixture.mjs) has one entry here: `used` when a
 * Maestro launch builder emits it, `unused` when nothing does, each with a
 * one-line reason. The launch-surface test fails when a release adds an
 * option nobody has decided, or when a flag Maestro emits leaves the help.
 * Long-form reasons for the four evaluated flags live in
 * GROK_CAPABILITY_EVIDENCE.flagDecisions; the entries here point at them.
 *
 * Keys are the primary long flag of each option, as `--help` prints it.
 */

export type GrokFlagStatus = 'used' | 'unused';

export interface GrokFlagDecision {
	readonly status: GrokFlagStatus;
	readonly reason: string;
}

/** The help command a flag set belongs to, as the fixture files name it. */
export type GrokHelpCommand = 'grok' | 'grok agent' | 'grok agent stdio';

function decide(
	entries: Record<string, [GrokFlagStatus, string]>
): Readonly<Record<string, GrokFlagDecision>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(entries).map(([flag, [status, reason]]) => [
				flag,
				Object.freeze({ status, reason }),
			])
		)
	);
}

const SEE_FLAG_DECISIONS = 'see GROK_CAPABILITY_EVIDENCE.flagDecisions';

export const GROK_FLAG_LEDGER = Object.freeze({
	/** The help fixture version the ledger was decided against. */
	version: '1.0.70',
	commands: Object.freeze({
		grok: decide({
			'--add-dir': [
				'unused',
				'no additionalDirArgs; grants refused by the planner (GROK_DIRECTORY_GRANT_SUPPORT), and grok refuses it on an untrusted folder',
			],
			'--agent': ['unused', 'Maestro selects no grok agent definition; the default agent runs'],
			'--agents': ['unused', 'no inline subagent definitions are passed'],
			'--allow': [
				'unused',
				'approval is never widened by rule; full mode uses --always-approve, read-only adds a --deny',
			],
			'--always-approve': ['used', 'batchModeArgs and yoloModeArgs (full mode, batch turns)'],
			'--continue': [
				'unused',
				'implicit continuation refused by grokLaunchArgsProblem; turns resume by native id',
			],
			'--cwd': ['used', 'workingDirArgs'],
			'--debug': ['unused', 'debug logging is not captured by Maestro'],
			'--debug-file': ['unused', 'debug logging is not captured by Maestro'],
			'--deny': ['used', 'readOnlyArgs: --deny Bash(*) keeps a headless read-only turn alive'],
			'--disable-web-search': ['unused', 'no web-access toggle is wired for grok'],
			'--disallowed-tools': [
				'unused',
				'per-tool names are undocumented and version-dependent, so no noToolsArgs (definitions.ts)',
			],
			'--fork-session': ['unused', 'forks refused by grokLaunchArgsProblem'],
			'--fullscreen': ['unused', 'TUI rendering only; Maestro runs headless turns'],
			'--help': ['unused', 'read by scripts/refresh-grok-help-fixture.mjs, never by a launch'],
			'--include-partial-messages': [
				'unused',
				'affects streaming-messages-json only; chat turns use streaming-json',
			],
			'--json-schema': ['unused', `utility-turn candidate, ${SEE_FLAG_DECISIONS}`],
			'--leader-socket': ['unused', 'leader mode is not used'],
			'--model': ['used', 'modelArgs and the model config option emit -m'],
			'--max-turns': ['used', 'GROK_WIZARD_DISCOVERY_ARGS and GROK_WIZARD_GENERATION_ARGS bounds'],
			'--minimal': ['unused', 'TUI rendering only'],
			'--no-alt-screen': ['unused', 'TUI rendering only'],
			'--no-plan': [
				'unused',
				'plan mode is selected only by --permission-mode plan on read-only turns',
			],
			'--no-subagents': ['used', 'GROK_WIZARD_DISCOVERY_ARGS and GROK_WIZARD_GENERATION_ARGS'],
			'--oauth': ['unused', 'login is run by the person, outside a Maestro launch'],
			'--output-format': ['used', 'jsonOutputArgs: --output-format streaming-json'],
			'--single': ['used', 'promptArgs emit -p; also an exclusive prompt flag of the prompt file'],
			'--permission-mode': ['used', 'readOnlyArgs: --permission-mode plan'],
			'--prompt-file': ['used', 'promptFileArgs (acp-json prompt file)'],
			'--prompt-json': [
				'unused',
				'the prompt file carries the ACP blocks; listed only as an exclusive prompt flag',
			],
			'--resume': ['used', 'resumeArgs by native session id'],
			'--reasoning-effort': ['used', 'reasoningEffort config option'],
			'--restore-code': [
				'unused',
				'resume restores the conversation only; Maestro owns the checkout',
			],
			'--rules': ['unused', `the prompt stays embedded, ${SEE_FLAG_DECISIONS}`],
			'--session-id': [
				'unused',
				'grok assigns the native id and Maestro reads it back; refused by grokLaunchArgsProblem',
			],
			'--sandbox': ['unused', `profile is fixed per session, ${SEE_FLAG_DECISIONS}`],
			'--system-prompt-override': [
				'unused',
				`would replace the provider prompt, ${SEE_FLAG_DECISIONS}`,
			],
			'--tools': [
				'unused',
				'--tools "" is treated as unset (definitions.ts), so it cannot disable tools',
			],
			'--version': [
				'unused',
				'pre-turn discovery starts no grok process (detector.ts); the fixture script reads it',
			],
			'--verbatim': [
				'unused',
				'no offline source says what grok rewrites without it; the default handling is what suites pin',
			],
			'--worktree': ['unused', 'refused by grokLaunchArgsProblem; Maestro owns worktrees'],
			'--worktree-ref': ['unused', 'valid only with --worktree'],
		}),
		'grok agent': decide({
			'--reauth': ['unused', 'authentication is run by the person, outside a Maestro launch'],
			'--model': ['unused', 'the ACP route selects the model over the protocol, not argv'],
			'--reasoning-effort': [
				'unused',
				'the ACP route selects the effort over the protocol, not argv',
			],
			'--always-approve': [
				'unused',
				'Standard turns ask each permission request through the consent relay',
			],
			'--agent-profile': ['unused', 'no agent profile file is passed'],
			'--plugin-dir': ['unused', 'no per-process plugins are loaded'],
			'--leader': ['unused', 'leader mode is not used'],
			'--no-leader': [
				'unused',
				'Maestro writes no leader config; a user leader config is unverified',
			],
			'--grok-ws-origin': ['unused', 'relay endpoints are left at the binary default'],
			'--grok-ws-url': ['unused', 'relay endpoints are left at the binary default'],
			'--cli-chat-proxy-base-url': ['unused', 'API endpoints are left at the binary default'],
			'--xai-api-base-url': ['unused', 'API endpoints are left at the binary default'],
			'--debug': ['unused', 'debug logging is not captured by Maestro'],
			'--debug-file': ['unused', 'debug logging is not captured by Maestro'],
			'--help': ['unused', 'read by scripts/refresh-grok-help-fixture.mjs, never by a launch'],
			'--leader-socket': ['unused', 'leader mode is not used'],
		}),
		'grok agent stdio': decide({
			'--debug': ['unused', 'debug logging is not captured by Maestro'],
			'--debug-file': ['unused', 'debug logging is not captured by Maestro'],
			'--help': ['unused', 'read by scripts/refresh-grok-help-fixture.mjs, never by a launch'],
			'--leader-socket': ['unused', 'leader mode is not used'],
		}),
	} satisfies Record<GrokHelpCommand, Readonly<Record<string, GrokFlagDecision>>>),
});
