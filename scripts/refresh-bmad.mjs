#!/usr/bin/env node
/**
 * Refresh BMAD prompts
 *
 * Fetches the current BMAD workflow catalog and prompt sources from GitHub,
 * then regenerates the bundled Maestro prompt files and command catalog.
 *
 * Usage: npm run refresh-bmad
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BMAD_DIR = path.join(__dirname, '..', 'src', 'prompts', 'bmad');
const CATALOG_PATH = path.join(BMAD_DIR, 'catalog.ts');
const METADATA_PATH = path.join(BMAD_DIR, 'metadata.json');

const GITHUB_API = 'https://api.github.com';
const RAW_GITHUB = 'https://raw.githubusercontent.com';
const REPO_OWNER = 'bmad-code-org';
const REPO_NAME = 'BMAD-METHOD';
const REPO_REF = 'main';
const RAW_BASE = `${RAW_GITHUB}/${REPO_OWNER}/${REPO_NAME}/${REPO_REF}`;

const MODULE_HELP_FILES = ['src/core/module-help.csv', 'src/bmm/module-help.csv'];
const REFERENCE_TOKEN_REGEX =
	/`((?:\.\.?\/)?[A-Za-z0-9_./-]+\.md|\{project-root\}\/_bmad\/[^`]+\.md|\{installed_path\}\/[^`]+\.md)`/g;

function applyMaestroPromptFixes(id, prompt) {
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
		fixed = fixed.replace('{planning*artifacts}/\\_epic*.md', '{planning_artifacts}/*epic*.md');
		fixed = fixed.replace(
			'different than originally understood',
			'different from originally understood'
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

	if (id === 'dev-story') {
		fixed = fixed.replace(
			'- `story_file` = `` (explicit story path; auto-discovered if empty)',
			'- `story_path` = `` (explicit story path; auto-discovered if empty)'
		);
		fixed = fixed.replace(
			'<action>Store user-provided story path as {{story_path}}</action>\n          <goto anchor=\"task_check\" />',
			'<action>Store user-provided story path as {{story_path}}</action>\n          <action>Read COMPLETE story file</action>\n          <action>Extract story_key from filename or metadata</action>\n          <goto anchor=\"task_check\" />'
		);
		fixed = fixed.replace(
			'<action>Store user-provided story path as {{story_path}}</action>\n          <action>Continue with provided story file</action>',
			'<action>Store user-provided story path as {{story_path}}</action>\n          <action>Read COMPLETE story file</action>\n          <action>Extract story_key from filename or metadata</action>\n          <goto anchor=\"task_check\" />'
		);
		fixed = fixed.replace(
			'Dev Agent Record → Implementation Plan',
			'Dev Agent Record → Completion Notes'
		);
	}

	return fixed;
}

function httpsGet(url, options = {}) {
	return new Promise((resolve, reject) => {
		const timeoutMs = options.timeoutMs ?? 15000;
		const headers = {
			'User-Agent': 'Maestro-BMAD-Refresher',
			Accept: 'application/vnd.github+json',
			...options.headers,
		};

		const req = https.get(url, { headers }, (res) => {
			if (res.statusCode === 301 || res.statusCode === 302) {
				return resolve(httpsGet(res.headers.location, options));
			}

			if (res.statusCode !== 200) {
				reject(new Error(`HTTP ${res.statusCode}: ${url}`));
				return;
			}

			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => resolve({ data, headers: res.headers }));
			res.on('error', reject);
		});

		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
		});
		req.on('error', reject);
	});
}

async function getJson(url) {
	const { data } = await httpsGet(url);
	return JSON.parse(data);
}

async function getText(url) {
	const { data } = await httpsGet(url, {
		headers: {
			Accept: 'text/plain',
		},
	});
	return data;
}

function resolveReferenceToRepoPath(reference, sourcePath) {
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
	sourcePath,
	content,
	seen = new Set([sourcePath]),
	depth = 0
) {
	if (depth > 1) {
		return [];
	}

	const references = new Set();
	for (const match of content.matchAll(REFERENCE_TOKEN_REGEX)) {
		if (match[1]) {
			references.add(match[1]);
		}
	}

	const assets = [];
	for (const reference of references) {
		const repoPath = resolveReferenceToRepoPath(reference, sourcePath);
		if (!repoPath || seen.has(repoPath)) {
			continue;
		}

		seen.add(repoPath);
		try {
			const assetContent = await getText(`${RAW_BASE}/${repoPath}`);
			assets.push({ path: repoPath, content: assetContent.trim() });
			const nestedAssets = await collectReferencedAssets(repoPath, assetContent, seen, depth + 1);
			assets.push(...nestedAssets);
		} catch (error) {
			console.warn(`   Warning: Could not fetch referenced asset ${repoPath}: ${error.message}`);
		}
	}

	return assets;
}

function appendReferencedAssets(prompt, assets) {
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

function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"') {
			inQuotes = true;
			continue;
		}

		if (char === ',') {
			row.push(field);
			field = '';
			continue;
		}

		if (char === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			continue;
		}

		if (char !== '\r') {
			field += char;
		}
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	const [header = [], ...body] = rows;
	return body
		.filter((record) => record.some((value) => value !== ''))
		.map((record) => Object.fromEntries(header.map((name, index) => [name, record[index] ?? ''])));
}

function getPromptId(rawCommand) {
	return rawCommand.replace(/^bmad-(bmm-)?/, '');
}

function mergeUniqueStrings(values) {
	return [...new Set(values.filter(Boolean))];
}

function mergeDescriptions(descriptions) {
	const unique = mergeUniqueStrings(descriptions);
	if (unique.length === 0) return '';
	if (unique.length === 1) return unique[0];
	return unique.join(' ');
}

function normalizeWorkflowPath(workflowFile) {
	if (!workflowFile) return null;
	if (workflowFile.startsWith('_bmad/')) {
		return `src/${workflowFile.slice('_bmad/'.length)}`;
	}
	return workflowFile;
}

function resolveSkillWorkflowPath(skillName, treePaths) {
	const matches = treePaths.filter((candidate) => candidate.endsWith(`/${skillName}/workflow.md`));
	if (matches.length === 0) {
		throw new Error(`Unable to resolve workflow.md for skill ${skillName}`);
	}
	if (matches.length === 1) {
		return matches[0];
	}

	const preferred = matches.find((candidate) => candidate.includes('/src/')) ?? matches[0];
	return preferred;
}

async function loadTreePaths() {
	const tree = await getJson(
		`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_REF}?recursive=1`
	);
	return tree.tree.map((entry) => entry.path);
}

async function loadModuleHelpRows() {
	const allRows = [];
	for (const moduleHelpPath of MODULE_HELP_FILES) {
		const text = await getText(
			`${RAW_GITHUB}/${REPO_OWNER}/${REPO_NAME}/${REPO_REF}/${moduleHelpPath}`
		);
		allRows.push(...parseCsv(text));
	}
	return allRows.filter((row) => row.command);
}

function buildCatalog(rows, treePaths) {
	const byCommand = new Map();

	for (const row of rows) {
		const rawCommand = row.command;
		if (!rawCommand) continue;

		const id = getPromptId(rawCommand);
		const sourcePath = row['workflow-file']?.startsWith('skill:')
			? resolveSkillWorkflowPath(row['workflow-file'].slice('skill:'.length), treePaths)
			: normalizeWorkflowPath(row['workflow-file']);

		if (!sourcePath) {
			continue;
		}

		const existing = byCommand.get(rawCommand);
		if (existing) {
			existing.names.push(row.name);
			existing.descriptions.push(row.description);
			continue;
		}

		byCommand.set(rawCommand, {
			id,
			command: `/${rawCommand}`,
			rawCommand,
			sourcePath,
			names: row.name ? [row.name] : [],
			descriptions: row.description ? [row.description] : [],
		});
	}

	const catalog = Array.from(byCommand.values()).map((entry) => ({
		id: entry.id,
		command: entry.command,
		description: mergeDescriptions(entry.descriptions),
		name: mergeUniqueStrings(entry.names).join(' / ') || entry.rawCommand,
		sourcePath: entry.sourcePath,
		isCustom: false,
	}));

	catalog.sort((left, right) => {
		if (left.id === 'help') return -1;
		if (right.id === 'help') return 1;
		return left.command.localeCompare(right.command);
	});

	return catalog;
}

function writeCatalogFile(catalog) {
	const lines = [
		'/**',
		' * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY',
		' *',
		' * Generated by scripts/refresh-bmad.mjs',
		' */',
		'',
		'export interface BmadCatalogEntry {',
		'\tid: string;',
		'\tcommand: string;',
		'\tdescription: string;',
		'\tname: string;',
		'\tsourcePath: string;',
		'\tisCustom: boolean;',
		'}',
		'',
		'export const bmadCatalog: BmadCatalogEntry[] = ' +
			JSON.stringify(catalog, null, '\t').replace(/^/gm, '').replace(/\n/g, '\n') +
			';',
		'',
	];

	fs.writeFileSync(CATALOG_PATH, lines.join('\n'));
}

