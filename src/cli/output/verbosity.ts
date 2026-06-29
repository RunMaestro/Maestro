// Global verbosity state for maestro-cli, driven by the root `--quiet` /
// `--verbose` flags. A Commander `preAction` hook in index.ts copies the parsed
// global options here before any command action runs, so shared output helpers
// can consult the level without threading flags through every command.
//
// Levels:
//   quiet   - suppress incidental success chatter (errors still print)
//   normal  - default
//   verbose - opt-in extra detail
//
// `--json` output is never gated by quiet: machine-readable results must always
// be emitted in full.

export type Verbosity = 'quiet' | 'normal' | 'verbose';

let current: Verbosity = 'normal';

export function setVerbosity(opts: { quiet?: boolean; verbose?: boolean }): void {
	// quiet wins if both are somehow passed - the user asked for less, honor it.
	if (opts.quiet) {
		current = 'quiet';
	} else if (opts.verbose) {
		current = 'verbose';
	} else {
		current = 'normal';
	}
}

export function getVerbosity(): Verbosity {
	return current;
}

export function isQuiet(): boolean {
	return current === 'quiet';
}

export function isVerbose(): boolean {
	return current === 'verbose';
}
