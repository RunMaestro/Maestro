import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'account-setup';
const execFileAsync = promisify(execFile);

/** Resources that are symlinked from ~/.claude to each account directory */
const SHARED_SYMLINKS = [
	'commands',
	'ide',
	'plans',
	'plugins',
	'settings.json',
	'CLAUDE.md',
	'todos',
	'session-env',
	'projects',
];

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

	// Check for auth tokens — Claude Code uses .credentials.json (current) or .claude.json (legacy)
	try {
		await fs.access(path.join(baseDir, '.credentials.json'));
	} catch {
		try {
			await fs.access(path.join(baseDir, '.claude.json'));
		} catch {
			errors.push('No .credentials.json or .claude.json found — Claude Code may not be authenticated.');
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
	/** Auth files to check (relative to config dir) — first found wins */
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
		singleDir: '.codex',
		authFiles: ['auth.json', 'config.toml'],
		extractIdentity: extractCodexIdentity,
	},
	{
		agentType: 'opencode',
		singleDir: '.opencode',
		authFiles: ['config.json', 'auth.json'],
		extractIdentity: () => null,
	},
	{
		agentType: 'gemini-cli',
		singleDir: '.gemini',
		authFiles: ['oauth_creds.json', 'google_accounts.json'],
		extractIdentity: extractGeminiIdentity,
	},
];

/**
 * Discover existing provider account directories by scanning the home directory
 * for known config directory patterns across all supported providers.
 */
export async function discoverExistingAccounts(): Promise<Array<{
	configDir: string;
	name: string;
	email: string | null;
	hasAuth: boolean;
	agentType: string;
}>> {
	const homeDir = os.homedir();
	const entries = await fs.readdir(homeDir, { withFileTypes: true });
	const accounts: Array<{ configDir: string; name: string; email: string | null; hasAuth: boolean; agentType: string }> = [];

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
				// Directory doesn't exist — skip
			}
		}
	}

	return accounts;
}

