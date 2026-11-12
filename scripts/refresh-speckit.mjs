#!/usr/bin/env node
/**
 * Refresh Spec Kit Prompts
 *
 * Fetches the latest spec-kit command templates from GitHub and updates the
 * bundled files. Run manually before releases or when spec-kit updates.
 *
 * Spec-kit no longer publishes pre-rendered command ZIPs as release assets.
 * The command templates live at `templates/commands/<cmd>.md` in the repo and
 * are rendered per-agent at install time. We fetch the raw templates at the
 * latest release tag and apply the same substitutions spec-kit would for the
 * Claude (bash) integration (see src/specify_cli/integrations/base.py
 * process_template).
 *
 * Usage: bun run refresh-speckit
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPECKIT_DIR = path.join(__dirname, '..', 'src', 'prompts', 'speckit');
const METADATA_PATH = path.join(SPECKIT_DIR, 'metadata.json');

// GitHub spec-kit repository info
const GITHUB_API = 'https://api.github.com';
const RAW_GITHUB = 'https://raw.githubusercontent.com';
const REPO_OWNER = 'github';
const REPO_NAME = 'spec-kit';

// Commands to fetch (these are upstream commands, we skip 'implement' as it's custom)
const UPSTREAM_COMMANDS = [
	'constitution',
	'specify',
	'clarify',
	'plan',
	'tasks',
	'analyze',
	'checklist',
	'taskstoissues',
];

/**
 * Make an HTTPS GET request
 */
function httpsGet(url, options = {}) {
	return new Promise((resolve, reject) => {
		const headers = {
			'User-Agent': 'Maestro-SpecKit-Refresher',
			...options.headers,
		};

		https
			.get(url, { headers }, (res) => {
				// Handle redirects
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
			})
			.on('error', reject);
	});
}

/**
 * Rewrite repo-relative paths to their installed `.specify/...` locations.
 * Faithful port of CommandRegistrar.rewrite_project_relative_paths.
 */
function rewriteProjectRelativePaths(text) {
	if (!text) return text;
	for (const [oldPath, newPath] of [
		['../../memory/', '.specify/memory/'],
		['../../scripts/', '.specify/scripts/'],
		['../../templates/', '.specify/templates/'],
	]) {
		text = text.split(oldPath).join(newPath);
	}
	text = text.replace(/(^|[\s`"'(])(?:\.?\/)?memory\//gm, '$1.specify/memory/');
	text = text.replace(/(^|[\s`"'(])(?:\.?\/)?scripts\//gm, '$1.specify/scripts/');
	text = text.replace(/(^|[\s`"'(])(?:\.?\/)?templates\//gm, '$1.specify/templates/');
	return text
		.split('.specify/.specify/')
		.join('.specify/')
		.split('.specify.specify/')
		.join('.specify/');
}

/**
 * Turn a raw templates/commands/<cmd>.md source into the agent-ready Claude
 * command body. Faithful port of IntegrationBase.process_template, specialized
 * for the Claude (bash) integration.
 */
function processSpeckitTemplate(content) {
	const scriptType = 'sh';
	const argPlaceholder = '$ARGUMENTS';
	const contextFile = 'CLAUDE.md';
	const agentName = 'claude';

	// 1. Extract the script command from the `scripts:` frontmatter block.
	let scriptCommand = '';
	let inScripts = false;
	for (const line of content.split('\n')) {
		if (line.trim() === 'scripts:') {
			inScripts = true;
			continue;
		}
		if (inScripts && line && !/^\s/.test(line)) inScripts = false;
		if (inScripts) {
			const m = line.match(new RegExp(`^\\s*${scriptType}:\\s*(.+)$`));
			if (m) {
				scriptCommand = m[1].trim();
				break;
			}
		}
	}

	// 2. Replace {SCRIPT}.
	if (scriptCommand) content = content.split('{SCRIPT}').join(scriptCommand);

	// 3. Strip the `scripts:` section from the frontmatter.
	const out = [];
	let inFrontmatter = false;
	let skipSection = false;
	let dashCount = 0;
	for (const line of content.split(/(?<=\n)/)) {
		const stripped = line.replace(/[\r\n]+$/, '');
		if (stripped === '---') {
			dashCount += 1;
			inFrontmatter = dashCount === 1;
			skipSection = false;
			out.push(line);
			continue;
		}
		if (inFrontmatter) {
			if (stripped === 'scripts:') {
				skipSection = true;
				continue;
			}
			if (skipSection) {
				if (/^\s/.test(line)) continue;
				skipSection = false;
			}
		}
		out.push(line);
	}
	content = out.join('');

	// 4-6. Placeholder substitutions.
	content = content.split('{ARGS}').join(argPlaceholder).split('$ARGUMENTS').join(argPlaceholder);
	content = content.split('__AGENT__').join(agentName).split('__CONTEXT_FILE__').join(contextFile);

	// 7. Rewrite repo-relative paths.
	content = rewriteProjectRelativePaths(content);

	// 8. Replace __SPECKIT_COMMAND_<NAME>__ with the slash invocation.
	content = content.replace(
		/__SPECKIT_COMMAND_([A-Z][A-Z0-9_]*)__/g,
		(_m, name) => '/speckit.' + name.toLowerCase().split('_').join('.')
	);

	return content;
}

/**
 * Get the latest release info from GitHub
 */
async function getLatestRelease() {
	const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
	const { data } = await httpsGet(url);
	return JSON.parse(data);
}

/**
 * Main refresh function
 */
async function refreshSpecKit() {
	console.log('🔄 Refreshing Spec Kit prompts from GitHub...\n');

	if (!fs.existsSync(SPECKIT_DIR)) {
		console.error('❌ Spec Kit directory not found:', SPECKIT_DIR);
		process.exit(1);
	}

	try {
		console.log('📡 Fetching latest release info...');
		const release = await getLatestRelease();
		const version = release.tag_name;
		console.log(`   Found release: ${version} (${release.name})`);

		console.log('\n✏️  Fetching and processing command templates...');
		let updatedCount = 0;
		for (const commandName of UPSTREAM_COMMANDS) {
			const url = `${RAW_GITHUB}/${REPO_OWNER}/${REPO_NAME}/${version}/templates/commands/${commandName}.md`;
			const { data: raw } = await httpsGet(url);
			const content = processSpeckitTemplate(raw);

			const promptFile = path.join(SPECKIT_DIR, `speckit.${commandName}.md`);
			const existingContent = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';

			if (content !== existingContent) {
				fs.writeFileSync(promptFile, content);
				console.log(`   ✓ Updated: speckit.${commandName}.md`);
				updatedCount++;
			} else {
				console.log(`   - Unchanged: speckit.${commandName}.md`);
			}
		}

		// Update metadata
		const metadata = {
			lastRefreshed: new Date().toISOString(),
			commitSha: version,
			sourceVersion: version.replace(/^v/, ''),
			sourceUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
		};

		fs.writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2));
		console.log('\n📄 Updated metadata.json');

		console.log('\n✅ Refresh complete!');
		console.log(`   Version: ${version.replace(/^v/, '')}`);
		console.log(`   Updated: ${updatedCount} files`);
		console.log(`   Skipped: implement (custom Maestro prompt)`);
	} catch (error) {
		console.error('\n❌ Refresh failed:', error.message);
		process.exit(1);
	}
}

// Run
refreshSpecKit();
