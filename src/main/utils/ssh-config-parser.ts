/**
 * SSH Config Parser for Maestro.
 *
 * Parses ~/.ssh/config file to extract host configurations.
 * This allows users to leverage their existing SSH config for remote execution
 * without needing to re-enter connection details.
 *
 * Only extracts settings relevant to key-based authentication (no password support).
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Parsed SSH config host entry.
 * Contains the settings we care about for remote execution.
 */
export interface SshConfigHost {
  /** The Host pattern from the config (what you type after `ssh`) */
  host: string;

  /** The actual hostname or IP to connect to (from HostName directive) */
  hostName?: string;

  /** SSH port number (default: 22) */
  port?: number;

  /** Username for authentication */
  user?: string;

  /** Path to the identity (private key) file */
  identityFile?: string;

  /** Proxy jump host for bastion/jump servers */
  proxyJump?: string;
}

/**
 * Result of parsing an SSH config file.
 */
export interface SshConfigParseResult {
  /** Whether parsing was successful */
  success: boolean;

  /** List of parsed host entries (excludes wildcard-only entries) */
  hosts: SshConfigHost[];

  /** Error message if parsing failed */
  error?: string;

  /** Path to the config file that was parsed */
  configPath: string;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface SshConfigParserDeps {
  /** Function to read file contents */
  readFile: (filePath: string) => string;
  /** Function to check if file exists */
  fileExists: (filePath: string) => boolean;
  /** Home directory path */
  homeDir: string;
}

/**
 * Default dependencies using real implementations.
 */
function getDefaultDeps(): SshConfigParserDeps {
  return {
    readFile: (filePath: string): string => {
      return fs.readFileSync(filePath, 'utf-8');
    },
    fileExists: (filePath: string): boolean => {
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
    homeDir: process.env.HOME || process.env.USERPROFILE || '',
  };
}

/**
 * Expand tilde (~) in paths to the user's home directory.
 */
function expandPath(filePath: string, homeDir: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(homeDir, filePath.slice(2));
  }
  if (filePath === '~') {
    return homeDir;
  }
  return filePath;
}

/**
 * Normalize an IdentityFile path.
 * Handles ~ expansion and resolves %d, %h, %r tokens.
 */
function normalizeIdentityFile(
  identityFile: string,
  host: string,
  user: string | undefined,
  homeDir: string
): string {
  let normalized = expandPath(identityFile, homeDir);

  // Replace common SSH config tokens
  normalized = normalized.replace(/%d/g, homeDir);
  normalized = normalized.replace(/%h/g, host);
  if (user) {
    normalized = normalized.replace(/%r/g, user);
  }

  return normalized;
}

/**
 * Check if a host pattern is a wildcard pattern (e.g., *, ?.example.com)
 */
function isWildcardPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * Parse SSH config file and extract host configurations.
 *
 * The parser:
 * - Handles multi-line Host blocks
 * - Supports the most common directives (HostName, Port, User, IdentityFile, ProxyJump)
 * - Ignores comments and empty lines
 * - Filters out wildcard-only Host patterns (like `Host *`)
 *
 * @param deps Optional dependencies for testing
 * @returns Parsed config with list of hosts
 */
export function parseSshConfig(deps?: Partial<SshConfigParserDeps>): SshConfigParseResult {
  const d = { ...getDefaultDeps(), ...deps };
  const configPath = path.join(d.homeDir, '.ssh', 'config');

  if (!d.fileExists(configPath)) {
    return {
      success: true,
      hosts: [],
      configPath,
    };
  }

  try {
    const content = d.readFile(configPath);
    const hosts = parseConfigContent(content, d.homeDir);

    return {
      success: true,
      hosts,
      configPath,
    };
  } catch (err) {
    return {
      success: false,
      hosts: [],
      error: `Failed to parse SSH config: ${err instanceof Error ? err.message : String(err)}`,
      configPath,
    };
  }
}

/**
 * Parse the content of an SSH config file.
 *
 * @param content File content as string
 * @param homeDir Home directory for path expansion
 * @returns Array of parsed host entries
 */
export function parseConfigContent(content: string, homeDir: string): SshConfigHost[] {
  const lines = content.split(/\r?\n/);
  const hosts: SshConfigHost[] = [];
  let currentHost: SshConfigHost | null = null;

  for (const rawLine of lines) {
    // Strip comments (# can appear after whitespace)
    const commentIdx = rawLine.indexOf('#');
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();

    if (!line) continue;

    // Parse directive and value
    // SSH config format: Keyword Value (whitespace or = separated)
    const match = line.match(/^(\S+)\s*[=\s]\s*(.+)$/);
    if (!match) continue;

    const [, keyword, rawValue] = match;
    const value = rawValue.trim();
    const keywordLower = keyword.toLowerCase();

    if (keywordLower === 'host') {
      // Save previous host if it exists and is not a pure wildcard
      if (currentHost && !isWildcardPattern(currentHost.host)) {
        hosts.push(currentHost);
      }

      // Handle multi-pattern Host lines (e.g., "Host server1 server2")
      // We'll create separate entries for each non-wildcard pattern
      const patterns = value.split(/\s+/);

      // Start with the first non-wildcard pattern as the "main" host
      const mainPattern = patterns.find((p) => !isWildcardPattern(p));
      if (mainPattern) {
        currentHost = { host: mainPattern };
      } else {
        // All patterns are wildcards, skip this block
        currentHost = null;
      }
    } else if (currentHost) {
      // Apply directive to current host
      switch (keywordLower) {
        case 'hostname':
          currentHost.hostName = value;
          break;
        case 'port': {
          const port = parseInt(value, 10);
          if (!isNaN(port) && port > 0 && port <= 65535) {
            currentHost.port = port;
          }
          break;
        }
        case 'user':
          currentHost.user = value;
          break;
        case 'identityfile':
          // Normalize the identity file path
          currentHost.identityFile = normalizeIdentityFile(
            value,
            currentHost.hostName || currentHost.host,
            currentHost.user,
            homeDir
          );
          break;
        case 'proxyjump':
          currentHost.proxyJump = value;
          break;
        // Ignore other directives - we only care about connection settings
      }
    }
  }

  // Don't forget the last host
  if (currentHost && !isWildcardPattern(currentHost.host)) {
    hosts.push(currentHost);
  }

  return hosts;
}

/**
 * Find a host entry in the SSH config by name.
 *
 * @param hostName The Host pattern to look for
 * @param deps Optional dependencies for testing
 * @returns The matching host entry or undefined
 */
export function findSshConfigHost(
  hostName: string,
  deps?: Partial<SshConfigParserDeps>
): SshConfigHost | undefined {
  const result = parseSshConfig(deps);
  if (!result.success) return undefined;

  return result.hosts.find(
    (h) => h.host.toLowerCase() === hostName.toLowerCase()
  );
}

/**
 * Get a summary of what an SSH config host provides.
 * Useful for displaying to users what will be auto-filled.
 */
export function getSshConfigHostSummary(host: SshConfigHost): string {
  const parts: string[] = [];

  if (host.user && host.hostName) {
    parts.push(`${host.user}@${host.hostName}`);
  } else if (host.hostName) {
    parts.push(host.hostName);
  } else if (host.user) {
    parts.push(`${host.user}@...`);
  }

  if (host.port && host.port !== 22) {
    parts.push(`port ${host.port}`);
  }

  if (host.identityFile) {
    // Show just the filename for brevity
    const keyName = path.basename(host.identityFile);
    parts.push(`key: ${keyName}`);
  }

  return parts.join(', ') || 'No details available';
}
