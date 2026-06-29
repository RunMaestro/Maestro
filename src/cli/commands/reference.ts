// Reference command - emit the full command reference by introspecting the live
// Commander program tree. Because it reads the registered commands directly, the
// generated reference can never drift from the actual CLI surface: regenerate it
// after adding/changing a command and the docs update mechanically.
//
//   maestro-cli reference            # Markdown (default)
//   maestro-cli reference --format json
//
// `npm run gen:cli-reference` pipes the Markdown form into docs/cli-reference.md.

import type { Command } from 'commander';

interface OptionInfo {
	flags: string;
	description: string;
	defaultValue?: unknown;
}

interface CommandInfo {
	path: string; // full command path, e.g. "settings agent set"
	description: string;
	args: string;
	options: OptionInfo[];
	subcommands: CommandInfo[];
}

interface ReferenceOptions {
	format?: string;
}

function optionInfo(cmd: Command): OptionInfo[] {
	return cmd.options.map((opt) => ({
		flags: opt.flags,
		description: opt.description ?? '',
		defaultValue: opt.defaultValue,
	}));
}

/** Render the argument signature (e.g. "<agent-id> [message]") for a command. */
function argSignature(cmd: Command): string {
	// `registeredArguments` is the public-ish list of declared arguments; fall
	// back to the legacy `_args` only if a Commander version lacks it.
	const args =
		(cmd as unknown as { registeredArguments?: { name(): string; required: boolean }[] })
			.registeredArguments ??
		(cmd as unknown as { _args?: { name(): string; required: boolean }[] })._args ??
		[];
	return args.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(' ');
}

function buildInfo(cmd: Command, parentPath: string): CommandInfo {
	const name = cmd.name();
	const path = parentPath ? `${parentPath} ${name}` : name;
	return {
		path,
		description: cmd.description() ?? '',
		args: argSignature(cmd),
		options: optionInfo(cmd),
		subcommands: cmd.commands.map((c) => buildInfo(c as Command, path)),
	};
}

/** Flatten the tree into a depth-first list of leaf-and-group commands. */
function flatten(info: CommandInfo, out: CommandInfo[]): void {
	// Skip the synthetic root (empty/program name handled by caller).
	out.push(info);
	for (const sub of info.subcommands) flatten(sub, out);
}

function toMarkdown(root: CommandInfo): string {
	const lines: string[] = [];
	lines.push('# maestro-cli Command Reference');
	lines.push('');
	lines.push(
		'> Generated from the CLI command tree by `maestro-cli reference`. Do not edit by hand - run `npm run gen:cli-reference` to refresh.'
	);
	lines.push('');

	const all: CommandInfo[] = [];
	for (const sub of root.subcommands) flatten(sub, all);

	for (const cmd of all) {
		const sig = [cmd.path, cmd.args].filter(Boolean).join(' ');
		lines.push(`## \`${sig}\``);
		lines.push('');
		if (cmd.description) {
			lines.push(cmd.description);
			lines.push('');
		}
		const realOptions = cmd.options.filter((o) => o.flags !== '-h, --help');
		if (realOptions.length > 0) {
			lines.push('| Option | Description | Default |');
			lines.push('| ------ | ----------- | ------- |');
			for (const opt of realOptions) {
				const def =
					opt.defaultValue !== undefined && opt.defaultValue !== false
						? `\`${JSON.stringify(opt.defaultValue)}\``
						: '-';
				const desc = (opt.description || '-').replace(/\|/g, '\\|');
				lines.push(`| \`${opt.flags}\` | ${desc} | ${def} |`);
			}
			lines.push('');
		}
	}
	return lines.join('\n');
}

export function reference(program: Command, options: ReferenceOptions): void {
	const root = buildInfo(program, '');
	const format = (options.format ?? 'md').trim().toLowerCase();
	if (format === 'json') {
		console.log(JSON.stringify(root.subcommands, null, 2));
	} else {
		console.log(toMarkdown(root));
	}
}
