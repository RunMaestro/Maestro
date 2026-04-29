/**
 * Tests for src/main/shell-integration/bash-integration.ts
 *
 * The script's runtime correctness is verified at integration time (it can
 * only be fully validated by sourcing it in a real bash process — see the
 * end-to-end PTY validation noted in the commit). These tests cover the
 * static contract the parser and PtySpawner rely on: which mechanisms drive
 * the hooks, which OSC sequences are emitted, and that the script is guarded
 * against double-loading and against clobbering the user's PROMPT_COMMAND.
 */

import { describe, it, expect } from 'vitest';
import { getBashIntegrationScript } from '../../../main/shell-integration/bash-integration';

describe('getBashIntegrationScript', () => {
	const script = getBashIntegrationScript();

	it('returns a non-empty string', () => {
		expect(typeof script).toBe('string');
		expect(script.length).toBeGreaterThan(0);
	});

	it('installs a DEBUG trap as the pre-command hook', () => {
		// Bash has no native preexec; DEBUG trap is the standard substitute.
		expect(script).toMatch(/trap\s+'[^']*__maestro_on_preexec[^']*'\s+DEBUG/);
	});

	it('augments PROMPT_COMMAND without replacing the user value', () => {
		// Two branches: empty PROMPT_COMMAND, and non-empty (must sandwich, not overwrite).
		expect(script).toMatch(/if\s+\[\s+-z\s+"\$\{PROMPT_COMMAND:-\}"\s+\]/);
		expect(script).toMatch(
			/PROMPT_COMMAND='__maestro_on_precmd_start;'\s*"\$PROMPT_COMMAND"\s*';__maestro_on_precmd_end'/
		);
	});

	it('idempotency-checks PROMPT_COMMAND so re-sourcing does not double-wrap', () => {
		// Without this, sourcing twice would yield start;start;<user>;end;end.
		expect(script).toMatch(/\[\[\s*"\$PROMPT_COMMAND"\s*!=\s*\*__maestro_on_precmd\*\s*\]\]/);
	});

	it('guards against double-loading via _MAESTRO_SI_LOADED', () => {
		expect(script).toContain('_MAESTRO_SI_LOADED');
		// The guard must short-circuit: an early `return` when already loaded.
		expect(script).toMatch(/_MAESTRO_SI_LOADED[^\n]*\n[^\n]*return/);
	});

	it('uses a guard variable so DEBUG fires exactly once per user command', () => {
		// _MAESTRO_IN_CMD gates the trap body; without it, every statement of
		// PROMPT_COMMAND and every piece of a pipeline would re-trigger emission.
		expect(script).toContain('_MAESTRO_IN_CMD');
		// Initial value must be "1" (in-command) so DEBUG traps during shell
		// startup are silent until PROMPT_COMMAND has flipped it to "0".
		expect(script).toMatch(/_MAESTRO_IN_CMD="1"/);
		// The DEBUG body emits only when the guard reads "0".
		expect(script).toMatch(/\[\s*"\$\{_MAESTRO_IN_CMD:-1\}"\s*=\s*"0"\s*\]/);
	});

	it('emits OSC 133;A (prompt start) from the pre-prompt hook', () => {
		expect(script).toContain('\\033]133;A\\007');
	});

	it('emits OSC 133;B with hex-encoded command text from the pre-command hook', () => {
		expect(script).toContain('\\033]133;B;cmd=%s\\007');
	});

	it('emits OSC 133;C (output start) from the pre-command hook', () => {
		expect(script).toContain('\\033]133;C\\007');
	});

	it('emits OSC 133;D with the previous command exit code', () => {
		expect(script).toContain('\\033]133;D;%d\\007');
		// $? must be read FIRST in the precmd hook, otherwise printf / local
		// in earlier statements would clobber it and we would record the
		// wrong exit code.
		const startBody = script.match(/__maestro_on_precmd_start\(\)\s*\{([^}]*)\}/s);
		expect(startBody).not.toBeNull();
		const firstStmt = startBody![1].trim().split('\n')[0].trim();
		expect(firstStmt).toMatch(/last_status=\$\?/);
	});

	it('emits OSC 7 with a file:// URI from the pre-prompt hook', () => {
		expect(script).toContain('\\033]7;file://');
	});

	it('captures command text from $BASH_COMMAND inside the DEBUG trap', () => {
		// $BASH_COMMAND is the only mechanism in bash that gives the command
		// being executed inside a DEBUG trap. If this regresses (e.g. someone
		// switches to BASH_SOURCE or to history-1 parsing), command tracking
		// will silently break or corrupt.
		expect(script).toMatch(/__maestro_hex_encode\s+"\$BASH_COMMAND"/);
	});

	it('hex-encodes the command via od/tr so binary-unsafe bytes survive the OSC envelope', () => {
		// The encoder is what makes OSC 133;B robust to newlines, BEL, and
		// semicolons in user commands. If this regresses, the parser will
		// see truncated/garbled command text.
		expect(script).toMatch(/od\s+-An\s+-tx1/);
		expect(script).toContain("tr -d ' \\n\\t'");
	});
});
