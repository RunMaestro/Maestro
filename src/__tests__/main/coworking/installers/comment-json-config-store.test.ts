import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCommentJsonConfigStore } from '../../../../main/coworking/installers/comment-json-config-store';

const COMMENTED_CONFIG = `// Keep this user-owned heading.
{
\t/* Theme comment survives. */
\t"theme": "dark",
\t"mcpServers": {
\t\t// Existing server remains before installer-owned entries.
\t\t"existing": { "command": "noop", "args": [] }
\t}
}
`;

describe('createCommentJsonConfigStore', () => {
	let directory: string;
	let configPath: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-comment-json-store-'));
		configPath = path.join(directory, 'nested', 'config.json');
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it('creates missing files with two-space indentation and a trailing newline', async () => {
		const store = createCommentJsonConfigStore(() => configPath);
		const config = (await store.readConfig()) as Record<string, unknown>;
		config.mcpServers = {};

		await store.writeConfig(config);

		expect(fs.readFileSync(configPath, 'utf8')).toBe('{\n  "mcpServers": {}\n}\n');
	});

	it('preserves comments while normalizing indentation and retaining key order', async () => {
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, COMMENTED_CONFIG);
		const store = createCommentJsonConfigStore(() => configPath);
		const config = (await store.readConfig()) as Record<string, unknown>;
		const servers = config.mcpServers as Record<string, unknown>;
		servers['maestro-coworking'] = { command: 'maestro', args: [] };

		await store.writeConfig(config);

		const written = fs.readFileSync(configPath, 'utf8');
		expect(written).toContain('// Keep this user-owned heading.');
		expect(written).toContain('/* Theme comment survives. */');
		expect(written).toContain('// Existing server remains before installer-owned entries.');
		expect(written).toContain('  "theme": "dark"');
		expect(written).toContain('    "existing": {');
		expect(written).toMatch(/\n$/);
		expect(written.indexOf('"theme"')).toBeLessThan(written.indexOf('"mcpServers"'));
		expect(written.indexOf('"existing"')).toBeLessThan(written.indexOf('"maestro-coworking"'));
	});

	it('propagates malformed JSON without modifying its bytes', async () => {
		const malformed = '{\n  // incomplete\n';
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, malformed);
		const store = createCommentJsonConfigStore(() => configPath);

		await expect(store.readConfig()).rejects.toThrow();
		expect(fs.readFileSync(configPath, 'utf8')).toBe(malformed);
	});

	it('keeps the original bytes when the atomic write is interrupted', async () => {
		const original = '// User data\n{\n  "theme": "dark"\n}\n';
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, original);
		const interruptedWrite = async () => {
			throw new Error('simulated interruption before rename');
		};
		const store = createCommentJsonConfigStore(() => configPath, interruptedWrite);

		await expect(store.writeConfig({ theme: 'light' })).rejects.toThrow(
			'simulated interruption before rename'
		);
		expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
	});
});
