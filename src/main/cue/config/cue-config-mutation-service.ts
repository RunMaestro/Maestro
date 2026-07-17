import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { CueSettings } from '../../../shared/cue';
import { pipelineKeyForSubscription } from '../../../shared/cue/subscription-id';
import { CUE_CONFIG_PATH, CUE_PROMPTS_DIR } from '../../../shared/maestro-paths';
import { atomicWriteFile, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { validateCueConfigDocument } from './cue-config-validator';
import {
	pruneOrphanedPromptFiles,
	readCuePromptFile,
	removeEmptyMaestroDir,
	removeEmptyPromptsDir,
	resolveCueConfigPath,
	writeCuePromptFile,
} from './cue-config-repository';

export interface CueConfigMutationService {
	replace(projectRoot: string, content: string): Promise<{ changed: boolean; filePath: string }>;
	replaceWithPromptFiles(
		projectRoot: string,
		content: string,
		promptFiles?: Record<string, string>
	): Promise<{ changed: boolean; filePath: string }>;
	setSubscriptionEnabled(
		projectRoot: string,
		pipelineName: string,
		subscriptionName: string,
		enabled: boolean
	): Promise<boolean>;
	removeSubscription(projectRoot: string, subscriptionName: string): Promise<boolean>;
	updateGlobalSettings(
		projectRoot: string,
		settings: Pick<
			CueSettings,
			'timeout_minutes' | 'timeout_on_fail' | 'max_concurrent' | 'queue_size'
		>
	): Promise<boolean>;
	delete(projectRoot: string): Promise<boolean>;
	deleteAndPrunePrompts(projectRoot: string): Promise<boolean>;
}

export interface CueConfigMutationServiceOptions {
	atomicWrite?: (filePath: string, contents: string) => Promise<void>;
}

interface LoadedCueDocument {
	filePath: string;
	raw: string;
	root: Record<string, unknown>;
}

const SETTINGS_KEYS = [
	'timeout_minutes',
	'timeout_on_fail',
	'max_concurrent',
	'queue_size',
] as const;

type GlobalSettingsKey = (typeof SETTINGS_KEYS)[number];

// All services in this process share this queue. The project root key preserves
// independent progress for different projects while one project serializes its
// YAML and prompt-file transactions.
const projectMutationQueue = createKeyedWriteQueue();

/**
 * Serialized, comment-preserving Cue YAML mutations.
 *
 * Whole-document saves retain the caller's exact bytes after validating them.
 * Targeted mutations patch only the owned scalar/list range in the original
 * document; js-yaml is used solely for validation and target selection, never
 * to re-emit a document that may contain user comments or supported unknown
 * keys. Every replacement is queued per resolved project root, backed up once,
 * then atomically renamed into place.
 */
export function createCueConfigMutationService(
	options: CueConfigMutationServiceOptions = {}
): CueConfigMutationService {
	const writeAtomic = options.atomicWrite ?? atomicWriteFile;

	async function withProjectMutation<T>(
		projectRoot: string,
		work: (root: string) => Promise<T>
	): Promise<T> {
		const root = assertProjectRoot(projectRoot);
		return projectMutationQueue.enqueue(root, () => work(root));
	}

	async function loadValidated(root: string): Promise<LoadedCueDocument | null> {
		const filePath = resolveCueConfigPath(root);
		if (!filePath) return null;
		await assertExistingConfigContained(root, filePath);
		const raw = await fs.readFile(filePath, 'utf-8');
		const rootDocument = parseAndValidate(raw, filePath);
		return { filePath, raw, root: rootDocument };
	}

	async function backupOriginal(filePath: string, original: string): Promise<void> {
		const backupPath = `${filePath}.bak`;
		try {
			await fs.access(backupPath);
		} catch {
			await writeAtomic(backupPath, original);
		}
	}

	async function persist(filePath: string, original: string | null, next: string): Promise<void> {
		if (original === next) return;
		if (original !== null) await backupOriginal(filePath, original);
		await writeAtomic(filePath, next);
	}

	async function replace(
		projectRoot: string,
		content: string
	): Promise<{ changed: boolean; filePath: string }> {
		return withProjectMutation(projectRoot, async (root) => {
			parseAndValidate(content, path.join(root, CUE_CONFIG_PATH));
			const existing = await loadValidated(root);
			if (existing?.raw === content) {
				return { changed: false, filePath: existing.filePath };
			}

			const filePath = existing?.filePath ?? safeCanonicalConfigPath(root);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await persist(filePath, existing?.raw ?? null, content);
			return { changed: true, filePath };
		});
	}

	async function replaceWithPromptFiles(
		projectRoot: string,
		content: string,
		promptFiles?: Record<string, string>
	): Promise<{ changed: boolean; filePath: string }> {
		return withProjectMutation(projectRoot, async (root) => {
			const existing = await loadValidated(root);
			const filePath = existing?.filePath ?? safeCanonicalConfigPath(root);
			const parsed = parseAndValidate(content, filePath);
			const yamlChanged = existing?.raw !== content;
			const keepPaths = collectPromptReferences(parsed);
			let promptsChanged = false;

			// Prompt files are staged before the atomic YAML replacement. A failure
			// before replacement can leave only unreferenced prompt files, which a
			// later successful transaction prunes; it cannot publish YAML pointing
			// at a missing prompt. Cross-file atomic rollback is not available with
			// filesystem rename primitives, so the queue makes this recoverable
			// ordering the transaction invariant.
			for (const [relativePath, prompt] of Object.entries(promptFiles ?? {})) {
				const normalizedPath = normalizePromptPath(root, relativePath);
				if (readCuePromptFile(root, normalizedPath) !== prompt) {
					writeCuePromptFile(root, normalizedPath, prompt);
					promptsChanged = true;
				}
				keepPaths.add(normalizedPath);
			}

			if (yamlChanged) {
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await persist(filePath, existing?.raw ?? null, content);
			}

			const prunedCount = pruneOrphanedPromptFiles(root, keepPaths).length;
			if (keepPaths.size === 0) {
				removeEmptyPromptsDir(root);
			}
			return {
				changed: yamlChanged || promptsChanged || prunedCount > 0,
				filePath,
			};
		});
	}

	async function setSubscriptionEnabled(
		projectRoot: string,
		pipelineName: string,
		subscriptionName: string,
		enabled: boolean
	): Promise<boolean> {
		return withProjectMutation(projectRoot, async (root) => {
			const document = await loadValidated(root);
			if (!document) return false;
			const subscriptions = document.root.subscriptions;
			if (!Array.isArray(subscriptions)) return false;
			const index = subscriptions.findIndex((entry) => {
				if (!entry || typeof entry !== 'object') return false;
				const sub = entry as Record<string, unknown>;
				const pipeline = pipelineKeyForSubscription({
					name: sub.name as string,
					pipeline_name: typeof sub.pipeline_name === 'string' ? sub.pipeline_name : undefined,
				});
				return sub.name === subscriptionName && pipeline === pipelineName;
			});
			if (index < 0) return false;

			const next = patchSubscriptionEnabled(document.raw, index, enabled);
			parseAndValidate(next, document.filePath);
			await persist(document.filePath, document.raw, next);
			return true;
		});
	}

	async function removeSubscription(
		projectRoot: string,
		subscriptionName: string
	): Promise<boolean> {
		return withProjectMutation(projectRoot, async (root) => {
			const document = await loadValidated(root);
			if (!document) return false;
			const subscriptions = document.root.subscriptions;
			if (!Array.isArray(subscriptions)) return false;
			const index = subscriptions.findIndex(
				(entry) =>
					Boolean(entry) &&
					typeof entry === 'object' &&
					(entry as Record<string, unknown>).name === subscriptionName
			);
			if (index < 0) return false;

			const next = removeSubscriptionRange(document.raw, index, subscriptions.length === 1);
			parseAndValidate(next, document.filePath);
			await persist(document.filePath, document.raw, next);
			return true;
		});
	}

	async function updateGlobalSettings(
		projectRoot: string,
		settings: Pick<CueSettings, GlobalSettingsKey>
	): Promise<boolean> {
		return withProjectMutation(projectRoot, async (root) => {
			const document = await loadValidated(root);
			if (!document) return false;
			const next = patchSettings(document.raw, settings);
			parseAndValidate(next, document.filePath);
			await persist(document.filePath, document.raw, next);
			return next !== document.raw;
		});
	}

	async function deleteConfig(projectRoot: string): Promise<boolean> {
		return withProjectMutation(projectRoot, async (root) => {
			const document = await loadValidated(root);
			if (!document) return false;
			await backupOriginal(document.filePath, document.raw);
			await fs.unlink(document.filePath);
			return true;
		});
	}

	async function deleteAndPrunePrompts(projectRoot: string): Promise<boolean> {
		return withProjectMutation(projectRoot, async (root) => {
			const document = await loadValidated(root);
			if (document) {
				await backupOriginal(document.filePath, document.raw);
				await fs.unlink(document.filePath);
			}
			pruneOrphanedPromptFiles(root, []);
			removeEmptyPromptsDir(root);
			removeEmptyMaestroDir(root);
			return document !== null;
		});
	}

	return {
		replace,
		replaceWithPromptFiles,
		setSubscriptionEnabled,
		removeSubscription,
		updateGlobalSettings,
		delete: deleteConfig,
		deleteAndPrunePrompts,
	};
}

function assertProjectRoot(projectRoot: string): string {
	if (
		typeof projectRoot !== 'string' ||
		projectRoot.length === 0 ||
		!path.isAbsolute(projectRoot)
	) {
		throw new Error('Cue config projectRoot must be a non-empty absolute path');
	}
	return path.resolve(projectRoot);
}

function safeCanonicalConfigPath(root: string): string {
	const target = path.resolve(root, CUE_CONFIG_PATH);
	assertContained(root, target, 'Cue config path');
	return target;
}

async function assertExistingConfigContained(root: string, filePath: string): Promise<void> {
	const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(filePath)]);
	assertContained(realRoot, realFile, 'Cue config path');
}

