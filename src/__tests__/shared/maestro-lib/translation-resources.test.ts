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
});
