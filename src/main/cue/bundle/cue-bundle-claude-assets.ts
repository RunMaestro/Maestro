/**
 * Claude Code assets in a Cue bundle: a workspace's skills, its `.mcp.json`,
 * its project memory (`CLAUDE.md`), and Claude's auto memory for it.
 *
 * The exporter calls {@link collectClaudeAssets} once per workspace a Claude
 * agent works in; the importer uses {@link mergeMcpConfig}, and
 * `claudeMemoryDir()` from `memory-manager.ts` (the Memory Viewer's home for
 * Claude memory paths) to place auto memory. Like the rest of `bundle/`,
 * nothing here imports Electron.
 *
 * Secrets never travel:
 * - `.mcp.json` values that look secret (by env name, header name, flag name,
 *   or a known credential prefix) become `${VAR}` references, which Claude
 *   Code expands from the environment. The names join the bundle's
 *   `requirements.secrets`, so the importer is told to set them.
 * - Text files (memory, skills) have credential-shaped tokens replaced by
 *   `[redacted]` (`redactCredentialTokens()`). Their prose cannot be
 *   rewritten into a reference.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSecretEnvKey } from '../../../shared/agentEnvironment';
import { containsCredentialToken, redactCredentialTokens } from '../../../shared/agent-run/redact';
import { claudeMemoryDir } from '../../memory-manager';
import {
	CUE_BUNDLE_CLAUDE_MEMORY_DIR,
	type CueBundleClaudeAssetSelection,
	type CueBundleClaudeAssets,
} from '../../../shared/cue-bundle-types';

/** Skills, relative to a workspace root. */
export const CLAUDE_SKILLS_DIR = '.claude/skills';
/** Project-scoped MCP servers, relative to a workspace root. */
export const MCP_CONFIG_FILE = '.mcp.json';
/** Project memory files, relative to a workspace root. `CLAUDE.local.md` is personal and stays. */
export const PROJECT_MEMORY_FILES = ['CLAUDE.md', '.claude/CLAUDE.md'];

/** Auto memory file names Claude writes: flat Markdown files. */
const MEMORY_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
/** Skills larger than this are left out with a warning. */
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
/** A skills folder with more files than this is cut off with a warning. */
const MAX_SKILL_FILES = 500;

/** Header, flag and query names whose value is a credential. */
const SECRET_NAME_RE = /(authorization|token|secret|password|passwd|api[-_]?key|cookie|session)/i;

/** Every Claude Code asset kind, for callers that take the defaults. */
export const ALL_CLAUDE_ASSETS: Required<CueBundleClaudeAssetSelection> = {
	skills: true,
	mcp: true,
	memory: true,
};

/** Fill an asset selection's unset kinds with the default (on). */
export function resolveClaudeAssetSelection(
	selection: CueBundleClaudeAssetSelection | undefined
): Required<CueBundleClaudeAssetSelection> {
	return {
		skills: selection?.skills ?? true,
		mcp: selection?.mcp ?? true,
		memory: selection?.memory ?? true,
	};
}

/** Whether a name can be an auto memory file. */
export function isClaudeMemoryFileName(name: string): boolean {
	return MEMORY_FILE_RE.test(name);
}

