import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PlaybookSkillPromptMode } from '../../shared/types';
import { normalizePlaybookSkills } from '../../shared/playbookDag';

const DEFAULT_DESCRIPTION = 'No description';
const MAX_SKILL_CHARS = 1200;
const MAX_SKILL_BRIEF_CHARS = 220;
const MAX_SKILL_BLOCK_CHARS: Record<PlaybookSkillPromptMode, number> = {
	brief: 900,
	full: 2400,
};
const SKILL_BUDGET_TRUNCATION_NOTE = '[Additional skill guidance truncated for Auto Run budget]';

export interface ResolvedSkill {
	name: string;
	source: 'project' | 'user';
	filePath: string;
	description: string;
	instructions: string;
}

export interface ResolvedSkillSet {
	resolved: ResolvedSkill[];
	missing: string[];
}

interface ParsedSkillFile {
	name: string;
	description: string;
	body: string;
}

function parseSkillFile(content: string, fallbackName: string): ParsedSkillFile {
	const lines = content.split('\n');

	let name = fallbackName;
	let description = DEFAULT_DESCRIPTION;
	let body = content.trim();

	if (lines[0]?.trim() === '---') {
		let frontmatterEnd = -1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') {
				frontmatterEnd = i;
				break;
			}
		}

		if (frontmatterEnd !== -1) {
			const frontmatter = lines.slice(1, frontmatterEnd).join('\n');
			const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
			const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

			if (nameMatch) {
				name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
			}
			if (descMatch) {
				description = descMatch[1].trim().replace(/^["']|["']$/g, '');
			}

			body = lines
				.slice(frontmatterEnd + 1)
				.join('\n')
				.trim();
		}
	}

	return { name, description, body };
}

function readSkillMarkdown(skillDir: string): string | null {
	for (const candidate of ['skill.md', 'SKILL.md']) {
		const skillPath = path.join(skillDir, candidate);
		if (fs.existsSync(skillPath)) {
			return fs.readFileSync(skillPath, 'utf-8');
		}
	}
	return null;
}

function normalizeSkillName(name: string): string {
	return name.trim().toLowerCase();
}

function truncateSkillInstructions(text: string): string {
	if (text.length <= MAX_SKILL_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_SKILL_CHARS).trim()}\n\n[Skill content truncated for Auto Run prompt]`;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function sanitizeSkillLine(line: string): string {
	const trimmed = line.trim();
	if (!trimmed || trimmed === '---' || trimmed.startsWith('```') || trimmed.startsWith('#')) {
		return '';
	}

	return normalizeWhitespace(
		trimmed
			.replace(/^[-*+]\s+/, '')
			.replace(/^\d+\.\s+/, '')
			.replace(/^>\s+/, '')
	);
}

function truncateInlineText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	return `${text.slice(0, Math.max(maxChars - 1, 0)).trimEnd()}…`;
}

function buildSkillBrief(description: string, text: string): string {
	const segments: string[] = [];
	const seen = new Set<string>();
	const normalizedDescription = normalizeWhitespace(description);

	if (normalizedDescription && normalizedDescription !== DEFAULT_DESCRIPTION) {
		segments.push(normalizedDescription);
		seen.add(normalizedDescription.toLowerCase());
	}

	const usefulLines = text.split('\n').map(sanitizeSkillLine).filter(Boolean);

	for (const line of usefulLines) {
		const key = line.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		segments.push(line);
		seen.add(key);
		if (normalizeWhitespace(segments.join(' ')).length >= MAX_SKILL_BRIEF_CHARS) {
			break;
		}
	}

	const brief = normalizeWhitespace(segments.join(' '));
	if (!brief) {
		return '';
	}

	return truncateInlineText(brief, MAX_SKILL_BRIEF_CHARS);
}

