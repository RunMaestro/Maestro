/**
 * Run the GitHub CLI login for `maestro-cli feedback login`, attached to the
 * caller's terminal. Its own module so tests can stand in for the process.
 */

import { spawn } from 'child_process';
import type { FeedbackGhLoginCommand } from '../../shared/feedback';

/**
 * Run the gh login with this terminal attached, resolving to its exit code.
 * `keepStdoutClean` routes gh's stdout to stderr, so a `--json` caller's stdout
 * carries only the result.
 */
export function runGhLogin(
	login: FeedbackGhLoginCommand,
	keepStdoutClean = false
): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(login.command, login.args, {
			stdio: keepStdoutClean ? ['inherit', 2, 'inherit'] : 'inherit',
		});
		child.on('error', reject);
		child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	});
}