/** Check auth files for a provider directory and extract identity */
async function checkProviderAuth(
	configDir: string,
	provider: ProviderDiscoveryConfig,
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
		// Not JSON — might be config.toml, no identity info there
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
 * The structure may vary — look for common fields like "email", "accountEmail", etc.
 */
function extractEmailFromClaudeJson(content: string): string | null {
	try {
		const json = JSON.parse(content);
		// Try common field names where email might be stored
		// Claude Code stores it at oauthAccount.emailAddress
		return json.email
			|| json.accountEmail
			|| json.primaryEmail
			|| json.oauthAccount?.emailAddress
			|| json.oauthAccount?.email
			|| json.account?.email
			|| null;
	} catch {
		return null;
	}
}

/**
 * Read the email identity from an account's .claude.json file.
 */
export async function readAccountEmail(configDir: string): Promise<string | null> {
	try {
		const authFile = path.join(configDir, '.claude.json');
		const content = await fs.readFile(authFile, 'utf-8');
		return extractEmailFromClaudeJson(content);
	} catch {
		return null;
	}
}

/**
 * Create a new Claude account directory with symlinks to shared resources.
 * Does NOT authenticate — that requires running `claude login` separately.
 */
export async function createAccountDirectory(accountName: string): Promise<{
	success: boolean;
	configDir: string;
	error?: string;
}> {
	const homeDir = os.homedir();
	const baseDir = path.join(homeDir, '.claude');
	const configDir = path.join(homeDir, `.claude-${accountName}`);

	try {
		// Check if directory already exists
		try {
			await fs.access(configDir);
			return { success: false, configDir, error: `Directory ${configDir} already exists` };
		} catch {
			// Good — doesn't exist yet
		}

		// Validate base directory
		const validation = await validateBaseClaudeDir();
		if (!validation.valid) {
			return { success: false, configDir, error: validation.errors.join('; ') };
		}

		// Create the account directory
		await fs.mkdir(configDir, { recursive: true });
		logger.info(`Created account directory: ${configDir}`, LOG_CONTEXT);

		// Create symlinks for shared resources
		for (const resource of SHARED_SYMLINKS) {
			const source = path.join(baseDir, resource);
			const target = path.join(configDir, resource);

			try {
				await fs.access(source);
				// Check if target already exists
				try {
					await fs.lstat(target);
					// Already exists (maybe from a previous attempt) — skip
					continue;
				} catch {
					// Doesn't exist — create symlink
				}
				await fs.symlink(source, target);
				logger.info(`Symlinked ${resource}`, LOG_CONTEXT);
			} catch {
				// Source doesn't exist — not all resources are required
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
	const baseDir = path.join(os.homedir(), '.claude');
	const broken: string[] = [];
	const missing: string[] = [];

	for (const resource of SHARED_SYMLINKS) {
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
			// Not a symlink — could be a real file/dir, which is fine
		} catch {
			// Missing entirely — check if source exists
			try {
				await fs.access(path.join(baseDir, resource));
				missing.push(resource);
			} catch {
				// Source also doesn't exist — OK, resource is optional
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
	const baseDir = path.join(os.homedir(), '.claude');
	const { broken, missing } = await validateAccountSymlinks(configDir);
	const repaired: string[] = [];
	const errors: string[] = [];

	for (const resource of [...broken, ...missing]) {
		const source = path.join(baseDir, resource);
		const target = path.join(configDir, resource);
		try {
			// Remove broken symlink if exists
			try { await fs.unlink(target); } catch { /* didn't exist */ }
			await fs.symlink(source, target);
			repaired.push(resource);
		} catch (err) {
			errors.push(`Failed to repair ${resource}: ${err}`);
		}
	}

	return { repaired, errors };
}

/**
 * Sync credentials from the base ~/.claude directory to an account directory.
 * Used after the user runs `claude login` in the base dir to propagate
 * fresh OAuth tokens to the account directory.
 *
 * Copies .credentials.json from ~/.claude to the target configDir.
 */
export async function syncCredentialsFromBase(configDir: string): Promise<{
	success: boolean;
	error?: string;
}> {
	const baseDir = path.join(os.homedir(), '.claude');
	const baseCreds = path.join(baseDir, '.credentials.json');
	const targetCreds = path.join(configDir, '.credentials.json');

	try {
		// Verify base credentials exist
		try {
			await fs.access(baseCreds);
		} catch {
			return { success: false, error: 'No .credentials.json found in base ~/.claude directory' };
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

		// Copy the credentials
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
 * Build the command string to launch `claude login` for a specific account.
 * This should be run in a Maestro terminal session.
 */
export function buildLoginCommand(configDir: string, claudeBinaryPath?: string): string {
	const binary = claudeBinaryPath || 'claude';
	return `CLAUDE_CONFIG_DIR="${configDir}" ${binary} login`;
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
		// Safety check: only remove directories matching ~/.claude-* pattern
		const basename = path.basename(configDir);
		if (!basename.startsWith('.claude-')) {
			return { success: false, error: 'Safety check failed: directory name must start with .claude-' };
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
	configDir: string,
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

	try {
		// Check directory exists
		const checkCmd = `test -d "${configDir}" && echo "DIR_EXISTS" || echo "DIR_MISSING"`;
		const { stdout: dirCheck } = await execFileAsync('ssh', [...sshArgs, checkCmd], { timeout: 10000 });

		if (dirCheck.trim() === 'DIR_MISSING') {
			return { exists: false, hasAuth: false, symlinksValid: false };
		}

		// Check .claude.json exists (auth)
		const authCmd = `test -f "${configDir}/.claude.json" && echo "AUTH_EXISTS" || echo "AUTH_MISSING"`;
		const { stdout: authCheck } = await execFileAsync('ssh', [...sshArgs, authCmd], { timeout: 10000 });
		const hasAuth = authCheck.trim() === 'AUTH_EXISTS';

		// Check symlinks (projects/ is the critical one for --resume)
		const symlinkCmd = `test -L "${configDir}/projects" && test -d "${configDir}/projects" && echo "SYMLINKS_OK" || echo "SYMLINKS_BROKEN"`;
		const { stdout: symlinkCheck } = await execFileAsync('ssh', [...sshArgs, symlinkCmd], { timeout: 10000 });
		const symlinksValid = symlinkCheck.trim() === 'SYMLINKS_OK';

		return { exists: true, hasAuth, symlinksValid };
	} catch (error) {
		return { exists: false, hasAuth: false, symlinksValid: false, error: String(error) };
	}
}
