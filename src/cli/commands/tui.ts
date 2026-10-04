// TUI command - launch the Maestro terminal UI.
//
// The TUI is a separate ESM bundle (Ink's yoga-layout uses top-level await, which
// the CJS CLI bundle cannot hold), so this command only locates it and runs it as
// a child process. Plain CLI calls never load React.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ExitCode } from '../exit-codes';

const TUI_BUNDLE_NAME = 'maestro-tui.mjs';

export interface TuiOptions {
	dataDir?: string;
	dev?: boolean;
	doctor?: boolean;
}

/**
 * Candidate locations for the TUI bundle, in lookup order. The CLI bundle is
 * `dist/cli/maestro-cli.js` (CJS), so `__dirname` is `dist/cli/` and the TUI is a
 * sibling. Run from source (`src/cli/`), the dev checkout's build output is the
 * fallback.
 */
export function tuiBundleCandidates(cliDir: string): string[] {
	return [
		path.join(cliDir, TUI_BUNDLE_NAME),
		path.resolve(cliDir, '..', '..', 'dist', 'cli', TUI_BUNDLE_NAME),
	];
}

/** First candidate that exists, or null when the TUI was never built. */
export function resolveTuiBundlePath(
	cliDir: string,
	exists: (file: string) => boolean = fs.existsSync
): string | null {
	return tuiBundleCandidates(cliDir).find(exists) ?? null;
}

/** Flags the TUI understands, in the form `src/tui/args.ts` parses. */
export function buildTuiArgs(options: TuiOptions): string[] {
	const args: string[] = [];
	if (options.dataDir) args.push('--data-dir', options.dataDir);
	if (options.dev) args.push('--dev');
	if (options.doctor) args.push('--doctor');
	return args;
}

export async function tui(options: TuiOptions): Promise<void> {
	const bundle = resolveTuiBundlePath(__dirname);
	if (!bundle) {
		console.error(
			`Error: ${TUI_BUNDLE_NAME} not found. Searched:\n${tuiBundleCandidates(__dirname)
				.map((c) => `  ${c}`)
				.join('\n')}\nBuild it with: npm run build:tui`
		);
		process.exit(ExitCode.GeneralError);
	}

	const child = spawn(process.execPath, [bundle, ...buildTuiArgs(options)], {
		stdio: 'inherit',
	});
	child.on('error', (err) => {
		console.error(`Error: failed to start the TUI: ${err.message}`);
		process.exit(ExitCode.GeneralError);
	});
	child.on('exit', (code, signal) => {
		// A signal death has no code; 128 + signal is the shell convention, and
		// 1 is close enough when the number is unknown.
		process.exit(code ?? (signal ? 128 : ExitCode.GeneralError));
	});
}
