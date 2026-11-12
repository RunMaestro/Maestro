/**
 * @file Unit tests for the per-agent ephemeral MCP-config adapters: each strategy
 * produces the right globalArgs / env / temp files, and the agent map marks the
 * installed CLIs verified and the rest best-guess.
 */
import { describe, it, expect } from 'vitest';
import {
	buildMcpInjection,
	MCP_CONFIG_BY_AGENT,
	MCP_SERVER_NAME,
	type McpServerSpec,
} from '../../../shared/plugins/mcp-agent-config';

const spec: McpServerSpec = {
	command: '/bin/electron',
	args: ['/cli.js', 'mcp', 'serve', '--tab', 't1'],
	env: { ELECTRON_RUN_AS_NODE: '1' },
};
const opts = { tmpDir: '/tmp', join: (...p: string[]) => p.join('/') };

describe('buildMcpInjection - claude-mcp-config', () => {
	it('emits inline --mcp-config JSON (additive, no --strict, no temp files)', () => {
		const inj = buildMcpInjection({ strategy: 'claude-mcp-config', verified: true }, spec, opts);
		expect(inj.files).toEqual([]);
		expect(inj.env).toEqual({});
		expect(inj.globalArgs[0]).toBe('--mcp-config');
		expect(inj.globalArgs).toHaveLength(2);
		expect(JSON.parse(inj.globalArgs[1])).toEqual({
			mcpServers: { [MCP_SERVER_NAME]: { command: spec.command, args: spec.args, env: spec.env } },
		});
	});
});

describe('buildMcpInjection - codex-config-override', () => {
	it('emits -c mcp_servers overrides with TOML-encoded values, no files', () => {
		const inj = buildMcpInjection(
			{ strategy: 'codex-config-override', verified: true },
			spec,
			opts
		);
		expect(inj.files).toEqual([]);
		expect(inj.env).toEqual({});
		expect(inj.globalArgs).toContain(
			`mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(spec.command)}`
		);
		expect(inj.globalArgs).toContain(
			`mcp_servers.${MCP_SERVER_NAME}.args=["/cli.js", "mcp", "serve", "--tab", "t1"]`
		);
		expect(inj.globalArgs.some((a) => a.startsWith(`mcp_servers.${MCP_SERVER_NAME}.env=`))).toBe(
			true
		);
	});

	it('omits the env override when the spec carries no env', () => {
		const inj = buildMcpInjection(
			{ strategy: 'codex-config-override', verified: true },
			{ command: 'codex', args: [] },
			opts
		);
		expect(inj.globalArgs.some((a) => a.includes('.env='))).toBe(false);
	});
});

describe('buildMcpInjection - opencode-env-config', () => {
	it('writes a temp opencode.json and points OPENCODE_CONFIG at it', () => {
		const inj = buildMcpInjection(
			{
				strategy: 'opencode-env-config',
				verified: true,
				envVar: 'OPENCODE_CONFIG',
				fileName: 'oc.json',
			},
			spec,
			opts
		);
		expect(inj.globalArgs).toEqual([]);
		expect(inj.env).toEqual({ OPENCODE_CONFIG: '/tmp/oc.json' });
		expect(inj.files).toHaveLength(1);
		expect(inj.files[0].path).toBe('/tmp/oc.json');
		const cfg = JSON.parse(inj.files[0].content);
		expect(cfg.mcp[MCP_SERVER_NAME]).toMatchObject({
			type: 'local',
			command: [spec.command, ...spec.args],
			environment: spec.env,
			enabled: true,
		});
	});
});

describe('buildMcpInjection - mcp-json-file', () => {
	it('writes a { mcpServers } file and sets env when an envVar is given', () => {
		const inj = buildMcpInjection(
			{ strategy: 'mcp-json-file', verified: false, envVar: 'X_CFG', fileName: 'x.json' },
			spec,
			opts
		);
		expect(inj.env).toEqual({ X_CFG: '/tmp/x.json' });
		expect(JSON.parse(inj.files[0].content)).toEqual({
			mcpServers: { [MCP_SERVER_NAME]: { command: spec.command, args: spec.args, env: spec.env } },
		});
	});

	it('writes the file but sets no env when no envVar is given', () => {
		const inj = buildMcpInjection(
			{ strategy: 'mcp-json-file', verified: false, fileName: 'x.json' },
			spec,
			opts
		);
		expect(inj.env).toEqual({});
		expect(inj.files).toHaveLength(1);
	});
});

describe('MCP_CONFIG_BY_AGENT', () => {
	it('marks the auto-injected installed CLIs (claude, codex) verified', () => {
		expect(MCP_CONFIG_BY_AGENT['claude-code'].verified).toBe(true);
		expect(MCP_CONFIG_BY_AGENT.codex.verified).toBe(true);
	});

	it('marks the other agents as best-guess (unverified)', () => {
		for (const id of [
			'opencode',
			'gemini-cli',
			'qwen3-coder',
			'copilot-cli',
			'factory-droid',
			'hermes',
			'pi',
		]) {
			expect(MCP_CONFIG_BY_AGENT[id].verified).toBe(false);
		}
	});
});