function buildSkillPromptEntry(skill: ResolvedSkill, mode: PlaybookSkillPromptMode): string {
	if (mode === 'full') {
		const parts = [`### ${skill.name}`];
		if (skill.description && skill.description !== DEFAULT_DESCRIPTION) {
			parts.push(skill.description);
		}
		parts.push(skill.instructions);
		return parts.join('\n\n').trim();
	}

	const brief = buildSkillBrief(skill.description, skill.instructions);
	return brief ? `- ${skill.name}: ${brief}` : `- ${skill.name}`;
}

function enforceSkillBlockBudget(entries: string[], mode: PlaybookSkillPromptMode): string[] {
	const maxChars = MAX_SKILL_BLOCK_CHARS[mode];
	const separator = mode === 'full' ? '\n\n' : '\n';
	const joinedEntries = entries.join(separator);

	if (joinedEntries.length <= maxChars) {
		return entries;
	}

	const reservedChars = separator.length + SKILL_BUDGET_TRUNCATION_NOTE.length;
	const truncatedEntries = truncateInlineText(joinedEntries, Math.max(maxChars - reservedChars, 0));

	return truncatedEntries
		? [truncatedEntries, SKILL_BUDGET_TRUNCATION_NOTE]
		: [SKILL_BUDGET_TRUNCATION_NOTE];
}

function scanSkillsDir(
	dir: string,
	source: 'project' | 'user',
	lookup: Map<string, ResolvedSkill>
): void {
	if (!fs.existsSync(dir)) {
		return;
	}

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}

		const skillDir = path.join(dir, entry.name);
		const content = readSkillMarkdown(skillDir);
		if (!content) {
			continue;
		}

		const parsed = parseSkillFile(content, entry.name);
		const normalizedDirName = normalizeSkillName(entry.name);
		const normalizedSkillName = normalizeSkillName(parsed.name);
		const filePath = path.join(
			skillDir,
			fs.existsSync(path.join(skillDir, 'skill.md')) ? 'skill.md' : 'SKILL.md'
		);
		const skill: ResolvedSkill = {
			name: parsed.name,
			source,
			filePath,
			description: parsed.description,
			instructions: truncateSkillInstructions(parsed.body),
		};

		lookup.set(normalizedDirName, skill);
		lookup.set(normalizedSkillName, skill);
	}
}

export function resolvePlaybookSkills(
	projectPath: string,
	requestedSkills: string[]
): ResolvedSkillSet {
	const normalizedRequestedSkills = normalizePlaybookSkills(requestedSkills);
	if (normalizedRequestedSkills.length === 0) {
		return { resolved: [], missing: [] };
	}

	const lookup = new Map<string, ResolvedSkill>();
	scanSkillsDir(path.join(projectPath, '.codex', 'skills'), 'project', lookup);
	scanSkillsDir(path.join(projectPath, '.claude', 'skills'), 'project', lookup);
	scanSkillsDir(path.join(os.homedir(), '.codex', 'skills'), 'user', lookup);
	scanSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'user', lookup);

	const resolved: ResolvedSkill[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();

	for (const requested of normalizedRequestedSkills) {
		const skill = lookup.get(normalizeSkillName(requested));
		if (!skill) {
			missing.push(requested);
			continue;
		}
		if (seen.has(skill.filePath)) {
			continue;
		}
		seen.add(skill.filePath);
		resolved.push(skill);
	}

	return { resolved, missing };
}

export function buildSkillPromptBlock(
	skills: ResolvedSkill[],
	mode: PlaybookSkillPromptMode = 'brief'
): string {
	if (skills.length === 0) {
		return '';
	}

	const header =
		mode === 'full'
			? [
					'## Project Skills',
					'',
					'Use the following skill guidance only when it helps complete the active task.',
				]
			: ['## Skill Briefs', '', 'Apply only the relevant guidance for the active task:'];
	const entries = enforceSkillBlockBudget(
		skills.map((skill) => buildSkillPromptEntry(skill, mode)),
		mode
	);

	return [...header, '', ...entries].join('\n').trim();
}
