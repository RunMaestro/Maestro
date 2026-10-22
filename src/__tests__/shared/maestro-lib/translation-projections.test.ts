// @vitest-environment node
import { describe, it, expect } from 'vitest';
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
				(await planResourceProjections([script, header], destination)).projections
			).toHaveLength(0);
			expect((await planResourceProjections([script], destination)).projections[0].mode).toBe(
				0o700
			);
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
			const planned = await planResourceProjections([resource], destination);
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
			expect((await planResourceProjections([restricted], destination)).projections).toHaveLength(
				0
			);
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
			const plan = await planResourceProjections([resource], {
				provider: 'codex',
				version: '0.162.1',
				accountRoot: '/isolated/codex',
				projectRoot: root,
			});
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
				planResourceProjections([resource], {
					provider: 'codex',
					version: '0.162.1',
					accountRoot: '/isolated/codex',
					projectRoot: project,
				})
			).rejects.toThrow('symlink');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it('delivers the selected knowledge on native resume through the shared launch path', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-launch-'));
		try {
			const directory = path.join(
				root,
				'.maestro/provider-knowledge',
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
				agent: { id: 'claude-code' },
				command: 'claude',
				args: ['--resume', 'native'],
				cwd: root,
				prompt: 'Recall the earlier fact.',
				sessionCustomEnvVars: { [TRANSLATION_KNOWLEDGE_ENV_VAR]: directory },
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.error);
			expect(result.plan.args).toContain('--settings');
			expect(result.plan.args.some((arg) => arg.includes('autoMemoryDirectory'))).toBe(true);
			expect(result.plan.args.join(' ')).toContain('# User Request');
			expect(result.plan.args.join(' ')).toContain('Read memory/MEMORY.md');
			expect(() => bindTranslationKnowledge('prompt', '/unmanaged')).toThrow('Unsafe');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
