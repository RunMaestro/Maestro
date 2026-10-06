/**
 * Claude Code assets in a bundle: what is collected from a workspace, and how
 * secrets are kept out of it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	ALL_CLAUDE_ASSETS,
	collectClaudeAssets,
	mergeMcpConfig,
	resolveClaudeAssetSelection,
	scrubMcpConfig,
} from '../../../../main/cue/bundle/cue-bundle-claude-assets';
import { claudeMemoryDir, resolveClaudeConfigDir } from '../../../../main/memory-manager';
import { REDACTED_PLACEHOLDER as REDACTED } from '../../../../shared/agent-run/redact';

const ANTHROPIC_KEY = 'sk-ant-api03-' + 'a'.repeat(40);
const GITHUB_PAT = 'ghp_' + 'B'.repeat(36);

describe('scrubMcpConfig', () => {
	function scrub(servers: Record<string, unknown>) {
		const result = scrubMcpConfig(JSON.stringify({ mcpServers: servers }));
		return { ...result, json: JSON.parse(result.content).mcpServers };
	}

	it('turns secret env values into references to the same name', () => {
		const { json, secrets } = scrub({
			github: {
				command: 'npx',
				env: { GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_PAT, LOG_LEVEL: 'info' },
			},
		});
		expect(json.github.env).toEqual({
			GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}',
			LOG_LEVEL: 'info',
		});
		expect(secrets).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
	});

	it('catches a credential-shaped value under an innocent name', () => {
		const { json, secrets } = scrub({ svc: { command: 'x', env: { UPSTREAM: ANTHROPIC_KEY } } });
		expect(json.svc.env.UPSTREAM).toBe('${UPSTREAM}');
		expect(secrets).toEqual(['UPSTREAM']);
	});

	it('keeps a header scheme and references the credential after it', () => {
		const { json, secrets } = scrub({
			linear: {
				type: 'http',
				url: 'https://mcp.linear.app/mcp',
				headers: { Authorization: 'Bearer lin_api_123', 'X-Team': 'eng' },
			},
		});
		expect(json.linear.headers).toEqual({
			Authorization: 'Bearer ${MCP_LINEAR_AUTHORIZATION}',
			'X-Team': 'eng',
		});
		expect(secrets).toEqual(['MCP_LINEAR_AUTHORIZATION']);
	});

	it('scrubs secret flags in args, joined and separate', () => {
		const { json, secrets } = scrub({
			db: {
				command: 'db-mcp',
				args: ['--api-key=abc123', '--token', 'xyz789', '--verbose', 'plain'],
			},
		});
		expect(json.db.args).toEqual([
			'--api-key=${MCP_DB_API_KEY}',
			'--token',
			'${MCP_DB_TOKEN}',
			'--verbose',
			'plain',
		]);
		expect(secrets).toEqual(['MCP_DB_API_KEY', 'MCP_DB_TOKEN']);
	});

	it('strips userinfo and secret query values from a URL', () => {
		const { json, secrets } = scrub({
			api: { type: 'sse', url: 'https://user:pw@example.com/sse?api_key=s3cr3t&region=eu' },
		});
		expect(json.api.url).toBe('https://example.com/sse?api_key=${MCP_API_API_KEY}&region=eu');
		expect(secrets).toEqual(['MCP_API_API_KEY']);
	});

	it('leaves existing references alone, and still lists the secret ones', () => {
		// What a re-export of an imported .mcp.json looks like: already scrubbed.
		const { json, secrets } = scrub({
			gh: {
				command: 'gh-mcp',
				args: ['--data', '${HOME}/data'],
				env: { GH_TOKEN: '${GH_TOKEN}' },
			},
		});
		expect(json.gh.env.GH_TOKEN).toBe('${GH_TOKEN}');
		expect(json.gh.args).toEqual(['--data', '${HOME}/data']);
		expect(secrets).toEqual(['GH_TOKEN']);
	});

	it('scrubs a literal secret that sits beside a reference', () => {
		const { json, secrets } = scrub({
			api: {
				type: 'http',
				url: 'https://host/mcp?tenant=${TENANT}&api_key=live-secret',
				headers: { Authorization: 'Bearer ${TOKEN}', 'X-Trace': '${TRACE_ID}-' + GITHUB_PAT },
			},
		});
		expect(json.api.url).toBe('https://host/mcp?tenant=${TENANT}&api_key=${MCP_API_API_KEY}');
		expect(json.api.headers).toEqual({
			Authorization: 'Bearer ${TOKEN}',
			'X-Trace': '${MCP_API_X_TRACE}',
		});
		expect(JSON.stringify(json)).not.toContain('live-secret');
		expect(JSON.stringify(json)).not.toContain(GITHUB_PAT);
		expect(secrets).toEqual(
			expect.arrayContaining(['MCP_API_API_KEY', 'MCP_API_X_TRACE', 'TOKEN'])
		);
	});

	it('drops secret defaults and keeps harmless ones', () => {
		const { json } = scrub({
			svc: {
				command: 'svc',
				args: ['--api-key=${KEY:-' + ANTHROPIC_KEY + '}', '--port', '${PORT:-8080}'],
				env: {
					GH_TOKEN: '${GH_TOKEN:-' + GITHUB_PAT + '}',
					DB_URL: '${DB_URL:-postgres://admin:hunter2@db/app}',
					LOG_LEVEL: '${LOG_LEVEL:-info}',
				},
				headers: { Authorization: 'Bearer ${API_TOKEN:-plain-secret-value}' },
			},
		});
		expect(json.svc.args).toEqual(['--api-key=${KEY}', '--port', '${PORT:-8080}']);
		expect(json.svc.env).toEqual({
			GH_TOKEN: '${GH_TOKEN}',
			DB_URL: '${DB_URL}',
			LOG_LEVEL: '${LOG_LEVEL:-info}',
		});
		expect(json.svc.headers.Authorization).toBe('Bearer ${API_TOKEN}');
	});

	it('keeps URL references as written when it rewrites another part', () => {
		const { json } = scrub({
			api: { type: 'sse', url: 'https://${USER_NAME}:${PASS}@host/sse?team=${TEAM}&token=abc' },
		});
		expect(json.api.url).toBe(
			'https://${USER_NAME}:${PASS}@host/sse?team=${TEAM}&token=${MCP_API_TOKEN}'
		);
	});

	it('warns about an absolute command path without naming it', () => {
		const { warnings } = scrub({ local: { command: '/Users/someone/bin/server' } });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toContain('/Users/someone');
	});

	it('refuses a file that is not a JSON object', () => {
		expect(() => scrubMcpConfig('[]')).toThrow();
		expect(() => scrubMcpConfig('{ nope')).toThrow();
	});
});

describe('mergeMcpConfig', () => {
	const file = (servers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
		JSON.stringify({ ...extra, mcpServers: servers }, null, 2) + '\n';

	it('takes the incoming file when there is none', () => {
		const incoming = file({ a: { command: 'a' } });
		expect(mergeMcpConfig(undefined, incoming)).toEqual({
			content: incoming,
			replaced: [],
			unchanged: false,
		});
	});

	it('adds servers and keeps the existing ones and other keys', () => {
		const merged = mergeMcpConfig(
			file({ mine: { command: 'm' } }, { note: 'kept' }),
			file({ theirs: { command: 't' } })
		);
		expect(JSON.parse(merged.content)).toEqual({
			note: 'kept',
			mcpServers: { mine: { command: 'm' }, theirs: { command: 't' } },
		});
		expect(merged.replaced).toEqual([]);
	});

	it('reports a same-named server that differs', () => {
		const merged = mergeMcpConfig(file({ a: { command: 'old' } }), file({ a: { command: 'new' } }));
		expect(merged.replaced).toEqual(['a']);
		expect(JSON.parse(merged.content).mcpServers.a.command).toBe('new');
	});

	it('keeps the existing bytes when nothing changes', () => {
		const existing = JSON.stringify({ mcpServers: { a: { command: 'a' } } });
		const merged = mergeMcpConfig(existing, file({ a: { command: 'a' } }));
		expect(merged).toEqual({ content: existing, replaced: [], unchanged: true });
	});
});

describe('resolveClaudeConfigDir and resolveClaudeAssetSelection', () => {
	it('prefers CLAUDE_CONFIG_DIR', () => {
		expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/opt/claude-work' })).toBe(
			path.resolve('/opt/claude-work')
		);
		expect(resolveClaudeConfigDir({})).toBe(path.join(os.homedir(), '.claude'));
	});

	it('turns every kind on unless switched off', () => {
		expect(resolveClaudeAssetSelection(undefined)).toEqual(ALL_CLAUDE_ASSETS);
		expect(resolveClaudeAssetSelection({ memory: false })).toEqual({
			skills: true,
			mcp: true,
			memory: false,
		});
	});
});

describe('collectClaudeAssets', () => {
	let tmp: string;
	let root: string;
	let configDir: string;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-claude-assets-')));
		root = path.join(tmp, 'proj');
		configDir = path.join(tmp, 'claude-config');
		fs.mkdirSync(root, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	function write(rel: string, content: string | Buffer, base = root): void {
		const file = path.join(base, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}

	const collect = (selection = ALL_CLAUDE_ASSETS) =>
		collectClaudeAssets({ root, key: 'proj', selection, claudeConfigDir: configDir });

	it('finds nothing in a workspace with no Claude assets', () => {
		expect(collect()).toEqual({ files: [], secrets: [], warnings: [] });
	});

	it('collects skills, the scrubbed MCP config, project memory and auto memory', () => {
		write('.claude/skills/review/SKILL.md', '---\nname: review\n---\nReview carefully.\n');
		write('.claude/skills/review/scripts/check.sh', '#!/bin/sh\necho ok\n');
		write('.claude/skills/review/logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
		write(
			'.mcp.json',
			JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp', env: { GH_TOKEN: GITHUB_PAT } } } })
		);
		write('CLAUDE.md', `# Project\nThe staging key is ${ANTHROPIC_KEY}.\n`);
		write('CLAUDE.local.md', 'personal notes');
		const memoryDir = claudeMemoryDir(configDir, root);
		write('MEMORY.md', '- [Build](build.md)\n', memoryDir);
		write('build.md', 'Run npm run build.\n', memoryDir);
		write('not memory.txt', 'ignored', memoryDir);

		const result = collect();
		const byPath = new Map(result.files.map((f) => [f.archivePath, f.content]));
		expect([...byPath.keys()].sort()).toEqual([
			'claude-memory/proj/MEMORY.md',
			'claude-memory/proj/build.md',
			'workspaces/proj/.claude/skills/review/SKILL.md',
			'workspaces/proj/.claude/skills/review/logo.png',
			'workspaces/proj/.claude/skills/review/scripts/check.sh',
			'workspaces/proj/.mcp.json',
			'workspaces/proj/CLAUDE.md',
		]);
		expect(byPath.get('workspaces/proj/CLAUDE.md')!.toString()).toContain(REDACTED);
		expect(byPath.get('workspaces/proj/CLAUDE.md')!.toString()).not.toContain(ANTHROPIC_KEY);
		expect(byPath.get('workspaces/proj/.mcp.json')!.toString()).not.toContain(GITHUB_PAT);
		expect(byPath.get('workspaces/proj/.claude/skills/review/logo.png')).toEqual(
			Buffer.from([0x89, 0x50, 0x00, 0x01])
		);
		expect(result.secrets).toEqual(['GH_TOKEN']);
		expect(result.assets).toEqual({
			skills: ['review'],
			mcpServers: ['gh'],
			projectMemory: ['CLAUDE.md'],
			autoMemory: ['MEMORY.md', 'build.md'],
		});
		expect(result.warnings.some((w) => w.includes('Redacted 1 secret-looking token'))).toBe(true);
	});

	it('includes only the kinds selected', () => {
		write('.claude/skills/a/SKILL.md', 'a');
		write('.mcp.json', JSON.stringify({ mcpServers: {} }));
		write('CLAUDE.md', 'memory');
		const result = collect({ skills: false, mcp: true, memory: false });
		expect(result.files.map((f) => f.archivePath)).toEqual(['workspaces/proj/.mcp.json']);
	});

	it('skips symlinks in skills and an unreadable .mcp.json, with warnings', () => {
		write('.claude/skills/a/SKILL.md', 'a');
		write('outside.txt', 'secret stuff', tmp);
		fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(root, '.claude/skills/a/link.txt'));
		write('.mcp.json', '{ not json');
		const result = collect();
		expect(result.files.map((f) => f.archivePath)).toEqual([
			'workspaces/proj/.claude/skills/a/SKILL.md',
		]);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining('symbolic link'),
				expect.stringContaining('.mcp.json was left out'),
			])
		);
	});
});
