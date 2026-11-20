/**
 * @file context-footprint.test.ts
 * @description The footprint collector over real temporary trees: it finds the
 * instruction files, skills, MCP servers and memory an agent has, reads only
 * the places it is told to, writes nothing, and says so when it cannot look.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	FOOTPRINT_LIMITS,
	collectContextFootprint,
	type FootprintFs,
	type FootprintTarget,
} from '../../main/context-footprint';
import { memoryLayoutFor } from '../../main/memory-manager';
import { localTranslationFs } from '../../shared/maestro-lib/translation/local-fs';
import { estimateTokenCount } from '../../shared/formatters';
import { formatContextFootprint } from '../../shared/contextFootprint';

let root: string;
let project: string;
let account: string;

/** Create files under `base` from a map of `/`-separated paths to their text. */
function seed(base: string, files: Record<string, string>): void {
	for (const [relative, text] of Object.entries(files)) {
		const file = path.join(base, ...relative.split('/'));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}
}

/** The port, with every path it is asked about written down. */
function recordingFs(): { port: FootprintFs; touched: string[] } {
	const touched: string[] = [];
	const port: FootprintFs = {
		stat: (file) => (touched.push(file), localTranslationFs.stat(file)),
		readdir: (directory, options) => (
			touched.push(directory),
			localTranslationFs.readdir(directory, options)
		),
		readFile: (file) => (touched.push(file), localTranslationFs.readFile(file)),
		realpath: (file) => (touched.push(file), localTranslationFs.realpath(file)),
	};
	return { port, touched };
}

/** A port whose reads fail the way `failures` says; everything else reads for real. */
function failingFs(failures: Record<string, string>): FootprintFs {
	const fail = (file: string) => {
		const code = failures[path.basename(file)];
		if (code) throw Object.assign(new Error(`${code}: ${file}`), { code });
	};
	return {
		stat: async (file) => (fail(file), localTranslationFs.stat(file)),
		readdir: async (directory, options) => (
			fail(directory),
			localTranslationFs.readdir(directory, options)
		),
		readFile: async (file) => (fail(file), localTranslationFs.readFile(file)),
		realpath: async (file) => (fail(file), localTranslationFs.realpath(file)),
	};
}

/** A port that must never be called. */
const untouchableFs: FootprintFs = {
	stat: async () => {
		throw new Error('stat must not be called');
	},
	readdir: async () => {
		throw new Error('readdir must not be called');
	},
	readFile: async () => {
		throw new Error('readFile must not be called');
	},
	realpath: async () => {
		throw new Error('realpath must not be called');
	},
};

function target(overrides: Partial<FootprintTarget> = {}): FootprintTarget {
	return {
		agentId: 'agent-1',
		agentName: 'Docs Agent',
		toolType: 'claude-code',
		projectRoot: project,
		accountDir: account,
		...overrides,
	};
}

/** Path, size, content digest and modified time of everything under `base`. */
function snapshot(base: string): Record<string, string> {
	const entries: Record<string, string> = {};
	const walk = (directory: string) => {
		for (const name of fs.readdirSync(directory)) {
			const full = path.join(directory, name);
			const info = fs.lstatSync(full);
			const key = path.relative(base, full).split(path.sep).join('/');
			if (info.isDirectory()) {
				entries[key] = 'dir';
				walk(full);
			} else {
				const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
				entries[key] = `${info.size}:${digest}:${info.mtimeMs}`;
			}
		}
	};
	walk(base);
	return entries;
}

