// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { spawnAgent } from '../../../cli/services/agent-spawner';

vi.mock('../../../cli/services/storage', () => ({
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSshRemotes: () => [],
	readSettings: () => ({}),
}));
vi.mock('../../../cli/services/wakatime', () => ({ buildCliWakaTimeHeartbeat: () => undefined }));
vi.mock('../../../shared/plugins/headless-agent-timeouts', async (original) => ({
	...(await original<typeof import('../../../shared/plugins/headless-agent-timeouts')>()),
	CODEX_STARTUP_TIMEOUT_MS: 700,
	HEADLESS_RUN_TIMEOUT_MS: 5_000,
	HEADLESS_IDLE_PROFILE: { warnMs: 800, idleMs: 1_200, toolMs: 2_000 },
}));

describe.skipIf(process.platform !== 'linux')(
	'real standalone CLI Codex auth/MCP lifecycle',
	() => {
		it.each(['startup', 'after-model', 'mcp-tool'] as const)(
			'bounds %s without caller-supplied timeouts',
			async (phase) => {
				const root = resolve('.maestro/auth-mcp-port-20261028/test-tmp');
				mkdirSync(root, { recursive: true });
				const dir = mkdtempSync(join(root, 'auth-cli-'));
				const pids = join(dir, 'pids.json');
				const controller = new AbortController();
				const run = spawnAgent('codex', dir, 'fixture', undefined, {
					agentCommand: resolve('src/__tests__/fixtures/process-lifecycle/codex-auth-stall.cjs'),
					agentConfigValues: {},
					globalEnvVars: {},
					signal: controller.signal,
					customArgs: `--fixture-phase=${phase} --fixture-pids=${pids}`,
				});
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const result = await Promise.race([
						run,
						new Promise<undefined>((resolve) => {
							timer = setTimeout(() => resolve(undefined), 4_000);
						}),
					]);
					expect(result, 'standalone CLI must settle after startup too').toBeDefined();
					expect(result?.success).toBe(false);
					expect(result?.outcome).toBe('crashed');
					expect(result?.error).toMatch(
						phase === 'startup'
							? /Startup or authentication/
							: phase === 'mcp-tool'
								? /tool or wait budget/
								: /semantic inactivity/
					);
					const { mcp } = JSON.parse(readFileSync(pids, 'utf8')) as { mcp: number };
					await vi.waitFor(
						() => {
							let state = '';
							try {
								state = readFileSync(`/proc/${mcp}/stat`, 'utf8').split(') ')[1][0];
							} catch {
								/* reaped */
							}
							expect(['', 'Z']).toContain(state);
						},
						{ timeout: 2_000 }
					);
				} finally {
					clearTimeout(timer);
					controller.abort();
					await run;
					rmSync(dir, { recursive: true, force: true });
				}
			}
		);
		it('returns the normal result from a completed turn', async () => {
			const result = await spawnAgent('codex', process.cwd(), 'fixture', undefined, {
				agentCommand: resolve('src/__tests__/fixtures/process-lifecycle/codex-auth-stall.cjs'),
				agentConfigValues: {},
				globalEnvVars: {},
				customArgs: '--fixture-phase=success',
			});
			expect(result).toMatchObject({ success: true, response: 'Done' });
		});
	}
);
