import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';
import { shellEscapeForDoubleQuotes } from '../utils/shell-escape';
import type { MultiplexableAgent } from '../../shared/account-types';
import {
	ACCOUNT_PROVIDER_META,
	getAccountProviderMeta,
	inferProviderFromDir,
} from '../../shared/accountProviderMeta';

const LOG_CONTEXT = 'account-setup';
const execFileAsync = promisify(execFile);

function validateManagedAccountDirectory(configDir: string): string | null {
	const resolvedConfigDir = path.resolve(configDir);
	const resolvedHomeDir = path.resolve(os.homedir());
	if (path.dirname(resolvedConfigDir) !== resolvedHomeDir) {
		return 'Safety check failed: directory must be a direct child of the home directory';
	}

	const basename = path.basename(resolvedConfigDir);
	const managedPrefixes = Object.values(ACCOUNT_PROVIDER_META)
		.map((m) => m.dirPrefix)
		.filter((p): p is string => !!p);
	if (!managedPrefixes.some((prefix) => basename.startsWith(prefix))) {
		return `Safety check failed: directory name must start with one of ${managedPrefixes.join(', ')}`;
	}

	return null;
}

/**
 * Resources symlinked from the provider's base dir into each account directory
 * so shared config applies across accounts while auth/state stays isolated.
 */
const SHARED_SYMLINKS: Record<MultiplexableAgent, string[]> = {
	'claude-code': [
		'commands',
		'ide',
		'plans',
		'plugins',
		'settings.json',
		'CLAUDE.md',
		'todos',
		'session-env',
		'projects',
	],
	// config.toml carries user settings; prompts/ carries custom prompts. auth.json is NOT shared.
	codex: ['config.toml', 'prompts'],
	// OpenCode account dirs act as XDG_DATA_HOME roots; config comes from XDG_CONFIG_HOME untouched.
	opencode: [],
	'gemini-cli': [],
	'factory-droid': [],
};

/**
 * Validate that the base ~/.claude directory exists and has the expected structure.
 */
export async function validateBaseClaudeDir(): Promise<{
	valid: boolean;
	baseDir: string;
	errors: string[];
}> {
	const baseDir = path.join(os.homedir(), '.claude');
	const errors: string[] = [];

	try {
		const stat = await fs.stat(baseDir);
		if (!stat.isDirectory()) {
			errors.push(`${baseDir} exists but is not a directory`);
		}
	} catch {
		errors.push(`${baseDir} does not exist. Run 'claude' at least once to create it.`);
	}

	// Check for auth tokens; Claude Code uses .credentials.json (current) or .claude.json (legacy)
	try {
		await fs.access(path.join(baseDir, '.credentials.json'));
	} catch {
		try {
			await fs.access(path.join(baseDir, '.claude.json'));
		} catch {
			errors.push(
				'No .credentials.json or .claude.json found; Claude Code may not be authenticated.'
			);
		}
	}

	return { valid: errors.length === 0, baseDir, errors };
}

/**
 * Provider-specific config for discovery.
 * Each entry describes where to find accounts and how to extract identity.
 */
interface ProviderDiscoveryConfig {
	agentType: string;
	/** Directory prefix to scan in home dir (e.g., '.claude-' matches ~/.claude-work) */
	dirPrefix?: string;
	/** Single config dir to detect as an account (e.g., '.codex' matches ~/.codex) */
	singleDir?: string;
	/** Auth files to check (relative to config dir); first found wins */
	authFiles: string[];
	/** Extract identity from auth/config file content */
	extractIdentity: (content: string) => string | null;
}

