#!/usr/bin/env node
/**
 * Refresh OpenSpec Prompts
 *
 * OpenSpec was rearchitected in the 1.x line: the old single
 * `openspec/AGENTS.md` with `Stage 1/2/3` sections is gone. The workflow
 * prompts now live as TypeScript template literals in
 * `src/core/templates/workflows/<name>.ts`, exposed under the new `opsx:`
 * command surface. We keep our existing command surface
 * (proposal/apply/archive) and map each onto the upstream workflow that
 * matches, extracting the `instructions:` template literal as the prompt body.
 *
 * Usage: bun run refresh-openspec
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENSPEC_DIR = path.join(__dirname, '..', 'src', 'prompts', 'openspec');
const METADATA_PATH = path.join(OPENSPEC_DIR, 'metadata.json');

// GitHub OpenSpec repository info
const REPO_OWNER = 'Fission-AI';
const REPO_NAME = 'OpenSpec';
const RAW_GITHUB = 'https://raw.githubusercontent.com';
const GITHUB_API = 'https://api.github.com';
const WORKFLOWS_BASE_PATH = 'src/core/templates/workflows';

// Mapping of our command id → upstream workflow module file.
// We skip custom commands like 'help' and 'implement'.
const UPSTREAM_COMMANDS = [
	{ id: 'proposal', sourceFile: 'propose.ts' },
	{ id: 'apply', sourceFile: 'apply-change.ts' },
	{ id: 'archive', sourceFile: 'archive-change.ts' },
];

/**
 * Make an HTTPS GET request
 */
function httpsGet(url, options = {}) {
	return new Promise((resolve, reject) => {
		const headers = {
			'User-Agent': 'Maestro-OpenSpec-Refresher',
			...options.headers,
		};

		https
			.get(url, { headers }, (res) => {
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
 * Extract the `instructions:` template-literal string from a workflow module's
 * TypeScript source. The literals are plain markdown with no `${}`
 * interpolation, so we walk the backtick-delimited string, honoring escapes.
 */
function extractInstructions(tsSource) {
	const marker = tsSource.indexOf('instructions:');
	if (marker < 0) return null;
	const start = tsSource.indexOf('`', marker);
	if (start < 0) return null;

	let result = '';
	for (let i = start + 1; i < tsSource.length; i++) {
		const char = tsSource[i];
		if (char === '\\') {
			const next = tsSource[i + 1];
			if (next === '`' || next === '\\' || next === '$') {
				result += next;
				i++;
				continue;
			}
			result += char;
			continue;
		}
		if (char === '`') break;
		result += char;
	}
	return result.trim();
}

/**
 * Get the latest release tag from GitHub (falls back to "main").
 */
async function getLatestVersion() {
	try {
		const { data } = await httpsGet(
			`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
		);
		return JSON.parse(data).tag_name;
	} catch {
		console.warn('   Warning: Could not fetch release info, using "main"');
		return 'main';
	}
}

/**
 * Main refresh function
 */
async function refreshOpenSpec() {
	console.log('🔄 Refreshing OpenSpec prompts from GitHub...\n');

	if (!fs.existsSync(OPENSPEC_DIR)) {
		console.error('❌ OpenSpec directory not found:', OPENSPEC_DIR);
		process.exit(1);
	}

	try {
		console.log('📡 Getting latest release...');
		const version = await getLatestVersion();
		console.log(`   Version: ${version}`);

		console.log('\n✏️  Fetching and extracting workflow prompts...');
		let updatedCount = 0;
		for (const { id, sourceFile } of UPSTREAM_COMMANDS) {
			const url = `${RAW_GITHUB}/${REPO_OWNER}/${REPO_NAME}/${version}/${WORKFLOWS_BASE_PATH}/${sourceFile}`;
			const { data: tsSource } = await httpsGet(url);
			const content = extractInstructions(tsSource);

			if (!content) {
				console.log(`   ⚠ Missing: openspec.${id}.md (could not extract from ${sourceFile})`);
				continue;
			}

			const promptFile = path.join(OPENSPEC_DIR, `openspec.${id}.md`);
			const existingContent = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';

			if (content !== existingContent) {
				fs.writeFileSync(promptFile, content);
				console.log(`   ✓ Updated: openspec.${id}.md`);
				updatedCount++;
			} else {
				console.log(`   - Unchanged: openspec.${id}.md`);
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
		console.log(`   Skipped: help, implement (custom Maestro prompts)`);
	} catch (error) {
		console.error('\n❌ Refresh failed:', error.message);
		process.exit(1);
	}
}

// Run
refreshOpenSpec();
