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
	options: { flags: string; description: string }[];
	subcommands: CommandInfo[];
}

let registered: Set<string>;
let nodes: CommandInfo[];

function findCommand(path: string, entries: CommandInfo[] = nodes): CommandInfo | undefined {
	for (const entry of entries) {
		if (entry.path === path) return entry;
		const found = findCommand(path, entry.subcommands);
		if (found) return found;
	}
	return undefined;
}

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
	nodes = JSON.parse(lines.join('\n')) as CommandInfo[];
	collectPaths(nodes, registered);
}, 60_000);

describe('maestro-cli command tree', () => {
	it('registers the global Board workflow and worker options commands', () => {
		for (const verb of [
			'catalog',
			'add-card',
			'show-card',
			'card-runs',
			'remove-cards',
			'worker-options',
			'worker-register',
			'worker-unregister',
			'worker-pause',
			'worker-resume',
			'role-update',
			'role-delete',
			'source-preview',
			'source-export',
			'source-suppress',
			'source-restore',
			'hold',
			'resume',
			'approve',
		]) {
			expect(registered).toContain(`maestro-cli board ${verb}`);
		}
	});

	it('exposes only supported catalog options and an optional project selector', () => {
		const catalog = findCommand('maestro-cli board catalog')!;
		expect(catalog.options.map((option) => option.flags)).toEqual(['--json']);
		const addCard = findCommand('maestro-cli board add-card')!;
		expect(
			addCard.options.find((option) => option.flags.startsWith('--project-root'))?.description
		).toBe('Registered source project root for selecting a project');
	});

	it('requires an exact worker ID for worker options', () => {
		const options = findCommand('maestro-cli board worker-options')!.options;
		expect(options.find((option) => option.flags.startsWith('-a, --agent'))?.flags).toBe(
			'-a, --agent <id>'
		);
	});

	it('keeps one explicit batch fence option per required identity', () => {
		const batch = findCommand('maestro-cli board remove-cards')!;
		for (const flag of ['--source', '--collection', '--revision', '--cards']) {
			expect(batch.options.filter((option) => option.flags.startsWith(`${flag} `))).toHaveLength(1);
		}
	});

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
