/**
 * BMAD Manager
 *
 * Manages bundled BMAD prompts with support for:
 * - Loading bundled prompts from src/prompts/bmad/
 * - Fetching updates from the BMAD GitHub repository
 * - User customization with ability to reset to defaults
 *
 * Source: https://github.com/bmad-code-org/BMAD-METHOD
 */

import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { bmadCatalog } from '../prompts/bmad/catalog';
import { captureException } from './utils/sentry';
import { logger } from './utils/logger';

const LOG_CONTEXT = '[BMAD]';
const BMAD_REPO_URL = 'https://github.com/bmad-code-org/BMAD-METHOD';
const BMAD_RAW_BASE = 'https://raw.githubusercontent.com/bmad-code-org/BMAD-METHOD/main';
const REFERENCE_TOKEN_REGEX =
	/`((?:\.\.?\/)?[A-Za-z0-9_./-]+\.md|\{project-root\}\/_bmad\/[^`]+\.md|\{installed_path\}\/[^`]+\.md)`/g;

const BMAD_COMMANDS = bmadCatalog.map((entry) => ({
	id: entry.id,
	command: entry.command,
	description: entry.description,
	sourcePath: entry.sourcePath,
	isCustom: entry.isCustom,
}));

function applyMaestroPromptFixes(id: string, prompt: string): string {
	let fixed = prompt;

	if (id === 'code-review') {
		fixed = fixed.replace(
			/<action>Run `git status --porcelain` to find uncommitted changes<\/action>\n<action>Run `git diff --name-only` to see modified files<\/action>\n<action>Run `git diff --cached --name-only` to see staged files<\/action>\n<action>Compile list of actually changed files from git output<\/action>/,
			`<action>Run \`git status --porcelain\` to find uncommitted changes</action>
<action>Run \`git diff --name-only\` to see modified files</action>
<action>Run \`git diff --cached --name-only\` to see staged files</action>
<action>If working-tree and staged diffs are both empty, inspect committed branch changes with \`git diff --name-only HEAD~1..HEAD\` or the current branch diff against its merge-base when available</action>
<action>Compile one combined list of actually changed files from git output</action>`
		);
	}

	if (id === 'create-story') {
		fixed = fixed.replace(
			/ {2}<\/check>\n {2}<action>Load the FULL file: \{\{sprint_status\}\}<\/action>[\s\S]*?<action>GOTO step 2a<\/action>\n<\/step>/,
			`  </check>\n</step>`
		);
	}

	if (id === 'retrospective') {
		fixed = fixed.replace(
			`- No time estimates — NEVER mention hours, days, weeks, months, or ANY time-based predictions. AI has fundamentally changed development speed.`,
			`- Do not invent time estimates or predictions. Only mention hours, days, sprints, or timelines when they are already present in project artifacts or completed work.`
		);
	}

	if (id === 'technical-research') {
		fixed = fixed.replace(
			`1. Set \`research_type = "technical"\`
2. Set \`research_topic = [discovered topic from discussion]\`
3. Set \`research_goals = [discovered goals from discussion]\`
4. Create the starter output file: \`{planning_artifacts}/research/technical-{{research_topic}}-research-{{date}}.md\` with exact copy of the \`./research.template.md\` contents
5. Load: \`./technical-steps/step-01-init.md\` with topic context`,
			`1. Set \`research_type = "technical"\`
2. Set \`research_topic = [discovered topic from discussion]\`
3. Set \`research_goals = [discovered goals from discussion]\`
4. Set \`research_topic_slug = sanitized lowercase kebab-case version of research_topic\` (replace whitespace with \`-\`, remove slashes and filesystem-reserved characters, collapse duplicate dashes)
5. Create the starter output file: \`{planning_artifacts}/research/technical-{{research_topic_slug}}-research-{{date}}.md\` with exact copy of the \`./research.template.md\` contents
6. Load: \`./technical-steps/step-01-init.md\` with topic context`
		);
	}

	return fixed;
}

export interface BmadCommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
	isCustom: boolean;
	isModified: boolean;
}

export interface BmadMetadata {
	lastRefreshed: string;
	commitSha: string;
	sourceVersion: string;
	sourceUrl: string;
}

