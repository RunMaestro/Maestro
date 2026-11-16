import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import * as toml from 'smol-toml';
import * as atomicStore from '../../../../main/utils/atomic-json-store';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexInstaller } from '../../../../main/coworking/installers/codex';

// Keep the parser real; inject a malformed serializer result only in the
// publication-guard test to prove invalid candidate bytes never reach disk.
vi.mock('smol-toml', async (importOriginal) => {
	const actual = await importOriginal<typeof import('smol-toml')>();
	return { ...actual, stringify: vi.fn(actual.stringify) };
});

const SPEC = {
	command: '/abs/path/coworking-mcp-server.js',
	args: ['/abs/path/coworking-mcp-server.js'],
	env: { MAESTRO_COWORKING_SOCKET: '/tmp/maestro-coworking.sock' },
};

describe('codexInstaller', () => {
	let tmpHome: string;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-coworking-codex-'));
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	const cfgPath = () => path.join(tmpHome, '.codex', 'config.toml');

	it('updates a legacy em-dash block without duplicating the MCP table', async () => {
		const legacy =
			'# >>> maestro-coworking BEGIN — managed by Maestro, do not edit\n' +
			'[mcp_servers.maestro-coworking]\ncommand = "old"\n' +
			'# <<< maestro-coworking END\n';
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), legacy);
		await codexInstaller.install(SPEC);
		const installed = fs.readFileSync(cfgPath(), 'utf8');
		expect(() => parseToml(installed)).not.toThrow();
		expect(installed.match(/\[mcp_servers\.maestro-coworking\]/g)).toHaveLength(1);
	});

	it('install + uninstall round-trips byte-exactly when there is no existing file', async () => {
		expect(await codexInstaller.isInstalled()).toBe(false);
		await codexInstaller.install(SPEC);
		expect(await codexInstaller.isInstalled()).toBe(true);
		await codexInstaller.uninstall();
		expect(await codexInstaller.isInstalled()).toBe(false);
		const after = fs.readFileSync(cfgPath(), 'utf8');
		expect(after).toBe('');
	});

	it('install preserves user content, uninstall restores it byte-exact', async () => {
		const userContent = `# user comments stay
[mcp_servers.user-server]
command = "noop"
args = []

[features]
auto_save = true
`;
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), userContent);

		await codexInstaller.install(SPEC);
		const installed = fs.readFileSync(cfgPath(), 'utf8');
		expect(installed).toContain(userContent.trimEnd());
		expect(installed).toContain('# >>> maestro-coworking BEGIN');
		expect(installed).toContain('[mcp_servers.maestro-coworking]');
		expect(installed).toContain('# <<< maestro-coworking END');

		await codexInstaller.uninstall();
		const restored = fs.readFileSync(cfgPath(), 'utf8');
		expect(restored).toBe(userContent);
	});

	it('install is idempotent - re-installing does not duplicate the block', async () => {
		await codexInstaller.install(SPEC);
		await codexInstaller.install(SPEC);
		const content = fs.readFileSync(cfgPath(), 'utf8');
		const begins = content.match(/maestro-coworking BEGIN/g) ?? [];
		const ends = content.match(/maestro-coworking END/g) ?? [];
		expect(begins.length).toBe(1);
		expect(ends.length).toBe(1);
	});

	it('emitted block is valid TOML structure (sentinel-delimited)', async () => {
		await codexInstaller.install(SPEC);
		const content = fs.readFileSync(cfgPath(), 'utf8');
		expect(content).toMatch(/\[mcp_servers\.maestro-coworking\]/);
		expect(content).toMatch(/command = ".*coworking-mcp-server\.js"/);
		expect(parseToml(content).mcp_servers).toEqual({ 'maestro-coworking': SPEC });
		expect(content).toMatch(/MAESTRO_COWORKING_SOCKET/);
	});

	it.each(['—', '-'])(
		'detects, updates and removes the %s managed block, preserving foreign bytes',
		async (dash) => {
			const prefix = '# my settings\nmodel = "synthetic"\n\n';
			const suffix = '\n# keep this comment\n[mcp_servers.other]\ncommand = "other"\n';
			const block = `# >>> maestro-coworking BEGIN ${dash} managed by Maestro, do not edit\n[mcp_servers.maestro-coworking]\ncommand = "old"\n# <<< maestro-coworking END`;
			fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
			fs.writeFileSync(cfgPath(), prefix + block + suffix);
			expect(await codexInstaller.isInstalled()).toBe(true);
			await codexInstaller.install(SPEC);
			const once = fs.readFileSync(cfgPath(), 'utf8');
			expect(once.startsWith(prefix)).toBe(true);
			expect(once.endsWith(suffix)).toBe(true);
			expect(parseToml(once).mcp_servers).toEqual({
				'maestro-coworking': SPEC,
				other: { command: 'other' },
			});
			await codexInstaller.install(SPEC);
			expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(once);
			await codexInstaller.install({ ...SPEC, command: 'updated' });
			expect(parseToml(fs.readFileSync(cfgPath(), 'utf8')).mcp_servers).toEqual({
				'maestro-coworking': { ...SPEC, command: 'updated' },
				other: { command: 'other' },
			});
			await codexInstaller.uninstall();
			expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(prefix.slice(0, -1) + suffix.slice(1));
			expect(parseToml(fs.readFileSync(cfgPath(), 'utf8')).mcp_servers).toEqual({
				other: { command: 'other' },
			});
			await codexInstaller.uninstall();
			expect(await codexInstaller.isInstalled()).toBe(false);
		}
	);

	it.each(['—', '-'])(
		'uninstalls the original %s block with CRLF and no final newline',
		async (dash) => {
			const prefix = '# preserve\r\nmodel = "synthetic"\r\n';
			const block = `# >>> maestro-coworking BEGIN ${dash} managed by Maestro, do not edit\r\n[mcp_servers.maestro-coworking]\r\ncommand = "old"\r\n# <<< maestro-coworking END`;
			fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
			fs.writeFileSync(cfgPath(), prefix + block);
			expect(await codexInstaller.isInstalled()).toBe(true);
			await codexInstaller.uninstall();
			expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(prefix);
		}
	);

	it('serializes control characters and quoted environment keys as real TOML', async () => {
		const spec = {
			command: 'C:\\synthetic\\"tool"',
			args: ['line\nnext', 'tab\there', '\u0000'],
			env: { 'key.with spaces': 'value\r\n' },
		};
		await codexInstaller.install(spec);
		expect(parseToml(fs.readFileSync(cfgPath(), 'utf8')).mcp_servers).toEqual({
			'maestro-coworking': spec,
		});
	});

	it.each([
		['bare collision', '[mcp_servers.maestro-coworking]\ncommand="mine"\n'],
		['quoted collision', '[mcp_servers."maestro-coworking"]\ncommand="mine"\n'],
		['inline collision', 'mcp_servers = { maestro-coworking = { command = "mine" } }\n'],
		['missing end', '# >>> maestro-coworking BEGIN - managed by Maestro, do not edit\n'],
		['orphan end', '# <<< maestro-coworking END\n'],
		['unknown begin', '# >>> maestro-coworking BEGIN ?\n# <<< maestro-coworking END\n'],
		[
			'reversed markers',
			'# <<< maestro-coworking END\n# >>> maestro-coworking BEGIN - managed by Maestro, do not edit\n',
		],
		['invalid input', 'model = "unterminated\n'],
		['invalid server container', 'mcp_servers = []\n'],
	])('rejects %s on install without any write', async (_label, input) => {
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), input);
		const write = vi.spyOn(atomicStore, 'atomicWriteFile');
		await expect(codexInstaller.install(SPEC)).rejects.toThrow(/Codex coworking:/);
		await expect(codexInstaller.uninstall()).rejects.toThrow(/Codex coworking:/);
		expect(write).not.toHaveBeenCalled();
		expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(input);
		expect(await codexInstaller.isInstalled()).toBe(false);
	});

	it.each([
		['nested markers', '# >>> maestro-coworking BEGIN - managed by Maestro, do not edit\n'],
		['foreign table', '[mcp_servers.foreign]\ncommand="keep"\n'],
		['foreign root key', 'model = "keep"\n'],
	])('rejects unsafe managed block with %s on install and uninstall', async (_label, extra) => {
		const input =
			'# >>> maestro-coworking BEGIN — managed by Maestro, do not edit\n' +
			extra +
			'[mcp_servers.maestro-coworking]\ncommand="old"\n# <<< maestro-coworking END\n';
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), input);
		const write = vi.spyOn(atomicStore, 'atomicWriteFile');
		await expect(codexInstaller.install(SPEC)).rejects.toThrow();
		await expect(codexInstaller.uninstall()).rejects.toThrow();
		expect(write).not.toHaveBeenCalled();
		expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(input);
	});

	it('rejects duplicate legacy/current blocks without modifying either', async () => {
		await codexInstaller.install(SPEC);
		const current = fs.readFileSync(cfgPath(), 'utf8');
		const input = current.replace('BEGIN -', 'BEGIN —') + current;
		fs.writeFileSync(cfgPath(), input);
		const write = vi.spyOn(atomicStore, 'atomicWriteFile');
		await expect(codexInstaller.install(SPEC)).rejects.toThrow(/markers/);
		await expect(codexInstaller.uninstall()).rejects.toThrow(/markers/);
		expect(write).not.toHaveBeenCalled();
		expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(input);
	});

	it('refuses markers inside a multiline string and keys attached outside the block', async () => {
		const block =
			'# >>> maestro-coworking BEGIN - managed by Maestro, do not edit\n[mcp_servers.maestro-coworking]\ncommand="old"\n# <<< maestro-coworking END\n';
		for (const input of [`description = """\n${block}"""\n`, block + 'foreign="keep"\n']) {
			fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
			fs.writeFileSync(cfgPath(), input);
			const write = vi.spyOn(atomicStore, 'atomicWriteFile');
			await expect(codexInstaller.install(SPEC)).rejects.toThrow();
			await expect(codexInstaller.uninstall()).rejects.toThrow();
			expect(write).not.toHaveBeenCalled();
			expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(input);
		}
	});

	it('updates a CRLF legacy block without changing surrounding bytes', async () => {
		const prefix = '# keep\r\nmodel="synthetic"\r\n';
		const suffix = '\r\n[mcp_servers.other]\r\ncommand="keep"\r\n';
		const block =
			'# >>> maestro-coworking BEGIN — managed by Maestro, do not edit\r\n[mcp_servers.maestro-coworking]\r\ncommand="old"\r\n# <<< maestro-coworking END';
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), prefix + block + suffix);
		await codexInstaller.install(SPEC);
		const output = fs.readFileSync(cfgPath(), 'utf8');
		expect(output.startsWith(prefix)).toBe(true);
		expect(output.endsWith(suffix)).toBe(true);
		expect(output.replace(/\r\n/g, '')).not.toContain('\n');
		expect(parseToml(output).mcp_servers).toEqual({
			'maestro-coworking': SPEC,
			other: { command: 'keep' },
		});
	});

	it('refuses candidate parse failure before atomic publication', async () => {
		const input = '# preserve\nmodel="synthetic"\n';
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), input);
		const write = vi.spyOn(atomicStore, 'atomicWriteFile');
		vi.mocked(toml.stringify).mockReturnValueOnce('[invalid');
		await expect(codexInstaller.install(SPEC)).rejects.toThrow(
			/updated configuration is not valid TOML/
		);
		expect(write).not.toHaveBeenCalled();
		expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(input);
	});

	it('uninstall on a non-installed config is a no-op', async () => {
		await codexInstaller.uninstall();
		expect(fs.existsSync(cfgPath())).toBe(false);
	});
});
