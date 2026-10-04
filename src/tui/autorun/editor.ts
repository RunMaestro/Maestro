/**
 * Handing a file to the person's editor (AR-2). The App stops reading the
 * keyboard and freezes its frame while this runs (see `App.tsx`), so the editor
 * owns the terminal exactly as if it had been started from a shell.
 */

import { spawn } from 'child_process';
import { shellEscape } from '../../shared/maestro-lib';

export type EditorResult = { ok: true } | { ok: false; message: string };

/**
 * What `$VISUAL`, then `$EDITOR`, names, or `vi`. It may carry arguments
 * (`code -w`), so it is run through a shell rather than as one program name.
 */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): string {
	return env.VISUAL?.trim() || env.EDITOR?.trim() || 'vi';
}

/** The shell line that opens `file`. The path is quoted, the editor words are the person's own. */
export function editorInvocation(file: string, env: NodeJS.ProcessEnv = process.env): string {
	return `${resolveEditorCommand(env)} ${shellEscape(file)}`;
}

/** Runs the editor on the terminal and resolves when it exits. */
export function runEditor(
	file: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<EditorResult> {
	return new Promise((resolve) => {
		const child = spawn(editorInvocation(file, env), { shell: true, stdio: 'inherit', env });
		child.on('error', (error) =>
			resolve({ ok: false, message: `Could not start the editor: ${error.message}` })
		);
		child.on('exit', (code, signal) =>
			resolve(
				code === 0
					? { ok: true }
					: {
							ok: false,
							message: `The editor (${resolveEditorCommand(env)}) ${
								signal ? `stopped with ${signal}` : `exited with code ${code}`
							}.`,
						}
			)
		);
	});
}