const PROVIDER_DISCOVERY: ProviderDiscoveryConfig[] = [
	{
		agentType: 'claude-code',
		dirPrefix: '.claude-',
		authFiles: ['.claude.json', '.credentials.json'],
		extractIdentity: extractEmailFromClaudeJson,
	},
	{
		agentType: 'codex',
		dirPrefix: '.codex-',
		singleDir: '.codex',
		authFiles: ['auth.json', 'config.toml'],
		extractIdentity: extractCodexIdentity,
	},
	{
		agentType: 'opencode',
		dirPrefix: '.opencode-',
		singleDir: '.opencode',
		authFiles: ['opencode/auth.json', 'config.json', 'auth.json'],
		extractIdentity: () => null,
	},
	{
		agentType: 'gemini-cli',
		singleDir: '.gemini',
		authFiles: ['oauth_creds.json', 'google_accounts.json'],
		extractIdentity: extractGeminiIdentity,
	},
	{
		agentType: 'factory-droid',
		singleDir: '.factory',
		authFiles: ['auth.json', 'settings.json'],
		extractIdentity: extractFactoryIdentity,
	},
];

/**
 * Discover existing provider account directories by scanning the home directory
 * for known config directory patterns across all supported providers.
 */
export async function discoverExistingAccounts(): Promise<
	Array<{
		configDir: string;
		name: string;
		email: string | null;
		hasAuth: boolean;
		agentType: string;
	}>
> {
	const homeDir = os.homedir();
	const entries = await fs.readdir(homeDir, { withFileTypes: true });
	const accounts: Array<{
		configDir: string;
		name: string;
		email: string | null;
		hasAuth: boolean;
		agentType: string;
	}> = [];

	for (const provider of PROVIDER_DISCOVERY) {
		// Scan for prefix-based directories (e.g., ~/.claude-work, ~/.claude-personal)
		if (provider.dirPrefix) {
			for (const entry of entries) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				if (!entry.name.startsWith(provider.dirPrefix)) continue;

				const configDir = path.join(homeDir, entry.name);
				const name = entry.name.replace(provider.dirPrefix, '');
				const authResult = await checkProviderAuth(configDir, provider);

				accounts.push({
					configDir,
					name,
					email: authResult.email,
					hasAuth: authResult.hasAuth,
					agentType: provider.agentType,
				});
			}
		}

		// Check for single config directory (e.g., ~/.codex)
		if (provider.singleDir) {
			const configDir = path.join(homeDir, provider.singleDir);
			try {
				const stat = await fs.stat(configDir);
				if (stat.isDirectory()) {
					const authResult = await checkProviderAuth(configDir, provider);
					accounts.push({
						configDir,
						name: provider.singleDir.replace('.', ''),
						email: authResult.email,
						hasAuth: authResult.hasAuth,
						agentType: provider.agentType,
					});
				}
			} catch {
				// Directory doesn't exist; skip
			}
		}
	}

	return accounts;
}

/** Check auth files for a provider directory and extract identity */
async function checkProviderAuth(
	configDir: string,
	provider: ProviderDiscoveryConfig
): Promise<{ hasAuth: boolean; email: string | null }> {
	for (const authFile of provider.authFiles) {
		try {
			const content = await fs.readFile(path.join(configDir, authFile), 'utf-8');
			return {
				hasAuth: true,
				email: provider.extractIdentity(content),
			};
		} catch {
			// Try next auth file
		}
	}
	return { hasAuth: false, email: null };
}

/** Extract identity from Codex auth.json or config.toml */
function extractCodexIdentity(content: string): string | null {
	try {
		// auth.json has account info
		const json = JSON.parse(content);
		return json.email || json.user?.email || json.account?.email || null;
	} catch {
		// Not JSON; might be config.toml, no identity info there
		return null;
	}
}

/** Extract identity from Factory Droid auth.json or settings.json */
function extractFactoryIdentity(content: string): string | null {
	try {
		const json = JSON.parse(content);
		return json.email || json.user?.email || json.account?.email || null;
	} catch {
		return null;
	}
}

/** Extract identity from Gemini google_accounts.json or oauth_creds.json */
function extractGeminiIdentity(content: string): string | null {
	try {
		const json = JSON.parse(content);
		// google_accounts.json has { active: "email@example.com" }
		return json.active || json.email || null;
	} catch {
		return null;
	}
}

