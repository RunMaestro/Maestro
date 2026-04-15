import GithubSlugger from 'github-slugger';
import type { TocEntry } from './types';

// ─── Image Cache ──────────────────────────────────────────────────────────────

/** Global cache for loaded images to prevent re-fetching and flickering */
export const imageCache = new Map<
	string,
	{ dataUrl: string; width?: number; height?: number; loadedAt: number }
>();

/** Cache entries older than this are evicted (10 minutes) */
export const IMAGE_CACHE_TTL = 10 * 60 * 1000;

// Clean up old cache entries periodically
setInterval(() => {
	const now = Date.now();
	for (const [key, value] of imageCache.entries()) {
		if (now - value.loadedAt > IMAGE_CACHE_TTL) {
			imageCache.delete(key);
		}
	}
}, IMAGE_CACHE_TTL);

// ─── Large File Thresholds ────────────────────────────────────────────────────

/** Files larger than this will skip token counting (expensive operation) */
export const LARGE_FILE_TOKEN_SKIP_THRESHOLD = 1024 * 1024; // 1MB

/** Files larger than this will have content truncated for syntax highlighting */
export const LARGE_FILE_PREVIEW_LIMIT = 100 * 1024; // 100KB

// ─── Language Detection ───────────────────────────────────────────────────────

/** Map filename extension to syntax highlighting language code */
/** Extension → syntax highlighting language (module-scope for reuse) */
const LANGUAGE_MAP: Record<string, string> = {
	ts: 'typescript',
	tsx: 'tsx',
	js: 'javascript',
	jsx: 'jsx',
	json: 'json',
	md: 'markdown',
	py: 'python',
	rb: 'ruby',
	go: 'go',
	rs: 'rust',
	java: 'java',
	c: 'c',
	cpp: 'cpp',
	cs: 'csharp',
	php: 'php',
	html: 'html',
	css: 'css',
	scss: 'scss',
	sql: 'sql',
	sh: 'bash',
	yaml: 'yaml',
	yml: 'yaml',
	toml: 'toml',
	xml: 'xml',
	csv: 'csv',
	tsv: 'csv',
	jsonl: 'jsonl',
	ndjson: 'jsonl',
};

/** Map filename extension to syntax highlighting language code */
export const getLanguageFromFilename = (filename: string): string => {
	const ext = filename.split('.').pop()?.toLowerCase();
	return LANGUAGE_MAP[ext || ''] || 'text';
};

// ─── Binary Detection ─────────────────────────────────────────────────────────

/** Check if content appears to be binary (null bytes or high non-printable ratio) */
export const isBinaryContent = (content: string): boolean => {
	if (content.includes('\0')) return true;

	const sample = content.slice(0, 8192);
	if (sample.length === 0) return false;

	let nonPrintableCount = 0;
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i);
		if (code < 9 || (code > 13 && code < 32) || (code >= 127 && code < 160)) {
			nonPrintableCount++;
		}
	}

	return nonPrintableCount / sample.length > 0.1;
};

/** Known binary file extensions (module-scope Set for O(1) lookup) */
const BINARY_EXTENSIONS = new Set([
	// macOS/iOS specific
	'icns',
	'car',
	'actool',
	// Design files
	'psd',
	'ai',
	'sketch',
	'fig',
	'xd',
	// Compiled/object files
	'o',
	'a',
	'so',
	'dylib',
	'dll',
	'class',
	'pyc',
	'pyo',
	'wasm',
	// Database files
	'db',
	'sqlite',
	'sqlite3',
	// Fonts
	'ttf',
	'otf',
	'woff',
	'woff2',
	'eot',
	// Archives
	'zip',
	'tar',
	'gz',
	'7z',
	'rar',
	'bz2',
	'xz',
	'tgz',
	// Other binary
	'exe',
	'bin',
	'dat',
	'pak',
]);

/** Check if file extension indicates a known binary format */
export const isBinaryExtension = (filename: string): boolean => {
	const ext = filename.split('.').pop()?.toLowerCase();
	return BINARY_EXTENSIONS.has(ext || '');
};

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Format file size in human-readable format */
export const formatFileSize = (bytes: number): string => {
	if (bytes <= 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

/** Format ISO date/time for display */
export const formatDateTime = (isoString: string): string => {
	const date = new Date(isoString);
	return date.toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
};

// ─── Markdown Helpers ─────────────────────────────────────────────────────────

/** Count markdown task checkboxes (- [ ] and - [x]), skipping code fences */
export const countMarkdownTasks = (content: string): { open: number; closed: number } => {
	const lines = content.split('\n');
	let inCodeFence = false;
	let open = 0;
	let closed = 0;

	for (const line of lines) {
		if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) continue;

		if (/^[\s]*[-*]\s*\[\s*\]/.test(line)) open++;
		if (/^[\s]*[-*]\s*\[[xX]\]/.test(line)) closed++;
	}

	return { open, closed };
};

/** Extract headings from markdown content for table of contents */
export const extractHeadings = (content: string): TocEntry[] => {
	const headings: TocEntry[] = [];
	const lines = content.split('\n');
	let inCodeFence = false;
	const slugger = new GithubSlugger();

	for (const line of lines) {
		if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) continue;

		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const level = match[1].length;
			const text = match[2].trim();
			const slug = slugger.slug(text);
			headings.push({ level, text, slug });
		}
	}

	return headings;
};

/**
 * Normalize a POSIX-style path by resolving `.` and `..` segments.
 * Does not use Node's path module (runs in renderer).
 */
function normalizePosixPath(p: string): string {
	const parts = p.split('/');
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') continue;
		if (part === '..') {
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}
	return (p.startsWith('/') ? '/' : '') + resolved.join('/');
}

/** Resolve image path relative to markdown file directory */
export const resolveImagePath = (src: string, markdownFilePath: string): string => {
	if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
		return src;
	}

	if (src.startsWith('/')) {
		return src;
	}

	const markdownDir = markdownFilePath.substring(0, markdownFilePath.lastIndexOf('/'));
	if (!markdownDir) return normalizePosixPath(src);
	return normalizePosixPath(`${markdownDir}/${src}`);
};