/** A NUL byte in the first 8 KB means binary, as git decides it. */
function isBinary(buf: Buffer): boolean {
	return buf.subarray(0, 8000).includes(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `MCP_<SERVER>_<NAME>`, upper snake case. */
function referenceName(server: string, name: string): string {
	const snake = (s: string) =>
		s
			.replace(/[^A-Za-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.toUpperCase();
	return ['MCP', snake(server), snake(name)].filter(Boolean).join('_');
}

// ─── .mcp.json ───────────────────────────────────────────────────────────────

export interface ScrubbedMcpConfig {
	/** The scrubbed file, ready to store. */
	content: string;
	servers: string[];
	/** Variables the scrubbed file now references. */
	secrets: string[];
	warnings: string[];
}

/**
 * Replace every secret value in a `.mcp.json` with a `${VAR}` reference.
 * Values that already reference a variable are left alone. Throws on a file
 * that is not a JSON object.
 */
export function scrubMcpConfig(raw: string): ScrubbedMcpConfig {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) throw new Error('not a JSON object');
	const secrets = new Set<string>();
	const warnings: string[] = [];
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};

	const reference = (server: string, name: string): string => {
		const variable = referenceName(server, name);
		secrets.add(variable);
		return `\${${variable}}`;
	};

	for (const [serverName, server] of Object.entries(servers)) {
		if (!isRecord(server)) continue;

		if (isRecord(server.env)) {
			for (const [key, value] of Object.entries(server.env)) {
				if (typeof value !== 'string' || value.includes('${')) continue;
				if (isSecretEnvKey(key) || containsCredentialToken(value)) {
					server.env[key] = `\${${key}}`;
					secrets.add(key);
				}
			}
		}

		if (isRecord(server.headers)) {
			for (const [header, value] of Object.entries(server.headers)) {
				if (typeof value !== 'string' || value.includes('${')) continue;
				if (!SECRET_NAME_RE.test(header) && !containsCredentialToken(value)) continue;
				const scheme = /^(Bearer|Basic|Token)\s+\S/i.exec(value)?.[1];
				const ref = reference(serverName, header);
				server.headers[header] = scheme ? `${scheme} ${ref}` : ref;
			}
		}

		if (Array.isArray(server.args)) {
			const args = server.args as unknown[];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (typeof arg !== 'string' || arg.includes('${')) continue;
				const flagWithValue = /^(--?[\w-]+)=(.*)$/.exec(arg);
				if (flagWithValue && SECRET_NAME_RE.test(flagWithValue[1]) && flagWithValue[2]) {
					args[i] = `${flagWithValue[1]}=${reference(serverName, flagWithValue[1])}`;
					continue;
				}
				const next = args[i + 1];
				if (
					/^--?[\w-]+$/.test(arg) &&
					SECRET_NAME_RE.test(arg) &&
					typeof next === 'string' &&
					next &&
					!next.startsWith('-') &&
					!next.includes('${')
				) {
					args[i + 1] = reference(serverName, arg);
					i++;
					continue;
				}
				if (containsCredentialToken(arg)) args[i] = reference(serverName, `arg ${i}`);
			}
		}

		if (typeof server.url === 'string' && !server.url.includes('${')) {
			server.url = scrubUrl(server.url, (name) => reference(serverName, name));
		}

		if (typeof server.command === 'string' && path.isAbsolute(server.command)) {
			warnings.push(
				`MCP server "${serverName}" runs its command by absolute path; check it exists on the importing machine.`
			);
		}
	}

	const content = JSON.stringify(parsed, null, 2) + '\n';
	// A reference that was already there needs its value on the importing
	// machine too, when its name says it is a secret (`${GH_TOKEN}`, not `${HOME}`).
	for (const name of mcpConfigReferences(content)) {
		if (isSecretEnvKey(name)) secrets.add(name);
	}

	return {
		content,
		servers: Object.keys(servers).sort(),
		secrets: [...secrets].sort(),
		warnings,
	};
}

/** Variable names a `.mcp.json` references as `${NAME}` or `${NAME:-default}`. */
export function mcpConfigReferences(content: string): string[] {
	const names = new Set<string>();
	for (const match of content.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
		names.add(match[1]);
	}
	return [...names].sort();
}

/** Strip userinfo and replace secret query values with references. */
function scrubUrl(url: string, reference: (name: string) => string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return containsCredentialToken(url) ? reference('url') : url;
	}
	let changed = false;
	if (parsed.username || parsed.password) {
		parsed.username = '';
		parsed.password = '';
		changed = true;
	}
	const replacements: Array<[string, string]> = [];
	for (const [name, value] of parsed.searchParams) {
		if (value && (SECRET_NAME_RE.test(name) || containsCredentialToken(value))) {
			replacements.push([name, reference(name)]);
		}
	}
	if (!changed && replacements.length === 0) return url;
	// Put the references in after serializing, so `${` is not percent-encoded.
	replacements.forEach(([name], i) => parsed.searchParams.set(name, `MAESTROREF${i}MAESTROREF`));
	let out = parsed.toString();
	replacements.forEach(([, ref], i) => {
		out = out.replace(`MAESTROREF${i}MAESTROREF`, ref);
	});
	return out;
}

