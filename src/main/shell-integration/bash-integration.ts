/**
 * Bash shell integration script.
 *
 * Returns shell code that emits OSC 133 (semantic prompt) and OSC 7 (working
 * directory) sequences. Maestro parses these from PTY output to track the
 * currently-running command and CWD per terminal tab so they can be persisted
 * and optionally re-run across restarts.
 *
 * Bash has no native pre-prompt / pre-command hooks the way zsh does, so we
 * synthesize them:
 *   - `PROMPT_COMMAND` (with the user's existing value sandwiched between our
 *     start/end pair) drives the pre-prompt half. We never replace it.
 *   - `trap '...' DEBUG` drives the pre-command half, gated by a guard variable
 *     so we emit exactly once per user-typed command — DEBUG fires before every
 *     simple command, including each piece of a pipeline and every statement of
 *     PROMPT_COMMAND, all of which we want to ignore.
 *
 * The script is idempotent: a `_MAESTRO_SI_LOADED` guard prevents
 * double-registration if it is sourced more than once. Command text in OSC
 * 133;B is hex-encoded (`cmd=<hex>`) so arbitrary bytes — newlines, BEL,
 * semicolons, multi-byte chars — survive the OSC envelope intact. The parser
 * (`oscParser.ts`, added in a later task) is responsible for hex-decoding it.
 *
 * The captured command text is `$BASH_COMMAND` — the first simple command in
 * a pipeline / compound. For `foo | bar` we record `foo`. This is good enough
 * for the persistence use case (tracking long-running foreground programs like
 * `btop`, `vim`, `npm run dev`); a more elaborate `history 1` parse would be
 * fragile under custom `HISTTIMEFORMAT` settings.
 *
 * Sequences emitted (identical to the zsh integration):
 *   - `\e]133;A\a`               prompt start
 *   - `\e]133;B;cmd=<hex>\a`     command start (with hex-encoded text)
 *   - `\e]133;C\a`               output start (after command-start)
 *   - `\e]133;D;<exit>\a`        previous command finished (with exit code)
 *   - `\e]7;file://<host><pwd>\a` current working directory
 */
export function getBashIntegrationScript(): string {
	return `# Maestro shell integration (bash)
if [ -n "\${_MAESTRO_SI_LOADED:-}" ]; then
	return 0 2>/dev/null || true
fi
_MAESTRO_SI_LOADED=1

# State machine for the DEBUG trap. The trap fires before EVERY simple command
# (each piece of a pipeline, every statement of PROMPT_COMMAND, etc.), so we
# need a guard to emit OSC sequences exactly once per user-typed command.
#   "1" = in-command (or shell init) — DEBUG trap stays silent
#   "0" = at-prompt                  — next DEBUG trap is a new command-start
# Init to "1" so DEBUG traps fired during shell startup don't masquerade as
# user commands (PROMPT_COMMAND will flip the guard to "0" before the first
# real prompt is drawn).
_MAESTRO_IN_CMD="1"

# Hex-encode bytes (matches zsh integration). od/tr is portable across bash 3+.
__maestro_hex_encode() {
	printf '%s' "$1" | od -An -tx1 -v 2>/dev/null | tr -d ' \\n\\t'
}

# DEBUG trap target. Skipped while a command (or PROMPT_COMMAND) is running so
# we report exactly one command-start per user command.
__maestro_on_preexec() {
	if [ "\${_MAESTRO_IN_CMD:-1}" = "0" ]; then
		_MAESTRO_IN_CMD="1"
		local cmd_hex
		cmd_hex=\$(__maestro_hex_encode "\$BASH_COMMAND")
		printf '\\033]133;B;cmd=%s\\007' "\$cmd_hex"
		printf '\\033]133;C\\007'
	fi
}

# First half of the prompt cycle. MUST run before any user PROMPT_COMMAND so
# \$? from the actual user command isn't clobbered, and so prompt-start is
# emitted before any prompt-related output.
__maestro_on_precmd_start() {
	local last_status=\$?
	printf '\\033]133;D;%d\\007' "\$last_status"
	printf '\\033]133;A\\007'
	printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-localhost}" "\$PWD"
}

# Second half. Runs AFTER user PROMPT_COMMAND finishes, flipping the guard so
# the next typed command is recognized by the DEBUG trap as a command-start.
# Done at the end (rather than the start) so DEBUG traps fired by user
# PROMPT_COMMAND statements stay silent.
__maestro_on_precmd_end() {
	_MAESTRO_IN_CMD="0"
}

trap '__maestro_on_preexec' DEBUG

# Sandwich the user's PROMPT_COMMAND between our start/end pair. Idempotent:
# bails if already injected (e.g. user re-sources their bashrc by hand).
if [ -z "\${PROMPT_COMMAND:-}" ]; then
	PROMPT_COMMAND='__maestro_on_precmd_start;__maestro_on_precmd_end'
elif [[ "\$PROMPT_COMMAND" != *__maestro_on_precmd* ]]; then
	PROMPT_COMMAND='__maestro_on_precmd_start;'"\$PROMPT_COMMAND"';__maestro_on_precmd_end'
fi
`;
}
