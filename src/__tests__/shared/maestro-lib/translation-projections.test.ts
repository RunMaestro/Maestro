// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateUUID } from '../../../shared/uuid';
import {
	translationArtifact,
	translationHash,
} from '../../../shared/maestro-lib/translation/identity';
import {
	planResourceProjections,
	assertTranslationTarget,
} from '../../../shared/maestro-lib/translation/resource-projections';
import {
	bindTranslationKnowledge,
	TRANSLATION_KNOWLEDGE_ENV_VAR,
} from '../../../shared/maestro-lib/translation/knowledge-binding';
import { buildAgentLaunchPlan } from '../../../shared/maestro-lib/launch/launch-plan';

describe('native project discovery and shared launch binding', () => {
	it('reports native resources without staging them by default, even when a native file conflicts', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-opt-in-'));
		try {
			await fs.writeFile(path.join(root, 'AGENTS.md'), 'User-owned instructions');
			const resources = [
				translationArtifact(
					'instruction',
					'/source/CLAUDE.md',
					'CLAUDE.md',
					Buffer.from('Source instructions')
				),
				translationArtifact(
					'skill',
					'/source/SKILL.md',
					'.claude/skills/test/SKILL.md',
					Buffer.from('---\nname: test\n---\nSkill body')
				),
				translationArtifact(
					'subagent',
					'/source/reviewer.md',
					'.claude/agents/reviewer.md',
					Buffer.from('---\nname: reviewer\n---\nReview code')
				),
			];
			const result = await planResourceProjections(resources, {
				provider: 'codex',
				version: '0.162.1',
				accountRoot: '/isolated/codex',
				projectRoot: root,
			});
			expect(result.projections).toEqual([]);
			expect(result.limitations).toHaveLength(1);
			expect(result.limitations[0]).toMatchObject({
				code: 'resource-not-projected',
				severity: 'info',
			});
			for (const file of [
				'AGENTS.md',
				'.agents/skills/test/SKILL.md',
				'.codex/agents/reviewer.toml',
			])
				expect(result.limitations[0].message).toContain(file);
			expect(await fs.readdir(root)).toEqual(['AGENTS.md']);
			expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(
				'User-owned instructions'
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('rejects a file alias outside the selected root while permitting canonical aliases inside it', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-leaf-alias-'));
		try {
			const project = path.join(root, 'project');
			await fs.mkdir(project);
			const external = path.join(root, 'external.md');
			await fs.writeFile(external, 'unselected body');
			await fs.writeFile(path.join(project, 'CLAUDE.md'), 'project instructions');
			await fs.symlink(external, path.join(project, 'external-alias.md'));
			await fs.symlink('CLAUDE.md', path.join(project, 'AGENTS.md'));
			await expect(
				assertTranslationTarget(path.join(project, 'external-alias.md'), project)
			).rejects.toThrow('symlink');
			await expect(
				assertTranslationTarget(path.join(project, 'AGENTS.md'), project)
			).resolves.toBeUndefined();
			expect(await fs.readFile(external, 'utf8')).toBe('unselected body');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('skips all assets of an incompatible skill and retains owner execute for portable assets', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-assets-'));
		try {
			const header = translationArtifact(
				'skill',
				'/source/SKILL.md',
				'.claude/skills/test/SKILL.md',
				Buffer.from('---\nname: test\nallowed-tools: Read\n---\nBody.')
			);
			const script = {
				...translationArtifact(
					'skill',
					'/source/run.sh',
					'.claude/skills/test/run.sh',
					Buffer.from('echo test')
				),
				mode: 0o700,
			};
			const destination = {
				provider: 'codex' as const,
				version: '0.162.1',
				accountRoot: '/isolated/codex',
				projectRoot: root,
			};
			expect(
				(await planResourceProjections([script, header], destination, undefined, true)).projections
			).toHaveLength(0);
			expect(
				(await planResourceProjections([script], destination, undefined, true)).projections[0].mode
			).toBe(0o700);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('plans a native Codex definition without writing it or broadening tool restrictions', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-resource-'));
		try {
			const resource = translationArtifact(
				'subagent',
				path.join(root, 'reviewer.md'),
				'.claude/agents/reviewer.md',
				Buffer.from('---\nname: reviewer\ndescription: Review changes\n---\nReview selected code.')
			);
			const destination = {
				provider: 'codex' as const,
				version: '0.162.1',
				accountRoot: path.join(root, 'codex'),
				projectRoot: root,
			};
			const planned = await planResourceProjections([resource], destination, undefined, true);
			expect(planned.projections[0].path).toBe(path.join(root, '.codex/agents/reviewer.toml'));
			expect(Buffer.from(planned.projections[0].bytesBase64, 'base64').toString()).toContain(
				'developer_instructions'
			);
			await expect(fs.stat(planned.projections[0].path)).rejects.toMatchObject({ code: 'ENOENT' });
			const restricted = translationArtifact(
				'subagent',
				resource.sourcePath,
				resource.relativePath,
				Buffer.from('---\nname: reviewer\ntools: Read\n---\nRead only.')
			);
			expect(
				(await planResourceProjections([restricted], destination, undefined, true)).projections
			).toHaveLength(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('blocks a user-owned conflict instead of overwriting the native resource', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-conflict-'));
		try {
			const file = path.join(root, '.agents/skills/test/SKILL.md');
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, 'user-owned distinct body');
			const resource = translationArtifact(
				'skill',
				'/source/SKILL.md',
				'.claude/skills/test/SKILL.md',
				Buffer.from('---\nname: test\ndescription: Test\n---\nImported body.')
			);
			const plan = await planResourceProjections(
				[resource],
				{
					provider: 'codex',
					version: '0.162.1',
					accountRoot: '/isolated/codex',
					projectRoot: root,
				},
				undefined,
				true
			);
			expect(plan.limitations).toMatchObject([
				{ code: 'native-resource-conflict', severity: 'block' },
			]);
			expect(await fs.readFile(file, 'utf8')).toBe('user-owned distinct body');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('rejects a native directory symlink that escapes the project', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-symlink-'));
		try {
			const project = path.join(root, 'project');
			const external = path.join(root, 'external');
			await fs.mkdir(project);
			await fs.mkdir(external);
			await fs.symlink(external, path.join(project, '.agents'), 'dir');
			const resource = translationArtifact(
				'skill',
				'/source/SKILL.md',
				'.claude/skills/test/SKILL.md',
				Buffer.from('---\nname: test\n---\nBody.')
			);
			await expect(
				planResourceProjections(
					[resource],
					{
						provider: 'codex',
						version: '0.162.1',
						accountRoot: '/isolated/codex',
						projectRoot: project,
					},
					undefined,
					true
				)
			).rejects.toThrow('symlink');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it.each(['claude-code', 'codex'])(
		'delivers the selected knowledge on %s resume through the shared launch path',
		async (provider) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-launch-'));
			try {
				vi.stubEnv('MAESTRO_USER_DATA', root);
				const directory = path.join(
					root,
					'provider-knowledge',
					translationHash('agent'),
					generateUUID()
				);
				await fs.mkdir(directory, { recursive: true });
				await fs.writeFile(
					path.join(directory, 'knowledge-index.md'),
					'Read memory/MEMORY.md and its linked topics.'
				);
				const result = buildAgentLaunchPlan({
					surface: 'cli',
					agent: { id: provider },
					command: provider,
					args: ['--resume', 'native'],
					cwd: root,
					prompt: 'Recall the earlier fact.',
					sessionCustomEnvVars: { [TRANSLATION_KNOWLEDGE_ENV_VAR]: directory },
					// Acceptance and desktop inherit the host data directory; library callers may supply it.
					...(provider === 'claude-code' && {
						translationKnowledgeRoot: path.join(root, 'provider-knowledge'),
					}),
				});
				expect(result.ok).toBe(true);
				if (!result.ok) throw new Error(result.error);
				if (provider === 'claude-code') {
					expect(result.plan.args).toContain('--settings');
					expect(result.plan.args).toContain('--add-dir');
					expect(result.plan.args).toContain(directory);
					expect(result.plan.args).toContain(
						JSON.stringify({ autoMemoryDirectory: path.join(directory, 'memory') })
					);
				} else expect(result.plan.args).not.toContain('--add-dir');
				expect(result.plan.args.join(' ')).toContain('# User Request');
				expect(result.plan.args.join(' ')).toContain('Read memory/MEMORY.md');
				expect(() =>
					bindTranslationKnowledge('prompt', '/unmanaged', path.join(root, 'provider-knowledge'))
				).toThrow('Unsafe');
			} finally {
				vi.unstubAllEnvs();
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
});