interface StoredPrompt {
	content: string;
	isModified: boolean;
	modifiedAt?: string;
}

interface StoredData {
	metadata: BmadMetadata;
	prompts: Record<string, StoredPrompt>;
}

let customizationMutationQueue = Promise.resolve();

function withCustomizationLock<T>(mutation: () => Promise<T>): Promise<T> {
	const run = customizationMutationQueue.then(mutation, mutation);
	customizationMutationQueue = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

/**
 * Get path to user's BMAD customizations file.
 */
function getUserDataPath(): string {
	return path.join(app.getPath('userData'), 'bmad-customizations.json');
}

/**
 * Load user customizations from disk.
 */
async function loadUserCustomizations(): Promise<StoredData | null> {
	try {
		const content = await fs.readFile(getUserDataPath(), 'utf-8');
		return JSON.parse(content);
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
			(error instanceof Error && /ENOENT/.test(error.message))
		) {
			return null;
		}
		captureException(error, { operation: 'bmad:loadUserCustomizations' });
		throw error;
	}
}

function fetchWithTimeout(url: string, timeoutMs = 15000): Promise<Response> {
	return fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch((error) => {
		captureException(error, {
			operation: 'bmad:fetch',
			url,
			timeoutMs,
		});
		throw error;
	});
}

function resolveReferenceToRepoPath(reference: string, sourcePath: string): string | null {
	if (reference.startsWith('{project-root}/_bmad/')) {
		return `src/${reference.slice('{project-root}/_bmad/'.length)}`;
	}

	if (reference.startsWith('{installed_path}/')) {
		return path.posix.join(
			path.posix.dirname(sourcePath),
			reference.slice('{installed_path}/'.length)
		);
	}

	if (reference.startsWith('./') || reference.startsWith('../')) {
		return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), reference));
	}

	if (reference.endsWith('.md')) {
		return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), reference));
	}

	return null;
}

async function collectReferencedAssets(
	sourcePath: string,
	content: string,
	seen = new Set([sourcePath]),
	depth = 0
): Promise<Array<{ path: string; content: string }>> {
	if (depth > 1) {
		return [];
	}

	const references = new Set<string>();
	for (const match of content.matchAll(REFERENCE_TOKEN_REGEX)) {
		if (match[1]) {
			references.add(match[1]);
		}
	}

	const assets: Array<{ path: string; content: string }> = [];
	for (const reference of references) {
		const repoPath = resolveReferenceToRepoPath(reference, sourcePath);
		if (!repoPath || seen.has(repoPath)) {
			continue;
		}

		seen.add(repoPath);
		try {
			const response = await fetchWithTimeout(`${BMAD_RAW_BASE}/${repoPath}`);
			if (!response.ok) {
				throw new Error(`Failed to fetch referenced asset ${repoPath}: ${response.statusText}`);
			}
			const assetContent = await response.text();
			assets.push({ path: repoPath, content: assetContent.trim() });
			const nestedAssets = await collectReferencedAssets(repoPath, assetContent, seen, depth + 1);
			assets.push(...nestedAssets);
		} catch (error) {
			void captureException(error);
			logger.warn(`Could not fetch referenced BMAD asset ${repoPath}: ${error}`, LOG_CONTEXT);
		}
	}

	return assets;
}

