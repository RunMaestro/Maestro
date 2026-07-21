import os from 'os';
import path from 'path';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';

/** Return the local Claude Code projects root for a home directory. */
export function getClaudeProjectsDir(homeDir = os.homedir()): string {
	return path.join(homeDir, '.claude', 'projects');
}

/** Return the local Claude Code directory for one project using Claude's path encoding. */
export function getClaudeProjectDir(projectPath: string, homeDir?: string): string {
	return path.join(getClaudeProjectsDir(homeDir), encodeClaudeProjectPath(projectPath));
}