/**
 * Extract the email address from a .claude.json file content.
 * The structure may vary; look for common fields like "email", "accountEmail", etc.
 */
function extractEmailFromClaudeJson(content: string): string | null {
	try {
		const json = JSON.parse(content);
		// Try common field names where email might be stored
		// Claude Code stores it at oauthAccount.emailAddress
		return (
			json.email ||
			json.accountEmail ||
			json.primaryEmail ||
			json.oauthAccount?.emailAddress ||
			json.oauthAccount?.email ||
			json.account?.email ||
			null
		);
	} catch {
		return null;
	}
}

/**
 * Read the email identity from an account directory's auth files.
 * Provider is inferred from the directory name; each provider's auth
 * files are checked in order (same rules as discovery).
 */
export async function readAccountEmail(configDir: string): Promise<string | null> {
	const agentType = inferProviderFromDir(configDir);
	const provider = PROVIDER_DISCOVERY.find((p) => p.agentType === agentType);
	if (!provider) return null;
	const { email } = await checkProviderAuth(configDir, provider);
	return email;
}

/**
 * Create a new account directory for a provider, with symlinks to shared resources.
 * Does NOT authenticate - that requires running the provider's login command separately.
 */
export async function createAccountDirectory(
	accountName: string,
	agentType: MultiplexableAgent = 'claude-code'
): Promise<{
	success: boolean;
	configDir: string;
	error?: string;
}> {
	const meta = getAccountProviderMeta(agentType);
	if (!meta.supportsCreate || !meta.dirPrefix) {
		return {
			success: false,
			configDir: '',
			error:
				meta.createUnsupportedReason ??
				`${meta.displayName} does not support isolated account directories`,
		};
	}

	const homeDir = os.homedir();
	const baseDir = path.join(homeDir, meta.baseDirName);
	const configDir = path.join(homeDir, `${meta.dirPrefix}${accountName}`);

	try {
		// Check if directory already exists
		try {
			await fs.access(configDir);
			return { success: false, configDir, error: `Directory ${configDir} already exists` };
		} catch {
			// Good; doesn't exist yet
		}

		// Claude requires an authenticated base dir because core resources are symlinked from it.
		// Other providers work from an empty dir (login populates it), so no hard base requirement.
		if (agentType === 'claude-code') {
			const validation = await validateBaseClaudeDir();
			if (!validation.valid) {
				return { success: false, configDir, error: validation.errors.join('; ') };
			}
		}

		// Create the account directory
		await fs.mkdir(configDir, { recursive: true });
		logger.info(`Created account directory: ${configDir}`, LOG_CONTEXT);

		// Create symlinks for shared resources
		for (const resource of SHARED_SYMLINKS[agentType]) {
			const source = path.join(baseDir, resource);
			const target = path.join(configDir, resource);

			try {
				await fs.access(source);
				// Check if target already exists
				try {
					await fs.lstat(target);
					// Already exists (maybe from a previous attempt); skip
					continue;
				} catch {
					// Doesn't exist; create symlink
				}
				await fs.symlink(source, target);
				logger.info(`Symlinked ${resource}`, LOG_CONTEXT);
			} catch {
				// Source doesn't exist; not all resources are required
				logger.warn(`Skipped symlink for ${resource} (source not found)`, LOG_CONTEXT);
			}
		}

		return { success: true, configDir };
	} catch (error) {
		logger.error('Failed to create account directory', LOG_CONTEXT, { error: String(error) });
		return { success: false, configDir, error: String(error) };
	}
}

/**
 * Validate an account directory's symlinks are intact.
 * Returns list of broken or missing symlinks.
 */
