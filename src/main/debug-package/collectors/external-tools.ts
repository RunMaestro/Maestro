/**
 * External Tools Collector
 *
 * Collects information about external dependencies:
 * - Available shells
 * - Git availability
 * - gh CLI status
 * - cloudflared status
 */

import { detectShells } from '../../utils/shellDetector';
import { execFileNoThrow } from '../../utils/execFile';
import { isCloudflaredInstalled } from '../../utils/cliDetection';
import { sanitizePath } from './settings';

export interface ExternalToolsInfo {
	shells: Array<{
		id: string;
		name: string;
		available: boolean;
		path?: string; // Sanitized
	}>;
	git: {
		available: boolean;
		version?: string;
	};
	github: {
		ghCliInstalled: boolean;
		ghCliAuthenticated: boolean;
		ghPath?: string; // "[SET]" if custom, "[DEFAULT]" otherwise
	};
	cloudflared: {
		installed: boolean;
	};
}

/**
 * Collect information about external tools and dependencies.
 */
export async function collectExternalTools(): Promise<ExternalToolsInfo> {
	const result: ExternalToolsInfo = {
		shells: [],
		git: {
			available: false,
		},
		github: {
			ghCliInstalled: false,
			ghCliAuthenticated: false,
		},
		cloudflared: {
			installed: false,
		},
	};

	// Detect available shells
	try {
		const shells = await detectShells();
		result.shells = shells.map((shell) => ({
			id: shell.id,
			name: shell.name,
			available: shell.available,
			path: shell.path ? sanitizePath(shell.path) : undefined,
		}));
	} catch {
		// Shells detection failed, leave empty
	}

	// Check git availability
	try {
		const gitResult = await execFileNoThrow('git', ['--version']);
		if (gitResult.exitCode === 0) {
			result.git.available = true;
			// Extract version from "git version X.Y.Z"
			const match = gitResult.stdout.match(/git version (\S+)/);
			if (match) {
				result.git.version = match[1];
			}
		}
	} catch {
		// Git not available
	}

	// Check gh CLI installation and authentication
	try {
		const ghResult = await execFileNoThrow('gh', ['--version']);
		if (ghResult.exitCode === 0) {
			result.github.ghCliInstalled = true;

			// Check if authenticated
			const authResult = await execFileNoThrow('gh', ['auth', 'status']);
			result.github.ghCliAuthenticated = authResult.exitCode === 0;
		}
	} catch {
		// gh CLI not available
	}

	// Check cloudflared
	try {
		result.cloudflared.installed = await isCloudflaredInstalled();
	} catch {
		// cloudflared not available
	}

	return result;
}