function appendReferencedAssets(
	prompt: string,
	assets: Array<{ path: string; content: string }>
): string {
	if (assets.length === 0) {
		return prompt;
	}

	return `${prompt.trimEnd()}

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

${assets
	.map(
		(asset) => `## ${asset.path}

\`\`\`md
${asset.content}
\`\`\``
	)
	.join('\n\n')}`;
}

function applyMaestroRuntimePromptFixes(id: string, prompt: string): string {
	let fixed = applyMaestroPromptFixes(id, prompt);

	if (id === 'create-story') {
		fixed = fixed.replace(/GOTO step 2a/g, 'GOTO step 2');
		if (!fixed.includes('</workflow>')) {
			fixed = `${fixed.trimEnd()}\n\n</workflow>\n`;
		}
	}

	if (id === 'dev-story') {
		fixed = fixed.replace(
			'- `story_file` = `` (explicit story path; auto-discovered if empty)',
			'- `story_path` = `` (explicit story path; auto-discovered if empty)'
		);
		fixed = fixed.replace(
			'<action>Store user-provided story path as {{story_path}}</action>\n          <goto anchor="task_check" />',
			'<action>Store user-provided story path as {{story_path}}</action>\n          <action>Read COMPLETE story file</action>\n          <action>Extract story_key from filename or metadata</action>\n          <goto anchor="task_check" />'
		);
		fixed = fixed.replace(
			'<action>Store user-provided story path as {{story_path}}</action>\n          <action>Continue with provided story file</action>',
			'<action>Store user-provided story path as {{story_path}}</action>\n          <action>Read COMPLETE story file</action>\n          <action>Extract story_key from filename or metadata</action>\n          <goto anchor="task_check" />'
		);
		fixed = fixed.replace(
			'Dev Agent Record → Implementation Plan',
			'Dev Agent Record → Completion Notes'
		);
	}

	if (id === 'qa-automate') {
		fixed = fixed.replace(
			'If failures occur, report them clearly with likely causes and suggested fixes, but do not modify product code in this workflow.',
			'If failures occur, report them clearly with likely causes and suggested fixes, but do not modify product code in this workflow.\nSet `tests_verified = true` only when the relevant test command passes; otherwise set `tests_verified = false`.'
		);
		fixed = fixed.replace(
			'**Done!** Tests generated and verified. Validate against `{checklist}`.',
			'- If `tests_verified = true`: `**Done!** Tests generated and verified. Validate against `{checklist}`.`\n- If `tests_verified = false`: `**Done!** Tests were generated, but verification failed. Review the reported failures before treating them as passing.`'
		);
	}

	if (id === 'retrospective') {
		fixed = fixed.replace('{planning*artifacts}/\\_epic*.md', '{planning_artifacts}/*epic*.md');
		fixed = fixed.replace(
			'different than originally understood',
			'different from originally understood'
		);
	}

	if (id === 'sprint-planning') {
		fixed = fixed.replace(
			'<action>Look for all files matching `{epics_pattern}` in {epics_location}</action>\n<action>Could be a single `epics.md` file or multiple `epic-1.md`, `epic-2.md` files</action>',
			'<action>Look for whole-document candidates first: `epics.md`, `bmm-epics.md`, `user-stories.md`, and files matching `{epics_pattern}` in {epics_location}</action>\n<action>If no whole document is found, look for `epics/index.md` and then load every epic file referenced there</action>\n<action>If both whole and sharded sources exist, use the whole document only</action>'
		);
	}

	if (id === 'sprint-status') {
		fixed = fixed.replace(
			'<action>Count story statuses: backlog, ready-for-dev, in-progress, review, done</action>',
			'<action>Count story statuses: backlog, ready-for-dev, in-progress, review, done</action>\n  <action>Store grouped story keys as: stories_backlog, stories_ready_for_dev, stories_in_progress, stories_in_review, stories_done</action>'
		);
	}

	return fixed;
}

/**
 * Save user customizations to disk.
 */
async function saveUserCustomizations(data: StoredData): Promise<void> {
	await fs.writeFile(getUserDataPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get the path to bundled prompts directory.
 * In development, this is src/prompts/bmad
 * In production, this is in the app resources.
 */
function getBundledPromptsPath(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'prompts', 'bmad');
	}
	return path.join(__dirname, '..', '..', 'src', 'prompts', 'bmad');
}

/**
 * Get the user data directory for storing downloaded BMAD prompts.
 */
function getUserPromptsPath(): string {
	return path.join(app.getPath('userData'), 'bmad-prompts');
}

/**
 * Get bundled prompts by reading from disk.
 * Checks user prompts directory first (for downloaded updates), then falls back to bundled.
 */
async function getBundledPrompts(): Promise<
	Record<string, { prompt: string; description: string; isCustom: boolean }>
> {
	const bundledPromptsDir = getBundledPromptsPath();
	const userPromptsDir = getUserPromptsPath();
	const result: Record<string, { prompt: string; description: string; isCustom: boolean }> = {};

	for (const cmd of BMAD_COMMANDS) {
		try {
			const userPromptPath = path.join(userPromptsDir, `bmad.${cmd.id}.md`);
			const prompt = await fs.readFile(userPromptPath, 'utf-8');
			result[cmd.id] = {
				prompt,
				description: cmd.description,
				isCustom: cmd.isCustom,
			};
			continue;
		} catch {
			// Downloaded prompt not found, try bundled prompt.
		}

		try {
			const promptPath = path.join(bundledPromptsDir, `bmad.${cmd.id}.md`);
			const prompt = await fs.readFile(promptPath, 'utf-8');
			result[cmd.id] = {
				prompt,
				description: cmd.description,
				isCustom: cmd.isCustom,
			};
		} catch (error) {
			void captureException(error);
			logger.warn(`Failed to load bundled prompt for ${cmd.id}: ${error}`, LOG_CONTEXT);
			result[cmd.id] = {
				prompt: `# ${cmd.id}\n\nPrompt not available.`,
				description: cmd.description,
				isCustom: cmd.isCustom,
			};
		}
	}

	return result;
}

