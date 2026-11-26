/**
 * The Claude Code skills a project can use: `.claude/skills/<name>/SKILL.md` in the project, then
 * in the user's home. What `/skills` lists, read the same way by the desktop (`claude:getSkills`)
 * and by a headless host's runtime.
 */

import fs from 'fs/promises';
import path from 'path';
import type { ClaudeSkillSummary } from '../../maestroBuiltinCommandText';

/** Only a missing entry means "no skill here"; a permission or I/O error is the caller's to see. */
function isMissingEntryError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * One SKILL.md as a skill: its frontmatter `name` and `description` (the directory name and
 * "No description" when absent), and about four characters per token. `null` when it is not there.
 */
async function readSkillFile(
	filePath: string,
	skillDirName: string,
	source: ClaudeSkillSummary['source']
): Promise<ClaudeSkillSummary | null> {
	let content: string;
	try {
		content = await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		if (isMissingEntryError(error)) return null;
		throw error;
	}
	let name = skillDirName;
	let description = 'No description';
	let inFrontmatter = false;
	let frontmatter = '';
	for (const line of content.split('\n')) {
		if (line.trim() === '---') {
			if (inFrontmatter) break;
			inFrontmatter = true;
			continue;
		}
		if (inFrontmatter) frontmatter += line + '\n';
	}
	const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
	const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
	if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
	if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
	return { name, description, tokenCount: Math.round(content.length / 4), source };
}

/**
 * The skills in one skills directory. Claude Code writes `SKILL.md`; a case-sensitive file system
 * (Linux, WSL) does not match `skill.md` to it, so the canonical name is tried first.
 */
async function readSkillsDir(
	dir: string,
	source: ClaudeSkillSummary['source']
): Promise<ClaudeSkillSummary[]> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isMissingEntryError(error)) return [];
		throw error;
	}
	const skills: ClaudeSkillSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		for (const candidate of ['SKILL.md', 'skill.md']) {
			const skill = await readSkillFile(path.join(dir, entry.name, candidate), entry.name, source);
			if (skill) {
				skills.push(skill);
				break;
			}
		}
	}
	return skills;
}

/** The project's skills, then the user's. Throws on a permission or I/O error. */
export async function discoverClaudeSkills(
	projectPath: string,
	homeDir: string
): Promise<ClaudeSkillSummary[]> {
	return [
		...(await readSkillsDir(path.join(projectPath, '.claude', 'skills'), 'project')),
		...(await readSkillsDir(path.join(homeDir, '.claude', 'skills'), 'user')),
	];
}
