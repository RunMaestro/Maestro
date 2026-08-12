/**
 * External Tools Collector
 *
 * Collects information about external dependencies:
 * - Available shells (no paths)
 * - Git availability and version
 * - gh CLI status
 * - cloudflared status
 */

import { detectShells } from '../../utils/shellDetector';
import { execFileNoThrow } from '../../utils/execFile';
import { isCloudflaredInstalled } from '../../utils/cliDetection';

export interface ExternalToolsInfo {
	shells: Array<{
		id: string;
		name: string;
		available: boolean;
	}>;
	git: {
		available: boolean;
		version?: string;
	};
	github: {
		ghCliInstalled: boolean;
		ghCliAuthenticated: boolean;
	};
	cloudflared: {
		installed: boolean;
	};
}

/**
 * Collect information about external tools and dependencies.
 * No installation paths are included - only availability and versions.
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

	// Detect available shells (no paths)
	try {
		const shells = await detectShells();
		result.shells = shells.map((shell) => ({
			id: shell.id,
			name: shell.name,
			available: shell.available,
		}));
	} catch {
		// Shells detection failed, leave empty
	}

	// Check git availability
	try {
		const gitResult = await execFileNoThrow('git', ['--version']);
		if (gitResult.exitCode === 0) {
			result.git.available = true;
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