/**
 * Get bundled metadata by reading from disk.
 * Checks user prompts directory first (for downloaded updates), then falls back to bundled.
 */
async function getBundledMetadata(): Promise<BmadMetadata> {
	const bundledPromptsDir = getBundledPromptsPath();
	const userPromptsDir = getUserPromptsPath();

	try {
		const userMetadataPath = path.join(userPromptsDir, 'metadata.json');
		const content = await fs.readFile(userMetadataPath, 'utf-8');
		return JSON.parse(content);
	} catch {
		// Downloaded metadata not found, try bundled metadata.
	}

	try {
		const metadataPath = path.join(bundledPromptsDir, 'metadata.json');
		const content = await fs.readFile(metadataPath, 'utf-8');
		return JSON.parse(content);
	} catch {
		return {
			lastRefreshed: '2026-03-14T00:00:00.000Z',
			commitSha: 'main',
			sourceVersion: 'main',
			sourceUrl: BMAD_REPO_URL,
		};
	}
}

/**
 * Get current BMAD metadata.
 */
export async function getBmadMetadata(): Promise<BmadMetadata> {
	const customizations = await loadUserCustomizations();
	if (customizations?.metadata) {
		return customizations.metadata;
	}
	return getBundledMetadata();
}

/**
 * Get all BMAD prompts (bundled defaults merged with user customizations).
 */
export async function getBmadPrompts(): Promise<BmadCommand[]> {
	const bundled = await getBundledPrompts();
	const customizations = await loadUserCustomizations();

	return BMAD_COMMANDS.map((cmd) => {
		const bundledPrompt = bundled[cmd.id];
		const customPrompt = customizations?.prompts?.[cmd.id];
		const isModified = customPrompt?.isModified ?? false;
		const prompt = isModified && customPrompt ? customPrompt.content : bundledPrompt.prompt;

		return {
			id: cmd.id,
			command: cmd.command,
			description: bundledPrompt.description,
			prompt,
			isCustom: bundledPrompt.isCustom,
			isModified,
		};
	});
}

/**
 * Save user's edit to a BMAD prompt.
 */
export async function saveBmadPrompt(id: string, content: string): Promise<void> {
	return withCustomizationLock(async () => {
		const customizations = (await loadUserCustomizations()) ?? {
			metadata: await getBundledMetadata(),
			prompts: {},
		};

		customizations.prompts[id] = {
			content,
			isModified: true,
			modifiedAt: new Date().toISOString(),
		};

		await saveUserCustomizations(customizations);
		logger.info(`Saved customization for bmad.${id}`, LOG_CONTEXT);
	});
}

/**
 * Reset a BMAD prompt to its bundled default.
 */
export async function resetBmadPrompt(id: string): Promise<string> {
	return withCustomizationLock(async () => {
		const bundled = await getBundledPrompts();
		const defaultPrompt = bundled[id];

		if (!defaultPrompt) {
			throw new Error(`Unknown BMAD command: ${id}`);
		}

		const customizations = await loadUserCustomizations();
		if (customizations?.prompts?.[id]) {
			delete customizations.prompts[id];
			await saveUserCustomizations(customizations);
			logger.info(`Reset bmad.${id} to bundled default`, LOG_CONTEXT);
		}

		return defaultPrompt.prompt;
	});
}

