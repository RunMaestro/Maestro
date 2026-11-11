// @vitest-environment node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { translationArtifact } from '../../../shared/maestro-lib/translation/identity';
import {
	projectResourceDefinition,
	translationKnowledgePrompt,
	collectTranslationResources,
} from '../../../shared/maestro-lib/translation/resources';
import { resolveClaudeMemoryPath } from '../../../shared/maestro-lib/translation/memory';
import { planResourceProjections } from '../../../shared/maestro-lib/translation/resource-projections';
import { canonicalJson } from '../../../shared/canonicalJson';

describe('project resource translation', () => {
	it.each([false, true])(
		'reads resources through a project-root alias (managed: %s)',
		async (managed) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-root-alias-'));
			try {
				const project = path.join(root, 'project');
				const alias = path.join(root, 'alias');
				await fs.mkdir(path.join(project, '.agents/skills/example'), { recursive: true });
				await fs.writeFile(
					path.join(project, '.agents/skills/example/SKILL.md'),
					'Project instructions'
				);
				await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
				const resources = await collectTranslationResources(
					{
						provider: 'codex',
						version: '0.162.1',
						accountRoot: path.join(root, 'account'),
						projectRoot: alias,
					},
					{ projectKnowledge: true, selectedUserResources: [] },
					managed ? alias : undefined
				);
				expect(resources.artifacts.map((artifact) => artifact.relativePath)).toEqual([
					'.agents/skills/example/SKILL.md',
				]);
				expect(resources.limitations).not.toContainEqual(
					expect.objectContaining({ code: 'linked-user-resource' })
				);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it.each(['memory', 'selected-user/memories'])(
		'archives a managed %s directory link without importing unselected account knowledge',
		async (directory) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-memory-link-'));
			try {
				const managed = path.join(root, 'managed');
				const external = path.join(root, 'unselected');
				const link = path.join(managed, directory);
				await fs.mkdir(path.dirname(link), { recursive: true });
				await fs.mkdir(external);
				await fs.writeFile(path.join(external, 'private.md'), 'unselected account knowledge');
				await fs.symlink(external, link, 'dir');
				const resources = await collectTranslationResources(
					{
						provider: 'codex',
						version: '0.162.1',
						accountRoot: '/unselected/account',
						projectRoot: '/project',
					},
					{ projectKnowledge: true, selectedUserResources: [] },
					managed
				);
				expect(resources.artifacts).toHaveLength(1);
				expect(resources.artifacts[0].metadata?.directoryLink).toBe(true);
				expect(Buffer.from(resources.artifacts[0].bytesBase64, 'base64').toString()).toBe(external);
				expect(resources.limitations).toContainEqual(
					expect.objectContaining({ code: 'linked-user-resource' })
				);
				expect(JSON.stringify(resources)).not.toContain('unselected account knowledge');
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it('blocks a missing explicit resource instead of silently dropping it from the payload', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-selected-resource-'));
		try {
			const accountRoot = path.join(root, 'account');
			const resources = await collectTranslationResources(
				{
					provider: 'codex',
					version: '0.162.1',
					accountRoot,
					projectRoot: path.join(root, 'project'),
				},
				{
					projectKnowledge: true,
					selectedUserResources: [path.join(accountRoot, 'memories/missing.md')],
				}
			);
			expect(resources.artifacts).toHaveLength(0);
			expect(resources.limitations).toEqual([
				expect.objectContaining({ code: 'missing-selected-resource', severity: 'block' }),
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('archives a nested project file link without importing its unselected target', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-project-file-'));
		try {
			const projectRoot = path.join(root, 'project');
			const skill = path.join(projectRoot, '.agents/skills/test');
			const external = path.join(root, 'external.md');
			await fs.mkdir(skill, { recursive: true });
			await fs.writeFile(external, 'unselected private body');
			await fs.symlink(external, path.join(skill, 'reference.md'));
			const resources = await collectTranslationResources(
				{
					provider: 'codex',
					version: '0.162.1',
					accountRoot: path.join(root, 'account'),
					projectRoot,
				},
				{ projectKnowledge: true, selectedUserResources: [] }
			);
			expect(resources.artifacts).toHaveLength(1);
			expect(Buffer.from(resources.artifacts[0].bytesBase64, 'base64').toString()).toBe(external);
			expect(resources.artifacts[0].metadata?.directoryLink).toBe(true);
			expect(resources.limitations).toContainEqual(
				expect.objectContaining({ code: 'linked-resource-target' })
			);
			expect(JSON.stringify(resources)).not.toContain('unselected private body');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('blocks selected resource aliases that resolve outside an approved root', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'selected-resource-alias-'));
		try {
			const accountRoot = path.join(root, 'account');
			const skills = path.join(accountRoot, 'skills');
			const selected = path.join(skills, 'reference.md');
			await fs.mkdir(skills, { recursive: true });
			await fs.writeFile(path.join(accountRoot, 'auth.json'), 'unselected credential fixture');
			await fs.symlink(path.join(accountRoot, 'auth.json'), selected);
			const resources = await collectTranslationResources(
				{
					provider: 'codex',
					version: '0.162.1',
					accountRoot,
					projectRoot: path.join(root, 'project'),
				},
				{ projectKnowledge: true, selectedUserResources: [selected] }
			);
			expect(resources.artifacts).toHaveLength(0);
			expect(resources.limitations).toContainEqual(
				expect.objectContaining({ code: 'unsafe-resource-scope', severity: 'block' })
			);
			expect(JSON.stringify(resources)).not.toContain('unselected credential fixture');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('does not implicitly import user skills through a project directory link', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-user-skills-'));
		try {
			const project = path.join(root, 'project');
			const skills = path.join(root, 'user-skills');
			await fs.mkdir(path.join(project, '.agents'), { recursive: true });
			await fs.mkdir(path.join(skills, 'test'), { recursive: true });
			await fs.writeFile(path.join(skills, 'test/SKILL.md'), 'User-level body');
			await fs.symlink(skills, path.join(project, '.agents/skills'), 'dir');
			const resources = await collectTranslationResources(
				{
					provider: 'codex',
					version: '0.162.1',
					accountRoot: path.join(root, 'account'),
					projectRoot: project,
				},
				{ projectKnowledge: true, selectedUserResources: [] }
			);
			expect(resources.artifacts).toHaveLength(1);
			expect(resources.artifacts[0].metadata?.directoryLink).toBe(true);
			expect(resources.limitations).toContainEqual(
				expect.objectContaining({ code: 'linked-user-resource' })
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('finds newly authored managed memory topics without reading account-global knowledge', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-memory-'));
		try {
			await fs.mkdir(path.join(root, 'memory'));
			await fs.writeFile(path.join(root, 'memory/MEMORY.md'), '[new](new.md)');
			await fs.writeFile(path.join(root, 'memory/new.md'), 'new synthetic fact');
			const resources = await collectTranslationResources(
				{
					provider: 'codex',
					version: '0.162.1',
					accountRoot: '/unselected/provider-home',
					projectRoot: '/project',
				},
				{ projectKnowledge: true, selectedUserResources: [] },
				root
			);
			expect(resources.artifacts.map((a) => a.relativePath)).toEqual([
				'memory/MEMORY.md',
				'memory/new.md',
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('excludes shared account-memory overrides unless individual resources are selected', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'account-memory-'));
		try {
			const accountRoot = path.join(root, 'account');
			const projectRoot = path.join(root, 'project');
			const memory = path.join(root, 'shared');
			await Promise.all([accountRoot, projectRoot, memory].map((p) => fs.mkdir(p)));
			await fs.writeFile(
				path.join(accountRoot, 'settings.json'),
				JSON.stringify({ autoMemoryDirectory: memory })
			);
			await fs.writeFile(path.join(memory, 'unselected.md'), 'unrelated account knowledge');
			const resources = await collectTranslationResources(
				{ provider: 'claude-code', version: '2.1.296', accountRoot, projectRoot },
				{ projectKnowledge: true, selectedUserResources: [] }
			);
			expect(resources.artifacts).toHaveLength(0);
			expect(resources.limitations[0].code).toBe('account-memory-scope');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('resolves account and actual memory directory overrides', () => {
		expect(resolveClaudeMemoryPath('/project/worktree', '/selected/account')).toBe(
			path.join('/selected/account', 'projects', '-project-worktree', 'memory')
		);
		expect(resolveClaudeMemoryPath('/project/worktree', '/selected/account', 'knowledge')).toBe(
			path.resolve('/project/worktree', 'knowledge')
		);
	});
	it('translates Markdown definitions into TOML and retains incompatible settings', () => {
		const artifact = translationArtifact(
			'subagent',
			'/project/.claude/agents/reviewer.md',
			'agents/reviewer.md',
			Buffer.from(
				'---\nname: reviewer\ndescription: Review code\nmodel: opus\nhooks:\n  Stop: []\n---\nReview exactly the selected changes.\n'
			)
		);
		const result = projectResourceDefinition(artifact, 'codex');
		expect(result.body).toContain('name = "reviewer"');
		expect(result.body).toContain('developer_instructions = ');
		expect(result.metadata.model).toBe('opus');
		expect(
			result.limitations.filter((l) => l.code === 'resource-execution-semantics')
		).toHaveLength(2);
	});
	it('binds exact memory topics and skill assets without editing global summaries', () => {
		const artifacts = [
			translationArtifact(
				'memory',
				'/source/MEMORY.md',
				'memory/MEMORY.md',
				Buffer.from('[topic](topic.md)')
			),
			translationArtifact(
				'memory',
				'/source/topic.md',
				'memory/topic.md',
				Buffer.from('synthetic fact')
			),
		];
		const prompt = translationKnowledgePrompt('/project/.maestro/knowledge', artifacts);
		expect(prompt).toContain(path.join('/project/.maestro/knowledge', 'memory', 'MEMORY.md'));
		expect(prompt).toContain(path.join('/project/.maestro/knowledge', 'memory', 'topic.md'));
		expect(prompt).not.toContain('memory_summary.md');
	});
	it('refuses TOML definitions without portable instructions', () => {
		const artifact = translationArtifact(
			'subagent',
			'/source/reviewer.toml',
			'agents/reviewer.toml',
			Buffer.from('name = "reviewer"')
		);
		expect(projectResourceDefinition(artifact, 'claude-code').limitations[0].code).toBe(
			'missing-subagent-instructions'
		);
	});
	// #2018: a dated skill in ~/.agents/skills made every provider switch fail.
	it('keeps YAML frontmatter dates as text so the plan can be fingerprinted', () => {
		const artifact = translationArtifact(
			'skill',
			'/home/.agents/skills/dated/SKILL.md',
			'skills/dated/SKILL.md',
			Buffer.from(
				'---\nname: dated\ndescription: d\nlast_updated: 2025-11-03\nscore: .nan\n---\nbody\n'
			)
		);
		const { metadata } = projectResourceDefinition(artifact, 'codex');
		expect(metadata.last_updated).toBe('2025-11-03');
		expect(metadata.score).toBeNull();
		expect(() => canonicalJson(metadata)).not.toThrow();
	});
	it('writes TOML datetimes as text so the plan can be fingerprinted', () => {
		const artifact = translationArtifact(
			'subagent',
			'/source/reviewer.toml',
			'agents/reviewer.toml',
			Buffer.from('name = "reviewer"\ndeveloper_instructions = "Review."\ncreated = 2025-11-03\n')
		);
		const { metadata } = projectResourceDefinition(artifact, 'claude-code');
		expect(metadata.created).toBe('2025-11-03');
		expect(() => canonicalJson(metadata)).not.toThrow();
	});
});

// Sanitized Grok project fixtures: temp folders, synthetic text only.
describe('Grok project resource translation', () => {
	const grokVersion = '1.0.70';
	it('collects Grok skills, reports unpinned rules and agents, and keeps account files out', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-grok-resources-'));
		try {
			const projectRoot = path.join(root, 'project');
			const accountRoot = path.join(root, 'grok-home');
			await fs.mkdir(path.join(projectRoot, '.grok/skills/lint'), { recursive: true });
			await fs.mkdir(path.join(projectRoot, '.grok/rules/nested'), { recursive: true });
			await fs.mkdir(path.join(projectRoot, '.grok/agents'), { recursive: true });
			await fs.mkdir(path.join(accountRoot, 'agents'), { recursive: true });
			await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'Project rules');
			await fs.writeFile(
				path.join(projectRoot, '.grok/skills/lint/SKILL.md'),
				'---\nname: lint\ndescription: Lint it\n---\nRun the linter.'
			);
			await fs.writeFile(path.join(projectRoot, '.grok/rules/a.md'), 'SYNTHETIC-RULE-A');
			await fs.writeFile(path.join(projectRoot, '.grok/rules/nested/b.md'), 'SYNTHETIC-RULE-B');
			await fs.writeFile(path.join(projectRoot, '.grok/agents/helper.md'), 'SYNTHETIC-AGENT');
			await fs.writeFile(path.join(accountRoot, 'auth.json'), 'SYNTHETIC-CREDENTIAL');
			await fs.writeFile(path.join(accountRoot, 'config.toml'), 'SYNTHETIC-CONFIG');
			await fs.writeFile(path.join(accountRoot, 'agents/mine.md'), 'SYNTHETIC-USER-AGENT');
			const resources = await collectTranslationResources(
				{ provider: 'grok', version: grokVersion, accountRoot, projectRoot },
				{
					projectKnowledge: true,
					selectedUserResources: [
						path.join(accountRoot, 'auth.json'),
						path.join(accountRoot, 'config.toml'),
						path.join(accountRoot, 'agents/mine.md'),
					],
				}
			);
			expect(resources.artifacts.map((a) => a.relativePath).sort()).toEqual([
				'.grok/skills/lint/SKILL.md',
				'AGENTS.md',
			]);
			const byCode = (code: string) => resources.limitations.filter((l) => l.code === code);
			expect(byCode('unsafe-resource-scope')).toHaveLength(2);
			expect(byCode('unsafe-resource-scope').every((l) => l.severity === 'block')).toBe(true);
			expect(byCode('grok-rules-unsupported')).toEqual([
				expect.objectContaining({
					severity: 'warning',
					message: expect.stringContaining('2 rule'),
				}),
			]);
			expect(
				byCode('subagent-discovery-unpinned')
					.map((l) => l.severity)
					.sort()
			).toEqual(['block', 'warning']);
			const serialized = JSON.stringify(resources);
			for (const secret of [
				'SYNTHETIC-CREDENTIAL',
				'SYNTHETIC-CONFIG',
				'SYNTHETIC-RULE-A',
				'SYNTHETIC-RULE-B',
				'SYNTHETIC-AGENT',
				'SYNTHETIC-USER-AGENT',
			]) {
				expect(serialized).not.toContain(secret);
				expect(serialized).not.toContain(Buffer.from(secret).toString('base64'));
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('plans Grok destination resources without aliases, enforcement claims or subagents', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-grok-projection-'));
		try {
			const projectRoot = path.join(root, 'project');
			await fs.mkdir(projectRoot);
			const destination = {
				provider: 'grok' as const,
				version: grokVersion,
				accountRoot: path.join(root, 'grok-home'),
				projectRoot,
			};
			const artifact = (
				kind: Parameters<typeof translationArtifact>[0],
				relativePath: string,
				text: string,
				scope: Parameters<typeof translationArtifact>[4] = 'project'
			) =>
				translationArtifact(
					kind,
					`/source/${relativePath}`,
					relativePath,
					Buffer.from(text),
					scope
				);
			const resources = [
				artifact('instruction', 'CLAUDE.md', 'Shared rules'),
				artifact(
					'skill',
					'.claude/skills/lint/SKILL.md',
					'---\nname: lint\ndescription: L\n---\nLint.'
				),
				artifact('skill', '.claude/skills/lint/run.sh', 'echo lint'),
				artifact(
					'skill',
					'.claude/skills/guarded/SKILL.md',
					'---\nname: guarded\nallowed-tools: Bash\n---\nRestricted.'
				),
				artifact('skill', '.claude/skills/guarded/asset.txt', 'SYNTHETIC-GUARDED-ASSET'),
				artifact('subagent', '.claude/agents/reviewer.md', '---\nname: reviewer\n---\nReview.'),
				artifact(
					'subagent',
					'selected-user/agents/mine.md',
					'---\nname: mine\n---\nMine.',
					'selected-user'
				),
			];
			const { projections, limitations } = await planResourceProjections(resources, destination);
			expect(
				projections.map((p) => path.relative(projectRoot, p.path).replace(/\\/g, '/')).sort()
			).toEqual(['.agents/skills/lint/SKILL.md', '.agents/skills/lint/run.sh', 'CLAUDE.md']);
			expect(projections.every((p) => !p.symlinkTarget)).toBe(true);
			expect(JSON.stringify(projections)).not.toContain(
				Buffer.from('SYNTHETIC-GUARDED-ASSET').toString('base64')
			);
			expect(
				limitations
					.filter((l) => l.code === 'subagent-discovery-unpinned')
					.map((l) => l.severity)
					.sort()
			).toEqual(['block', 'warning']);
			expect(limitations).toContainEqual(
				expect.objectContaining({ code: 'grok-resource-discovery-unverified', severity: 'warning' })
			);
			// Planning writes nothing.
			expect(await fs.readdir(projectRoot)).toEqual([]);

			// An `.agents` link out of the project is refused before any write is planned.
			const outside = path.join(root, 'outside');
			await fs.mkdir(outside);
			await fs.symlink(outside, path.join(projectRoot, '.agents'), 'dir');
			await expect(planResourceProjections(resources, destination)).rejects.toThrow('symlink');
			expect(await fs.readdir(outside)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
