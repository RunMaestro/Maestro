// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentRepository } from '../../../shared/maestro-lib/agents/repository';
import { createEventBus } from '../../../shared/maestro-lib/client/event-bus';
import { resolveMaestroPaths } from '../../../shared/maestro-lib/paths/resolve';
import { createProcessRegistry } from '../../../shared/maestro-lib/runtime/processes';
import { createRuntimeTranslationService } from '../../../shared/maestro-lib/runtime/translation';
import { createRuntimeTurns } from '../../../shared/maestro-lib/runtime/turns';
import type { ProviderMigrationState } from '../../../shared/maestro-lib/translation/types';
import type { AssembledTurn } from '../../../shared/maestro-lib/turns/assemble';
import { canonicalJson } from '../../../shared/canonicalJson';
import { findCodexSessionFile } from '../../../shared/maestro-lib/codex/session-files';

vi.mock('../../../shared/maestro-lib/turns/provider-binary', () => ({
	locateProviderBinary: vi.fn(async (definition) => `/synthetic/${definition.binaryName}`),
}));
vi.mock('../../../shared/maestro-lib/launch/exec-file', async (original) => ({
	...(await original<typeof import('../../../shared/maestro-lib/launch/exec-file')>()),
	execFileNoThrow: vi.fn(async (binary: string) =>
		binary === 'git'
			? { exitCode: 128, stdout: '', stderr: 'not a git repository' }
			: { exitCode: 0, stdout: binary.includes('codex') ? '0.162.1' : '2.1.296', stderr: '' }
	),
}));

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('headless translate at send', () => {
	it('preserves an unknown persisted tab provider and refuses native translation', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-tab-provider-'));
		roots.push(root);
		const paths = resolveMaestroPaths({
			env: { MAESTRO_USER_DATA: root },
			productionDataPath: root,
		});
		const stored = {
			sessions: [
				{
					id: 'agent',
					name: 'Test',
					toolType: 'claude-code',
					cwd: root,
					aiTabs: [{ id: 'tab', agentSessionId: 'native', tabProvider: 'future-provider' }],
				},
			],
		};
		await fs.writeFile(paths.sessionsFile, JSON.stringify(stored));
		const bus = createEventBus('test');
		const registry = createProcessRegistry();
		const repository = createAgentRepository({ paths, bus, processes: registry });
		expect(await repository.load()).toEqual({ ok: true });
		const service = createRuntimeTranslationService(paths, repository, registry);
		const report = await service.run({
			agentId: 'agent',
			tabId: 'tab',
			destination: 'codex',
			action: 'plan',
		});
		expect(report.success).toBe(false);
		expect(report.error).toContain('Unknown tab provider: future-provider');
		expect(repository.getTab('agent', 'tab')?.tabProvider).toBe('future-provider');
		expect(JSON.parse(await fs.readFile(paths.sessionsFile, 'utf8'))).toEqual(stored);
	});

	it('holds warnings, then uses the shared native transaction and resumes its output', async () => {
		const root = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-translation-'))
		);
		roots.push(root);
		const paths = resolveMaestroPaths({
			env: { MAESTRO_USER_DATA: root },
			productionDataPath: root,
		});
		expect(paths.userDataDir).toBe(root);
		expect(paths.syncDir).toBe(root);
		const project = path.join(root, 'project');
		const codexRoot = path.join(root, 'codex');
		const claudeRoot = path.join(root, 'claude');
		const nativeDir = path.join(codexRoot, 'sessions/2026/10/17');
		await fs.mkdir(nativeDir, { recursive: true });
		await fs.mkdir(project, { recursive: true });
		await fs.mkdir(claudeRoot, { recursive: true });
		const native =
			[
				{ type: 'session_meta', payload: { id: 'source', cwd: project } },
				{
					type: 'response_item',
					payload: {
						type: 'message',
						id: 'user-1',
						role: 'user',
						content: [{ type: 'input_text', text: 'Retain every byte of context.' }],
					},
				},
			]
				.map((row) => JSON.stringify(row))
				.join('\n') + '\n';
		const sourceFile = path.join(nativeDir, 'source.jsonl');
		await fs.writeFile(sourceFile, native);
		await fs.writeFile(
			paths.agentConfigsFile,
			JSON.stringify({
				configs: {
					codex: { customEnvVars: { CODEX_HOME: codexRoot } },
					'claude-code': { customEnvVars: { CLAUDE_CONFIG_DIR: claudeRoot } },
				},
			})
		);
		await fs.writeFile(
			paths.sessionsFile,
			JSON.stringify({
				sessions: [
					{
						id: 'agent',
						name: 'Test',
						toolType: 'claude-code',
						cwd: project,
						customModel: 'captured-model',
						customEffort: 'high',
						activeTabId: 'tab',
						aiTabs: [
							{
								id: 'tab',
								agentSessionId: null,
								providerSessions: { codex: { agentSessionId: 'source' } },
								logs: [{ source: 'user', text: 'Visible context' }],
							},
						],
					},
				],
			})
		);
		const bus = createEventBus('test');
		const registry = createProcessRegistry();
		const repository = createAgentRepository({ paths, bus, processes: registry });
		expect(await repository.load()).toEqual({ ok: true });
		const runAgentTurn = vi.fn(async (_turn: AssembledTurn) => ({
			ok: false as const,
			reason: 'launch' as const,
			message: 'Synthetic stop before a real process can start',
		}));
		const options = {
			paths,
			repository,
			bus,
			registry,
			fence: () => ({ ok: true as const }),
			deps: { runAgentTurn },
		};
		const held = createRuntimeTurns(options);
		try {
			const sent = await held.api.send('agent', 'tab', { text: 'Held message stays intact' });
			expect(sent.ok).toBe(false);
			expect(runAgentTurn).not.toHaveBeenCalled();
			expect(await held.api.queue.list('agent')).toMatchObject({
				ok: true,
				value: [{ text: 'Held message stays intact', paused: true }],
			});
			expect(repository.getTab('agent', 'tab')?.logs).toHaveLength(1);
		} finally {
			held.dispose();
		}

		const service = createRuntimeTranslationService(paths, repository, registry);
		expect(await findCodexSessionFile('source', codexRoot)).toBe(sourceFile);
		const planned = await service.run({
			agentId: 'agent',
			tabId: 'tab',
			destination: 'claude-code',
			action: 'plan',
		});
		expect(planned.plan?.status, JSON.stringify(planned.plan?.limitations ?? planned.error)).toBe(
			'ready'
		);
		const plan = planned.plan!;
		await repository.updateTranslation('agent', (agent) => ({
			...agent,
			providerMigration: {
				operationId: 'previous',
				destination: 'claude-code',
				state: 'committed',
				verification: 'unverified',
				acceptedDirections: [
					{
						source: plan.source.provider,
						destination: plan.destination.provider,
						sourceVersion: plan.source.version,
						destinationVersion: plan.destination.version,
						warnings: plan.limitations.filter((l) => l.severity === 'warning').map(canonicalJson),
					},
				],
			} satisfies ProviderMigrationState,
		}));
		const ready = createRuntimeTurns(options);
		try {
			const sent = await ready.api.send('agent', 'tab', { text: 'Continue the same context' });
			expect(runAgentTurn, JSON.stringify(sent)).toHaveBeenCalledTimes(1);
			const turn = runAgentTurn.mock.calls[0][0];
			const tab = repository.getTab('agent', 'tab')!;
			expect(turn.resumeSessionId).toBe(tab.agentSessionId);
			expect(turn.resumeSessionId).toBeTruthy();
			expect(turn.launch.args).toEqual(expect.arrayContaining(['--resume', turn.resumeSessionId]));
			expect(turn.settings).toEqual({
				provider: 'claude-code',
				model: 'captured-model',
				effort: 'high',
			});
			expect(tab.providerSessions).toMatchObject({ codex: { agentSessionId: 'source' } });
			expect(tab.logs).toHaveLength(2);
			expect(tab.logs?.[1]).toMatchObject({
				contextTranslation: {
					source: { provider: 'codex' },
					destination: { provider: 'claude-code' },
				},
			});
			expect(await fs.readFile(sourceFile, 'utf8')).toBe(native);
			expect(
				(repository.getAgent('agent')!.providerMigration as ProviderMigrationState)
					.acceptedDirections
			).toHaveLength(1);
		} finally {
			ready.dispose();
		}
	});
});
