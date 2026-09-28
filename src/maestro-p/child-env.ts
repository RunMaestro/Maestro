// Environment for the claude TUI maestro-p spawns.
//
// maestro-p inherits whatever environment its caller built, and headless callers
// (launchd jobs, cron, `env -i` wrappers, Python subprocess) routinely build a
// minimal one. Two classes of variable matter to the child claude:
//
//   * Session identity markers, which must be REMOVED (see
//     CLAUDE_SESSION_IDENTITY_ENV_VARS).
//   * The login name, which must be PRESENT (see LOGIN_NAME_ENV_VARS).

import * as os from 'os';

// Env vars that mark the CURRENT process as running inside a Claude Code
// session. When maestro-p is invoked from within a Claude agent (or any
// process that inherited these), they leak into the claude TUI we spawn and
// make that child claude believe it is a NESTED/child session: it then runs in
// an ephemeral mode and never writes its own `<session-id>.jsonl` transcript.
// Since the JSONL is maestro-p's only source of truth, the run produces no
// `assistant`/`result` envelopes and times out with `first_byte_timeout` even
// though the answer rendered on screen - the "synopsis/tab-naming returns
// empty in TUI mode" bug. Verified by A/B: keeping CLAUDE_CODE_SESSION_ID /
// CLAUDE_CODE_CHILD_SESSION reproduces the empty-result timeout; stripping both
// makes the TUI write its transcript and the run succeed. We strip the whole
// CLAUDE_CODE_* identity family plus the CLAUDECODE marker defensively; auth
// and config (CLAUDE_CONFIG_DIR, ANTHROPIC_*, MAESTRO_CLAUDE_BIN) are kept.
export const CLAUDE_SESSION_IDENTITY_ENV_VARS = [
	'CLAUDECODE',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_CHILD_SESSION',
	'CLAUDE_CODE_ENTRYPOINT',
] as const;

// The login name, filled in from the OS account when the caller left it unset.
// With USER missing, claude cannot find the subscription login it keeps in the
// macOS keychain: it starts on "API Usage Billing" instead of the plan, with no
// error. A run-mode turn then bills per-token API credit, and `--status` fails
// because the /usage panel never renders (#1577). LOGNAME is the POSIX spelling
// of the same fact and is filled for the same reason. Windows is skipped: it
// names the account in USERNAME, which it always sets.
export const LOGIN_NAME_ENV_VARS = ['USER', 'LOGNAME'] as const;

export interface BuildChildEnvOptions {
	platform?: NodeJS.Platform;
	/** Resolves the OS account name; undefined when it cannot be read. */
	loginName?: () => string | undefined;
}

function osLoginName(): string | undefined {
	try {
		return os.userInfo().username || undefined;
	} catch {
		// No passwd entry for this uid (an arbitrary-uid container). Nothing to
		// fill in; the TUI's billing-mode check still reports the fallback.
		return undefined;
	}
}

/**
 * Return a copy of `parentEnv` fit for the claude TUI: session-identity markers
 * removed, and the login name filled in when the caller left it unset or blank.
 * A value the caller did set is never overwritten.
 */
export function buildChildEnv(
	parentEnv: NodeJS.ProcessEnv = process.env,
	{ platform = process.platform, loginName = osLoginName }: BuildChildEnvOptions = {}
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...parentEnv };
	for (const key of CLAUDE_SESSION_IDENTITY_ENV_VARS) {
		delete env[key];
	}
	if (platform === 'win32') return env;

	const missing = LOGIN_NAME_ENV_VARS.filter((key) => !env[key]?.trim());
	if (missing.length === 0) return env;
	const name = loginName();
	if (!name) return env;
	for (const key of missing) {
		env[key] = name;
	}
	return env;
}