const SYMLINKS_WORK = (() => {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-footprint-link-'));
	try {
		fs.writeFileSync(path.join(probe, 'a'), 'a');
		fs.symlinkSync('a', path.join(probe, 'b'));
		return true;
	} catch {
		return false;
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
})();

const labels = (audit: Awaited<ReturnType<typeof collectContextFootprint>>) =>
	audit.inventory.components.map((component) => component.label);

describe('collectContextFootprint', () => {
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-footprint-'));
		project = path.join(root, 'work', 'project');
		account = path.join(root, 'accounts', 'main');
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(account, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe('project files', () => {
		it('lists the instruction files by size, with where each came from', async () => {
			seed(project, {
				'CLAUDE.md': 'c'.repeat(4_000),
				'AGENTS.md': 'a'.repeat(400),
				'.claude/CLAUDE.md': 'd'.repeat(40),
			});
			const audit = await collectContextFootprint(target({ accountDir: undefined }));
			const byLabel = Object.fromEntries(
				audit.inventory.components.map((component) => [component.label, component])
			);
			expect(Object.keys(byLabel).sort()).toEqual(['.claude/CLAUDE.md', 'AGENTS.md', 'CLAUDE.md']);
			expect(byLabel['CLAUDE.md']).toMatchObject({
				kind: 'instruction',
				scope: 'project',
				path: path.join(project, 'CLAUDE.md'),
				discoveredBy: 'project instruction files',
				bytes: 4_000,
				estimatedTokens: 1_000,
				activation: { state: 'unknown' },
			});
			expect(byLabel['AGENTS.md'].bytes).toBe(400);
		});

		it.skipIf(!SYMLINKS_WORK)(
			'counts a link and its target once, and remembers the other name',
			async () => {
				seed(project, { 'CLAUDE.md': 'shared instructions' });
				fs.symlinkSync('CLAUDE.md', path.join(project, 'AGENTS.md'));
				const audit = await collectContextFootprint(target({ accountDir: undefined }));
				expect(labels(audit)).toEqual(['CLAUDE.md']);
				expect(audit.inventory.components[0].aliases).toEqual(['AGENTS.md']);
			}
		);

		it('finds one skill per folder under every project skill root, and skips what is not a skill', async () => {
			seed(project, {
				'.claude/skills/review/SKILL.md': 'r'.repeat(800),
				'.claude/skills/lower/skill.md': 'l'.repeat(80),
				'.claude/skills/no-skill-file/notes.md': 'not a skill',
				'.claude/skills/.system/SKILL.md': 'tooling',
				'.claude/skills/README.md': 'a file in the root',
				'.agents/skills/shared/SKILL.md': 's'.repeat(40),
				'.codex/skills/legacy/SKILL.md': 'x'.repeat(40),
				'.grok/skills/other/SKILL.md': 'y'.repeat(40),
			});
			const audit = await collectContextFootprint(target({ accountDir: undefined }));
			expect(labels(audit).sort()).toEqual([
				'.agents/skills/shared',
				'.claude/skills/lower',
				'.claude/skills/review',
				'.codex/skills/legacy',
				'.grok/skills/other',
			]);
			const review = audit.inventory.components.find((c) => c.label === '.claude/skills/review');
			expect(review).toMatchObject({
				kind: 'skill',
				scope: 'project',
				bytes: 800,
				path: path.join(project, '.claude', 'skills', 'review', 'SKILL.md'),
				discoveredBy: 'project skills folder .claude/skills',
			});
		});

		it('lists MCP servers by name and claims no size for them', async () => {
			seed(project, {
				'.mcp.json': JSON.stringify({
					mcpServers: { zeta: { command: 'z' }, alpha: { url: 'u' } },
				}),
			});
			const audit = await collectContextFootprint(target({ accountDir: undefined }));
			expect(audit.inventory.components).toEqual([
				expect.objectContaining({
					kind: 'mcp-server',
					label: '.mcp.json: alpha',
					bytes: null,
					estimatedTokens: null,
				}),
				expect.objectContaining({ kind: 'mcp-server', label: '.mcp.json: zeta', bytes: null }),
			]);
			expect(audit.unknowns.map((note) => note.code)).toContain('mcp-tool-definitions');
		});

		it('never carries a secret from .mcp.json into the report', async () => {
			const token = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
			seed(project, {
				'.mcp.json': JSON.stringify({
					mcpServers: {
						docs: {
							command: 'npx',
							args: ['--api-key', token],
							env: { API_TOKEN: token },
							headers: { Authorization: `Bearer ${token}` },
						},
					},
				}),
			});
			const audit = await collectContextFootprint(target({ accountDir: undefined }));
			expect(labels(audit)).toEqual(['.mcp.json: docs']);
			expect(JSON.stringify(audit)).not.toContain(token);
		});

		it('says so when .mcp.json is not JSON, and when it is too large to open', async () => {
			seed(project, { '.mcp.json': '{ not json' });
			const broken = await collectContextFootprint(target({ accountDir: undefined }));
			expect(broken.inventory.components).toEqual([]);
			expect(broken.unknowns).toContainEqual({
				code: 'unreadable',
				message: '.mcp.json is not a JSON object, so its servers were not listed.',
			});

			seed(project, {
				'.mcp.json': JSON.stringify({ mcpServers: { a: {} }, pad: 'p'.repeat(200) }),
			});
			const { port, touched } = recordingFs();
			const large = await collectContextFootprint(target({ accountDir: undefined }), {
				fs: port,
				limits: { mcpConfigBytes: 100 },
			});
			expect(large.inventory.components).toEqual([]);
			expect(large.unknowns.map((note) => note.code)).toContain('truncated');
			expect(touched.filter((file) => file.endsWith('.mcp.json'))).toHaveLength(1); // stat only
		});
	});

	describe('account files', () => {
		it('reads the account instruction files and skills, labelled as the account', async () => {
			seed(account, {
				'CLAUDE.md': 'u'.repeat(2_000),
				'skills/deploy/SKILL.md': 'd'.repeat(400),
			});
			const audit = await collectContextFootprint(target());
			expect(audit.inventory.components).toEqual([
				expect.objectContaining({
					kind: 'instruction',
					scope: 'account',
					label: '<account>/CLAUDE.md',
					path: path.join(account, 'CLAUDE.md'),
					discoveredBy: 'account instruction files',
					bytes: 2_000,
				}),
				expect.objectContaining({
					kind: 'skill',
					scope: 'account',
					label: '<account>/skills/deploy',
					bytes: 400,
				}),
			]);
		});

		it('reads nothing of the account when the provider has none', async () => {
			seed(account, { 'CLAUDE.md': 'would be found' });
			const audit = await collectContextFootprint(target({ accountDir: undefined }));
			expect(audit.inventory.components).toEqual([]);
			expect(audit.subject.accountDir).toBeUndefined();
		});
	});

	describe('memory', () => {
		it("counts a Claude agent's index apart from its entries", async () => {
			const memory = memoryLayoutFor('claude-code', { projectPath: project, accountDir: account });
			seed(memory.directoryPath, {
				'MEMORY.md': 'm'.repeat(2_000),
				'user_role.md': 'u'.repeat(400),
				'project_state.md': 'p'.repeat(40),
			});
			const audit = await collectContextFootprint(target({ memory }));
			const memoryRows = audit.inventory.components.filter((c) => c.label.startsWith('memory/'));
			// The audit orders by kind, then by size, so the larger entry comes first.
			expect(memoryRows.map((c) => [c.kind, c.label, c.scope, c.bytes])).toEqual([
				['memory-index', 'memory/MEMORY.md', 'project', 2_000],
				['memory', 'memory/user_role.md', 'project', 400],
				['memory', 'memory/project_state.md', 'project', 40],
			]);
			expect(memoryRows[0].path).toBe(path.join(memory.directoryPath, 'MEMORY.md'));
			expect(memoryRows[0].discoveredBy).toBe('memory store listing');
		});

		it("counts a Codex agent's nested store as account memory", async () => {
			const memory = memoryLayoutFor('codex', { projectPath: project, accountDir: account });
			seed(memory.directoryPath, {
				'MEMORY.md': 'i'.repeat(40),
				'rollout_summaries/one.md': 'r'.repeat(80),
			});
			const audit = await collectContextFootprint(target({ toolType: 'codex', memory }));
			const rows = audit.inventory.components.filter((c) => c.label.startsWith('memory/'));
			expect(rows.map((c) => [c.kind, c.label, c.scope])).toEqual([
				['memory-index', 'memory/MEMORY.md', 'account'],
				['memory', 'memory/rollout_summaries/one.md', 'account'],
			]);
		});

		it('says where it looked when the store does not exist, so an empty section is not read as healthy', async () => {
			const memory = memoryLayoutFor('claude-code', { projectPath: project, accountDir: account });
			const audit = await collectContextFootprint(target({ memory }));
			expect(audit.inventory.components).toEqual([]);
			expect(audit.unknowns).toContainEqual({
				code: 'memory-missing',
				message: `No memory store exists at ${memory.directoryPath}.`,
			});
			expect(audit.unknowns.map((note) => note.code)).not.toContain('memory-not-read');
		});

		it('says why a memory store was not read, or that none was', async () => {
			const none = await collectContextFootprint(target());
			expect(none.unknowns).toContainEqual({
				code: 'memory-not-read',
				message: 'No memory store was read.',
			});
			const refused = await collectContextFootprint(
				target({ memory: { unavailable: 'Memory viewer is not supported for agent "opencode"' } })
			);
			expect(refused.unknowns).toContainEqual({
				code: 'memory-not-read',
				message:
					'The memory store was not read: Memory viewer is not supported for agent "opencode"',
			});
		});

		it("never reads another project's memory or another account's files", async () => {
			const memory = memoryLayoutFor('claude-code', { projectPath: project, accountDir: account });
			const other = memoryLayoutFor('claude-code', {
				projectPath: path.join(root, 'work', 'someone-elses-project'),
				accountDir: account,
			});
			seed(memory.directoryPath, { 'MEMORY.md': 'mine' });
			seed(other.directoryPath, { 'MEMORY.md': 'theirs', 'other-secret-note.md': 'theirs' });
			seed(path.join(root, 'accounts', 'zz-second-account-sentinel'), {
				'CLAUDE.md': 'zz-second-account-sentinel',
				'skills/x/SKILL.md': 'x',
			});
			const audit = await collectContextFootprint(target({ memory }));
			const everything = JSON.stringify(audit);
			expect(everything).not.toContain('other-secret-note');
			expect(everything).not.toContain('zz-second-account-sentinel');
			expect(labels(audit)).toEqual(['memory/MEMORY.md']);
		});
	});

	describe('what it will and will not open', () => {
		it('touches only the named files and folders, and opens nothing but .mcp.json', async () => {
			seed(project, {
				'CLAUDE.md': 'project',
				'.mcp.json': JSON.stringify({ mcpServers: { a: {} } }),
				'.claude/skills/one/SKILL.md': 'skill',
				// Real files a wider scan would reach.
				'CLAUDE.local.md': 'personal override',
				'sub/CLAUDE.md': 'subfolder instructions',
				'sub/.claude/skills/deep/SKILL.md': 'deep skill',
			});
			seed(path.dirname(project), { 'CLAUDE.md': 'parent folder instructions' });
			seed(account, {
				'CLAUDE.md': 'account',
				'settings.json': '{"secret": true}',
				'.claude.json': '{"oauthAccount": "private"}',
				'projects/elsewhere/memory/MEMORY.md': 'not this project',
			});
			const { port, touched } = recordingFs();
			await collectContextFootprint(target(), { fs: port });

			const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
			const seen = new Set(touched.map(relative));
			for (const forbidden of [
				'work/CLAUDE.md',
				'work/project/CLAUDE.local.md',
				'work/project/sub',
				'work/project/sub/CLAUDE.md',
				'accounts/main/settings.json',
				'accounts/main/.claude.json',
				'accounts/main/projects',
			]) {
				expect(seen.has(forbidden), forbidden).toBe(false);
			}
			for (const expected of [
				'work/project/CLAUDE.md',
				'work/project/.mcp.json',
				'work/project/.claude/skills/one/SKILL.md',
				'accounts/main/CLAUDE.md',
			]) {
				expect(seen.has(expected), expected).toBe(true);
			}
		});

		it('opens the file, not just stats it, for .mcp.json alone', async () => {
			seed(project, {
				'CLAUDE.md': 'project',
				'.mcp.json': '{"mcpServers":{}}',
				'.claude/skills/a/SKILL.md': 's',
			});
			const reads: string[] = [];
			const port: FootprintFs = {
				...localTranslationFs,
				readFile: (file) => (reads.push(path.basename(file)), localTranslationFs.readFile(file)),
			};
			await collectContextFootprint(target({ accountDir: undefined }), { fs: port });
			expect(reads).toEqual(['.mcp.json']);
		});

		it('changes nothing on disk: no file written, removed, moved or touched', async () => {
			seed(project, {
				'CLAUDE.md': 'project',
				'AGENTS.md': 'agents',
				'.mcp.json': JSON.stringify({ mcpServers: { a: {} } }),
				'.claude/skills/one/SKILL.md': 'skill',
			});
			seed(account, { 'CLAUDE.md': 'account', 'skills/two/SKILL.md': 'skill two' });
			const memory = memoryLayoutFor('claude-code', { projectPath: project, accountDir: account });
			seed(memory.directoryPath, { 'MEMORY.md': 'index', 'a.md': 'entry' });
			const before = snapshot(root);
			await collectContextFootprint(target({ memory, nudgeMessage: 'nudge' }));
			expect(snapshot(root)).toEqual(before);
		});

		it('starts no timer and keeps nothing between runs', async () => {
			seed(project, { 'CLAUDE.md': 'x'.repeat(4_400) });
			vi.useFakeTimers();
			try {
				const first = await collectContextFootprint(target({ accountDir: undefined }));
				expect(vi.getTimerCount()).toBe(0);
				seed(project, { 'CLAUDE.md': 'x'.repeat(8_000) });
				const second = await collectContextFootprint(target({ accountDir: undefined }));
				expect(first.inventory.components[0].bytes).toBe(4_400);
				expect(second.inventory.components[0].bytes).toBe(8_000);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('when it cannot look', () => {
		it('reads no file of an agent that runs on an SSH remote, and says why', async () => {
			const audit = await collectContextFootprint(
				target({
					remote: true,
					memory: memoryLayoutFor('claude-code', { projectPath: project, accountDir: account }),
					nudgeMessage: 'a setting, sized even when the files are on another host',
				}),
				{ fs: untouchableFs }
			);
			expect(audit.inventory.components).toEqual([]);
			expect(audit.unknowns.map((note) => note.code)).toContain('remote-agent');
			expect(audit.configured.contributions.map((entry) => entry.id)).toEqual(['nudge-message']);
		});

		it('reads nothing under a project root that is not absolute', async () => {
			const audit = await collectContextFootprint(
				target({ projectRoot: 'relative/project', accountDir: undefined }),
				{ fs: untouchableFs }
			);
			expect(audit.inventory.components).toEqual([]);
			expect(audit.unknowns.map((note) => note.code)).toContain('no-project-root');
		});

		it('notes a file it was not allowed to read and carries on with the rest', async () => {
			seed(project, {
				'CLAUDE.md': 'blocked',
				'AGENTS.md': 'readable',
				'.mcp.json': '{"mcpServers":{"a":{}}}',
			});
			const audit = await collectContextFootprint(target({ accountDir: undefined }), {
				fs: failingFs({ 'CLAUDE.md': 'EACCES' }),
			});
			expect(labels(audit).sort()).toEqual(['.mcp.json: a', 'AGENTS.md']);
			expect(audit.unknowns).toContainEqual({
				code: 'unreadable',
				message: 'CLAUDE.md could not be read (EACCES).',
			});
		});

		it('does not hide a failure it does not recognise', async () => {
			seed(project, { 'CLAUDE.md': 'x' });
			await expect(
				collectContextFootprint(target({ accountDir: undefined }), {
					fs: failingFs({ 'CLAUDE.md': 'EIO' }),
				})
			).rejects.toThrow(/EIO/);
		});
	});

	describe('bounds', () => {
		it('has the limits the report promises', () => {
			expect(FOOTPRINT_LIMITS).toEqual({
				skillsPerRoot: 500,
				memoryEntries: 500,
				mcpConfigBytes: 1024 * 1024,
			});
		});

		it('examines only the first skill folders by name, and says how many there were', async () => {
			for (const name of ['e', 'a', 'd', 'b', 'c']) {
				seed(project, { [`.claude/skills/${name}/SKILL.md`]: name });
			}
			const audit = await collectContextFootprint(target({ accountDir: undefined }), {
				limits: { skillsPerRoot: 2 },
			});
			expect(labels(audit)).toEqual(['.claude/skills/a', '.claude/skills/b']);
			expect(audit.unknowns).toContainEqual({
				code: 'truncated',
				message: '.claude/skills has 5 folders; only the first 2 (by name) were examined.',
			});
		});

		it('keeps the memory index and the first entries by name, and says it cut', async () => {
			const memory = memoryLayoutFor('claude-code', { projectPath: project, accountDir: account });
			seed(memory.directoryPath, {
				'MEMORY.md': 'index',
				'd.md': 'd',
				'a.md': 'a',
				'c.md': 'c',
				'b.md': 'b',
			});
			const audit = await collectContextFootprint(target({ memory }), {
				limits: { memoryEntries: 3 },
			});
			expect(labels(audit)).toEqual(['memory/MEMORY.md', 'memory/a.md', 'memory/b.md']);
			expect(audit.unknowns).toContainEqual({
				code: 'truncated',
				message: 'The memory store has 5 entries; only the first 3 were counted.',
			});
		});
	});

	describe('text the Maestro settings add', () => {
		it('sizes the system prompt, the new session message and the nudge as configured now, and keeps no text', async () => {
			const audit = await collectContextFootprint(
				target({
					accountDir: undefined,
					maestroSystemPrompt: { text: 'S'.repeat(8_000) },
					newSessionMessage: 'N'.repeat(80),
					nudgeMessage: 'U'.repeat(40),
				})
			);
			expect(audit.configured.contributions).toEqual([
				{
					id: 'maestro-system-prompt',
					label: 'Maestro system prompt',
					chars: 8_000,
					estimatedTokens: estimateTokenCount('S'.repeat(8_000)),
					frequency: 'each-spawn',
					source: 'the Maestro system prompt builder, assembled for this agent now',
					basis: 'configured-now',
					delivery: { state: 'unknown' },
					window: { state: 'unknown' },
				},
				expect.objectContaining({
					id: 'new-session-message',
					frequency: 'first-message',
					chars: 80,
					source: "the agent's New Session Message setting, as saved now",
				}),
				expect.objectContaining({
					id: 'nudge-message',
					frequency: 'every-message',
					chars: 40,
					source: "the agent's Nudge Message setting, as saved now",
				}),
			]);
			expect(JSON.stringify(audit)).not.toContain('SSSSSSSSSS');
		});

		it('never reports delivery or window for text it only read from settings or rebuilt', async () => {
			// The shape of the supervisor review probe: an agent on a remote (no file reads),
			// a prompt assembled just now, a first-message text that a resumed tab never
			// received again, and a nudge saved after the last launch.
			const audit = await collectContextFootprint({
				agentId: 'synthetic-review',
				toolType: 'codex',
				projectRoot: '/synthetic',
				remote: true,
				maestroSystemPrompt: { text: 'Current settings, assembled now; never delivered.' },
				newSessionMessage: 'Saved first-message text; a resumed tab has no delivery record.',
				nudgeMessage: 'Changed after the last launch.',
			});
			expect(audit.configured.contributions).toHaveLength(3);
			for (const entry of audit.configured.contributions) {
				expect(entry.basis).toBe('configured-now');
				expect(entry.delivery).toEqual({ state: 'unknown' });
				expect(entry.window).toEqual({ state: 'unknown' });
			}
			const text = formatContextFootprint(audit);
			expect(text).not.toMatch(/KNOWN LOADED/i);
			expect(text).toContain('delivery unknown  window unknown');
			expect(audit.unknowns.map((note) => note.code)).toContain('delivery-unknown');
			expect(Object.keys(audit)).not.toContain('loaded');
		});

		it('gives a setting changed between two runs the size it has now, with nothing carried over', async () => {
			const before = await collectContextFootprint(
				target({ accountDir: undefined, nudgeMessage: 'n'.repeat(40) })
			);
			const after = await collectContextFootprint(
				target({ accountDir: undefined, nudgeMessage: 'n'.repeat(400) })
			);
			expect(before.configured.contributions[0].estimatedTokens).toBe(10);
			expect(after.configured.contributions[0].estimatedTokens).toBe(100);
			expect(after.configured.contributions[0].delivery).toEqual({ state: 'unknown' });
		});

		it('ignores blank messages and reports the prompt as not measured when there is none', async () => {
			const audit = await collectContextFootprint(
				target({ accountDir: undefined, newSessionMessage: '   ', nudgeMessage: '\n' })
			);
			expect(audit.configured.contributions).toEqual([]);
			expect(audit.unknowns).toContainEqual({
				code: 'maestro-prompt-unavailable',
				message: 'The Maestro system prompt was not measured.',
			});
		});

		it("passes on the builder's caveat about what the prompt leaves out", async () => {
			const audit = await collectContextFootprint(
				target({
					accountDir: undefined,
					maestroSystemPrompt: { text: 'prompt', caveat: 'The System One section is not counted.' },
				})
			);
			expect(audit.unknowns).toContainEqual({
				code: 'maestro-prompt-partial',
				message: 'The System One section is not counted.',
			});
		});
	});

	describe('the audit it returns', () => {
		it('flags a large file with its provenance, and keeps the two sections apart', async () => {
			seed(project, {
				'CLAUDE.md': 'c'.repeat(8_000),
				'.claude/skills/tiny/SKILL.md': 't'.repeat(80),
			});
			const audit = await collectContextFootprint(
				target({ accountDir: undefined, maestroSystemPrompt: { text: 'p'.repeat(40_000) } })
			);
			expect(audit.candidates.items).toEqual([
				expect.objectContaining({
					label: 'CLAUDE.md',
					path: path.join(project, 'CLAUDE.md'),
					discoveredBy: 'project instruction files',
					estimatedTokens: 2_000,
					basis: 'file-size',
					activation: { state: 'unknown' },
				}),
			]);
			expect(audit.inventory.estimatedTokens).toBe(2_020);
			expect(audit.configured.contributions.map((entry) => entry.estimatedTokens)).toEqual([
				10_000,
			]);
			expect(audit.subject).toEqual({
				agentId: 'agent-1',
				agentName: 'Docs Agent',
				toolType: 'claude-code',
				projectRoot: project,
			});
		});

		it('names the scopes it did not audit, every time it reads files', async () => {
			const audit = await collectContextFootprint(target({ accountDir: undefined }));
			const note = audit.unknowns.find((entry) => entry.code === 'unaudited-scopes');
			expect(note?.message).toContain('parent folders or subfolders');
			expect(note?.message).toContain('CLAUDE.local.md');
		});
	});
});
