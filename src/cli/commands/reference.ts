// Reference command - emit the full command reference by introspecting the live
// Commander program tree. Because it reads the registered commands directly, the
// generated reference can never drift from the actual CLI surface: regenerate it
// after adding/changing a command and the docs update mechanically.
//
//   maestro-cli reference            # Markdown (default)
//   maestro-cli reference --format json
//   maestro-cli reference --all      # include verbs of switched-off Encore Features
//
// `npm run gen:cli-reference` pipes the `--all` Markdown form into docs/cli-reference.md.
// Without `--all` the reference matches `--help`: a feature the user switched
// off contributes no commands and no options.

import type { Command, Option } from 'commander';
import { listedSubcommands } from '../utils/encore-gate';

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
	all?: boolean;
}

function optionInfo(cmd: Command, includeHidden: boolean): OptionInfo[] {
	const options = cmd.options as readonly Option[];
	return options
		.filter((opt) => includeHidden || !opt.hidden)
		.map((opt) => ({
			flags: opt.flags,
			description: opt.description ?? '',
			defaultValue: opt.defaultValue,
		}));
}

type CommandArgument = { name(): string; required: boolean; variadic?: boolean };

/** Render the argument signature (e.g. "<agent-id> [message...]") for a command. */
export function argSignature(cmd: Command): string {
	// Commander exposes registeredArguments publicly; retain the legacy fallback for older versions.
	const current = cmd as unknown as { registeredArguments?: CommandArgument[] };
	const legacy = cmd as unknown as { _args?: CommandArgument[] };
	const args = current.registeredArguments ?? legacy._args ?? [];
	return args
		.map((a) => {
			const name = a.name() + (a.variadic ? '...' : '');
			return a.required ? `<${name}>` : `[${name}]`;
		})
		.join(' ');
}

function buildInfo(cmd: Command, parentPath: string, includeHidden: boolean): CommandInfo {
	const name = cmd.name();
	const path = parentPath ? `${parentPath} ${name}` : name;
	return {
		path,
		description: cmd.description() ?? '',
		args: argSignature(cmd),
		options: optionInfo(cmd, includeHidden),
		subcommands: listedSubcommands(cmd, includeHidden).map((c) =>
			buildInfo(c, path, includeHidden)
		),
	};
}

/** Flatten the tree into a depth-first list of leaf-and-group commands. */
function flatten(info: CommandInfo, out: CommandInfo[]): void {
	// Skip the synthetic root (empty/program name handled by caller).
	out.push(info);
	for (const sub of info.subcommands) flatten(sub, out);
}

/**
 * Mintlify parses the page as MDX, so a bare `<agent>` in prose is an unclosed
 * JSX tag and `{x}` is an expression: either one fails the whole docs deploy.
 * Escape them everywhere except inside code spans, where they are literal.
 */
export function escapeMdxProse(text: string): string {
	return text
		.split(/(`[^`]*`)/)
		.map((part, i) =>
			i % 2 === 1 ? part : part.replace(/</g, '&lt;').replace(/[{}]/g, (c) => `\\${c}`)
		)
		.join('');
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
			lines.push(escapeMdxProse(cmd.description));
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
				const desc = escapeMdxProse(opt.description || '-').replace(/\|/g, '\\|');
				const flags = opt.flags.replace(/\|/g, '\\|');
				lines.push(`| \`${flags}\` | ${desc} | ${def} |`);
			}
			lines.push('');
		}
	}
	return lines.join('\n');
}

export function reference(program: Command, options: ReferenceOptions): void {
	const root = buildInfo(program, '', options.all === true);
	const format = (options.format ?? 'md').trim().toLowerCase();
	if (format === 'json') {
		console.log(JSON.stringify(root.subcommands, null, 2));
	} else {
		console.log(toMarkdown(root));
	}
}
