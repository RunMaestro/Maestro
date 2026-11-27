import type { TranslationFs, TranslationFsStat } from './fs-port';
import { localTranslationFsSync } from './local-fs';
import * as path from 'node:path';
import type { TranslationIdentity } from './types';
import type { SshRemoteConfig } from '../../types';
import { canonicalJson } from '../../canonicalJson';
import { translationHash } from './identity';
import {
	embedSystemPromptInPrompt,
	stripEmbeddedSystemPrompt,
	hasEmbeddedSystemPrompt,
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
} from '../../embeddedSystemPrompt';

export const TRANSLATION_KNOWLEDGE_ENV_VAR = 'MAESTRO_TRANSLATION_KNOWLEDGE';
export const TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR = 'MAESTRO_TRANSLATION_KNOWLEDGE_REMOTE';

/** The trusted host identity, never the knowledge directory, selects the root. */
export function translationKnowledgeRoot(
	userDataDir: string,
	identity: Pick<TranslationIdentity, 'remoteHost' | 'remoteHome'> = {}
): string {
	if (!identity.remoteHost && !identity.remoteHome)
		return path.join(userDataDir, 'provider-knowledge');
	if (
		!identity.remoteHost ||
		!/^[a-f0-9]{64}$/.test(identity.remoteHost) ||
		typeof identity.remoteHome !== 'string' ||
		!path.posix.isAbsolute(identity.remoteHome) ||
		identity.remoteHome.includes('\0')
	)
		throw new Error('Invalid SSH provider knowledge identity');
	return path.posix.join(identity.remoteHome, '.maestro', 'provider-knowledge');
}

/** Reject cross-host reuse before any filesystem read, including on local launches. */
export function resolveTranslationKnowledgeBinding(
	env: Record<string, string> | undefined,
	localRoot: string,
	remote?: SshRemoteConfig
): { directory: string; root: string; remoteHome?: string } | undefined {
	const directory = env?.[TRANSLATION_KNOWLEDGE_ENV_VAR];
	const encoded = env?.[TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR];
	if (!directory && !encoded) return undefined;
	if (!directory) throw new Error('Missing provider knowledge directory');
	if (!remote) {
		if (encoded) throw new Error('SSH provider knowledge cannot be used on a local launch');
		return { directory: path.resolve(directory), root: localRoot };
	}
	if (!encoded) throw new Error('SSH provider knowledge requires its remote host binding');
	const identity = JSON.parse(encoded) as Pick<TranslationIdentity, 'remoteHost' | 'remoteHome'>;
	if (!identity || identity.remoteHost !== translationHash(canonicalJson(remote)))
		throw new Error('Provider knowledge belongs to a different SSH host');
	const root = translationKnowledgeRoot('', identity);
	if (!path.posix.isAbsolute(directory)) throw new Error('Unsafe provider knowledge binding');
	return { directory: path.posix.resolve(directory), root, remoteHome: identity.remoteHome };
}

/** Only operation directories under the host's root, with no redirected descendants. */
export function assertTranslationKnowledgeDirectory(directory: string, knowledgeRoot: string): void;
export function assertTranslationKnowledgeDirectory(
	directory: string,
	knowledgeRoot: string,
	nativeFs: TranslationFs
): Promise<void>;
export function assertTranslationKnowledgeDirectory(
	directory: string,
	knowledgeRoot: string,
	nativeFs?: TranslationFs
): void | Promise<void> {
	const paths = nativeFs?.paths ?? path;
	const root = paths.resolve(knowledgeRoot);
	const resolved = paths.resolve(directory);
	const parts = paths.relative(root, resolved).split(paths.sep);
	if (
		parts.length !== 2 ||
		!/^[a-f0-9]{64}$/.test(parts[0]) ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[1])
	)
		throw new Error('Unsafe provider knowledge binding');
	const candidates = [paths.dirname(resolved), resolved];
	const check = (stat: TranslationFsStat): void => {
		if (stat.isSymbolicLink())
			throw new Error('Provider knowledge escapes its selected root through a symlink');
	};
	const allowMissing = (error: unknown): void => {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	};
	if (nativeFs)
		return Promise.all(
			candidates.map((candidate) => nativeFs.lstat(candidate).then(check, allowMissing))
		).then(() => {});
	for (const candidate of candidates) {
		try {
			check(localTranslationFsSync.lstat(candidate));
		} catch (error) {
			allowMissing(error);
		}
	}
}

/** Deliver on every continuation too; a resume may skip provider system-prompt flags. */
export function bindTranslationKnowledge(
	prompt: string | undefined,
	directory: string | undefined,
	knowledgeRoot: string
): string | undefined;
export function bindTranslationKnowledge(
	prompt: string | undefined,
	directory: string | undefined,
	knowledgeRoot: string,
	nativeFs: TranslationFs
): Promise<string | undefined>;
export function bindTranslationKnowledge(
	prompt: string | undefined,
	directory: string | undefined,
	knowledgeRoot: string,
	nativeFs?: TranslationFs
): string | undefined | Promise<string | undefined> {
	const embedIndex = (index: string): string | undefined => {
		if (!prompt || !index.trim()) return prompt;
		const userPrompt = stripEmbeddedSystemPrompt(prompt);
		const existing = hasEmbeddedSystemPrompt(prompt)
			? prompt.slice(0, prompt.indexOf(EMBEDDED_SYSTEM_PROMPT_SEPARATOR))
			: '';
		return embedSystemPromptInPrompt([existing, index].filter(Boolean).join('\n\n'), userPrompt);
	};
	if (nativeFs)
		return (async () => {
			if (!directory) return prompt;
			await assertTranslationKnowledgeDirectory(directory, knowledgeRoot, nativeFs);
			const indexPath = (nativeFs.paths ?? path).join(directory, 'knowledge-index.md');
			if ((await nativeFs.lstat(indexPath)).isSymbolicLink())
				throw new Error('Unsafe provider knowledge index symlink');
			if (!prompt) return prompt;
			return embedIndex((await nativeFs.readFile(indexPath)).toString('utf8'));
		})();
	if (!directory) return prompt;
	assertTranslationKnowledgeDirectory(directory, knowledgeRoot);
	const indexPath = path.join(directory, 'knowledge-index.md');
	if (localTranslationFsSync.lstat(indexPath).isSymbolicLink())
		throw new Error('Unsafe provider knowledge index symlink');
	if (!prompt) return prompt;
	return embedIndex(localTranslationFsSync.readFile(indexPath));
}
