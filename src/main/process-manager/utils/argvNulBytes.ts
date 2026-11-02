/**
 * An argument cannot carry a NUL byte: argv is a list of C strings, so the
 * byte would end the argument early, and Node refuses the whole spawn up
 * front with `The argument 'args[N]' must be a string without null bytes`.
 * A NUL in a prompt (pasted text, a file read into the conductor profile)
 * means nothing to a model, so it is dropped rather than losing the turn.
 */
export function stripNulBytesFromArgs(args: string[]): { args: string[]; stripped: number } {
	let stripped = 0;
	const cleaned = args.map((arg) => {
		if (!arg.includes('\0')) return arg;
		const without = arg.split('\0').join('');
		stripped += arg.length - without.length;
		return without;
	});
	return stripped > 0 ? { args: cleaned, stripped } : { args, stripped: 0 };
}