function assertContained(root: string, target: string, label: string): void {
	const relative = path.relative(root, target);
	if (
		!relative ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(`${label} resolves outside its project root`);
	}
}

function parseAndValidate(raw: string, filePath: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (error) {
		throw new Error(
			`Cue YAML parse failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const validation = validateCueConfigDocument(parsed);
	if (!validation.valid) {
		throw new Error(`Cue YAML validation failed for ${filePath}: ${validation.errors.join('; ')}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`Cue YAML root must be a mapping for ${filePath}`);
	}
	return parsed as Record<string, unknown>;
}

function collectPromptReferences(document: Record<string, unknown>): Set<string> {
	const keepPaths = new Set<string>();
	const subscriptions = document.subscriptions;
	if (!Array.isArray(subscriptions)) return keepPaths;

	for (const subscription of subscriptions) {
		if (!subscription || typeof subscription !== 'object') continue;
		const record = subscription as Record<string, unknown>;
		for (const key of ['prompt_file', 'output_prompt_file']) {
			const value = record[key];
			if (typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)) {
				keepPaths.add(value);
			}
		}
		if (Array.isArray(record.fan_out_prompt_files)) {
			for (const value of record.fan_out_prompt_files) {
				if (typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)) {
					keepPaths.add(value);
				}
			}
		}
	}
	return keepPaths;
}

