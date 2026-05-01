import path from 'path';

export type CcpmArtifactKind = 'prd' | 'epic' | 'task' | 'progress' | 'bug';

export interface CcpmPathResolverConfig {
	ccpmRoot?: string;
	prdsDir?: string;
	epicsDir?: string;
}

export interface CcpmArtifactPathInput {
	projectPath: string;
	kind: CcpmArtifactKind;
	slug: string;
	taskId?: string | number;
	bugId?: string | number;
	config?: CcpmPathResolverConfig;
}

export interface CcpmProjectPaths {
	projectRoot: string;
	ccpmRoot: string;
	prdsDir: string;
	epicsDir: string;
	prdFile: string;
	epicDir: string;
	epicFile: string;
	tasksDir: string;
	progressFile: string;
	bugsDir: string;
}

const DEFAULT_CCPM_ROOT = '.claude';
const DEFAULT_PRDS_DIR = 'prds';
const DEFAULT_EPICS_DIR = 'epics';

export function slugifyCcpmSegment(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/['"]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return slug || 'untitled';
}

export function resolveCcpmProjectPaths(
	projectPath: string,
	slug: string,
	config: CcpmPathResolverConfig = {}
): CcpmProjectPaths {
	const safeSlug = slugifyCcpmSegment(slug);
	const projectRoot = path.resolve(projectPath);
	const ccpmRoot = resolveInsideProject(projectRoot, config.ccpmRoot ?? DEFAULT_CCPM_ROOT);
	const prdsDir = resolveInsideProject(
		projectRoot,
		path.resolve(ccpmRoot, config.prdsDir ?? DEFAULT_PRDS_DIR)
	);
	const epicsDir = resolveInsideProject(
		projectRoot,
		path.resolve(ccpmRoot, config.epicsDir ?? DEFAULT_EPICS_DIR)
	);
	const epicDir = path.resolve(epicsDir, safeSlug);

	return {
		projectRoot,
		ccpmRoot,
		prdsDir,
		epicsDir,
		prdFile: path.resolve(prdsDir, `${safeSlug}.md`),
		epicDir,
		epicFile: path.resolve(epicDir, 'epic.md'),
		tasksDir: path.resolve(epicDir, 'tasks'),
		progressFile: path.resolve(epicDir, 'progress.md'),
		bugsDir: path.resolve(epicDir, 'bugs'),
	};
}

export function resolveCcpmArtifactPath(input: CcpmArtifactPathInput): string {
	const paths = resolveCcpmProjectPaths(input.projectPath, input.slug, input.config);

	switch (input.kind) {
		case 'prd':
			return paths.prdFile;
		case 'epic':
			return paths.epicFile;
		case 'task':
			return path.resolve(paths.tasksDir, `${formatNumberedId(input.taskId, 'task')}.md`);
		case 'progress':
			return paths.progressFile;
		case 'bug':
			return path.resolve(paths.bugsDir, `${formatNumberedId(input.bugId, 'bug')}.md`);
		default: {
			const exhaustive: never = input.kind;
			return exhaustive;
		}
	}
}

function resolveInsideProject(projectRoot: string, configuredPath: string): string {
	if (path.isAbsolute(configuredPath)) {
		const resolved = path.resolve(configuredPath);
		const relative = path.relative(projectRoot, resolved);

		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error(`CCPM root must be inside the active project: ${configuredPath}`);
		}

		return resolved;
	}

	return path.resolve(projectRoot, configuredPath);
}

function formatNumberedId(value: string | number | undefined, fallback: string): string {
	if (typeof value === 'number') {
		return String(value).padStart(3, '0');
	}

	if (typeof value === 'string' && value.trim()) {
		return slugifyCcpmSegment(value);
	}

	return fallback;
}