/**
 * Merge an incoming `.mcp.json` into the one already in a workspace: the
 * bundle's servers are added, a server of the same name is replaced, and
 * everything else in the existing file is kept.
 */
export function mergeMcpConfig(
	existing: string | undefined,
	incoming: string
): { content: string; replaced: string[]; unchanged: boolean } {
	const next = JSON.parse(incoming) as Record<string, unknown>;
	if (existing === undefined) return { content: incoming, replaced: [], unchanged: false };
	const current: unknown = JSON.parse(existing);
	if (!isRecord(current)) throw new Error('the existing .mcp.json is not a JSON object');
	const currentServers = isRecord(current.mcpServers) ? current.mcpServers : {};
	const nextServers = isRecord(next.mcpServers) ? next.mcpServers : {};
	const replaced = Object.keys(nextServers)
		.filter(
			(name) =>
				name in currentServers &&
				JSON.stringify(currentServers[name]) !== JSON.stringify(nextServers[name])
		)
		.sort();
	const merged = { ...current, mcpServers: { ...currentServers, ...nextServers } };
	const content = JSON.stringify(merged, null, 2) + '\n';
	const unchanged = JSON.stringify(merged) === JSON.stringify(current);
	return { content: unchanged ? existing : content, replaced, unchanged };
}

// ─── Collection ──────────────────────────────────────────────────────────────

export interface ClaudeAssetFile {
	archivePath: string;
	content: Buffer;
}

export interface ClaudeAssetCollection {
	files: ClaudeAssetFile[];
	/** Variables the exported `.mcp.json` references. */
	secrets: string[];
	warnings: string[];
	/** What was found, for the manifest. Undefined when nothing was. */
	assets?: CueBundleClaudeAssets;
}

export interface CollectClaudeAssetsOptions {
	/** The workspace root. */
	root: string;
	/** Its bundle key. */
	key: string;
	selection: Required<CueBundleClaudeAssetSelection>;
	/** Claude's config directory, for auto memory. */
	claudeConfigDir: string;
}

/** A regular file (not a symlink), read whole; undefined when absent. */
function readRegularFile(filePath: string): Buffer | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch {
		return undefined;
	}
	return stat.isFile() ? fs.readFileSync(filePath) : undefined;
}

