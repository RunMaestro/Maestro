#!/usr/bin/env node
// maestro-p — wrapper binary that mimics `claude -p` semantics on the outside
// but drives Claude's interactive TUI on the inside, so usage falls under the
// user's Claude Max interactive quota instead of API billing.
//
// Phase 1 scaffold: parses top-level flags, prints usage / version, and exits.
// Run logic, --status mode, and TUI driving land in subsequent tasks.

import { Command } from 'commander';
import { VERSION } from './package-info';

const program = new Command();

program
	.name('maestro-p')
	.description(
		[
			'Drive Claude Code interactively while emitting stream-json on stdout.',
			'',
			'Invocation forms:',
			'  maestro-p [prompt] [...claude-flags]',
			'  maestro-p -p "<prompt>" [...claude-flags]',
			'  echo "<prompt>" | maestro-p [...claude-flags]',
			'  maestro-p --status [...claude-flags]',
			'',
			'Flag handling:',
			'  Consumed by maestro-p (not forwarded): -p, --print, --prompt, --status,',
			'    --stream-thinking, --max-wait, --help, --version.',
			'  Stripped with a warning (headless-mode flags that would corrupt the TUI):',
			'    --output-format, --input-format, --verbose.',
			'  Everything else is forwarded verbatim to the underlying `claude` invocation.',
			'',
			'Environment:',
			'  MAESTRO_CLAUDE_BIN  Override the `claude` binary location (default: PATH).',
			'  CLAUDE_CONFIG_DIR   Inherited by the spawned claude; switch Claude Max accounts.',
		].join('\n')
	)
	.version(VERSION)
	.option('-p, --print <text>', 'Prompt text (alias: --prompt). Mirrors `claude -p` semantics.')
	.option('--prompt <text>', 'Prompt text (alias for -p / --print).')
	.option('--status', 'Spawn the TUI, run /usage, emit one status JSON object, then exit.')
	.option('--stream-thinking', 'Mirror ANSI-stripped TUI lines to stderr for observability.')
	.option(
		'--max-wait <seconds>',
		'Hard timeout in seconds since the last received byte (default: 300).'
	)
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.action(() => {
		// Phase 1 scaffold: no run/--status implementation yet.
		// Future tasks wire up argument resolution, the TUI driver, and stream-json emission.
		process.stderr.write(
			'maestro-p: scaffold only — run/--status modes are not implemented yet.\n'
		);
		process.exit(1);
	});

program.parse(process.argv);