async function getLatestCommitSha(): Promise<string> {
	try {
		const response = await fetchWithTimeout(
			`${BMAD_REPO_URL.replace('https://github.com', 'https://api.github.com/repos')}/commits/main`,
			15000
		);
		if (!response.ok) {
			throw new Error(`Failed to fetch latest commit: ${response.statusText}`);
		}
		const commit = (await response.json()) as { sha?: string };
		return commit.sha?.slice(0, 7) ?? 'main';
	} catch (error) {
		void captureException(error);
		logger.warn(`Could not fetch BMAD commit SHA: ${error}`, LOG_CONTEXT);
		return 'main';
	}
}

async function getLatestVersion(): Promise<string> {
	try {
		const response = await fetchWithTimeout(
			'https://raw.githubusercontent.com/bmad-code-org/BMAD-METHOD/main/package.json'
		);
		if (!response.ok) {
			throw new Error(`Failed to fetch package.json: ${response.statusText}`);
		}
		const packageJson = (await response.json()) as { version?: string };
		return packageJson.version ?? 'main';
	} catch (error) {
		void captureException(error);
		logger.warn(`Could not fetch BMAD version: ${error}`, LOG_CONTEXT);
		return 'main';
	}
}

/**
 * Fetch latest prompts from the BMAD GitHub repository.
 */
export async function refreshBmadPrompts(): Promise<BmadMetadata> {
	return withCustomizationLock(async () => {
		logger.info('Refreshing BMAD prompts from GitHub...', LOG_CONTEXT);

		const downloadedPrompts: Array<{ id: string; prompt: string }> = [];

		for (const cmd of BMAD_COMMANDS) {
			const response = await fetchWithTimeout(`${BMAD_RAW_BASE}/${cmd.sourcePath}`);
			if (!response.ok) {
				throw new Error(`Failed to fetch ${cmd.sourcePath}: ${response.statusText}`);
			}

			const prompt = applyMaestroRuntimePromptFixes(cmd.id, await response.text());
			const assets = await collectReferencedAssets(cmd.sourcePath, prompt);
			downloadedPrompts.push({ id: cmd.id, prompt: appendReferencedAssets(prompt, assets) });
		}

		const userPromptsDir = getUserPromptsPath();
		await fs.mkdir(userPromptsDir, { recursive: true });

		for (const downloadedPrompt of downloadedPrompts) {
			await fs.writeFile(
				path.join(userPromptsDir, `bmad.${downloadedPrompt.id}.md`),
				downloadedPrompt.prompt,
				'utf-8'
			);
			logger.info(`Updated: bmad.${downloadedPrompt.id}.md`, LOG_CONTEXT);
		}

		const [commitSha, sourceVersion] = await Promise.all([
			getLatestCommitSha(),
			getLatestVersion(),
		]);
		const newMetadata: BmadMetadata = {
			lastRefreshed: new Date().toISOString(),
			commitSha,
			sourceVersion,
			sourceUrl: BMAD_REPO_URL,
		};

		await fs.writeFile(
			path.join(userPromptsDir, 'metadata.json'),
			JSON.stringify(newMetadata, null, 2),
			'utf-8'
		);

		const customizations = (await loadUserCustomizations()) ?? {
			metadata: newMetadata,
			prompts: {},
		};
		customizations.metadata = newMetadata;
		await saveUserCustomizations(customizations);

		logger.info(`Refreshed BMAD prompts to ${sourceVersion}`, LOG_CONTEXT);
		return newMetadata;
	});
}

/**
 * Get a single BMAD command by ID.
 */
export async function getBmadCommand(id: string): Promise<BmadCommand | null> {
	const commands = await getBmadPrompts();
	return commands.find((cmd) => cmd.id === id) ?? null;
}

/**
 * Get a BMAD command by its slash command string.
 */
export async function getBmadCommandBySlash(slashCommand: string): Promise<BmadCommand | null> {
	const commands = await getBmadPrompts();
	return commands.find((cmd) => cmd.command === slashCommand) ?? null;
}