async function getLatestCommitSha() {
	try {
		const commit = await getJson(
			`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/commits/${REPO_REF}`
		);
		return commit.sha.substring(0, 7);
	} catch (error) {
		console.warn('   Warning: Could not fetch commit SHA, using "main"');
		return REPO_REF;
	}
}

async function getSourceVersion() {
	try {
		const packageJson = await getText(
			`${RAW_GITHUB}/${REPO_OWNER}/${REPO_NAME}/${REPO_REF}/package.json`
		);
		const parsed = JSON.parse(packageJson);
		return parsed.version ?? REPO_REF;
	} catch (error) {
		console.warn('   Warning: Could not fetch BMAD package version, using "main"');
		return REPO_REF;
	}
}

async function refreshBmad() {
	console.log('🔄 Refreshing BMAD prompts from GitHub...\n');

	fs.mkdirSync(BMAD_DIR, { recursive: true });

	console.log('📡 Fetching BMAD workflow catalog...');
	const [treePaths, rows] = await Promise.all([loadTreePaths(), loadModuleHelpRows()]);
	const catalog = buildCatalog(rows, treePaths);
	console.log(`   Found ${catalog.length} unique prompt commands`);

	console.log('\n✏️  Writing prompt files...');
	let updatedCount = 0;
	for (const entry of catalog) {
		const prompt = applyMaestroPromptFixes(
			entry.id,
			await getText(`${RAW_BASE}/${entry.sourcePath}`)
		);
		const assets = await collectReferencedAssets(entry.sourcePath, prompt);
		const fullPrompt = appendReferencedAssets(prompt, assets);
		const promptPath = path.join(BMAD_DIR, `bmad.${entry.id}.md`);
		const existing = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';

		if (existing !== fullPrompt) {
			fs.writeFileSync(promptPath, fullPrompt);
			updatedCount++;
			console.log(`   ✓ Updated: bmad.${entry.id}.md`);
		} else {
			console.log(`   - Unchanged: bmad.${entry.id}.md`);
		}
	}

	console.log('\n📄 Writing catalog and metadata...');
	writeCatalogFile(catalog);

	const [commitSha, sourceVersion] = await Promise.all([getLatestCommitSha(), getSourceVersion()]);
	const metadata = {
		lastRefreshed: new Date().toISOString(),
		commitSha,
		sourceVersion,
		sourceUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
	};
	fs.writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2));

	console.log('\n✅ Refresh complete!');
	console.log(`   Commit: ${commitSha}`);
	console.log(`   Version: ${sourceVersion}`);
	console.log(`   Commands: ${catalog.length}`);
	console.log(`   Updated prompt files: ${updatedCount}`);
}

refreshBmad().catch((error) => {
	console.error('\n❌ Refresh failed:', error.message);
	process.exit(1);
});