function isRealDirectory(dir: string): boolean {
	try {
		return fs.lstatSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Collect one workspace's Claude Code assets. */
export function collectClaudeAssets(options: CollectClaudeAssetsOptions): ClaudeAssetCollection {
	const { root, key, selection } = options;
	const files: ClaudeAssetFile[] = [];
	const secrets = new Set<string>();
	const warnings: string[] = [];
	const assets: CueBundleClaudeAssets = {};
	const workspacePath = (rel: string) => `workspaces/${key}/${rel}`;

	const addText = (archivePath: string, buf: Buffer, label: string) => {
		if (isBinary(buf)) {
			files.push({ archivePath, content: buf });
			return;
		}
		const { text, redacted } = redactCredentialTokens(buf.toString('utf-8'));
		if (redacted > 0) {
			warnings.push(
				`Redacted ${redacted} secret-looking token${redacted === 1 ? '' : 's'} in ${label}.`
			);
		}
		files.push({ archivePath, content: Buffer.from(text, 'utf-8') });
	};

	if (selection.skills) {
		const skills = collectSkills(root, warnings, key);
		for (const rel of skills.files) {
			const buf = fs.readFileSync(path.join(root, rel));
			addText(workspacePath(rel), buf, `${key}/${rel}`);
		}
		if (skills.names.length > 0) assets.skills = skills.names;
	}

	if (selection.mcp) {
		const raw = readRegularFile(path.join(root, MCP_CONFIG_FILE));
		if (raw) {
			try {
				const scrubbed = scrubMcpConfig(raw.toString('utf-8'));
				files.push({
					archivePath: workspacePath(MCP_CONFIG_FILE),
					content: Buffer.from(scrubbed.content, 'utf-8'),
				});
				for (const name of scrubbed.secrets) secrets.add(name);
				warnings.push(...scrubbed.warnings);
				if (scrubbed.servers.length > 0) assets.mcpServers = scrubbed.servers;
			} catch (error) {
				warnings.push(
					`Workspace "${key}": ${MCP_CONFIG_FILE} was left out (${error instanceof Error ? error.message : String(error)}).`
				);
			}
		}
	}

	if (selection.memory) {
		const projectMemory: string[] = [];
		for (const rel of PROJECT_MEMORY_FILES) {
			const buf = readRegularFile(path.join(root, rel));
			if (!buf) continue;
			addText(workspacePath(rel), buf, `${key}/${rel}`);
			projectMemory.push(rel);
		}
		if (projectMemory.length > 0) assets.projectMemory = projectMemory;

		const autoMemory = listAutoMemory(root, options.claudeConfigDir);
		for (const name of autoMemory.names) {
			const buf = fs.readFileSync(path.join(autoMemory.dir, name));
			addText(`${CUE_BUNDLE_CLAUDE_MEMORY_DIR}/${key}/${name}`, buf, `${key} auto memory ${name}`);
		}
		if (autoMemory.names.length > 0) assets.autoMemory = autoMemory.names;
	}

	return {
		files,
		secrets: [...secrets].sort(),
		warnings,
		...(Object.keys(assets).length > 0 ? { assets } : {}),
	};
}

/** Every file under `.claude/skills`, root-relative, plus the skill folder names. */
function collectSkills(
	root: string,
	warnings: string[],
	key: string
): { files: string[]; names: string[] } {
	if (
		!isRealDirectory(path.join(root, '.claude')) ||
		!isRealDirectory(path.join(root, CLAUDE_SKILLS_DIR))
	) {
		return { files: [], names: [] };
	}
	const files: string[] = [];
	let skippedLinks = 0;
	let truncated = false;
	const walk = (rel: string) => {
		const entries = fs
			.readdirSync(path.join(root, rel), { withFileTypes: true })
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (truncated) return;
			if (entry.name === '.DS_Store') continue;
			const childRel = `${rel}/${entry.name}`;
			if (entry.isSymbolicLink()) {
				skippedLinks++;
			} else if (entry.isDirectory()) {
				walk(childRel);
			} else if (entry.isFile()) {
				const size = fs.statSync(path.join(root, childRel)).size;
				if (size > MAX_SKILL_FILE_BYTES) {
					warnings.push(`Workspace "${key}": skipped ${childRel}, which is over 1 MB.`);
				} else if (files.length >= MAX_SKILL_FILES) {
					truncated = true;
				} else {
					files.push(childRel);
				}
			}
		}
	};
	walk(CLAUDE_SKILLS_DIR);
	if (skippedLinks > 0) {
		warnings.push(
			`Workspace "${key}": skipped ${skippedLinks} symbolic link${skippedLinks === 1 ? '' : 's'} in ${CLAUDE_SKILLS_DIR}.`
		);
	}
	if (truncated) {
		warnings.push(
			`Workspace "${key}": ${CLAUDE_SKILLS_DIR} has more than ${MAX_SKILL_FILES} files; only the first ${MAX_SKILL_FILES} were exported.`
		);
	}
	const names = [
		...new Set(
			files
				.map((rel) => rel.slice(CLAUDE_SKILLS_DIR.length + 1).split('/'))
				.filter((parts) => parts.length > 1)
				.map((parts) => parts[0])
		),
	].sort();
	return { files, names };
}

/** Auto memory file names for a root, and the folder they are in. */
function listAutoMemory(root: string, claudeConfigDir: string): { dir: string; names: string[] } {
	// Claude encodes the cwd it was started in, which is the resolved path.
	let real = root;
	try {
		real = fs.realpathSync(root);
	} catch {
		// Keep the given path.
	}
	const dir = claudeMemoryDir(claudeConfigDir, real);
	const names: string[] = [];
	if (isRealDirectory(dir)) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isFile() && isClaudeMemoryFileName(entry.name)) names.push(entry.name);
		}
	}
	return { dir, names: names.sort() };
}