export async function validateAccountSymlinks(configDir: string): Promise<{
	valid: boolean;
	broken: string[];
	missing: string[];
}> {
	const agentType = inferProviderFromDir(configDir);
	const baseDir = path.join(os.homedir(), getAccountProviderMeta(agentType).baseDirName);
	const broken: string[] = [];
	const missing: string[] = [];

	for (const resource of SHARED_SYMLINKS[agentType]) {
		const target = path.join(configDir, resource);
		try {
			const stat = await fs.lstat(target);
			if (stat.isSymbolicLink()) {
				// Check if symlink target exists
				try {
					await fs.stat(target); // follows symlink
				} catch {
					broken.push(resource);
				}
			}
			// Not a symlink; could be a real file/dir, which is fine
		} catch {
			// Missing entirely; check if source exists
			try {
				await fs.access(path.join(baseDir, resource));
				missing.push(resource);
			} catch {
				// Source also doesn't exist; OK, resource is optional
			}
		}
	}

	return { valid: broken.length === 0 && missing.length === 0, broken, missing };
}

/**
 * Repair broken or missing symlinks for an account directory.
 */
export async function repairAccountSymlinks(configDir: string): Promise<{
	repaired: string[];
	errors: string[];
}> {
	const safetyError = validateManagedAccountDirectory(configDir);
	if (safetyError) return { repaired: [], errors: [safetyError] };

	const agentType = inferProviderFromDir(configDir);
	const baseDir = path.join(os.homedir(), getAccountProviderMeta(agentType).baseDirName);
	const { broken, missing } = await validateAccountSymlinks(configDir);
	const repaired: string[] = [];
	const errors: string[] = [];

	for (const resource of [...broken, ...missing]) {
		const source = path.join(baseDir, resource);
		const target = path.join(configDir, resource);
		try {
			// Remove broken symlink if exists
			try {
				await fs.unlink(target);
			} catch {
				/* didn't exist */
			}
			await fs.symlink(source, target);
			repaired.push(resource);
		} catch (err) {
			errors.push(`Failed to repair ${resource}: ${err}`);
		}
	}

	return { repaired, errors };
}

/**
 * Sync credentials from the provider's base directory to an account directory.
 * Used after the user logs in in the base dir to propagate fresh tokens
 * to the account directory. Provider is inferred from the directory name:
 * - claude-code: ~/.claude/.credentials.json -> <dir>/.credentials.json
 * - codex: ~/.codex/auth.json -> <dir>/auth.json
 * - opencode: $XDG_DATA_HOME|~/.local/share/opencode/auth.json -> <dir>/opencode/auth.json
 */
export async function syncCredentialsFromBase(configDir: string): Promise<{
	success: boolean;
	error?: string;
}> {
	const agentType = inferProviderFromDir(configDir);
	const homeDir = os.homedir();

	let baseCreds: string;
	let targetCreds: string;
	if (agentType === 'claude-code') {
		baseCreds = path.join(homeDir, '.claude', '.credentials.json');
		targetCreds = path.join(configDir, '.credentials.json');
	} else if (agentType === 'codex') {
		baseCreds = path.join(homeDir, '.codex', 'auth.json');
		targetCreds = path.join(configDir, 'auth.json');
	} else if (agentType === 'opencode') {
		const dataHome = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
		baseCreds = path.join(dataHome, 'opencode', 'auth.json');
		targetCreds = path.join(configDir, 'opencode', 'auth.json');
	} else {
		return {
			success: false,
			error: `Credential sync is not supported for ${getAccountProviderMeta(agentType).displayName}`,
		};
	}

	try {
		// Verify base credentials exist
		try {
			await fs.access(baseCreds);
		} catch {
			return { success: false, error: `No credentials found at ${baseCreds}` };
		}

		// Verify target directory exists
		try {
			const stat = await fs.stat(configDir);
			if (!stat.isDirectory()) {
				return { success: false, error: `${configDir} is not a directory` };
			}
		} catch {
			return { success: false, error: `${configDir} does not exist` };
		}

		// Copy the credentials (opencode nests auth under <dir>/opencode/)
		await fs.mkdir(path.dirname(targetCreds), { recursive: true });
		const content = await fs.readFile(baseCreds, 'utf-8');
		await fs.writeFile(targetCreds, content, 'utf-8');

		logger.info(`Synced credentials from ${baseCreds} to ${targetCreds}`, LOG_CONTEXT);
		return { success: true };
	} catch (error) {
		logger.error('Failed to sync credentials', LOG_CONTEXT, { error: String(error) });
		return { success: false, error: String(error) };
	}
}

