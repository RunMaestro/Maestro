/**
 * Cue environment variable sanitizer.
 *
 * Single responsibility: filter user-supplied `customEnvVars` before they are
 * merged into a spawned Cue agent's environment, so a malicious or
 * misconfigured YAML cannot inject loader-level variables that would run
 * attacker-controlled code in the child process.
 *
 * Policy:
 *   - Name regex:  /^[a-zA-Z_][a-zA-Z0-9_]*$/  (POSIX env var convention)
 *   - Blocklist:   PATH, HOME, USER, SHELL, LD_PRELOAD, LD_LIBRARY_PATH,
 *                  DYLD_INSERT_LIBRARIES, NODE_OPTIONS
 *     Comparison is CASE-INSENSITIVE (we uppercase the incoming name before
 *     membership check). Windows env var lookup is case-insensitive — `Path`
 *     and `PATH` refer to the same variable — so a case-sensitive blocklist
 *     would let an attacker bypass the guard by spelling `Path` or `PaTh`.
 *     The returned `droppedNames` preserves the original casing of the
 *     input so operators see what was actually rejected.
 *
 * Dropped entries are silently omitted from the returned map and reported in
 * `droppedNames`; callers that supply an `onLog` hook get a warn-level line
 * per dropped variable so operators can see the sanitization happen.
 */

const BLOCKED_ENV_VARS: ReadonlySet<string> = new Set([
	'PATH',
	'HOME',
	'USER',
	'SHELL',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'DYLD_INSERT_LIBRARIES',
	'NODE_OPTIONS',
]);

const VALID_ENV_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface SanitizeEnvResult {
	/** Env vars that passed both the name regex and the blocklist check. */
	sanitized: Record<string, string>;
	/** Names removed from the input (bad regex or blocked). Order preserved. */
	droppedNames: string[];
}

/**
 * Sanitize a map of custom environment variables for safe spawn.
 *
 * Returns an always-non-null `sanitized` map and the list of dropped names
 * (empty when nothing was filtered). If `onLog` is provided, emits one warn
 * line per dropped name so the activity journal reflects the sanitization.
 *
 * A `null`/`undefined` input is treated as an empty map (no vars to sanitize)
 * and returns `{ sanitized: {}, droppedNames: [] }`.
 */
export function sanitizeCustomEnvVars(
	vars: Record<string, string> | undefined | null,
	onLog?: (level: string, message: string) => void
): SanitizeEnvResult {
	const sanitized: Record<string, string> = {};
	const droppedNames: string[] = [];

	if (!vars) {
		return { sanitized, droppedNames };
	}

	for (const [name, value] of Object.entries(vars)) {
		if (!VALID_ENV_NAME_REGEX.test(name)) {
			droppedNames.push(name);
			if (onLog) {
				onLog(
					'warn',
					`[CUE] Dropped custom env var "${name}" — name is not a valid POSIX identifier`
				);
			}
			continue;
		}
		// Uppercase before membership check so Windows-style casing variants
		// (`path`, `PaTh`) cannot bypass the blocklist. droppedNames still
		// carries the original casing so the warn log matches what the user
		// actually typed.
		if (BLOCKED_ENV_VARS.has(name.toUpperCase())) {
			droppedNames.push(name);
			if (onLog) {
				onLog('warn', `[CUE] Dropped custom env var "${name}" — blocklisted for safety`);
			}
			continue;
		}
		sanitized[name] = value;
	}

	return { sanitized, droppedNames };
}

/**
 * Exposed for tests and for callers that need to consult the blocklist
 * without re-declaring it.
 */
export function getBlockedEnvVarNames(): ReadonlySet<string> {
	return BLOCKED_ENV_VARS;
}
