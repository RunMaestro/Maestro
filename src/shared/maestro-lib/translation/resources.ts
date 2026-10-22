import { canonicalJson } from '../../canonicalJson';
import { isPathAtOrUnderRoot } from '../../worktreePaths';
import type { TranslationFs } from './fs-port';
import { localTranslationFs } from './local-fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { translationArtifact, translationHash } from './identity';
import { discoverClaudeMemoryRoot } from './memory';
import type {
	TranslationArtifact,
	TranslationIdentity,
	TranslationLimitation,
	TranslationScope,
} from './types';

export interface TranslationResources {
	artifacts: TranslationArtifact[];
	limitations: TranslationLimitation[];
}

async function resolveResourceRoot(root: string, nativeFs: TranslationFs): Promise<string> {
	const paths = nativeFs?.paths ?? path;
	try {
		return await nativeFs.realpath(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return paths.resolve(root);
	}
}

/** Capture only project knowledge and explicitly selected resources, never whole provider homes. */
export async function collectTranslationResources(
	identity: TranslationIdentity,
	scope: TranslationScope,
	managedDirectory?: string,
	nativeFs: TranslationFs = localTranslationFs
): Promise<TranslationResources> {
	const paths = nativeFs?.paths ?? path;
	const projectRoot = managedDirectory ?? identity.projectRoot;
	const realProjectRoot = await resolveResourceRoot(projectRoot, nativeFs);
	const realAccountRoot = await resolveResourceRoot(identity.accountRoot, nativeFs);
	const artifacts: TranslationArtifact[] = [];
	const limitations: TranslationLimitation[] = [];
	const seen = new Map<string, string>();
	const roots: Array<{
		file: string;
		kind: TranslationArtifact['kind'];
		scope: TranslationArtifact['scope'];
		prefix: string;
		allowedRoot?: string;
	}> = [
		...['CLAUDE.md', 'AGENTS.md'].map((name) => ({
			file: paths.join(projectRoot, name),
			kind: 'instruction' as const,
			scope: 'project' as const,
			prefix: name,
		})),
		...['.claude/skills', '.agents/skills', '.codex/skills'].map((name) => ({
			file: paths.join(projectRoot, name),
			kind: 'skill' as const,
			scope: 'project' as const,
			prefix: name,
		})),
		...['.claude/agents', '.codex/agents'].map((name) => ({
			file: paths.join(projectRoot, name),
			kind: 'subagent' as const,
			scope: 'project' as const,
			prefix: name,
		})),
	];
	for (const name of ['.claude/agent-memory', '.claude/agent-memory-local'])
		roots.push({
			file: paths.join(projectRoot, name),
			kind: 'memory',
			scope: 'project',
			prefix: name,
		});
	if (managedDirectory) {
		roots.push({
			file: paths.join(managedDirectory, 'memory'),
			kind: 'memory',
			scope: 'project',
			prefix: 'memory',
		});
		for (const [prefix, kind] of [
			['selected-user/skills', 'skill'],
			['selected-user/agents', 'subagent'],
			['selected-user/memories', 'memory'],
		] as const)
			roots.push({
				file: paths.join(managedDirectory, prefix),
				kind,
				scope: 'selected-user',
				prefix,
			});
	} else if (identity.provider === 'claude-code') {
		const memory = await discoverClaudeMemoryRoot(
			identity.projectRoot,
			identity.accountRoot,
			identity.memoryProjectRoot,
			nativeFs,
			identity.remoteHome
		);
		if (memory.source === 'account')
			limitations.push({
				code: 'account-memory-scope',
				severity: 'warning',
				message:
					'Account-level autoMemoryDirectory is shared knowledge. Select individual user resources to include it; account-wide memory is excluded by default.',
			});
		else roots.push({ file: memory.path, kind: 'memory', scope: 'project', prefix: 'memory' });
	}
	for (const file of managedDirectory ? [] : scope.selectedUserResources) {
		const relative = paths.relative(identity.accountRoot, file).split(paths.sep).join('/');
		const approved = identity.userResourceRoots?.find(
			(root) =>
				isPathAtOrUnderRoot(
					paths.resolve(file).split(paths.sep).join('/'),
					paths.resolve(root.path).split(paths.sep).join('/')
				) && paths.resolve(file) !== paths.resolve(root.path)
		);
		const kind =
			approved?.kind ??
			(relative.startsWith('skills/')
				? 'skill'
				: relative.startsWith('agents/')
					? 'subagent'
					: relative.startsWith('memories/') || relative.startsWith('agent-memory/')
						? 'memory'
						: relative === 'CLAUDE.md' || relative === 'AGENTS.md'
							? 'instruction'
							: null);
		if (
			!kind ||
			!paths.isAbsolute(file) ||
			(!approved && relative.startsWith('../')) ||
			relative.endsWith('memory_summary.md')
		) {
			limitations.push({
				code: 'unsafe-resource-scope',
				severity: 'block',
				message:
					'Select individual instruction, memory, skill, or subagent resources inside the source account or host-approved skill roots. Global summaries and account settings are excluded.',
			});
			continue;
		}

		const category =
			kind === 'memory'
				? 'memories'
				: kind === 'subagent'
					? 'agents'
					: kind === 'instruction'
						? 'instructions'
						: 'skills';
		roots.push({
			file,
			kind,
			scope: 'selected-user',
			allowedRoot: approved?.path ?? paths.join(identity.accountRoot, relative.split('/')[0]),
			prefix: approved
				? `selected-user/${category}/${paths.relative(approved.path, file).split(paths.sep).join('/')}`
				: `selected-user/${relative}`,
		});
	}
	for (const root of roots) {
		let stat;
		try {
			stat = await nativeFs.stat(root.file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				if (root.allowedRoot)
					limitations.push({
						code: 'missing-selected-resource',
						severity: 'block',
						message: `Explicitly selected resource ${root.prefix} is missing or its link target is unavailable.`,
					});
				continue;
			}
			throw error;
		}
		const realRoot = await nativeFs.realpath(root.file);
		if (
			root.allowedRoot &&
			!isPathAtOrUnderRoot(
				realRoot.split(paths.sep).join('/'),
				(await resolveResourceRoot(root.allowedRoot, nativeFs)).split(paths.sep).join('/')
			)
		) {
			limitations.push({
				code: 'unsafe-resource-scope',
				severity: 'block',
				message: `Selected resource ${root.prefix} resolves outside its approved resource root. Select the intended target explicitly.`,
			});
			continue;
		}
		if (
			stat.isDirectory() &&
			isPathAtOrUnderRoot(
				realAccountRoot.split(paths.sep).join('/'),
				realRoot.split(paths.sep).join('/')
			)
		) {
			limitations.push({
				code: 'unsafe-resource-scope',
				severity: 'block',
				message:
					'A selected resource directory resolves to an account home or its parent. Account-wide import is prohibited.',
			});
			continue;
		}
		if (
			((root.scope === 'project' && root.kind !== 'memory') || managedDirectory) &&
			!isPathAtOrUnderRoot(
				realRoot.split(paths.sep).join('/'),
				realProjectRoot.split(paths.sep).join('/')
			)
		) {
			const link = await nativeFs.lstat(root.file);
			if (link.isSymbolicLink()) {
				const target = await nativeFs.readlink(root.file);
				const artifact = translationArtifact(
					root.kind,
					root.file,
					root.prefix,
					Buffer.from(target),
					root.scope
				);
				artifact.symlinkTarget = target;
				artifact.metadata = { directoryLink: true };
				artifacts.push(artifact);
			}
			limitations.push({
				code: 'linked-user-resource',
				severity: 'warning',
				message: `Project resource ${root.prefix} resolves outside the project. Its link is retained; select the user resource explicitly to transfer its content.`,
			});
			continue;
		}
		const entries = stat.isDirectory()
			? (await nativeFs.readdir(root.file, { recursive: true }))
					.map((name) => paths.join(root.file, name))
					.sort()
			: [root.file];
		for (const file of entries) {
			const lst = await nativeFs.lstat(file);
			if (lst.isDirectory()) continue;
			const real = await nativeFs.realpath(file);
			// Existing AGENTS.md -> CLAUDE.md loads once, with the original link preserved.
			if (seen.has(real) && !lst.isSymbolicLink()) continue;
			if (paths.basename(file) === 'memory_summary.md') {
				limitations.push({
					code: 'generated-global-memory',
					severity: 'warning',
					message:
						'Generated account-global memory summaries are excluded from project translation.',
				});
				continue;
			}
			const directoryLink = lst.isSymbolicLink() && (await nativeFs.stat(file)).isDirectory();
			const outsideScope = !isPathAtOrUnderRoot(
				real.split(paths.sep).join('/'),
				((root.scope === 'project' && root.kind !== 'memory') || managedDirectory
					? realProjectRoot
					: realRoot
				)
					.split(paths.sep)
					.join('/')
			);
			const archiveOnlyLink = lst.isSymbolicLink() && (directoryLink || outsideScope);
			const data = archiveOnlyLink
				? Buffer.from(await nativeFs.readlink(file))
				: await nativeFs.readFile(real);
			const relativePath = stat.isDirectory()
				? `${root.prefix}/${paths.relative(root.file, file).split(paths.sep).join('/')}`
				: root.prefix;
			const artifact = translationArtifact(root.kind, file, relativePath, data, root.scope);
			artifact.mode = 0o600 | ((await nativeFs.stat(file)).mode & 0o100);
			if (lst.isSymbolicLink()) artifact.symlinkTarget = await nativeFs.readlink(file);
			if (seen.has(real)) artifact.metadata = { aliasOf: seen.get(real) };
			else seen.set(real, artifact.id);
			if (archiveOnlyLink) {
				artifact.metadata = { ...artifact.metadata, directoryLink: true };
				limitations.push({
					code: outsideScope ? 'linked-resource-target' : 'linked-resource-directory',
					severity: 'warning',
					artifactId: artifact.id,
					message: `Resource link ${artifact.relativePath} is archived as a link; select its target explicitly to transfer its contents.`,
				});
			}
			if (
				!archiveOnlyLink &&
				!artifact.metadata?.aliasOf &&
				((root.kind === 'skill' && paths.basename(file) === 'SKILL.md') || root.kind === 'subagent')
			) {
				const projection = projectResourceDefinition(
					artifact,
					identity.provider === 'claude-code' ? 'codex' : 'claude-code'
				);
				artifact.metadata = { ...artifact.metadata, ...projection.metadata };
				limitations.push(...projection.limitations);
			}
			artifacts.push(artifact);
		}
	}
	const instructions = artifacts.filter((a) => a.kind === 'instruction' && a.scope === 'project');
	if (instructions.length > 1 && new Set(instructions.map((a) => a.sha256)).size > 1)
		limitations.push({
			code: 'instruction-conflict',
			severity: 'block',
			message:
				'CLAUDE.md and AGENTS.md contain distinct instructions. Resolve their intended precedence before migration; neither file is overwritten.',
		});
	return { artifacts, limitations };
}

/** Translate portable bodies; unsupported execution controls stay in the archive. */
export function projectResourceDefinition(
	artifact: TranslationArtifact,
	destination: string
): {
	body: string;
	instructions: string;
	metadata: Record<string, unknown>;
	limitations: TranslationLimitation[];
} {
	const text = Buffer.from(artifact.bytesBase64, 'base64').toString('utf8');
	let metadata: Record<string, unknown> = {};
	let body = text;
	const limitations: TranslationLimitation[] = [];
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (frontmatter) {
		try {
			const value = yaml.load(frontmatter[1]);
			if (value && typeof value === 'object' && !Array.isArray(value))
				metadata = value as Record<string, unknown>;
		} catch {
			limitations.push({
				code: 'invalid-frontmatter',
				severity: 'block',
				artifactId: artifact.id,
				message: `Invalid definition frontmatter: ${artifact.relativePath}`,
			});
		}
		body = text.slice(frontmatter[0].length);
	} else if (
		artifact.relativePath.endsWith('.toml') ||
		artifact.metadata?.nativeFormat === 'toml'
	) {
		try {
			metadata = parseToml(text);
			body =
				typeof metadata.developer_instructions === 'string' ? metadata.developer_instructions : '';
			if (!body)
				limitations.push({
					code: 'missing-subagent-instructions',
					severity: 'block',
					artifactId: artifact.id,
					message: `No portable instructions in ${artifact.relativePath}.`,
				});
		} catch {
			limitations.push({
				code: 'invalid-toml',
				severity: 'block',
				artifactId: artifact.id,
				message: `Invalid TOML definition ${artifact.relativePath}.`,
			});
		}
	}

	const instructions = body;
	const portable = new Set(['name', 'description', 'developer_instructions']);
	for (const key of Object.keys(metadata))
		if (!portable.has(key)) {
			limitations.push({
				code: 'resource-execution-semantics',
				severity: 'warning',
				artifactId: artifact.id,
				message: `${artifact.relativePath}: ${key} requires destination-specific model, effort, memory, tool, hook or permission verification.`,
			});
		}
	if (artifact.kind === 'subagent' && destination === 'codex') {
		const name =
			typeof metadata.name === 'string'
				? metadata.name
				: path.basename(artifact.relativePath, '.md');
		body = stringifyToml({
			name,
			description: typeof metadata.description === 'string' ? metadata.description : '',
			developer_instructions: body,
		});
	}
	if (
		artifact.kind === 'subagent' &&
		destination === 'claude-code' &&
		(artifact.relativePath.endsWith('.toml') || artifact.metadata?.nativeFormat === 'toml')
	) {
		body = `---\n${yaml.dump({ name: metadata.name ?? path.basename(artifact.relativePath, '.toml'), description: metadata.description ?? '' })}---\n${body}`;
	}
	if (artifact.kind === 'skill')
		limitations.push({
			code: 'skill-runtime-bindings',
			severity: 'warning',
			artifactId: artifact.id,
			message: `${artifact.relativePath}: scripts, tools and native invocation bindings must be verified before capability continuity is certified.`,
		});
	return { body, instructions, metadata, limitations };
}

/** Managed resource tree is loaded through the same launch binding for both providers. */
export function translationKnowledgePrompt(
	directory: string,
	artifacts: TranslationArtifact[],
	paths: path.PlatformPath = path
): string {
	if (!artifacts.length) return '';
	const entries = artifacts
		.filter((a) => a.kind !== 'instruction' || a.scope === 'selected-user')
		.map((artifact) => `${artifact.kind}: ${paths.join(directory, artifact.relativePath)}`);
	return `Maestro provider translation project knowledge\nRead the selected project instructions and memory index below before continuing. Follow their linked topic files when relevant. These are selected project resources, not account-global memory. Skills and subagents retain their source definitions; native execution equivalence is unverified.\n${entries.join('\n')}`;
}

export function resourceBindingHash(artifacts: TranslationArtifact[]): string {
	return translationHash(
		artifacts
			.map((a) => canonicalJson({ path: a.relativePath, hash: a.sha256 }))
			.sort()
			.join('\n')
	);
}
