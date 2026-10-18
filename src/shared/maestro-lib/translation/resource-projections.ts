import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { canonicalJson } from '../../canonicalJson';
import { isPathAtOrUnderRoot } from '../../worktreePaths';
import { projectResourceDefinition } from './resources';
import { translationArtifact, translationHash } from './identity';
import type {
	TranslationArtifact,
	TranslationIdentity,
	TranslationCheckpoint,
	TranslationLimitation,
	ResourceProjection,
} from './types';

/** Refuse symlink escapes before creating native files. This is also used by rollback/readback. */
export async function assertTranslationTarget(file: string, root: string): Promise<void> {
	const relative = path.relative(path.resolve(root), path.resolve(file));
	if (
		!relative ||
		relative === '..' ||
		relative.startsWith('..' + path.sep) ||
		path.isAbsolute(relative)
	)
		throw new Error('Unsafe translation target');
	try {
		if ((await fs.lstat(file)).isSymbolicLink()) {
			const real = await fs.realpath(file);
			const realRoot = await fs.realpath(root);
			if (!isPathAtOrUnderRoot(real.replace(/\\/g, '/'), realRoot.replace(/\\/g, '/')))
				throw new Error('Translation target escapes its selected root through a symlink');
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	let ancestor = path.dirname(file);
	while (ancestor !== path.dirname(ancestor)) {
		try {
			const real = await fs.realpath(ancestor);
			let realRoot: string;
			try {
				realRoot = await fs.realpath(root);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				realRoot = path.resolve(root);
			}
			if (
				!isPathAtOrUnderRoot(real.replace(/\\/g, '/'), realRoot.replace(/\\/g, '/')) &&
				ancestor !== path.dirname(root)
			)
				throw new Error('Translation target escapes its selected root through a symlink');
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			ancestor = path.dirname(ancestor);
		}
	}
}

/** Project supported metadata to native discovery paths; no different-format symlinks. */
export async function planResourceProjections(
	resources: TranslationArtifact[],
	destination: TranslationIdentity,
	checkpoint?: TranslationCheckpoint
): Promise<{ projections: ResourceProjection[]; limitations: TranslationLimitation[] }> {
	const projections: ResourceProjection[] = [];
	const limitations: TranslationLimitation[] = [];
	const incompatibleSkills = new Set(
		resources
			.filter(
				(artifact) =>
					artifact.kind === 'skill' &&
					artifact.relativePath.endsWith('/SKILL.md') &&
					projectResourceDefinition(artifact, destination.provider).limitations.some(
						(l) => l.code === 'resource-execution-semantics' || l.severity === 'block'
					)
			)
			.map((artifact) => artifact.relativePath.slice(0, -'SKILL.md'.length))
	);
	for (const artifact of resources) {
		if (
			artifact.kind === 'skill' &&
			[...incompatibleSkills].some((prefix) => artifact.relativePath.startsWith(prefix))
		)
			continue;
		if (
			artifact.metadata?.directoryLink ||
			artifact.metadata?.originalDirectoryLink ||
			artifact.metadata?.aliasOf
		)
			continue;
		let file: string | undefined;
		let bytes = Buffer.from(artifact.bytesBase64, 'base64');
		let format: ResourceProjection['format'] = 'binary';
		let symlinkTarget: string | undefined;
		if (artifact.kind === 'instruction' && artifact.scope === 'project') {
			file = path.join(
				destination.projectRoot,
				destination.provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'
			);
			format = 'markdown';
			const sibling = path.join(destination.projectRoot, artifact.relativePath);
			if (sibling !== file) {
				try {
					if (translationHash(await fs.readFile(sibling)) === artifact.sha256)
						symlinkTarget = path.basename(sibling);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
			}
		} else if (artifact.kind === 'skill') {
			const match = /(?:^|\/)skills\/([^/]+)\/(.+)$/.exec(artifact.relativePath);
			if (!match) {
				limitations.push({
					code: 'skill-discovery-path',
					severity: 'warning',
					artifactId: artifact.id,
					message: `${artifact.relativePath} has no native skill-directory identity; it remains accessible through the knowledge binding.`,
				});
				continue;
			}
			file = path.join(
				destination.projectRoot,
				destination.provider === 'codex' ? '.agents' : '.claude',
				'skills',
				match[1],
				match[2]
			);
			if (match[2] === 'SKILL.md') {
				const definition = projectResourceDefinition(artifact, destination.provider);
				if (
					definition.limitations.some(
						(l) => l.code === 'resource-execution-semantics' || l.severity === 'block'
					)
				)
					continue;
				bytes = Buffer.from(
					`---\n${yaml.dump({ name: definition.metadata.name ?? match[1], description: definition.metadata.description ?? '' })}---\n${definition.body}`
				);
				format = 'markdown';
			}
		} else if (artifact.kind === 'subagent') {
			const definition = projectResourceDefinition(artifact, destination.provider);
			if (
				definition.limitations.some(
					(l) => l.code === 'resource-execution-semantics' || l.severity === 'block'
				)
			)
				continue;
			const name =
				typeof definition.metadata.name === 'string'
					? definition.metadata.name
					: path.basename(artifact.relativePath, path.extname(artifact.relativePath));
			if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
				limitations.push({
					code: 'unsafe-subagent-name',
					severity: 'block',
					artifactId: artifact.id,
					message: `Unsafe native subagent identity in ${artifact.relativePath}.`,
				});
				continue;
			}
			file = path.join(
				destination.projectRoot,
				destination.provider === 'codex' ? '.codex' : '.claude',
				'agents',
				`${name}.${destination.provider === 'codex' ? 'toml' : 'md'}`
			);
			bytes = Buffer.from(definition.body);
			format = destination.provider === 'codex' ? 'toml' : 'markdown';
			// Same-format projection must retain the original frontmatter too.
			if (
				destination.provider === 'claude-code' &&
				!artifact.relativePath.endsWith('.toml') &&
				artifact.metadata?.nativeFormat !== 'toml'
			)
				bytes = Buffer.from(artifact.bytesBase64, 'base64');
		} else continue;
		await assertTranslationTarget(file, destination.projectRoot);
		const hash = translationHash(bytes);
		let existing: Buffer | undefined;
		try {
			existing = await fs.readFile(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		if (existing && translationHash(existing) === hash) continue;
		if (existing && artifact.kind === 'instruction') {
			limitations.push({
				code: 'instruction-conflict',
				severity: 'block',
				artifactId: artifact.id,
				message: `Incoming instructions differ from the native file or shared alias ${file}. Resolve the canonical body before migration.`,
			});
			continue;
		}
		if (existing && !checkpoint?.ownedResources?.[file]) {
			// Preserve equivalent user-native definitions without rewriting their formatting.
			const candidate = translationArtifact(artifact.kind, file, path.basename(file), existing);
			const candidateDefinition = projectResourceDefinition(candidate, destination.provider);
			const incomingDefinition = projectResourceDefinition(artifact, destination.provider);
			if (
				format !== 'binary' &&
				candidateDefinition.instructions.trim() === incomingDefinition.instructions.trim() &&
				canonicalJson(candidateDefinition.metadata) === canonicalJson(incomingDefinition.metadata)
			)
				continue;
			limitations.push({
				code: 'native-resource-conflict',
				severity: 'block',
				artifactId: artifact.id,
				message: `User-owned destination resource differs: ${file}. Both versions remain intact.`,
			});
			continue;
		}
		const backup = existing
			? translationArtifact(artifact.kind, file, artifact.relativePath, existing)
			: undefined;
		if (backup) backup.mode = (await fs.stat(file)).mode & 0o777;
		const duplicate = projections.find((p) => p.path === file);
		if (duplicate) {
			if (duplicate.sha256 !== hash)
				limitations.push({
					code: 'resource-discovery-conflict',
					severity: 'block',
					artifactId: artifact.id,
					message: `Multiple selected resources target ${file} with different content.`,
				});
			continue;
		}
		projections.push({
			path: file,
			sha256: hash,
			created: !existing,
			expectedHash: existing ? translationHash(existing) : null,
			bytesBase64: bytes.toString('base64'),
			resourceKey: artifact.relativePath,
			format,
			mode: artifact.mode ?? 0o600,
			...(symlinkTarget && !existing && { symlinkTarget }),
			...(backup && { backup }),
		});
	}
	const selected = new Set(resources.map((a) => a.relativePath));
	for (const [file, owned] of Object.entries(checkpoint?.ownedResources ?? {})) {
		if (selected.has(owned.resourceKey)) continue;
		const nativeRoots = destination.provider === 'codex' ? ['.agents', '.codex'] : ['.claude'];
		const relative = path.relative(destination.projectRoot, file).replace(/\\/g, '/');
		if (!nativeRoots.some((prefix) => relative.startsWith(prefix + '/'))) continue;
		await assertTranslationTarget(file, destination.projectRoot);
		let existing: Buffer;
		try {
			existing = await fs.readFile(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		if (translationHash(existing) !== owned.sha256) {
			limitations.push({
				code: 'native-resource-conflict',
				severity: 'block',
				message: `Deleted resource ${file} has later native edits. Both the edit and tombstone are retained.`,
			});
			continue;
		}
		projections.push({
			path: file,
			sha256: owned.sha256,
			created: false,
			expectedHash: owned.sha256,
			bytesBase64: '',
			deleted: true,
			resourceKey: owned.resourceKey,
			format: owned.format,
			backup: translationArtifact('skill', file, owned.resourceKey, existing),
		});
	}
	return { projections, limitations };
}

/** Normalize native definition changes into the portable resource lineage, preserving their original bytes. */
export function nativeResourceVariant(
	base: TranslationArtifact,
	file: string,
	bytes: Buffer,
	format: ResourceProjection['format']
): TranslationArtifact {
	return {
		...base,
		sourcePath: file,
		sha256: translationHash(bytes),
		bytesBase64: bytes.toString('base64'),
		metadata: { ...base.metadata, nativeFormat: format },
	};
}