function normalizePromptPath(root: string, relativePath: string): string {
	if (typeof relativePath !== 'string' || relativePath.length === 0) {
		throw new Error('cue:writeYaml: promptFiles key must be a non-empty string');
	}
	if (path.isAbsolute(relativePath)) {
		throw new Error(
			`cue:writeYaml: promptFiles key must be a relative path, got "${relativePath}"`
		);
	}
	const normalizedPath = path.sep === '/' ? relativePath.replace(/\\/g, '/') : relativePath;
	if (normalizedPath.split(/[/\\]/).some((segment) => segment === '..' || segment === '.')) {
		throw new Error(
			`cue:writeYaml: promptFiles key "${relativePath}" contains "." or ".." segment`
		);
	}
	const promptsBase = path.resolve(root, CUE_PROMPTS_DIR);
	const target = path.resolve(root, normalizedPath);
	if (!target.startsWith(promptsBase + path.sep)) {
		throw new Error(
			`cue:writeYaml: promptFiles key "${relativePath}" resolves outside the .maestro/prompts directory`
		);
	}
	if (path.extname(target).toLowerCase() !== '.md') {
		throw new Error(`cue:writeYaml: promptFiles key "${relativePath}" must end with .md`);
	}
	return normalizedPath;
}

interface SubscriptionRange {
	start: number;
	end: number;
	indent: string;
}
function subscriptionRange(raw: string, index: number): SubscriptionRange {
	const lines = raw.split(/(?<=\n)/);
	const subscriptionsLine = lines.findIndex((line) =>
		/^subscriptions\s*:(?:\s*(?:#.*)?)?\r?\n?$/.test(line)
	);
	if (subscriptionsLine < 0) throw new Error('Cue YAML subscriptions block cannot be located');

	const starts: number[] = [];
	let listIndent: string | undefined;
	let cursor = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		if (lineIndex > subscriptionsLine) {
			if (/^\S[^:]*:/.test(line)) break;
			const match = /^(\s*)-\s+/.exec(line);
			if (match) {
				if (listIndent === undefined) listIndent = match[1];
				if (match[1] === listIndent) starts.push(cursor);
			}
		}
		cursor += line.length;
	}
	const start = starts[index];
	if (start === undefined || listIndent === undefined) {
		throw new Error('Cue YAML subscription range cannot be located');
	}
	const nextStart = starts[index + 1];
	if (nextStart !== undefined) return { start, end: nextStart, indent: listIndent };

	const afterStart = raw.slice(start);
	const nextRoot = /\n(?=\S[^\n]*:)/.exec(afterStart);
	const provisionalEnd = nextRoot ? start + nextRoot.index! + 1 : raw.length;
	const body = raw.slice(start, provisionalEnd);
	const trailingCommentOrBlank = /(?:\r?\n[ \t]*(?:#.*)?)+\r?\n?$/.exec(body);
	const end =
		trailingCommentOrBlank && trailingCommentOrBlank.index! > 0
			? start + trailingCommentOrBlank.index!
			: provisionalEnd;
	return { start, end, indent: listIndent };
}

function patchSubscriptionEnabled(raw: string, index: number, enabled: boolean): string {
	const range = subscriptionRange(raw, index);
	const block = raw.slice(range.start, range.end);
	const directKey = new RegExp(
		`^${escapeRegExp(range.indent)}  enabled:\\s*[^\\r\\n]*(\\r?\\n|$)`,
		'm'
	);
	if (directKey.test(block)) {
		return (
			raw.slice(0, range.start) +
			block.replace(directKey, `${range.indent}  enabled: ${enabled}\n`) +
			raw.slice(range.end)
		);
	}
	const firstLineEnd = block.indexOf('\n') + 1;
	if (firstLineEnd === 0) throw new Error('Cue YAML subscription cannot be patched');
	return (
		raw.slice(0, range.start) +
		block.slice(0, firstLineEnd) +
		`${range.indent}  enabled: ${enabled}\n` +
		block.slice(firstLineEnd) +
		raw.slice(range.end)
	);
}

function removeSubscriptionRange(raw: string, index: number, removingLast: boolean): string {
	const range = subscriptionRange(raw, index);
	const next = raw.slice(0, range.start) + raw.slice(range.end);
	if (!removingLast) return next;

	return next.replace(
		/^(\s*subscriptions\s*:)(\s*(?:#.*)?)?\r?\n/m,
		(_match, declaration: string, trailing = '') => `${declaration} []${trailing}\n`
	);
}

function patchSettings(raw: string, settings: Pick<CueSettings, GlobalSettingsKey>): string {
	const lines = raw.split(/(?<=\n)/);
	const settingsLine = lines.findIndex((line) => /^settings\s*:(?:\s*(?:#.*)?)?\r?\n?$/.test(line));
	const values: Record<GlobalSettingsKey, string> = {
		timeout_minutes: String(settings.timeout_minutes),
		timeout_on_fail: settings.timeout_on_fail,
		max_concurrent: String(settings.max_concurrent),
		queue_size: String(settings.queue_size),
	};
	if (settingsLine < 0) {
		const suffix = raw.length === 0 || raw.endsWith('\n') ? '' : '\n';
		return `${raw}${suffix}settings:\n${SETTINGS_KEYS.map((key) => `  ${key}: ${values[key]}\n`).join('')}`;
	}

	let end = settingsLine + 1;
	while (end < lines.length && !/^\S[^:]*:/.test(lines[end])) end++;
	const block = lines.slice(settingsLine + 1, end);
	const childIndent =
		block
			.map((line) => /^([ \t]+)(?!#|\r?$)\S/.exec(line)?.[1])
			.find((indent): indent is string => indent !== undefined) ?? '  ';
	for (const key of SETTINGS_KEYS) {
		const keyLine = block.findIndex((line) =>
			new RegExp(`^${escapeRegExp(childIndent)}${escapeRegExp(key)}\\s*:`).test(line)
		);
		const replacement = `${childIndent}${key}: ${values[key]}\n`;
		if (keyLine >= 0) block[keyLine] = replacement;
		else block.push(replacement);
	}
	return [...lines.slice(0, settingsLine + 1), ...block, ...lines.slice(end)].join('');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
