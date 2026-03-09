#!/usr/bin/env node
/**
 * Refresh LLM Guard Secret Detection Patterns
 *
 * Fetches the latest secret detection patterns from:
 * - gitleaks (https://github.com/gitleaks/gitleaks)
 * - secrets-patterns-db (https://github.com/mazen160/secrets-patterns-db)
 *
 * Generates an updated patterns file that can be reviewed before merging.
 *
 * Usage: npm run refresh-llm-guard
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'src', 'main', 'security', 'llm-guard');
const GENERATED_FILE = path.join(OUTPUT_DIR, 'generated-patterns.ts');
const METADATA_FILE = path.join(OUTPUT_DIR, 'patterns-metadata.json');

// Sources
const SOURCES = {
	gitleaks: {
		name: 'gitleaks',
		url: 'https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml',
		repo: 'https://github.com/gitleaks/gitleaks',
	},
	secretsDb: {
		name: 'secrets-patterns-db',
		url: 'https://raw.githubusercontent.com/mazen160/secrets-patterns-db/master/db/rules-stable.yml',
		repo: 'https://github.com/mazen160/secrets-patterns-db',
	},
};

/**
 * Make an HTTPS GET request
 */
function httpsGet(url) {
	return new Promise((resolve, reject) => {
		https
			.get(url, { headers: { 'User-Agent': 'Maestro-LLMGuard-Refresher' } }, (res) => {
				if (res.statusCode === 301 || res.statusCode === 302) {
					return resolve(httpsGet(res.headers.location));
				}

				if (res.statusCode !== 200) {
					reject(new Error(`HTTP ${res.statusCode}: ${url}`));
					return;
				}

				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => resolve(data));
				res.on('error', reject);
			})
			.on('error', reject);
	});
}

/**
 * Parse gitleaks TOML config to extract rules
 */
function parseGitleaksToml(tomlContent) {
	const rules = [];

	// Split by [[rules]] sections
	const sections = tomlContent.split(/\[\[rules\]\]/g).slice(1);

	for (const section of sections) {
		const rule = {};

		// Extract id
		const idMatch = section.match(/^id\s*=\s*"([^"]+)"/m);
		if (idMatch) rule.id = idMatch[1];

		// Extract description
		const descMatch = section.match(/^description\s*=\s*"([^"]+)"/m);
		if (descMatch) rule.description = descMatch[1];

		// Extract regex (handles multi-line with ''')
		const regexMatch =
			section.match(/^regex\s*=\s*'''([^']+)'''/m) || section.match(/^regex\s*=\s*"([^"]+)"/m);
		if (regexMatch) rule.regex = regexMatch[1];

		// Extract entropy if present
		const entropyMatch = section.match(/^entropy\s*=\s*([\d.]+)/m);
		if (entropyMatch) rule.entropy = parseFloat(entropyMatch[1]);

		// Extract keywords if present
		const keywordsMatch = section.match(/^keywords\s*=\s*\[([^\]]+)\]/m);
		if (keywordsMatch) {
			rule.keywords = keywordsMatch[1]
				.split(',')
				.map((k) => k.trim().replace(/"/g, ''))
				.filter(Boolean);
		}

		if (rule.id && rule.regex) {
			rules.push(rule);
		}
	}

	return rules;
}

/**
 * Parse secrets-patterns-db YAML to extract patterns
 * Format:
 * patterns:
 *   - pattern:
 *       name: AWS API Key
 *       regex: AKIA[0-9A-Z]{16}
 *       confidence: high
 */
