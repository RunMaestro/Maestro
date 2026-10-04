/**
 * Command-line flags the launcher (`maestro-cli tui`) passes through.
 * `--doctor` is read here so the entry can hand it to its own handler.
 */

export interface TuiArgs {
	dataDir?: string;
	dev: boolean;
	doctor: boolean;
}

export function parseTuiArgs(argv: string[]): TuiArgs {
	const args: TuiArgs = { dev: false, doctor: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dev') args.dev = true;
		else if (arg === '--doctor') args.doctor = true;
		else if (arg === '--data-dir') args.dataDir = argv[++i];
		else if (arg.startsWith('--data-dir=')) args.dataDir = arg.slice('--data-dir='.length);
	}
	return args;
}