/**
 * Build the command string to authenticate a specific account dir.
 * Provider is inferred from the directory name. Returns null for
 * providers without an isolated-dir login flow (gemini-cli, factory-droid).
 * This should be run in a Maestro terminal session.
 */
export function buildLoginCommand(configDir: string, binaryPath?: string): string | null {
	const meta = getAccountProviderMeta(inferProviderFromDir(configDir));
	return meta.buildLoginCommand ? meta.buildLoginCommand(configDir, binaryPath) : null;
}

/**
 * Remove an account directory. Does NOT remove symlink targets (shared resources).
 * Only removes the account-specific directory and its contents.
 */
export async function removeAccountDirectory(configDir: string): Promise<{
	success: boolean;
	error?: string;
}> {
	try {
		const safetyError = validateManagedAccountDirectory(configDir);
		if (safetyError) {
			return { success: false, error: safetyError };
		}

		await fs.rm(configDir, { recursive: true, force: true });
		return { success: true };
	} catch (error) {
		return { success: false, error: String(error) };
	}
}

/**
 * Validate that an account directory exists on a remote host.
 * Uses SSH to check directory existence and symlink integrity.
 * Called before spawning an SSH session with a specific account.
 *
 * @param sshConfig - The SSH remote config from the session
 * @param configDir - The CLAUDE_CONFIG_DIR path (e.g., ~/.claude-work)
 * @returns Validation result with details about remote directory state
 */
export async function validateRemoteAccountDir(
	sshConfig: { host: string; user?: string; port?: number },
	configDir: string
): Promise<{
	exists: boolean;
	hasAuth: boolean;
	symlinksValid: boolean;
	error?: string;
}> {
	const sshTarget = sshConfig.user ? `${sshConfig.user}@${sshConfig.host}` : sshConfig.host;
	const sshArgs: string[] = [];
	if (sshConfig.port) sshArgs.push('-p', String(sshConfig.port));
	sshArgs.push(sshTarget);

	const escapedConfigDir = shellEscapeForDoubleQuotes(configDir);

	try {
		// Check directory exists
		const checkCmd = `test -d "${escapedConfigDir}" && echo "DIR_EXISTS" || echo "DIR_MISSING"`;
		const { stdout: dirCheck } = await execFileAsync('ssh', [...sshArgs, checkCmd], {
			timeout: 10000,
		});

		if (dirCheck.trim() === 'DIR_MISSING') {
			return { exists: false, hasAuth: false, symlinksValid: false };
		}

		// Check .claude.json exists (auth)
		const authCmd = `test -f "${escapedConfigDir}/.claude.json" && echo "AUTH_EXISTS" || echo "AUTH_MISSING"`;
		const { stdout: authCheck } = await execFileAsync('ssh', [...sshArgs, authCmd], {
			timeout: 10000,
		});
		const hasAuth = authCheck.trim() === 'AUTH_EXISTS';

		// Check symlinks (projects/ is the critical one for --resume)
		const symlinkCmd = `test -L "${escapedConfigDir}/projects" && test -d "${escapedConfigDir}/projects" && echo "SYMLINKS_OK" || echo "SYMLINKS_BROKEN"`;
		const { stdout: symlinkCheck } = await execFileAsync('ssh', [...sshArgs, symlinkCmd], {
			timeout: 10000,
		});
		const symlinksValid = symlinkCheck.trim() === 'SYMLINKS_OK';

		return { exists: true, hasAuth, symlinksValid };
	} catch (error) {
		return { exists: false, hasAuth: false, symlinksValid: false, error: String(error) };
	}
}