function parseSecretsDbYaml(yamlContent) {
	const patterns = [];

	// The YAML format uses "patterns:" as root, with nested pattern objects
	const lines = yamlContent.split('\n');
	let currentPattern = null;
	let inPatterns = false;
	let inPatternBlock = false;

	for (const line of lines) {
		// Check if we're in the patterns section
		if (line.match(/^patterns:/)) {
			inPatterns = true;
			continue;
		}

		if (!inPatterns) continue;

		// New pattern block starts with "  - pattern:" (indented list item with nested object)
		if (line.match(/^\s+-\s+pattern:\s*$/)) {
			// Save previous pattern
			if (currentPattern && currentPattern.regex && currentPattern.name) {
				patterns.push(currentPattern);
			}
			currentPattern = {};
			inPatternBlock = true;
			continue;
		}

		// If line starts a new list item but isn't a pattern block, we're done with patterns
		if (line.match(/^\s+-\s+[^p]/) && inPatternBlock) {
			inPatternBlock = false;
		}

		if (!currentPattern || !inPatternBlock) continue;

		// Extract name field (nested inside pattern block)
		const nameMatch = line.match(/^\s+name:\s*['"]?(.+?)['"]?\s*$/);
		if (nameMatch) {
			currentPattern.name = nameMatch[1].replace(/^['"]|['"]$/g, '');
		}

		// Extract regex field
		const regexMatch = line.match(/^\s+regex:\s*['"]?(.+?)['"]?\s*$/);
		if (regexMatch) {
			currentPattern.regex = regexMatch[1].replace(/^['"]|['"]$/g, '');
		}

		// Extract confidence field
		const confidenceMatch = line.match(/^\s+confidence:\s*['"]?(\w+)['"]?\s*$/);
		if (confidenceMatch) {
			currentPattern.confidence = confidenceMatch[1].trim();
		}
	}

	// Don't forget the last pattern
	if (currentPattern && currentPattern.regex && currentPattern.name) {
		patterns.push(currentPattern);
	}

	return patterns;
}

/**
 * Convert rule ID to our type format
 */
function toSecretType(id) {
	// Convert kebab-case and spaces to SCREAMING_SNAKE_CASE
	return (
		'SECRET_' +
		id
			.toUpperCase()
			.replace(/[-\s]+/g, '_') // Replace hyphens and spaces with underscores
			.replace(/[^A-Z0-9_]/g, '')
	); // Remove any other special characters
}

/**
 * Convert Go/PCRE regex to JavaScript-compatible regex
 * Handles inline flags like (?i) which aren't supported in JS
 */
function convertToJsRegex(regex) {
	let converted = regex;
	let flags = '';

	// Handle leading (?i) - case insensitive for whole pattern
	if (converted.startsWith('(?i)')) {
		converted = converted.slice(4);
		flags = 'i';
	}

	// Handle inline (?i) in the middle - these can't be directly converted,
	// so we make the whole regex case insensitive and remove the markers
	if (converted.includes('(?i)')) {
		converted = converted.replace(/\(\?i\)/g, '');
		flags = 'i';
	}

	// Handle (?-i:...) which means "case sensitive for this group" - not supported in JS
	// We'll just remove the flag markers
	converted = converted.replace(/\(\?-i:([^)]+)\)/g, '($1)');

	// Handle named capture groups (?P<name>...) -> (?<name>...) for JS
	converted = converted.replace(/\(\?P<([^>]+)>/g, '(?<$1>');

	// Remove other unsupported flags
	converted = converted.replace(/\(\?[imsx-]+\)/g, '');
	converted = converted.replace(/\(\?[imsx-]+:/g, '(?:');

	return { pattern: converted, flags };
}

/**
 * Escape regex special characters for TypeScript regex literal
 */
function escapeRegexForTs(regex) {
	// The regex is already escaped for TOML/YAML, we need to ensure it works in JS
	return regex
		.replace(/\\\\/g, '\\') // Unescape double backslashes
		.replace(/(?<!\\)\//g, '\\/') // Escape unescaped forward slashes for JS regex literal
		.replace(/'/g, "\\'"); // Escape single quotes for template literal
}

/**
 * Map confidence string to numeric value
 */
function mapConfidence(confidence) {
	const map = {
		high: 0.95,
		medium: 0.85,
		low: 0.7,
	};
	return map[confidence?.toLowerCase()] || 0.85;
}

/**
 * Generate TypeScript patterns file
 */
function generatePatternsFile(gitleaksRules, secretsDbPatterns, metadata) {
	const allPatterns = [];
	const seenTypes = new Set();

	// Process gitleaks rules (higher priority)
	for (const rule of gitleaksRules) {
		const type = toSecretType(rule.id);
		if (seenTypes.has(type)) continue;
		seenTypes.add(type);

		try {
			// Convert Go regex to JS-compatible
			const { pattern: jsPattern, flags } = convertToJsRegex(rule.regex);

			// Test if regex is valid
			new RegExp(jsPattern, flags);

			allPatterns.push({
				type,
				regex: jsPattern,
				flags,
				confidence: rule.entropy ? Math.min(0.99, 0.8 + rule.entropy * 0.05) : 0.9,
				source: 'gitleaks',
				description: rule.description,
			});
		} catch (e) {
			console.warn(`   ⚠ Skipping invalid regex for ${rule.id}: ${e.message}`);
		}
	}

	// Process secrets-patterns-db (fill in gaps)
	for (const pattern of secretsDbPatterns) {
		if (!pattern.name || !pattern.regex) continue;

		const type = toSecretType(pattern.name);
		if (seenTypes.has(type)) continue;
		seenTypes.add(type);

		try {
			// Convert Go regex to JS-compatible
			const { pattern: jsPattern, flags } = convertToJsRegex(pattern.regex);

			// Test if regex is valid
			new RegExp(jsPattern, flags);

			allPatterns.push({
				type,
				regex: jsPattern,
				flags,
				confidence: mapConfidence(pattern.confidence),
				source: 'secrets-patterns-db',
			});
		} catch (e) {
			console.warn(`   ⚠ Skipping invalid regex for ${pattern.name}: ${e.message}`);
		}
	}

	// Sort by type for consistency
	allPatterns.sort((a, b) => a.type.localeCompare(b.type));

	// Generate TypeScript
	const tsContent = `/**
 * Auto-generated secret detection patterns
 *
 * Generated: ${metadata.generatedAt}
 * Sources:
 *   - gitleaks: ${metadata.gitleaksCommit || 'latest'}
 *   - secrets-patterns-db: ${metadata.secretsDbCommit || 'latest'}
 *
 * DO NOT EDIT MANUALLY - Run 'npm run refresh-llm-guard' to update
 *
 * To customize patterns, edit the manual patterns in index.ts instead.
 */

export interface GeneratedSecretPattern {
	type: string;
	regex: RegExp;
	confidence: number;
	source: 'gitleaks' | 'secrets-patterns-db';
	description?: string;
}

/**
 * Auto-generated patterns from upstream sources.
 * These are merged with manual patterns in index.ts
 */
export const GENERATED_SECRET_PATTERNS: GeneratedSecretPattern[] = [
${allPatterns
	.map((p) => {
		const flagStr = p.flags ? `g${p.flags}` : 'g';
		return `	{
		type: '${p.type}',
		regex: /${escapeRegexForTs(p.regex)}/${flagStr},
		confidence: ${p.confidence.toFixed(2)},
		source: '${p.source}',${
			p.description
				? `
		description: '${p.description.replace(/'/g, "\\'")}',`
				: ''
		}
	}`;
	})
	.join(',\n')}
];

/**
 * Map of pattern types for quick lookup
 */
export const GENERATED_PATTERN_TYPES = new Set(
	GENERATED_SECRET_PATTERNS.map(p => p.type)
);

/**
 * Get pattern count by source
 */
export function getPatternStats() {
	const stats = { gitleaks: 0, 'secrets-patterns-db': 0, total: GENERATED_SECRET_PATTERNS.length };
	for (const p of GENERATED_SECRET_PATTERNS) {
		stats[p.source]++;
	}
	return stats;
}
`;

	return { content: tsContent, patternCount: allPatterns.length };
}

/**
 * Main refresh function
 */
async function refreshPatterns() {
	console.log('🔄 Refreshing LLM Guard secret detection patterns...\n');

	const metadata = {
		generatedAt: new Date().toISOString(),
		sources: {},
	};

	try {
		// Fetch gitleaks patterns
		console.log('📡 Fetching gitleaks patterns...');
		const gitleaksContent = await httpsGet(SOURCES.gitleaks.url);
		const gitleaksRules = parseGitleaksToml(gitleaksContent);
		console.log(`   Found ${gitleaksRules.length} rules`);
		metadata.sources.gitleaks = {
			url: SOURCES.gitleaks.repo,
			ruleCount: gitleaksRules.length,
		};

		// Fetch secrets-patterns-db patterns
		console.log('📡 Fetching secrets-patterns-db patterns...');
		const secretsDbContent = await httpsGet(SOURCES.secretsDb.url);
		const secretsDbPatterns = parseSecretsDbYaml(secretsDbContent);
		console.log(`   Found ${secretsDbPatterns.length} patterns`);
		metadata.sources.secretsDb = {
			url: SOURCES.secretsDb.repo,
			patternCount: secretsDbPatterns.length,
		};

		// Generate patterns file
		console.log('\n✏️  Generating patterns file...');
		const { content, patternCount } = generatePatternsFile(
			gitleaksRules,
			secretsDbPatterns,
			metadata
		);

		// Write generated file
		fs.writeFileSync(GENERATED_FILE, content);
		console.log(`   Generated: ${path.relative(process.cwd(), GENERATED_FILE)}`);
		console.log(`   Total patterns: ${patternCount}`);

		// Write metadata
		metadata.totalPatterns = patternCount;
		fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
		console.log(`   Metadata: ${path.relative(process.cwd(), METADATA_FILE)}`);

		// Summary
		console.log('\n✅ Refresh complete!');
		console.log(`   gitleaks rules: ${gitleaksRules.length}`);
		console.log(`   secrets-patterns-db patterns: ${secretsDbPatterns.length}`);
		console.log(`   Total generated: ${patternCount} (deduplicated)`);
		console.log('\n📝 Review the generated file and update index.ts to import if needed.');
	} catch (error) {
		console.error('\n❌ Refresh failed:', error.message);
		console.error(error.stack);
		process.exit(1);
	}
}

// Run
refreshPatterns();
