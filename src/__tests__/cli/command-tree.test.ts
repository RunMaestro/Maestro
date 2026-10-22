/**
 * @file command-tree.test.ts
 * @description The CLI entry registers every command the generated reference documents.
 *
 * A verb can lose its registration in `src/cli/index.ts` while its module, its unit tests
 * and its docs all stay: the tests call the command functions directly, so they keep
 * passing while `maestro-cli <verb>` fails with "unknown command". That happened to
 * `maestro-cli host` when an rc merge dropped its block. This reads the live command tree
 * the way `maestro-cli reference --format json` does and checks it against
 * `docs/cli-reference.md`, which `npm run gen:cli-reference` generates from that tree.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

interface CommandInfo {
	path: string;
	subcommands: CommandInfo[];
}

let registered: Set<string>;

function collectPaths(nodes: CommandInfo[], out: Set<string>): void {
	for (const node of nodes) {
		out.add(node.path);
		collectPaths(node.subcommands, out);
	}
}

beforeAll(async () => {
	const argv = process.argv;
	const lines: string[] = [];
	const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	});
	process.argv = ['node', 'maestro-cli', 'reference', '--format', 'json', '--all'];
	try {
		await import('../../cli/index');
	} finally {
		process.argv = argv;
		log.mockRestore();
	}
	registered = new Set();
	collectPaths(JSON.parse(lines.join('\n')) as CommandInfo[], registered);
}, 60_000);

describe('maestro-cli command tree', () => {
	it('registers host start, status and stop', () => {
		expect(registered).toContain('maestro-cli host');
		expect(registered).toContain('maestro-cli host start');
		expect(registered).toContain('maestro-cli host status');
		expect(registered).toContain('maestro-cli host stop');
	});

	it('registers every command docs/cli-reference.md documents', () => {
		const reference = fs.readFileSync(
			path.join(__dirname, '../../../docs/cli-reference.md'),
			'utf8'
		);
		// Each command is a `## \`maestro-cli <path> <args>\`` heading; the args are
		// `<required>` / `[optional]` placeholders after the path. A Windows checkout
		// can end each line with \r.
		const documented = [...reference.matchAll(/^## `(maestro-cli[^`]*)`\r?$/gm)].map((match) =>
			match[1].replace(/\s+[<[].*$/, '').trim()
		);
		expect(documented.length).toBeGreaterThan(0);
		expect(documented.filter((command) => !registered.has(command))).toEqual([]);
	});
});
