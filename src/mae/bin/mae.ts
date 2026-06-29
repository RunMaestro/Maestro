#!/usr/bin/env node
// Entry point for the `mae` launcher. Bundled to dist/cli/mae.js (root bin `mae`).

import { runMae } from '../launcher';

runMae({ argv: process.argv.slice(2) })
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		process.stderr.write(`mae: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
