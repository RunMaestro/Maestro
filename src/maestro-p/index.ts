#!/usr/bin/env node
// maestro-p
// Standalone wrapper that mimics `claude -p` semantics by driving Claude's
// interactive TUI under the hood, so callers (Maestro, shells, pipelines)
// consume the interactive Claude Max quota instead of API billing.
//
// Phase 1 scaffold: this file currently only exposes --help and --version.
// Subsequent tasks wire up argument parsing, the TUI driver, JSONL tailer,
// stream-json emitter, /usage parser, and the run/status flows.

import { Command } from 'commander';

import { VERSION } from './package-info';

const program = new Command();

program
	.name('maestro-p')
	.description(
		[
			'Wrap Claude Code so callers see `claude -p` semantics while the underlying',
			'session runs through the interactive TUI (Claude Max quota, not API billing).',
			'',
			'Argument handling:',
			'  - Prompt-input flags (consumed): -p, --print, --prompt',
			'  - maestro-p flags (consumed):    --status, --stream-thinking, --max-wait, --help, --version',
			'  - Stripped (dropped with warning): --output-format, --input-format, --verbose',
			'  - Everything else is forwarded verbatim to the spawned `claude` TUI.',
			'',
			'Environment:',
			'  MAESTRO_CLAUDE_BIN  Path to the claude binary (defaults to `claude` on PATH).',
			'  CLAUDE_CONFIG_DIR   Claude config directory (defaults to ~/.claude); inherited by the TUI.',
		].join('\n')
	)
	.version(VERSION, '-v, --version', 'Print the maestro-p version and exit')
	.helpOption('-h, --help', 'Show this help and exit')
	.allowUnknownOption(true)
	.allowExcessArguments(true);

program.parse(process.argv);

// Phase 1 scaffold stops here. Future tasks resolve the prompt, spawn the TUI,
// tail the JSONL, and emit stream-json to stdout. Until then, invocations
// without --help or --version are a no-op (exit 0).
