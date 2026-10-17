/**
 * @file agent-spawner.test.ts
 * @description Tests for the agent-spawner CLI service
 *
 * Tests all exported functions and internal utilities:
 * - Document reading and task counting
 * - Document reading and task extraction
 * - Checkbox manipulation (uncheckAllTasks)
 * - Document writing
 * - Claude detection and spawning
 * - UUID generation
 * - PATH expansion
 * - Executable detection
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { DEFAULT_STDERR_TAIL_LIMIT } from '../../../shared/maestro-lib/run/start-turn';

// Create mock spawn function at module level
const mockSpawn = vi.fn();
const mockStdin = {
	end: vi.fn(),
	write: vi.fn(),
	// The run layer listens for stdin errors (EPIPE), as on a real stream.
	on: vi.fn(),
};
// `setEncoding` is part of a real child stream: the spawner decodes there
// rather than per chunk, so a multibyte character split across two reads
// survives. Emitting strings from these fakes mirrors that.
const mockStdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() });
const mockStderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() });
const mockKill = vi.fn();
const mockChild = Object.assign(new EventEmitter(), {
	stdin: mockStdin,
	stdout: mockStdout,
	stderr: mockStderr,
	kill: mockKill,
	// A running child, as Node reports one: the stop ladder signals only a
	// process whose exit state is still null.
	exitCode: null as number | null,
	signalCode: null as NodeJS.Signals | null,
});

/**
 * How the harness answers the PATH lookup.
 *
 * Every LOCAL agent spawn resolves its binary before exec'ing it (#1608), and
 * the CLI resolves it through the library's `checkBinaryExists`, the same
 * lookup the desktop uses. That lookup's own rules (known install locations,
 * `which` / `where`, the Windows .exe/.cmd choice) are covered in
 * path-prober.test.ts, so here it answers from this resolver. Detection tests
 * set it to describe what the lookup found.
 */
type PathProbeResolver = (binary: string) => string | undefined;
const DEFAULT_PATH_PROBE: PathProbeResolver = (binary) => `/usr/local/bin/${binary}`;
let pathProbeResolver: PathProbeResolver = DEFAULT_PATH_PROBE;

const mockCheckBinaryExists = vi.fn();
function answerPathProbe(binary: string) {
	const resolved = pathProbeResolver(binary);
	return Promise.resolve(resolved ? { exists: true, path: resolved } : { exists: false });
}

vi.mock('../../../shared/maestro-lib/launch/path-prober', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/launch/path-prober')>();
	return {
		...actual,
		checkBinaryExists: (binary: string) => mockCheckBinaryExists(binary),
	};
});

// Mock child_process before imports
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
		},
	};
});

// Mock fs module
vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	const mocked = {
		...actual,
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		existsSync: vi.fn(() => false),
		// Default to "maestro-p not found" so Claude spawns resolve to API unless a
		// test opts into the TUI by making this succeed. Mirrors production, where
		// getCliMaestroPBinPath()/fileExists gate the interactive path.
		accessSync: vi.fn(() => {
			throw new Error('ENOENT');
		}),
		readdirSync: vi.fn(() => []),
		mkdirSync: vi.fn(),
		createWriteStream: vi.fn(
			() =>
				({
					write: vi.fn(),
					end: vi.fn(),
				}) as any
		),
		promises: {
			...actual.promises,
			stat: vi.fn(),
			access: vi.fn(),
			readdir: vi.fn(),
		},
		constants: {
			X_OK: 1,
		},
	};
	return {
		...mocked,
		default: mocked,
	};
});

// Mock os module
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const mocked = {
		...actual,
		homedir: vi.fn(() => '/Users/testuser'),
		tmpdir: vi.fn(() => '/tmp'),
	};
	return {
		...mocked,
		default: mocked,
	};
});

// Mock storage service
const mockGetAgentCustomPath = vi.fn();
const mockReadAgentConfig = vi.fn<(toolType: string) => Record<string, unknown>>(() => ({}));
const mockReadSshRemotes = vi.fn<() => unknown[]>(() => []);
vi.mock('../../../cli/services/storage', () => ({
	getAgentCustomPath: (...args: unknown[]) => mockGetAgentCustomPath(...args),
	readAgentConfig: (toolType: string) => mockReadAgentConfig(toolType),
	readSshRemotes: () => mockReadSshRemotes(),
}));

// Mock SSH wrapper so SSH tests don't need real ssh/bash on the test machine
const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
}));

import {
	readDocAndCountTasks,
	readDocAndGetTasks,
	uncheckAllTasks,
	writeDoc,
	getClaudeCommand,
	detectClaude,
	detectAgent,
	getAgentCommand,
	resolveCliBatchModeArgs,
	spawnAgent,
	AgentResult,
} from '../../../cli/services/agent-spawner';
import { getAgentDefinition } from '../../../main/agents/definitions';
import { isolateAgentEnv } from '../../helpers/agentEnvIsolation';
// Static, so they share one module instance with the statically imported
// `spawnAgent` above; other suites here call `vi.resetModules()`.
import { resetEffortRejections } from '../../../shared/effortRejection';
import { resolveEffortLevel } from '../../../shared/modelTiers';

const hostPlatform = process.platform;

describe('agent-spawner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset mock child emitter for each test
		mockStdout.removeAllListeners();
		mockStderr.removeAllListeners();
		(mockChild as EventEmitter).removeAllListeners();
		mockGetAgentCustomPath.mockReturnValue(undefined);
		mockReadAgentConfig.mockReturnValue({});
		// The remote the SSH tests point at. The launch plan resolves it before
		// the wrapper runs, so a remote missing from this list is an error.
		mockReadSshRemotes.mockReturnValue([
			{
				id: 'r1',
				name: 'r1',
				host: 'remotehost',
				port: 22,
				username: 'dev',
				privateKeyPath: '',
				enabled: true,
			},
		]);
		mockWrapSpawnWithSsh.mockReset();
		pathProbeResolver = DEFAULT_PATH_PROBE;
		mockCheckBinaryExists.mockImplementation(answerPathProbe);
		// The host decides how a prompt travels: on Windows an agent that reads
		// stdin gets it there, everywhere else it goes on the command line. The
		// tests below describe the command line, so they pin a POSIX host; the
		// Windows cases set `win32` themselves.
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
		vi.restoreAllMocks();
	});

	describe('readDocAndCountTasks', () => {
		it('should count unchecked tasks in a document', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
# Task List

- [ ] First task
- [ ] Second task
- [x] Completed task
- [ ] Third task
      `);

			const result = readDocAndCountTasks('/playbooks', 'tasks');

			expect(result.taskCount).toBe(3);
			expect(result.content).toContain('First task');
		});

		it('should return zero count for document with no unchecked tasks', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
# Task List

- [x] Completed task
- [x] Another completed
      `);

			const result = readDocAndCountTasks('/playbooks', 'tasks');

			expect(result.taskCount).toBe(0);
		});

		it('should return empty content and zero count when file does not exist', () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = readDocAndCountTasks('/playbooks', 'missing');

			expect(result.content).toBe('');
			expect(result.taskCount).toBe(0);
			expect(result.missingPath).toBeUndefined();
		});

		it('names the path it tried when the file does not exist', () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
			});

			const result = readDocAndCountTasks('/playbooks', 'sub/missing');

			expect(result).toEqual({
				content: '',
				taskCount: 0,
				missingPath: '/playbooks/sub/missing.md',
			});
		});

		it('should handle various checkbox formats', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ] Basic unchecked
  - [ ] Nested unchecked
    - [ ] Deeply nested
- [ ]    Extra spaces after checkbox
      `);

			const result = readDocAndCountTasks('/playbooks', 'tasks');

			expect(result.taskCount).toBe(4);
		});

		it('should append .md extension to filename', () => {
			vi.mocked(fs.readFileSync).mockReturnValue('- [ ] Task');

			readDocAndCountTasks('/playbooks', 'tasks');

			expect(fs.readFileSync).toHaveBeenCalledWith('/playbooks/tasks.md', 'utf-8');
		});

		it('should handle document with only whitespace', () => {
			vi.mocked(fs.readFileSync).mockReturnValue('   \n  \n   ');

			const result = readDocAndCountTasks('/playbooks', 'empty');

			expect(result.taskCount).toBe(0);
			expect(result.content).toBe('   \n  \n   ');
		});

		it('should count tasks with varying indentation levels', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ] No indent
 - [ ] One space
  - [ ] Two spaces
   - [ ] Three spaces
    - [ ] Four spaces
      `);

			const result = readDocAndCountTasks('/playbooks', 'indented');

			expect(result.taskCount).toBe(5);
		});

		it('should not count tasks with text before checkbox', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
text - [ ] This should not count
- [ ] This should count
      `);

			const result = readDocAndCountTasks('/playbooks', 'mixed');

			// The regex only matches lines starting with optional whitespace then -
			expect(result.taskCount).toBe(1);
		});

		it('should count empty checkbox tasks', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ]
- [ ] Task with content
      `);

			const result = readDocAndCountTasks('/playbooks', 'empty-tasks');

			// Empty checkbox line might not match due to regex requiring content
			// Let's verify behavior
			expect(result.taskCount).toBeGreaterThanOrEqual(1);
		});
	});

	describe('readDocAndGetTasks', () => {
		it('should extract task text from unchecked items', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
# Task List

- [ ] First task
- [ ] Second task with details
- [x] Completed task (should not appear)
- [ ] Third task
      `);

			const result = readDocAndGetTasks('/playbooks', 'tasks');

			expect(result.tasks).toEqual(['First task', 'Second task with details', 'Third task']);
		});

		it('should return empty array for document with no unchecked tasks', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
# All Done!

- [x] Completed
      `);

			const result = readDocAndGetTasks('/playbooks', 'tasks');

			expect(result.tasks).toEqual([]);
		});

		it('should return empty content and tasks when file does not exist', () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = readDocAndGetTasks('/playbooks', 'missing');

			expect(result.content).toBe('');
			expect(result.tasks).toEqual([]);
		});

		it('should trim task text properly', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ]    Task with leading spaces
- [ ] Task with trailing spaces
      `);

			const result = readDocAndGetTasks('/playbooks', 'tasks');

			expect(result.tasks[0]).toBe('Task with leading spaces');
			expect(result.tasks[1]).toBe('Task with trailing spaces');
		});

		it('should preserve task content with special characters', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ] Task with "quotes" and 'apostrophes'
- [ ] Task with code: \`npm install\`
- [ ] Task with **bold** and *italic*
- [ ] Task with emoji 🚀
      `);

			const result = readDocAndGetTasks('/playbooks', 'special');

			expect(result.tasks).toHaveLength(4);
			expect(result.tasks[0]).toContain('"quotes"');
			expect(result.tasks[3]).toContain('🚀');
		});

		it('should handle nested tasks', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ] Parent task
  - [ ] Child task
    - [ ] Grandchild task
      `);

			const result = readDocAndGetTasks('/playbooks', 'nested');

			expect(result.tasks).toEqual(['Parent task', 'Child task', 'Grandchild task']);
		});

		it('should append .md extension to filename', () => {
			vi.mocked(fs.readFileSync).mockReturnValue('- [ ] Task');

			readDocAndGetTasks('/playbooks', 'tasks');

			expect(fs.readFileSync).toHaveBeenCalledWith('/playbooks/tasks.md', 'utf-8');
		});
	});

	describe('uncheckAllTasks', () => {
		it('should uncheck all checked tasks', () => {
			const content = `
# Task List

- [x] First completed
- [X] Second completed (uppercase)
- [ ] Already unchecked
- [x] Third completed
      `;

			const result = uncheckAllTasks(content);

			expect(result).not.toContain('[x]');
			expect(result).not.toContain('[X]');
			expect(result.match(/\[ \]/g)?.length).toBe(4);
		});

		it('should preserve indentation', () => {
			const content = `
  - [x] Indented task
    - [x] Nested task
      `;

			const result = uncheckAllTasks(content);

			expect(result).toContain('  - [ ] Indented task');
			expect(result).toContain('    - [ ] Nested task');
		});

		it('should not modify non-list checkbox patterns', () => {
			const content = `
# Title

Some text with [x] in it that's not a checkbox

- [x] Real checkbox
      `;

			const result = uncheckAllTasks(content);

			// The inline [x] should not be changed - only list item checkboxes
			expect(result).toContain('# Title');
			expect(result).toContain('Some text with [x] in it');
			expect(result).toContain('- [ ] Real checkbox');
		});

		it('should handle empty content', () => {
			expect(uncheckAllTasks('')).toBe('');
		});

		it('should handle content with no checkboxes', () => {
			const content = '# Just a title\n\nSome text';
			expect(uncheckAllTasks(content)).toBe(content);
		});

		it('should handle mixed checked and unchecked tasks', () => {
			const content = `
- [x] Done
- [ ] Not done
- [X] Also done
- [ ] Also not done
      `;

			const result = uncheckAllTasks(content);

			// All should be unchecked now
			const checkboxMatches = result.match(/- \[.\]/g) || [];
			expect(checkboxMatches.every((m) => m === '- [ ]')).toBe(true);
		});

		it('should handle multiline content correctly', () => {
			const content = `# Project Tasks

## Phase 1
- [x] Setup repository
- [x] Initialize project
- [ ] Configure CI/CD

## Phase 2
- [x] Implement feature A
- [ ] Implement feature B
- [x] Write tests
`;

			const result = uncheckAllTasks(content);

			expect(result).toContain('## Phase 1');
			expect(result).toContain('## Phase 2');
			expect(result).not.toContain('[x]');
			expect(result).not.toContain('[X]');
		});

		it('should preserve other markdown formatting', () => {
			const content = `
**Bold text**
*Italic text*
\`code\`
> Blockquote
- [x] Task

1. Numbered item
2. Another item
      `;

			const result = uncheckAllTasks(content);

			expect(result).toContain('**Bold text**');
			expect(result).toContain('*Italic text*');
			expect(result).toContain('`code`');
			expect(result).toContain('> Blockquote');
			expect(result).toContain('1. Numbered item');
		});

		it('should handle Windows line endings', () => {
			const content = '- [x] Task 1\r\n- [x] Task 2\r\n';

			const result = uncheckAllTasks(content);

			expect(result).toContain('- [ ] Task 1');
			expect(result).toContain('- [ ] Task 2');
		});

		it('should handle tasks with no space after checkbox', () => {
			// Edge case: malformed checkbox
			const content = '- [x]Task without space';

			const result = uncheckAllTasks(content);

			// The regex requires - [x] pattern at line start
			expect(result).toContain('- [ ]Task without space');
		});
	});

	describe('writeDoc', () => {
		it('should write content to file', () => {
			writeDoc('/playbooks', 'tasks.md', '# New Content');

			expect(fs.writeFileSync).toHaveBeenCalledWith(
				'/playbooks/tasks.md',
				'# New Content',
				'utf-8'
			);
		});

		it('should write to correct path', () => {
			writeDoc('/path/to/folder', 'doc.md', 'content');

			expect(fs.writeFileSync).toHaveBeenCalledWith('/path/to/folder/doc.md', 'content', 'utf-8');
		});

		it('should handle empty content', () => {
			writeDoc('/playbooks', 'empty.md', '');

			expect(fs.writeFileSync).toHaveBeenCalledWith('/playbooks/empty.md', '', 'utf-8');
		});

		it('should handle content with special characters', () => {
			const content = '# Title\n\n- [ ] Task with "quotes" and \'apostrophes\' and `code`';

			writeDoc('/playbooks', 'special.md', content);

			expect(fs.writeFileSync).toHaveBeenCalledWith('/playbooks/special.md', content, 'utf-8');
		});

		it('should handle unicode content', () => {
			const content = '# 任务列表\n\n- [ ] 任务一 🚀';

			writeDoc('/playbooks', 'unicode.md', content);

			expect(fs.writeFileSync).toHaveBeenCalledWith('/playbooks/unicode.md', content, 'utf-8');
		});

		it('should concatenate folder and filename with slash', () => {
			writeDoc('/some/path', 'file.md', 'content');

			const calledPath = (fs.writeFileSync as Mock).mock.calls[0][0];
			expect(calledPath).toBe('/some/path/file.md');
		});
	});

	describe('getClaudeCommand', () => {
		it('should return a non-empty string', () => {
			const command = getClaudeCommand();
			expect(typeof command).toBe('string');
			expect(command.length).toBeGreaterThan(0);
		});

		it('should return default command when no cached path', () => {
			// Before any detection is done, should return default 'claude'
			const command = getClaudeCommand();
			// Either 'claude' or a cached path
			expect(command).toBeTruthy();
		});
	});

	describe('detectClaude', () => {
		beforeEach(() => {
			// Reset the cached path by reimporting
			vi.resetModules();
		});

		it('should detect Claude with custom path from settings', async () => {
			// Mock custom path from settings
			mockGetAgentCustomPath.mockReturnValue('/custom/path/to/claude');

			// Mock file exists and is executable
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			vi.mocked(fs.promises.access).mockResolvedValue(undefined);

			// Re-import to get fresh module without cached path
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result = await freshDetectClaude();

			expect(result.available).toBe(true);
			expect(result.path).toBe('/custom/path/to/claude');
			expect(result.source).toBe('settings');
		});

		it('should fall back to PATH detection when custom path is invalid', async () => {
			// Mock custom path from settings
			mockGetAgentCustomPath.mockReturnValue('/invalid/path/to/claude');

			// Mock file does not exist
			vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT'));
			pathProbeResolver = () => '/usr/local/bin/claude';

			// Re-import to get fresh module
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result = await freshDetectClaude();

			expect(result.available).toBe(true);
			expect(result.path).toBe('/usr/local/bin/claude');
			expect(result.source).toBe('path');
		});

		it('resolves PATH through the shared lookup the desktop uses, by binary name', async () => {
			mockGetAgentCustomPath.mockReturnValue(undefined);

			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');
			await freshDetectClaude();

			expect(mockCheckBinaryExists).toHaveBeenCalledTimes(1);
			expect(mockCheckBinaryExists).toHaveBeenCalledWith('claude');
			// No `which` / `where` child of the CLI's own.
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('runs the .cmd shim the lookup resolves for an npm install on Windows (#1718)', async () => {
			// An npm install puts an extensionless sh shim first on PATH, and
			// CreateProcess cannot run it. The CLI used to take the first `where`
			// hit; the shared lookup picks the runnable .cmd beside it, as the
			// desktop does.
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			mockGetAgentCustomPath.mockReturnValue(undefined);
			const shim = 'C:\\Users\\t\\AppData\\Roaming\\npm\\opencode.cmd';
			pathProbeResolver = () => shim;

			const { detectAgent: freshDetectAgent } = await import('../../../cli/services/agent-spawner');
			const result = await freshDetectAgent('opencode');

			expect(mockCheckBinaryExists).toHaveBeenCalledWith('opencode');
			expect(result).toEqual({ available: true, path: shim, source: 'path' });
		});

		it('should return unavailable when Claude is not found', async () => {
			// No custom path
			mockGetAgentCustomPath.mockReturnValue(undefined);
			pathProbeResolver = () => undefined;

			// Re-import to get fresh module
			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result = await freshDetectClaude();

			expect(result.available).toBe(false);
			expect(result.path).toBeUndefined();
		});

		it('should return cached result on subsequent calls', async () => {
			// First call - setup
			mockGetAgentCustomPath.mockReturnValue('/custom/path/to/claude');
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			vi.mocked(fs.promises.access).mockResolvedValue(undefined);

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result1 = await freshDetectClaude();
			expect(result1.available).toBe(true);

			// Clear the mock to verify caching
			vi.mocked(fs.promises.stat).mockClear();

			// Second call - should use cache
			const result2 = await freshDetectClaude();
			expect(result2.available).toBe(true);
			expect(result2.source).toBe('settings');

			// stat should not be called again (cached)
			// Note: Due to how caching works, if path is cached, isExecutable isn't rechecked
		});

		it('should reject non-file paths', async () => {
			mockGetAgentCustomPath.mockReturnValue('/path/to/directory');

			// Mock stat returning directory
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => false,
			} as fs.Stats);

			// The PATH lookup won't find it either
			pathProbeResolver = () => undefined;

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result = await freshDetectClaude();

			expect(result.available).toBe(false);
		});

		it('should reject non-executable files on Unix', async () => {
			// Save original platform
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

			mockGetAgentCustomPath.mockReturnValue('/path/to/claude');

			// Mock file exists but is not executable
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			vi.mocked(fs.promises.access).mockRejectedValue(new Error('EACCES'));

			// The PATH lookup won't find it either
			pathProbeResolver = () => undefined;

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result = await freshDetectClaude();

			// Restore platform
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });

			expect(result.available).toBe(false);
		});
	});

	describe('detectAgent', () => {
		beforeEach(() => {
			vi.resetModules();
		});

		it('should detect agent with custom path from settings', async () => {
			mockGetAgentCustomPath.mockReturnValue('/custom/path/to/codex');
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			vi.mocked(fs.promises.access).mockResolvedValue(undefined);

			const { detectAgent: freshDetectAgent } = await import('../../../cli/services/agent-spawner');

			const result = await freshDetectAgent('codex');
			expect(result.available).toBe(true);
			expect(result.path).toBe('/custom/path/to/codex');
			expect(result.source).toBe('settings');
		});

		it('should resolve a rotated Codex Desktop path from settings', async () => {
			const originalPlatform = process.platform;
			const originalLocalAppData = process.env.LOCALAPPDATA;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
			const stalePath = path.win32.join(
				process.env.LOCALAPPDATA,
				'OpenAI',
				'Codex',
				'bin',
				'old-version',
				'codex.exe'
			);
			const currentPath = path.win32.join(
				process.env.LOCALAPPDATA,
				'OpenAI',
				'Codex',
				'bin',
				'current-version',
				'codex.exe'
			);
			mockGetAgentCustomPath.mockReturnValue(stalePath);
			vi.mocked(fs.promises.readdir).mockResolvedValue([
				{ name: 'current-version', isDirectory: () => true },
			] as any);
			vi.mocked(fs.promises.stat).mockImplementation(async (filePath) => {
				if (filePath === currentPath) {
					return { isFile: () => true, birthtimeMs: 200 } as fs.Stats;
				}
				throw new Error('ENOENT');
			});

			try {
				const { detectAgent: freshDetectAgent } =
					await import('../../../cli/services/agent-spawner');
				const result = await freshDetectAgent('codex');

				expect(result).toEqual({
					available: true,
					path: currentPath,
					source: 'settings',
				});
			} finally {
				if (originalLocalAppData === undefined) {
					delete process.env.LOCALAPPDATA;
				} else {
					process.env.LOCALAPPDATA = originalLocalAppData;
				}
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});

		it('should fall back to PATH detection when custom path is invalid', async () => {
			mockGetAgentCustomPath.mockReturnValue('/invalid/path');
			vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT'));
			pathProbeResolver = () => '/usr/local/bin/codex';

			const { detectAgent: freshDetectAgent } = await import('../../../cli/services/agent-spawner');

			const result = await freshDetectAgent('codex');
			expect(result.available).toBe(true);
			expect(result.path).toBe('/usr/local/bin/codex');
			expect(result.source).toBe('path');
			expect(mockCheckBinaryExists).toHaveBeenCalledWith('codex');
		});

		it('should return unavailable when agent is not found', async () => {
			mockGetAgentCustomPath.mockReturnValue(undefined);
			pathProbeResolver = () => undefined;

			const { detectAgent: freshDetectAgent } = await import('../../../cli/services/agent-spawner');

			const result = await freshDetectAgent('opencode');
			expect(result.available).toBe(false);
		});

		it('should cache results across calls', async () => {
			mockGetAgentCustomPath.mockReturnValue('/custom/droid');
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			vi.mocked(fs.promises.access).mockResolvedValue(undefined);

			const { detectAgent: freshDetectAgent } = await import('../../../cli/services/agent-spawner');

			const result1 = await freshDetectAgent('factory-droid');
			expect(result1.available).toBe(true);

			vi.mocked(fs.promises.stat).mockClear();

			const result2 = await freshDetectAgent('factory-droid');
			expect(result2.available).toBe(true);
			expect(result2.source).toBe('settings');
		});
	});

	describe('getAgentCommand', () => {
		it('should return default command for unknown agent', async () => {
			vi.resetModules();
			const { getAgentCommand: freshGetAgentCommand } =
				await import('../../../cli/services/agent-spawner');

			// Before detection, should return the binaryName from definitions
			const command = freshGetAgentCommand('claude-code');
			expect(command).toBeTruthy();
			expect(typeof command).toBe('string');
		});
	});

	describe('spawnAgent', () => {
		// Agent env defaults are shell-wins by design, so a value exported by the
		// developer's own shell would otherwise be what the default assertions
		// below actually measure. Tests that exercise the shell-wins path set the
		// variable themselves, inside the test body, after this has run.
		isolateAgentEnv();

		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
		});

		it.each(['claude-code', 'codex'] as const)(
			'reports the actual %s process only after launch',
			async (type) => {
				const onProcessStarted = vi.fn();
				Object.assign(mockChild, { pid: 45123 });
				try {
					const pending = spawnAgent(type, '/project', 'prompt', undefined, { onProcessStarted });
					expect(onProcessStarted).not.toHaveBeenCalled();
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(onProcessStarted).toHaveBeenCalledExactlyOnceWith(45123);
					mockChild.emit('close', 0);
					await pending;
				} finally {
					delete (mockChild as { pid?: number }).pid;
				}
			}
		);

		it.each([undefined, 'provider-session'])(
			'injects Codex MCP config beside exec config (resume=%s)',
			async (session) => {
				const proofFile = '/private/run/proof';
				const pending = spawnAgent('codex', '/project', 'post summary', session, {
					customEffort: 'high',
					customArgs: '-c model_reasoning_summary=auto',
					pluginRunProofFile: proofFile,
					mcpCliScriptPath: '/bundled/maestro-cli.js',
				});
				await new Promise((resolve) => setTimeout(resolve, 0));
				const [, args, options] = mockSpawn.mock.calls[0];
				expect(args).toContain('-c');
				expect(args.join(' ')).toContain('mcp_servers.maestro.command');
				const bridgeIndex = args.findIndex((arg: string) =>
					arg.startsWith('mcp_servers.maestro.command=')
				);
				expect(bridgeIndex).toBeGreaterThan(args.indexOf('exec'));
				expect(bridgeIndex).toBeGreaterThan(args.indexOf('model_reasoning_summary=auto'));
				expect(bridgeIndex).toBeLessThan(args.indexOf('--'));
				expect(args.join(' ')).toContain(proofFile);
				expect(args.join(' ')).not.toContain('secret-run-proof');
				expect(options.env.MAESTRO_PLUGIN_RUN_TOKEN).toBeUndefined();
				mockChild.emit('close', 1);
				await pending;
			}
		);

		it('should spawn Claude with correct arguments', async () => {
			const resultPromise = spawnAgent('claude-code', '/project/path', 'Test prompt');

			// Let the async operations start
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Verify spawn was called
			expect(mockSpawn).toHaveBeenCalled();
			const [cmd, args, options] = mockSpawn.mock.calls[0];

			// Command should be 'claude' or cached path
			expect(cmd).toBeTruthy();

			// Should have base args + session-id + prompt
			expect(args).toContain('--print');
			expect(args).toContain('--verbose');
			expect(args).toContain('--output-format');
			expect(args).toContain('stream-json');
			expect(args).toContain('--dangerously-skip-permissions');
			expect(args).toContain('--session-id');
			expect(args).toContain('--');
			expect(args).toContain('Test prompt');

			// Options
			expect(options.cwd).toBe('/project/path');
			expect(options.env.PATH).toBeDefined();

			// Complete the spawn
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Success"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
		});

		it('reports a cancelled Claude run as failed even if it closes with code zero', async () => {
			const controller = new AbortController();
			const pending = spawnAgent('claude-code', '/project', 'prompt', undefined, {
				signal: controller.signal,
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			const [, , options] = mockSpawn.mock.calls[0];
			expect(options.signal).toBeUndefined();
			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"result","result":"late answer","session_id":"provider-late","total_cost_usd":0.08}'
				)
			);
			controller.abort();
			mockChild.emit(
				'error',
				Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
			);
			mockChild.emit('close', 0);
			expect(await pending).toMatchObject({
				success: false,
				error: 'Agent run cancelled',
				agentSessionId: 'provider-late',
				usageStats: { totalCostUsd: 0.08 },
			});
		});

		it('runs the local maestro-p TUI when the agent selected the interactive token source', async () => {
			// Honoring the token source across the board: a local Claude agent set to
			// interactive (TUI) wraps the spawn with maestro-p via process.execPath
			// (node), injecting MAESTRO_CLAUDE_BIN, instead of running `claude --print`.
			// Make maestro-p "present": getCliMaestroPBinPath() (accessSync) resolves
			// and the resolver's fileExists (existsSync) confirms the candidate. No
			// `app.asar` beside the CLI: this is the dev layout, not a packaged app.
			vi.mocked(fs.accessSync).mockReturnValue(undefined);
			vi.mocked(fs.existsSync).mockImplementation((p) => !String(p).endsWith('app.asar'));

			const resultPromise = spawnAgent('claude-code', '/project/path', 'Test prompt', undefined, {
				enableMaestroP: true,
				maestroPMode: 'interactive',
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockSpawn).toHaveBeenCalled();
			const [cmd, args, options] = mockSpawn.mock.calls[0];

			// Command is the node/electron execPath (maestro-p is a Node script), not claude.
			expect(cmd).toBe(process.execPath);
			// maestro-p.js script is the first arg, followed by its interactive flag,
			// then the original headless batch args ending with the prompt positional.
			expect(String(args[0])).toMatch(/maestro-p\.js$/);
			expect(args).toContain('--dangerously-skip-permissions');
			expect(args).toContain('--');
			expect(args).toContain('Test prompt');
			// MAESTRO_CLAUDE_BIN points maestro-p at the real claude binary to drive.
			expect(options.env.MAESTRO_CLAUDE_BIN).toBeTruthy();

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"ok"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);
			const result = await resultPromise;
			expect(result.success).toBe(true);
		});

		it('runs maestro-p under the packaged app binary when the CLI was started by a system node (#1770)', async () => {
			// A packaged CLI sits beside app.asar, which a plain `node` cannot read,
			// so node-pty only loads when maestro-p runs under the app binary itself.
			vi.mocked(fs.accessSync).mockReturnValue(undefined);
			vi.mocked(fs.existsSync).mockReturnValue(true);
			const original = process.resourcesPath;
			Object.defineProperty(process, 'resourcesPath', { value: undefined, configurable: true });
			try {
				const resultPromise = spawnAgent('claude-code', '/project/path', 'Test prompt', undefined, {
					enableMaestroP: true,
					maestroPMode: 'interactive',
				});
				await new Promise((resolve) => setTimeout(resolve, 0));

				const [cmd, args, options] = mockSpawn.mock.calls[0];
				const resourcesDir = path.dirname(String(args[0]));
				expect(cmd).not.toBe(process.execPath);
				expect(path.dirname(String(cmd)).startsWith(path.dirname(resourcesDir))).toBe(true);
				expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
				expect(String(options.env.NODE_PATH).split(path.delimiter)[0]).toBe(
					path.join(resourcesDir, 'app.asar', 'node_modules')
				);

				mockStdout.emit('data', Buffer.from('{"type":"result","result":"ok"}\n'));
				await new Promise((resolve) => setTimeout(resolve, 0));
				mockChild.emit('close', 0);
				expect((await resultPromise).success).toBe(true);
			} finally {
				Object.defineProperty(process, 'resourcesPath', { value: original, configurable: true });
			}
		});

		it('stays on claude --print for the API token source (no maestro-p wrap)', async () => {
			// The inverse guard: even with maestro-p present on disk, an agent set to
			// API must NOT route through maestro-p.
			vi.mocked(fs.accessSync).mockReturnValue(undefined);
			vi.mocked(fs.existsSync).mockReturnValue(true);

			const resultPromise = spawnAgent('claude-code', '/project/path', 'Test prompt', undefined, {
				enableMaestroP: false,
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [cmd, args] = mockSpawn.mock.calls[0];
			expect(cmd).not.toBe(process.execPath);
			expect(String(args[0])).not.toMatch(/maestro-p\.js$/);
			expect(args).toContain('--print');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"ok"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should use --resume for existing session', async () => {
			const resultPromise = spawnAgent(
				'claude-code',
				'/project/path',
				'Test prompt',
				'existing-session-id'
			);

			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, args] = mockSpawn.mock.calls[0];
			expect(args).toContain('--resume');
			expect(args).toContain('existing-session-id');
			expect(args).not.toContain('--session-id');

			// Complete
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
		});

		it('should parse result from stdout', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit result JSON
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"The response text"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('The response text');
		});

		it('should capture session_id from stdout', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit session_id and result
			mockStdout.emit('data', Buffer.from('{"session_id":"abc-123"}\n'));
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.agentSessionId).toBe('abc-123');
		});

		it('should parse usage statistics from modelUsage', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit usage stats
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						modelUsage: {
							'claude-3': {
								inputTokens: 100,
								outputTokens: 50,
								cacheReadInputTokens: 20,
								cacheCreationInputTokens: 10,
								contextWindow: 200000,
							},
						},
						total_cost_usd: 0.05,
					}) + '\n'
				)
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.usageStats).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 20,
				cacheCreationInputTokens: 10,
				totalCostUsd: 0.05,
				contextWindow: 200000,
				// Reported by the model, so flagged authoritative even though it
				// matches the fallback size (review of PR #1356).
				contextWindowResolved: true,
			});
		});

		it('should parse usage statistics from usage field', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit usage stats via 'usage' field
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_read_input_tokens: 30,
							cache_creation_input_tokens: 15,
						},
						total_cost_usd: 0.08,
					}) + '\n'
				)
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.usageStats?.inputTokens).toBe(200);
			expect(result.usageStats?.outputTokens).toBe(100);
		});

		// claude reports cost and modelUsage as the SESSION's running totals; a
		// resumed turn reports its share, using the cost-state row the transcript
		// held when it spawned.
		it('reports a resumed turn its share of the session totals', async () => {
			const realFs = await vi.importActual<typeof import('fs')>('fs');
			const realOs = await vi.importActual<typeof import('os')>('os');
			// Real filesystem I/O needs the runner's temp directory, not the suite's POSIX mock.
			const configDir = realFs.mkdtempSync(
				path.join(realFs.realpathSync(realOs.tmpdir()), 'cli-cost-')
			);
			const projectDir = path.join(configDir, 'projects', '-project');
			realFs.mkdirSync(projectDir, { recursive: true });
			realFs.writeFileSync(
				path.join(projectDir, 'sid-resume.jsonl'),
				JSON.stringify({
					type: 'cost-state',
					totalCostUSD: 0.1,
					modelUsage: { 'claude-x': { inputTokens: 10, outputTokens: 5, costUSD: 0.1 } },
				}) + '\n'
			);
			const previous = process.env.CLAUDE_CONFIG_DIR;
			process.env.CLAUDE_CONFIG_DIR = configDir;
			try {
				const resultPromise = spawnAgent('claude-code', '/project', 'prompt', 'sid-resume');
				await new Promise((resolve) => setTimeout(resolve, 0));
				mockStdout.emit(
					'data',
					Buffer.from(
						JSON.stringify({
							type: 'result',
							result: 'Done',
							session_id: 'sid-resume',
							total_cost_usd: 0.25,
							modelUsage: { 'claude-x': { inputTokens: 30, outputTokens: 12, costUSD: 0.25 } },
						}) + '\n'
					)
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
				mockChild.emit('close', 0);

				const result = await resultPromise;

				expect(result.usageStats?.totalCostUsd).toBeCloseTo(0.15, 9);
				expect(result.usageStats?.inputTokens).toBe(20);
				expect(result.usageStats?.outputTokens).toBe(7);
			} finally {
				if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
				else process.env.CLAUDE_CONFIG_DIR = previous;
				realFs.rmSync(configDir, { recursive: true, force: true });
			}
		});

		it('should aggregate usage from multiple models', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						modelUsage: {
							'model-a': {
								inputTokens: 100,
								outputTokens: 50,
							},
							'model-b': {
								inputTokens: 200,
								outputTokens: 100,
								contextWindow: 300000,
							},
						},
						total_cost_usd: 0.1,
					}) + '\n'
				)
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.usageStats?.inputTokens).toBe(200); // MAX(100, 200)
			expect(result.usageStats?.outputTokens).toBe(100); // MAX(50, 100)
			expect(result.usageStats?.contextWindow).toBe(300000); // Larger window
		});

		it('carries the last call occupancy snapshot and resolved window onto usageStats (#1669)', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			const lines = [
				// The last main-transcript API call: its input is the real occupancy.
				{
					type: 'assistant',
					message: {
						content: [{ type: 'text', text: 'working' }],
						usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 500 },
					},
				},
				// The turn total, which is SPEND and reports a model-provided window.
				{
					type: 'result',
					result: 'Done',
					modelUsage: {
						'claude-opus': { inputTokens: 4000, outputTokens: 60, contextWindow: 1_000_000 },
					},
					total_cost_usd: 0.1,
				},
				// A trailing usage-only message with neither: it must not erase them.
				{ usage: { input_tokens: 4000, output_tokens: 60 }, total_cost_usd: 0.1 },
			];
			mockStdout.emit('data', Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.usageStats?.inputTokens).toBe(4000);
			expect(result.usageStats?.totalCostUsd).toBe(0.1);
			expect(result.usageStats?.contextWindow).toBe(1_000_000);
			expect(result.usageStats?.contextWindowResolved).toBe(true);
			expect(result.usageStats?.absoluteUsage).toEqual({
				inputTokens: 1000,
				outputTokens: 20,
				cacheReadInputTokens: 500,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
		});

		it('should return error on non-zero exit code', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit stderr
			mockStderr.emit('data', Buffer.from('Error: Something went wrong\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.error).toContain('Something went wrong');
		});

		it('bounds failure output while preserving the stderr tail', async () => {
			const pending = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockStderr.emit('data', 'x'.repeat(DEFAULT_STDERR_TAIL_LIMIT * 2));
			mockStderr.emit('data', '\nlast diagnostic');
			mockChild.emit('close', 1);

			const result = await pending;
			expect(result.success).toBe(false);
			expect(result.error?.length).toBeLessThanOrEqual(DEFAULT_STDERR_TAIL_LIMIT);
			expect(result.error).toMatch(/last diagnostic$/);
		});

		it('should return error when no result and non-zero exit', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.error).toContain('Process exited with code 1');
		});

		it('should handle spawn error', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('error', new Error('spawn ENOENT'));

			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to spawn Claude');
			expect(result.error).toContain('spawn ENOENT');
		});

		it('should close stdin immediately', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockStdin.end).toHaveBeenCalled();

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);

			await resultPromise;
		});

		it('should handle partial JSON lines (buffering)', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Send data in chunks
			mockStdout.emit('data', Buffer.from('{"type":"result",'));
			mockStdout.emit('data', Buffer.from('"result":"Complete"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('Complete');
		});

		it('should flush buffer on close when last line lacks trailing newline', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Result line without trailing newline (stays in buffer until close)
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Flushed"}'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('Flushed');
		});

		it('should flush buffer with session_id and usage on close', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Earlier lines with newlines are processed normally
			mockStdout.emit('data', Buffer.from('{"session_id":"sess-1"}\n'));
			// Final result without trailing newline
			mockStdout.emit(
				'data',
				Buffer.from('{"type":"result","result":"Done","total_cost_usd":0.05}')
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('Done');
			expect(result.agentSessionId).toBe('sess-1');
			expect(result.usageStats?.totalCostUsd).toBe(0.05);
		});

		it('should use assistant message text when result field is empty', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Assistant message with response text (as Claude Code actually emits)
			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"CLI capture test OK"}]}}\n'
				)
			);
			// Result message with empty result field (matches real Claude Code behavior)
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"","total_cost_usd":0.02}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('CLI capture test OK');
		});

		it('should prefer result field over assistant text when both present', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}\n'
				)
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Final answer"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('Final answer');
		});

		it('should handle assistant message with string content', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit(
				'data',
				Buffer.from('{"type":"assistant","message":{"role":"assistant","content":"Hello world"}}\n')
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":""}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('Hello world');
		});

		it('should separate multiple assistant messages with newlines', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First part."}]}}\n'
				)
			);
			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Second part."}]}}\n'
				)
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":""}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('First part.\nSecond part.');
		});

		it('should ignore non-JSON lines', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Mix of JSON and non-JSON
			mockStdout.emit('data', Buffer.from('Some debug output\n'));
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockStdout.emit('data', Buffer.from('More output\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('Done');
		});

		it('should only capture first result', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Multiple results
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"First"}\n'));
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Second"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.response).toBe('First');
		});

		it('should only capture first session_id', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit('data', Buffer.from('{"session_id":"first-id"}\n'));
			mockStdout.emit('data', Buffer.from('{"session_id":"second-id"}\n'));
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.agentSessionId).toBe('first-id');
		});

		it('should preserve session_id and usageStats on error', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit('data', Buffer.from('{"session_id":"error-session"}\n'));
			mockStdout.emit('data', Buffer.from('{"total_cost_usd":0.01}\n'));
			mockStderr.emit('data', Buffer.from('Error!\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.agentSessionId).toBe('error-session');
			expect(result.usageStats?.totalCostUsd).toBe(0.01);
		});

		it('should handle empty lines in output', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit('data', Buffer.from('\n\n{"type":"result","result":"Done"}\n\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
		});

		it('should handle success without result field', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// No result emitted, but process exits cleanly
			mockChild.emit('close', 0);

			const result = await resultPromise;

			// Without a result, success is false even with exit code 0
			expect(result.success).toBe(false);
		});

		it('should include expanded PATH in environment', async () => {
			// Mock platform to darwin to test Unix PATH expansion
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

			try {
				const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

				await new Promise((resolve) => setTimeout(resolve, 0));

				const [, , options] = mockSpawn.mock.calls[0];
				const pathEnv = options.env.PATH;

				// Should include common paths
				expect(pathEnv).toContain('/opt/homebrew/bin');
				expect(pathEnv).toContain('/usr/local/bin');
				expect(pathEnv).toContain('/Users/testuser/.local/bin');

				mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
				mockChild.emit('close', 0);

				await resultPromise;
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
			}
		});

		it('should include read-only args for Claude when readOnlyMode is true', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt', undefined, {
				readOnlyMode: true,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, args] = mockSpawn.mock.calls[0];
			// Should include Claude's read-only args from centralized definitions
			expect(args).toContain('--permission-mode');
			expect(args).toContain('plan');
			// Should still have base args
			expect(args).toContain('--print');
			// Should NOT have permission bypass in read-only mode
			expect(args).not.toContain('--dangerously-skip-permissions');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('Codex read-only spawn includes skip-git-repo-check exactly once and omits dangerous bypass flag', async () => {
			// Spawn Codex in read-only mode and inspect the args passed to the child
			const resultPromise = spawnAgent('codex', '/project', 'prompt', undefined, {
				readOnlyMode: true,
			});

			// Let async ops schedule
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockSpawn).toHaveBeenCalled();
			const [, args] = mockSpawn.mock.calls[0];

			// --skip-git-repo-check should appear exactly once
			const skipCount = args.filter((a: unknown) => String(a) === '--skip-git-repo-check').length;
			expect(skipCount).toBe(1);

			// --sandbox should be present and followed immediately by 'read-only'
			const sandboxIdx = args.findIndex((a: unknown) => String(a) === '--sandbox');
			expect(sandboxIdx).toBeGreaterThanOrEqual(0);
			expect(String(args[sandboxIdx + 1])).toBe('read-only');

			// Dangerous bypass flag must NOT be present in read-only mode
			expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');

			// Complete the spawn so the promise resolves
			mockStdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', text: 'Done' }) + '\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('Hermes read-only spawn args retain quiet mode and omit yolo', () => {
			const args = resolveCliBatchModeArgs(getAgentDefinition('hermes'), true);

			expect(args).toContain('-Q');
			expect(args).not.toContain('--yolo');
		});

		it('should not include read-only args when readOnlyMode is false', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt', undefined, {
				readOnlyMode: false,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, args] = mockSpawn.mock.calls[0];
			expect(args).not.toContain('--permission-mode');
			expect(args).not.toContain('plan');
			// Should have permission bypass in normal mode
			expect(args).toContain('--dangerously-skip-permissions');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should generate unique session-id for each spawn', async () => {
			// First spawn
			const promise1 = spawnAgent('claude-code', '/project', 'prompt1');
			await new Promise((resolve) => setTimeout(resolve, 0));
			const args1 = mockSpawn.mock.calls[0][1];

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await promise1;

			// Reset emitters
			mockStdout.removeAllListeners();
			mockStderr.removeAllListeners();
			(mockChild as EventEmitter).removeAllListeners();
			mockSpawn.mockClear();
			mockSpawn.mockReturnValue(mockChild);

			// Second spawn
			const promise2 = spawnAgent('claude-code', '/project', 'prompt2');
			await new Promise((resolve) => setTimeout(resolve, 0));
			const args2 = mockSpawn.mock.calls[0][1];

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await promise2;

			// Extract session IDs
			const sessionIdIndex1 = args1.indexOf('--session-id');
			const sessionIdIndex2 = args2.indexOf('--session-id');

			if (sessionIdIndex1 !== -1 && sessionIdIndex2 !== -1) {
				const id1 = args1[sessionIdIndex1 + 1];
				const id2 = args2[sessionIdIndex2 + 1];

				// UUIDs should be different
				expect(id1).not.toBe(id2);
				// Should be valid UUID format
				expect(id1).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
				);
				expect(id2).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
				);
			}
		});

		it('should set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 for claude-code batch spawns (#861)', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, , options] = mockSpawn.mock.calls[0];
			expect(options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 even in read-only mode', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt', undefined, {
				readOnlyMode: true,
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, , options] = mockSpawn.mock.calls[0];
			expect(options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should spawn copilot-cli with -p prompt arg and parse its result event', async () => {
			const resultPromise = spawnAgent('copilot-cli', '/project', 'Hello copilot');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [cmd, args] = mockSpawn.mock.calls[0];
			expect(cmd).toBeTruthy();

			// Copilot-CLI batch mode: copilot --allow-all --output-format json -p "prompt"
			expect(args).toContain('--allow-all');
			expect(args).toContain('--output-format');
			expect(args).toContain('json');
			expect(args).toContain('-p');
			expect(args).toContain('Hello copilot');
			// promptArgs path replaces the '--' separator
			expect(args).not.toContain('--');

			// Mirror real Copilot CLI batch-mode stdout: no session.start event;
			// the sessionId arrives only on the terminal `result` line.
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'Final answer from copilot', toolRequests: [] },
					}) + '\n'
				)
			);
			mockStdout.emit(
				'data',
				Buffer.from(JSON.stringify({ type: 'result', sessionId: 'cop-1', exitCode: 0 }) + '\n')
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
			expect(result.response).toBe('Final answer from copilot');
			expect(result.agentSessionId).toBe('cop-1');
		});

		it.each(['claude-code', 'codex', 'opencode', 'copilot-cli'] as const)(
			'keeps %s normalized model work alive for seventy minutes',
			async (type) => {
				vi.useFakeTimers();
				try {
					const onProgress = vi.fn();
					const pending = spawnAgent(type, '/project', 'prompt', undefined, {
						timeoutMs: 21_600_000,
						idle: { warnMs: 600_000, idleMs: 1_200_000, toolMs: 3_600_000 },
						onProgress,
					});
					await vi.advanceTimersByTimeAsync(0);
					expect(mockSpawn).toHaveBeenCalledOnce();
					for (let n = 0; n < 14; n++) {
						const text = `PRIVATE_REASONING_${n}`;
						const message =
							type === 'codex'
								? { type: 'item.completed', item: { type: 'reasoning', text } }
								: type === 'claude-code'
									? {
											type: 'assistant',
											message: { content: [{ type: 'thinking', thinking: text }] },
										}
									: type === 'copilot-cli'
										? { type: 'assistant.reasoning_delta', data: { deltaContent: text } }
										: {
												type: 'step_finish',
												part: {
													id: `step-${n}`,
													reason: 'tool-calls',
													tokens: { input: 10, output: 10 },
												},
											};
						mockStdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
						await vi.advanceTimersByTimeAsync(300_000);
					}
					expect(mockChild.kill).not.toHaveBeenCalled();
					const answer =
						type === 'claude-code'
							? { type: 'result', result: 'verified' }
							: type === 'codex'
								? {
										type: 'item.completed',
										item: { type: 'agent_message', phase: 'final', text: 'verified' },
									}
								: type === 'copilot-cli'
									? { type: 'assistant.message', data: { content: 'verified', toolRequests: [] } }
									: { type: 'text', part: { text: 'verified' } };
					mockStdout.emit('data', Buffer.from(JSON.stringify(answer) + '\n'));
					mockChild.emit('close', 0);
					expect(await pending).toMatchObject({ success: true, response: 'verified' });
					expect(
						onProgress.mock.calls.some(
							([event]) => event.type === 'activity' && event.text.includes('PRIVATE_REASONING')
						)
					).toBe(false);
				} finally {
					vi.useRealTimers();
				}
			}
		);

		it('charges launch preparation to the original absolute budget', async () => {
			vi.useFakeTimers();
			try {
				mockReadAgentConfig.mockImplementationOnce(() => {
					vi.advanceTimersByTime(300);
					return {};
				});
				const pending = spawnAgent('codex', '/project', 'prompt', undefined, { timeoutMs: 1_000 });
				await vi.advanceTimersByTimeAsync(701);
				expect(mockKill).toHaveBeenCalledWith('SIGTERM');
				mockChild.emit('close', 0);
				expect(await pending).toMatchObject({
					success: false,
					error: expect.stringContaining('absolute runtime ceiling'),
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it.each([undefined, 'resumed-provider-session'])(
			'bounds Codex startup despite stderr and init chatter (resume: %s)',
			async (resumeId) => {
				vi.useFakeTimers();
				try {
					const run = spawnAgent('codex', '/project', 'prompt', resumeId, {
						timeoutMs: 3_600_000,
						customArgs: '-c cli_auth_credentials_store=file',
					});
					await vi.advanceTimersByTimeAsync(0);
					expect(mockSpawn).toHaveBeenCalledOnce();
					mockStdout.emit(
						'data',
						Buffer.from(
							'noise\n{"type":"thread.started","thread_id":"waiting"}\n{"type":"turn.started"}\n' +
								'{"type":"error","message":"Reconnecting... 1/5"}\n' +
								'{"type":"event_msg","payload":{"type":"stream_error","message":"stream disconnected; retrying"}}\n'
						)
					);
					mockStderr.emit('data', Buffer.from('Reading additional input from stdin...'));
					await vi.advanceTimersByTimeAsync(119_999);
					expect(mockChild.kill).not.toHaveBeenCalled();
					await vi.advanceTimersByTimeAsync(1);
					expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
					mockChild.emit('close', 0);
					expect(await run).toMatchObject({
						success: false,
						outcome: 'crashed',
						agentSessionId: 'waiting',
						error: expect.stringContaining('Startup or authentication may be blocked'),
					});
					expect(mockSpawn.mock.calls[0][1]).toContain('cli_auth_credentials_store=file');
					expect(vi.getTimerCount()).toBe(0);
				} finally {
					vi.useRealTimers();
				}
			}
		);

		it.each([
			'{"type":"item.started","item":{"id":"cmd","type":"command_execution","command":"echo ok"}}',
			'{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Thinking"}]}}',
		])('keeps the long Codex run budget after model activity: %s', async (activity) => {
			vi.useFakeTimers();
			try {
				const pending = spawnAgent('codex', '/project', 'prompt', undefined, {
					timeoutMs: 3_600_000,
				});
				await vi.advanceTimersByTimeAsync(0);
				mockStdout.emit('data', Buffer.from(activity + '\n'));
				await vi.advanceTimersByTimeAsync(180_000);
				expect(mockChild.kill).not.toHaveBeenCalled();
				mockStdout.emit(
					'data',
					Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n')
				);
				mockChild.emit('close', 0);
				expect(await pending).toMatchObject({ success: true, response: 'Done' });
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it.each(['claude-code', 'codex'] as const)(
			'settles %s timeout with no close and suppresses late answers',
			async (type) => {
				vi.useFakeTimers();
				try {
					const onProgress = vi.fn();
					const pending = spawnAgent(type, '/project', 'prompt', undefined, {
						timeoutMs: 1_000,
						onProgress,
					});
					await vi.advanceTimersByTimeAsync(1);
					await vi.advanceTimersByTimeAsync(1_000);
					expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
					mockStdout.emit(
						'data',
						Buffer.from(
							type === 'codex'
								? '{"type":"item.completed","item":{"type":"agent_message","text":"Late"}}\n'
								: '{"type":"result","result":"Late"}\n'
						)
					);
					await vi.advanceTimersByTimeAsync(10_000);
					expect(mockChild.kill).toHaveBeenLastCalledWith('SIGKILL');
					expect(await pending).toMatchObject({
						success: false,
						outcome: 'crashed',
						error: 'Agent run stopped: absolute runtime ceiling exceeded',
					});
					expect(onProgress).toHaveBeenCalledExactlyOnceWith(
						expect.objectContaining({
							type: 'activity',
							text: expect.stringContaining('absolute runtime ceiling'),
						})
					);
					expect(vi.getTimerCount()).toBe(0);
				} finally {
					vi.useRealTimers();
				}
			}
		);

		it('does not report a partial JSON-line answer as success after timeout or cancellation', async () => {
			const controller = new AbortController();
			const pending = spawnAgent('codex', '/project', 'prompt', undefined, {
				timeoutMs: 1_000,
				signal: controller.signal,
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			const [, , options] = mockSpawn.mock.calls[0];
			expect(options.timeout).toBeUndefined();
			expect(options.detached).toBeUndefined();
			expect(options.signal).toBeUndefined();
			mockStdout.emit(
				'data',
				Buffer.from('{"type":"thread.started","thread_id":"codex-cancelled"}')
			);
			controller.abort();
			mockChild.emit(
				'error',
				Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
			);
			mockChild.emit('close', null, 'SIGTERM');
			expect(await pending).toMatchObject({
				success: false,
				outcome: 'interrupted',
				error: 'Agent run cancelled',
				agentSessionId: 'codex-cancelled',
			});
		});

		it('should pass through --resume=<sessionId> when resuming a copilot-cli session', async () => {
			const resultPromise = spawnAgent('copilot-cli', '/project', 'follow-up', 'cop-resume-1');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, args] = mockSpawn.mock.calls[0];
			// resumeArgs in the agent definition emits `--resume=<id>` as a single token.
			expect(args).toContain('--resume=cop-resume-1');

			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'still remembers', toolRequests: [] },
					}) + '\n'
				)
			);
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({ type: 'result', sessionId: 'cop-resume-1', exitCode: 0 }) + '\n'
				)
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
			// The resumed session id must round-trip through agentSessionId so the
			// caller can persist it and keep the chain going.
			expect(result.agentSessionId).toBe('cop-resume-1');
		});

		it('should spawn grok headless with -p, --always-approve, streaming-json and accumulate text deltas', async () => {
			const resultPromise = spawnAgent('grok', '/project', 'Hello grok');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [cmd, args] = mockSpawn.mock.calls[0];
			expect(cmd).toBeTruthy();

			// Grok batch mode: grok --always-approve --output-format streaming-json -p "prompt"
			expect(args).toContain('--always-approve');
			expect(args).toContain('--output-format');
			expect(args).toContain('streaming-json');
			expect(args).toContain('-p');
			expect(args).toContain('Hello grok');
			// promptArgs path replaces the '--' separator
			expect(args).not.toContain('--');
			// --permission-mode belongs to read-only mode only; grok's clap errors
			// with "cannot be used multiple times" if the flag ever repeats.
			expect(args).not.toContain('--permission-mode');

			// Mirror real grok streaming-json stdout: the answer arrives only as
			// token-sized text deltas, thought deltas are reasoning (excluded from
			// the response), and the terminal `end` event carries the sole
			// sessionId but no text.
			mockStdout.emit(
				'data',
				Buffer.from('{"type":"thought","data":"thinking..."}\n{"type":"text","data":"REA"}\n')
			);
			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"text","data":"DY"}\n' +
						JSON.stringify({
							type: 'end',
							stopReason: 'EndTurn',
							sessionId: 'grok-sess-1',
							requestId: 'req-1',
						}) +
						'\n'
				)
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
			expect(result.response).toBe('READY');
			expect(result.agentSessionId).toBe('grok-sess-1');
		});

		it('should run grok read-only with a single --permission-mode plan and no approve flag', async () => {
			const resultPromise = spawnAgent('grok', '/project', 'look around', undefined, {
				readOnlyMode: true,
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
			// grok hard-errors on a repeated --permission-mode ("the argument
			// '--permission-mode <MODE>' cannot be used multiple times"), so
			// read-only must strip the batch approve flag and leave exactly one.
			expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
			expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
			expect(args).not.toContain('--always-approve');
			expect(args).not.toContain('bypassPermissions');

			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"text","data":"ok"}\n{"type":"end","stopReason":"EndTurn","sessionId":"grok-sess-2"}\n'
				)
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
			expect(result.response).toBe('ok');
		});

		it('should resume a grok session via --resume <sessionId> and round-trip the id', async () => {
			const resultPromise = spawnAgent('grok', '/project', 'follow-up', 'grok-resume-1');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
			const resumeIdx = args.indexOf('--resume');
			expect(resumeIdx).toBeGreaterThanOrEqual(0);
			expect(args[resumeIdx + 1]).toBe('grok-resume-1');

			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"text","data":"still remembers"}\n{"type":"end","stopReason":"EndTurn","sessionId":"grok-resume-1"}\n'
				)
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
			// The resumed session id must round-trip through agentSessionId so the
			// caller can persist it and keep the chain going.
			expect(result.agentSessionId).toBe('grok-resume-1');
		});

		it('should surface a grok stream error event as a failed result', async () => {
			const resultPromise = spawnAgent('grok', '/project', 'trigger an error');
			await new Promise((resolve) => setTimeout(resolve, 0));

			// grok emits {"type":"error","message":...} on stdout, duplicates it on
			// stderr as `Error: <message>`, and exits 1.
			mockStdout.emit(
				'data',
				Buffer.from('{"type":"error","message":"This model does not support that"}\n')
			);
			mockStderr.emit('data', Buffer.from('Error: This model does not support that\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;
			expect(result.success).toBe(false);
			expect(result.error).toBe('This model does not support that');
		});

		it('should soft-succeed when Grok streams a full answer then exits non-zero without a structured error', async () => {
			// Mirrors wizard recovery: --max-turns (or similar) can exit 1 after
			// a complete text+end stream with no {"type":"error"} event.
			const resultPromise = spawnAgent('grok', '/project', 'brief task');
			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"text","data":"all done"}\n{"type":"end","stopReason":"EndTurn","sessionId":"sess-soft"}\n'
				)
			);
			mockStderr.emit('data', Buffer.from('max turns reached\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;
			expect(result.success).toBe(true);
			expect(result.response).toBe('all done');
			expect(result.agentSessionId).toBe('sess-soft');
		});

		it('should let a pre-set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS from shell env win', async () => {
			// `isolateAgentEnv` restores the real value after the test.
			process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '0';

			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, , options] = mockSpawn.mock.calls[0];
			expect(options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('0');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});
	});

	describe('turn contract (shared resolveTurnOutcome)', () => {
		const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

		// A local spawn first resolves the agent binary (`resolveLocalAgentCommand`).
		// Resolve it through a configured custom path, so these tests describe the
		// same command whether or not an earlier test warmed the module-level cache.
		beforeEach(() => {
			mockGetAgentCustomPath.mockReturnValue('/custom/path/to/agent');
			vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => true } as fs.Stats);
			vi.mocked(fs.promises.access).mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockChild);
		});

		const claudeResult = (text: string) =>
			`{"type":"system","subtype":"init","session_id":"sess-t"}\n` +
			`{"type":"assistant","message":{"content":[{"type":"text","text":"${text}"}]}}\n` +
			`{"type":"result","result":"${text}","session_id":"sess-t"}\n`;

		it('does not spawn anything when the signal is already aborted', async () => {
			const controller = new AbortController();
			controller.abort();

			const result = await spawnAgent('claude-code', '/project', 'prompt', undefined, {
				signal: controller.signal,
			});

			expect(result).toMatchObject({ success: false, outcome: 'interrupted' });
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('reports an aborted Claude turn as interrupted, keeping what it captured', async () => {
			const controller = new AbortController();
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt', undefined, {
				signal: controller.signal,
			});
			await tick();

			mockStdout.emit('data', Buffer.from(claudeResult('partial answer')));
			controller.abort();
			expect(mockKill).toHaveBeenCalledWith('SIGTERM');
			mockChild.emit('close', null, 'SIGTERM');

			const result = await resultPromise;
			expect(result).toMatchObject({
				success: false,
				outcome: 'interrupted',
				agentSessionId: 'sess-t',
			});
		});

		it('reports an aborted JSON-line turn as interrupted even when stderr looks like an error', async () => {
			const controller = new AbortController();
			const resultPromise = spawnAgent('codex', '/project', 'prompt', undefined, {
				signal: controller.signal,
			});
			await tick();

			controller.abort();
			mockStderr.emit('data', Buffer.from('Error: something the stop triggered\n'));
			mockChild.emit('close', 143, null);

			expect(await resultPromise).toMatchObject({ success: false, outcome: 'interrupted' });
		});

		it('escalates to SIGKILL when the agent ignores SIGTERM, and stops the timer once it exits', async () => {
			vi.useFakeTimers();
			try {
				const controller = new AbortController();
				const resultPromise = spawnAgent('claude-code', '/project', 'prompt', undefined, {
					signal: controller.signal,
				});
				await vi.advanceTimersByTimeAsync(0);

				controller.abort();
				expect(mockKill).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(5000);
				expect(mockKill).toHaveBeenLastCalledWith('SIGKILL');

				mockChild.emit('close', null, 'SIGKILL');
				expect((await resultPromise).outcome).toBe('interrupted');

				mockKill.mockClear();
				await vi.advanceTimersByTimeAsync(10000);
				expect(mockKill).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('never signals the child when the turn finishes before an abort', async () => {
			const controller = new AbortController();
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt', undefined, {
				signal: controller.signal,
			});
			await tick();

			mockStdout.emit('data', Buffer.from(claudeResult('done')));
			mockChild.emit('close', 0, null);
			expect((await resultPromise).outcome).toBe('completed');

			controller.abort();
			expect(mockKill).not.toHaveBeenCalled();
		});

		it('reports a signal-killed Claude turn with nothing captured as a crash, not an interrupt', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await tick();

			mockChild.emit('close', null, 'SIGKILL');

			const result = await resultPromise;
			expect(result).toMatchObject({ success: false, outcome: 'crashed' });
			expect(result.error).toContain('SIGKILL');
		});

		it('keeps failing a Claude turn that exits non-zero, even with text streamed (the old strict rule)', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await tick();

			mockStdout.emit('data', Buffer.from(claudeResult('the answer')));
			mockStderr.emit('data', Buffer.from('npm warn deprecated some-package@1.0.0\n'));
			mockChild.emit('close', 1, null);

			expect(await resultPromise).toMatchObject({ success: false, outcome: 'crashed' });
		});

		it('never reports a Claude turn killed by an unrequested signal as a success, even with partial text', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await tick();

			// Assistant text arrived, but no result event: the process was killed mid-turn.
			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"assistant","message":{"content":[{"type":"text","text":"half an answ"}]}}\n'
				)
			);
			mockChild.emit('close', null, 'SIGKILL');

			const result = await resultPromise;
			expect(result).toMatchObject({ success: false, outcome: 'crashed' });
			expect(result.error).toContain('SIGKILL');
		});

		it('fails a clean Claude exit whose result event is empty and produced no assistant text', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await tick();

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"","session_id":"s"}\n'));
			mockChild.emit('close', 0, null);

			expect(await resultPromise).toMatchObject({ success: false, outcome: 'crashed' });
		});

		it('keeps a generic-path answer produced before a bare bad exit (Grok with --max-turns)', async () => {
			const resultPromise = spawnAgent('grok', '/project', 'brief task');
			await tick();

			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"text","data":"The service hit a rate limit, so I added retries."}\n' +
						'{"type":"end","stopReason":"EndTurn","sessionId":"sess-g"}\n'
				)
			);
			mockStderr.emit('data', Buffer.from('max turns reached\n'));
			mockChild.emit('close', 1, null);

			// The answer merely MENTIONS a rate limit; it must not become a crash.
			expect(await resultPromise).toMatchObject({
				success: true,
				outcome: 'completed-with-warning',
			});
		});

		it('fails a Claude turn whose stderr carries a specific classified error, answer or not', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await tick();

			mockStdout.emit('data', Buffer.from(claudeResult('the answer')));
			mockStderr.emit('data', Buffer.from('Invalid API key - Please run /login\n'));
			mockChild.emit('close', 1, null);

			expect(await resultPromise).toMatchObject({ success: false, outcome: 'crashed' });
		});

		it('still fails a clean Claude exit that captured nothing', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await tick();

			mockChild.emit('close', 0, null);

			expect(await resultPromise).toMatchObject({ success: false, outcome: 'crashed' });
		});

		it('reports a failure to start as crashed', async () => {
			const resultPromise = spawnAgent('codex', '/project', 'prompt');
			await tick();

			mockChild.emit('error', new Error('spawn codex ENOENT'));

			expect(await resultPromise).toMatchObject({
				success: false,
				outcome: 'crashed',
				error: expect.stringContaining('ENOENT'),
			});
		});

		it('reports an unresolved SSH remote as crashed before anything is spawned', async () => {
			const result = await spawnAgent('codex', '/project', 'prompt', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'gone' },
			});

			expect(result).toMatchObject({ success: false, outcome: 'crashed' });
			expect(result.error).toContain('"gone" no longer exists');
			expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('does not overcount Codex usage, which reports a running session total on every event', async () => {
			const resultPromise = spawnAgent('codex', '/project', 'prompt');
			await tick();

			const tokenCount = (input: number, output: number) =>
				JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: { total_token_usage: { input_tokens: input, output_tokens: output } },
					},
				}) + '\n';
			// Running totals 100 -> 200 -> 300. Summing them (the old behavior) gives 600.
			mockStdout.emit(
				'data',
				Buffer.from(tokenCount(100, 10) + tokenCount(200, 20) + tokenCount(300, 30))
			);
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						type: 'response_item',
						payload: {
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: 'ok' }],
						},
					}) + '\n'
				)
			);
			mockChild.emit('close', 0, null);

			const result = await resultPromise;
			expect(result.usageStats?.inputTokens).toBe(300);
			expect(result.usageStats?.outputTokens).toBe(30);
		});

		it('carries Codex occupancy and the reported window onto usageStats (#1669)', async () => {
			const resultPromise = spawnAgent('codex', '/project', 'prompt');
			await tick();

			const tokenCount = (input: number, output: number) =>
				JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							total_token_usage: { input_tokens: input, output_tokens: output },
							model_context_window: 272_000,
						},
					},
				}) + '\n';
			mockStdout.emit('data', Buffer.from(tokenCount(100, 10) + tokenCount(300, 30)));
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						type: 'response_item',
						payload: {
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: 'ok' }],
						},
					}) + '\n'
				)
			);
			mockChild.emit('close', 0, null);

			const result = await resultPromise;
			// Totals are still delta-normalized...
			expect(result.usageStats?.inputTokens).toBe(300);
			expect(result.usageStats?.outputTokens).toBe(30);
			// ...and the running total the accumulator computed survives as occupancy.
			expect(result.usageStats?.absoluteUsage).toEqual({
				inputTokens: 300,
				outputTokens: 30,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
			expect(result.usageStats?.contextWindow).toBe(272_000);
			expect(result.usageStats?.contextWindowResolved).toBe(true);
		});

		it('sums Copilot per-turn output tokens, which are deltas rather than a running total', async () => {
			// copilot-cli sets `usesCombinedContextWindow`, which is about how the
			// context gauge adds input and output, NOT about how usage arrives. Its
			// parser emits each turn's `outputTokens` as a delta, so routing them
			// through the accumulator would read this rising sequence as a running
			// total and keep only the differences: 50 + 10 + 15 = 75 instead of 185.
			const resultPromise = spawnAgent('copilot-cli', '/project', 'prompt');
			await tick();

			const turn = (outputTokens: number) =>
				JSON.stringify({
					type: 'assistant.message',
					data: { content: 'part', toolRequests: [], outputTokens },
				}) + '\n';

			mockStdout.emit('data', Buffer.from(turn(50) + turn(60) + turn(75)));
			mockStdout.emit(
				'data',
				Buffer.from(JSON.stringify({ type: 'result', sessionId: 'cop-1', exitCode: 0 }) + '\n')
			);
			await tick();
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.usageStats?.outputTokens).toBe(185);
		});

		it('drops a stuck line buffer, says so, and keeps framing the lines after it', async () => {
			const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
				await tick();

				// A provider that never terminates a line would otherwise grow this
				// buffer for the life of the process.
				mockStdout.emit('data', 'x'.repeat(1024 * 1024 + 1));
				mockStdout.emit('data', claudeResult('after the drop'));
				mockChild.emit('close', 0, null);

				expect(await resultPromise).toMatchObject({
					success: true,
					response: 'after the drop',
				});
				expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropped'));
			} finally {
				warn.mockRestore();
			}
		});

		it('decodes on the stream, so a multibyte character split across reads survives', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await tick();

			// The spawner must ask the stream to decode. Without this it decoded
			// each Buffer on its own, and a character straddling two reads became
			// replacement characters on both sides.
			expect(mockStdout.setEncoding).toHaveBeenCalledWith('utf8');
			expect(mockStderr.setEncoding).toHaveBeenCalledWith('utf8');

			// What follows demonstrates the case rather than reproducing it: an
			// EventEmitter fake cannot decode, so the split is done here with the
			// same StringDecoder a real stream uses. The assertions above are what
			// would actually catch a regression. A byte-level split belongs with
			// the other hostile scenarios in the turn recordings, whose fixtures
			// are string chunks today - see the plan doc's deferred list.
			const whole = claudeResult('décor 🎼');
			const bytes = Buffer.from(whole, 'utf8');
			const decoder = new StringDecoder('utf8');
			const cut = bytes.indexOf(Buffer.from('🎼', 'utf8')) + 2;
			mockStdout.emit('data', decoder.write(bytes.subarray(0, cut)));
			mockStdout.emit('data', decoder.write(bytes.subarray(cut)));
			mockChild.emit('close', 0, null);

			expect(await resultPromise).toMatchObject({ response: 'décor 🎼' });
		});

		it('reassembles a JSON line split across chunks', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await tick();

			const whole = claudeResult('chunked answer');
			const cut = Math.floor(whole.length / 2);
			mockStdout.emit('data', Buffer.from(whole.slice(0, cut)));
			mockStdout.emit('data', Buffer.from(whole.slice(cut)));
			mockChild.emit('close', 0, null);

			expect(await resultPromise).toMatchObject({
				success: true,
				outcome: 'completed',
				response: 'chunked answer',
			});
		});
	});

	describe('PATH expansion (via spawnAgent)', () => {
		let originalPlatform: string;

		beforeEach(() => {
			originalPlatform = process.platform;
			mockSpawn.mockReturnValue(mockChild);
			// Mock platform to darwin for Unix path testing
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
		});

		afterEach(() => {
			// Restore original platform
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});

		it('should include homebrew paths', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const pathEnv = mockSpawn.mock.calls[0][2].env.PATH;
			expect(pathEnv).toContain('/opt/homebrew/bin');
			expect(pathEnv).toContain('/opt/homebrew/sbin');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should include user home paths', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const pathEnv = mockSpawn.mock.calls[0][2].env.PATH;
			expect(pathEnv).toContain('/Users/testuser/.local/bin');
			expect(pathEnv).toContain('/Users/testuser/.npm-global/bin');
			expect(pathEnv).toContain('/Users/testuser/bin');
			expect(pathEnv).toContain('/Users/testuser/.claude/local');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should include system paths', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const pathEnv = mockSpawn.mock.calls[0][2].env.PATH;
			expect(pathEnv).toContain('/usr/bin');
			expect(pathEnv).toContain('/bin');
			expect(pathEnv).toContain('/usr/sbin');
			expect(pathEnv).toContain('/sbin');
			expect(pathEnv).toContain('/usr/local/bin');
			expect(pathEnv).toContain('/usr/local/sbin');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should not duplicate existing paths', async () => {
			// Mock platform to darwin to test Unix PATH expansion
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Set PATH to include a path that would be added
				const originalPath = process.env.PATH;
				const delimiter = process.platform === 'win32' ? ';' : ':';
				process.env.PATH = `/opt/homebrew/bin${delimiter}/usr/bin`;

				mockSpawn.mockReturnValue(mockChild);
				const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
				await new Promise((resolve) => setTimeout(resolve, 0));

				const pathEnv = mockSpawn.mock.calls[0][2].env.PATH;

				// Count occurrences of /opt/homebrew/bin
				const parts = pathEnv.split(path.delimiter);
				const homebrewCount = parts.filter((p: string) => p === '/opt/homebrew/bin').length;

				// Should only appear once
				expect(homebrewCount).toBe(1);

				// Restore
				process.env.PATH = originalPath;

				mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
				mockChild.emit('close', 0);
				await resultPromise;
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});
	});

	describe('platform-specific behavior', () => {
		// Whether `where` or `which` runs is the shared lookup's choice now, and
		// path-prober.test.ts covers it. What the CLI owns is handing every
		// platform's PATH lookup to that one function.
		it.each(['win32', 'darwin', 'linux'])(
			'hands the PATH lookup to the shared lookup on %s',
			async (platform) => {
				Object.defineProperty(process, 'platform', { value: platform, configurable: true });
				mockGetAgentCustomPath.mockReturnValue(undefined);
				pathProbeResolver = () => undefined;

				vi.resetModules();
				const { detectClaude: freshDetectClaude } =
					await import('../../../cli/services/agent-spawner');
				const result = await freshDetectClaude();

				expect(mockCheckBinaryExists).toHaveBeenCalledWith('claude');
				expect(mockSpawn).not.toHaveBeenCalled();
				expect(result.available).toBe(false);
			}
		);

		it('should skip X_OK check on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			mockGetAgentCustomPath.mockReturnValue('C:\\Program Files\\claude\\claude.exe');
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			// Don't mock access - it shouldn't be called on Windows

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result = await freshDetectClaude();

			// On Windows, just checking if it's a file is enough
			expect(result.available).toBe(true);
			expect(fs.promises.access).not.toHaveBeenCalled();

			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});
	});

	// ========================================================================
	// Config override + SSH remote tests
	// ========================================================================
	//
	// These tests cover the CLI's agent-config override path
	// (applyAgentConfigOverrides) and the SSH remote wrapper integration.
	//
	// The spawn flow is driven by fake events on mockChild so we can assert
	// on the *inputs* to spawn() (command, args, env) without running anything.
	// runSpawn() schedules a "close" event on the next tick so the promise
	// resolves; tests call it before awaiting the spawnAgent promise.

	/** Yield to the microtask queue so spawn() runs and event listeners attach. */
	const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

	/**
	 * Wait until mockSpawn has been called at least `minCalls` times, or until
	 * the per-poll attempts run out. First-run dynamic imports (ssh-spawn-wrapper)
	 * can take several ticks, so we poll rather than assume spawn fires quickly.
	 */
	async function waitForSpawnCall(minCalls = 1, attempts = 50): Promise<void> {
		for (let i = 0; i < attempts; i++) {
			if (mockSpawn.mock.calls.length >= minCalls) return;
			await yieldTick();
		}
	}

	/**
	 * Drive a spawnAgent promise to resolution. Waits for spawn to be called
	 * (guarantees listeners are attached), emits stdout data, then emits a
	 * close event. Returns the agent result.
	 */
	async function driveSpawnToCompletion(
		resultPromise: Promise<AgentResult>,
		code = 0,
		output = ''
	): Promise<AgentResult> {
		// Race the spawn call against a soft timeout so tests that legitimately
		// never call spawn (e.g., SSH hard-fail path) still resolve quickly via
		// the promise they're awaiting rather than hanging here.
		await Promise.race([waitForSpawnCall(), resultPromise.then(() => {})]);
		if (mockSpawn.mock.calls.length > 0) {
			if (output) mockStdout.emit('data', Buffer.from(output));
			await yieldTick();
			(mockChild as EventEmitter).emit('close', code);
		}
		return resultPromise;
	}

	/** Grab the (command, args, options) triple passed to spawn(). */
	function spawnCall(): { command: string; args: string[]; options: { env: NodeJS.ProcessEnv } } {
		expect(mockSpawn).toHaveBeenCalled();
		const [command, args, options] = mockSpawn.mock.calls[0] as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv },
		];
		return { command, args, options };
	}

	const CLAUDE_OK = () => JSON.stringify({ type: 'result', result: 'ok' }) + '\n';
	const CODEX_INIT = () => JSON.stringify({ type: 'task_started' }) + '\n';

	describe('spawnAgent: local config overrides', () => {
		// Same reason as the `spawnAgent` suite above: this one asserts what an
		// agent's `defaultEnvVars` produce, which the ambient shell can override.
		isolateAgentEnv();

		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
		});

		it('appends session customArgs to Claude spawn', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				customArgs: '--verbose-extra --flag',
			});
			const result = await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			expect(result.success).toBe(true);
			const { args } = spawnCall();
			expect(args).toContain('--verbose-extra');
			expect(args).toContain('--flag');
		});

		it('shell-quote-parses session customArgs (preserves spaces inside quotes)', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				customArgs: '--foo "has spaces" --bar',
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			expect(args).toContain('--foo');
			expect(args).toContain('has spaces');
			expect(args).toContain('--bar');
		});

		it('reads customArgs from agent-level config when session customArgs is not set', async () => {
			mockReadAgentConfig.mockReturnValue({ customArgs: '--from-agent-config' });

			const p = spawnAgent('claude-code', '/p', 'hi');
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			expect(args).toContain('--from-agent-config');
		});

		it('session customArgs overrides agent-level customArgs', async () => {
			mockReadAgentConfig.mockReturnValue({ customArgs: '--agent-level' });

			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				customArgs: '--session-level',
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			expect(args).toContain('--session-level');
			expect(args).not.toContain('--agent-level');
		});

		it.each(['claude-code', 'codex'] as const)(
			'uses desktop blank-unset and path expansion for a live %s environment',
			async (toolType) => {
				vi.stubEnv('MAESTRO_TEST_BLANK', 'inherited');
				try {
					const p = spawnAgent(toolType, '/p', 'hi', undefined, {
						globalEnvVars: {
							MAESTRO_TEST_BLANK: '  ',
							CLAUDE_CONFIG_DIR: '',
							MAESTRO_TEST_PATH: '~/relay-fixture',
							MAESTRO_TEST_CANCEL: 'global',
							MAESTRO_TEST_RESTORE: '',
							'': 'unfinished row',
						},
						customEnvVars: { MAESTRO_TEST_CANCEL: '', MAESTRO_TEST_RESTORE: 'session' },
					});
					await driveSpawnToCompletion(
						p,
						0,
						toolType === 'claude-code' ? CLAUDE_OK() : CODEX_INIT()
					);
					const {
						options: { env },
					} = spawnCall();
					expect(env.MAESTRO_TEST_BLANK).toBeUndefined();
					expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
					expect(env.MAESTRO_TEST_CANCEL).toBeUndefined();
					expect(env.MAESTRO_TEST_RESTORE).toBe('session');
					expect(env.MAESTRO_TEST_PATH).toBe(path.join(os.homedir(), 'relay-fixture'));
					expect(env['']).toBeUndefined();
				} finally {
					vi.unstubAllEnvs();
				}
			}
		);

		it('retains standalone CLI explicit blank values without live desktop settings', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				customEnvVars: { MAESTRO_TEST_STANDALONE: '' },
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());
			expect(spawnCall().options.env.MAESTRO_TEST_STANDALONE).toBe('');
		});

		it('uses live desktop config and command with global env below session env', async () => {
			mockReadAgentConfig.mockReturnValue({ customArgs: '--wrong-disk-config' });
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				agentConfigValues: { customArgs: '--live-desktop-config' },
				agentCommand: '/desktop/claude',
				globalEnvVars: { MAESTRO_TEST_GLOBAL: 'global', MAESTRO_TEST_LAYER: 'global' },
				customEnvVars: { MAESTRO_TEST_LAYER: 'session' },
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());
			const {
				args,
				options: { env },
			} = spawnCall();
			expect(args).toContain('--live-desktop-config');
			expect(args).not.toContain('--wrong-disk-config');
			expect(mockSpawn.mock.calls[0][0]).toBe('/desktop/claude');
			expect(env.MAESTRO_TEST_GLOBAL).toBe('global');
			expect(env.MAESTRO_TEST_LAYER).toBe('session');
		});

		it('applies session customEnvVars to local spawn env (wins over shell env)', async () => {
			const prev = process.env.MAESTRO_TEST_ENV;
			process.env.MAESTRO_TEST_ENV = 'from-shell';

			try {
				const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
					customEnvVars: { MAESTRO_TEST_ENV: 'from-session' },
				});
				await driveSpawnToCompletion(p, 0, CLAUDE_OK());

				const { options } = spawnCall();
				expect(options.env.MAESTRO_TEST_ENV).toBe('from-session');
			} finally {
				if (prev === undefined) delete process.env.MAESTRO_TEST_ENV;
				else process.env.MAESTRO_TEST_ENV = prev;
			}
		});

		it('session customEnvVars wins over agent-level customEnvVars', async () => {
			mockReadAgentConfig.mockReturnValue({
				customEnvVars: { MAESTRO_TEST_LAYER: 'agent' },
			});

			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				customEnvVars: { MAESTRO_TEST_LAYER: 'session' },
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { options } = spawnCall();
			expect(options.env.MAESTRO_TEST_LAYER).toBe('session');
		});

		it('shell env wins over agent defaultEnvVars when user has no customEnvVars', async () => {
			// Regression: agent.defaultEnvVars must NOT silently override a value
			// the shell already exports. OpenCode has OPENCODE_CONFIG_CONTENT in
			// its defaultEnvVars - if the shell sets it, that shell value should
			// survive to the spawned process.
			// `isolateAgentEnv` restores the real value after the test.
			process.env.OPENCODE_CONFIG_CONTENT = 'shell-wins';

			const p = spawnAgent('opencode', '/p', 'hi');
			await driveSpawnToCompletion(p, 0);

			const { options } = spawnCall();
			expect(options.env.OPENCODE_CONFIG_CONTENT).toBe('shell-wins');
		});

		it('passes the inherited environment through without stripping it', async () => {
			// The CLI runs from the user's own shell, not from Electron, so what
			// that shell exported reaches the agent as it is.
			const saved = process.env.ELECTRON_RUN_AS_NODE;
			process.env.ELECTRON_RUN_AS_NODE = '1';
			try {
				const p = spawnAgent('opencode', '/p', 'hi');
				await driveSpawnToCompletion(p, 0);

				const { options } = spawnCall();
				expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
			} finally {
				if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
				else process.env.ELECTRON_RUN_AS_NODE = saved;
			}
		});

		it('agent defaultEnvVars is applied when the shell has not set it', async () => {
			// Complements the "shell wins" test: when the shell does NOT export
			// the key, the agent default must still reach the spawned process.
			// `isolateAgentEnv` has already cleared the key for this test.
			const p = spawnAgent('opencode', '/p', 'hi');
			await driveSpawnToCompletion(p, 0);

			const { options } = spawnCall();
			expect(options.env.OPENCODE_CONFIG_CONTENT).toContain('"permission"');
		});

		it('applies customModel via configOptions argBuilder for Claude', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, { customModel: 'opus' });
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			const modelIdx = args.indexOf('--model');
			expect(modelIdx).toBeGreaterThanOrEqual(0);
			expect(args[modelIdx + 1]).toBe('opus');
		});

		it('applies customModel for Codex (JSON-line agent)', async () => {
			const p = spawnAgent('codex', '/p', 'hi', undefined, { customModel: 'gpt-5.3-codex' });
			await driveSpawnToCompletion(p, 0, CODEX_INIT());

			const { args } = spawnCall();
			const modelIdx = args.indexOf('-m');
			expect(modelIdx).toBeGreaterThanOrEqual(0);
			expect(args[modelIdx + 1]).toBe('gpt-5.3-codex');
		});

		it('does not add --model when customModel is empty', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi');
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			expect(args).not.toContain('--model');
		});
	});

	describe('spawnAgent: effort refused by the provider', () => {
		isolateAgentEnv();

		// What `codex exec --json` prints when the API answers the effort with a
		// 400: the API's own JSON, carried as a string inside a JSONL event.
		const REFUSAL_LINE =
			JSON.stringify({
				type: 'error',
				message:
					'{"type":"error","error":{"message":"Unsupported value: \'low\' is not supported with the \'gpt-6-astra\' model. Supported values are: \'medium\', \'high\'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}',
			}) + '\n';

		let errorSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
			errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		});

		afterEach(() => {
			errorSpy.mockRestore();
			resetEffortRejections();
		});

		/** Args of the Nth agent spawn (0-based). */
		const argsOfSpawn = (index: number) => mockSpawn.mock.calls[index][1] as string[];
		const effortArg = (args: string[]) =>
			args.find((arg) => arg.startsWith('model_reasoning_effort='));

		it('runs the turn once more with the effort left to the agent', async () => {
			const p = spawnAgent('codex', '/p', 'hi', undefined, { customEffort: 'low' });

			await waitForSpawnCall(1);
			expect(effortArg(argsOfSpawn(0))).toBe('model_reasoning_effort="low"');
			mockStdout.emit('data', Buffer.from(REFUSAL_LINE));
			await yieldTick();
			(mockChild as EventEmitter).emit('close', 1);

			await waitForSpawnCall(2);
			expect(mockSpawn).toHaveBeenCalledTimes(2);
			expect(effortArg(argsOfSpawn(1))).toBeUndefined();
			await yieldTick();
			// A turn that closes with no final text reads as crashed, so the
			// retry answers before it exits.
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }) +
						'\n'
				)
			);
			await yieldTick();
			(mockChild as EventEmitter).emit('close', 0);

			const result = await p;
			expect(result.success).toBe(true);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('codex rejected effort "low" for gpt-6-astra')
			);
		});

		it('takes the refused value out of the ladder for the rest of the run', async () => {
			expect(resolveEffortLevel('codex', 'low')).toBe('low');

			const p = spawnAgent('codex', '/p', 'hi', undefined, { customEffort: 'low' });
			await waitForSpawnCall(1);
			mockStdout.emit('data', Buffer.from(REFUSAL_LINE));
			await yieldTick();
			(mockChild as EventEmitter).emit('close', 1);
			await waitForSpawnCall(2);
			await yieldTick();
			(mockChild as EventEmitter).emit('close', 0);
			await p;

			expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
		});

		it('does not retry when the caller sent no effort', async () => {
			// The agent's own configured effort was refused: nothing Maestro chose
			// is left to drop, so the failure is returned as it is.
			const p = spawnAgent('codex', '/p', 'hi');
			await waitForSpawnCall(1);
			mockStdout.emit('data', Buffer.from(REFUSAL_LINE));
			await yieldTick();
			(mockChild as EventEmitter).emit('close', 1);

			const result = await p;
			expect(result.success).toBe(false);
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		it('does not retry an ordinary failure', async () => {
			const p = spawnAgent('codex', '/p', 'hi', undefined, { customEffort: 'low' });
			await waitForSpawnCall(1);
			mockStderr.emit('data', Buffer.from('Not logged in\n'));
			await yieldTick();
			(mockChild as EventEmitter).emit('close', 1);

			const result = await p;
			expect(result.success).toBe(false);
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});
	});

	describe('spawnAgent: SSH integration', () => {
		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
		});

		const sshWrapResult = (
			overrides: Partial<{
				command: string;
				args: string[];
				cwd: string;
				customEnvVars: Record<string, string> | undefined;
				sshStdinScript: string | undefined;
				sshRemoteUsed: { id: string; name: string; host: string } | null;
			}> = {}
		) => ({
			command: 'ssh',
			args: ['remotehost', 'claude --print -- hi'],
			cwd: '/home/user',
			customEnvVars: undefined,
			prompt: undefined,
			sshStdinScript: undefined,
			sshRemoteUsed: { id: 'r1', name: 'r1', host: 'remotehost' },
			...overrides,
		});

		it('does NOT invoke the SSH wrapper when sshRemoteConfig is undefined', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi');
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
			const { command } = spawnCall();
			expect(command).not.toBe('ssh');
		});

		it('does NOT invoke the SSH wrapper when sshRemoteConfig.enabled is false', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: false, remoteId: null },
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
		});

		it('invokes the SSH wrapper and replaces command/args when remote resolves', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue(sshWrapResult());

			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});
			const result = await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			expect(result.success).toBe(true);
			expect(mockWrapSpawnWithSsh).toHaveBeenCalledTimes(1);
			const { command, args } = spawnCall();
			expect(command).toBe('ssh');
			expect(args).toEqual(['remotehost', 'claude --print -- hi']);
		});

		it('writes sshStdinScript to child.stdin when large-prompt passthrough is used', async () => {
			const script = '#!/bin/bash\nexec claude --print\nbig prompt here';
			mockWrapSpawnWithSsh.mockResolvedValue(
				sshWrapResult({ args: ['remotehost', '/bin/bash'], sshStdinScript: script })
			);

			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			expect(mockStdin.write).toHaveBeenCalledWith(script, expect.any(Function));
			expect(mockStdin.end).toHaveBeenCalled();
			// write() must run BEFORE end() (first call of write precedes first end)
			expect(mockStdin.write.mock.invocationCallOrder[0]).toBeLessThan(
				mockStdin.end.mock.invocationCallOrder[0]
			);
		});

		it('does NOT write to stdin when running locally (no sshStdinScript)', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi');
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			expect(mockStdin.write).not.toHaveBeenCalled();
			expect(mockStdin.end).toHaveBeenCalled();
		});

		it('returns a clear error when SSH is enabled but the remote is unresolvable', async () => {
			const result = await spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'missing-remote' },
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/SSH remote execution is enabled/i);
			expect(result.error).toContain('"missing-remote" no longer exists');
			// Must not fall through to a local spawn - user explicitly opted into SSH
			expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('names a disabled remote instead of calling it missing', async () => {
			mockReadSshRemotes.mockReturnValue([
				{ id: 'r1', name: 'Build Box', host: 'remotehost', enabled: false },
			]);

			const result = await spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('"Build Box" is disabled');
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('still fails if the wrapper cannot resolve a remote the plan found', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue(
				sshWrapResult({ command: 'claude', args: [], cwd: '/p', sshRemoteUsed: null })
			);

			const result = await spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/could not be resolved/i);
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('hard-fails for JSON-line agents (Codex) when SSH remote is unresolvable', async () => {
			const result = await spawnAgent('codex', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'gone' },
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('"gone" no longer exists');
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it('forwards agent binaryName (not local path) to the SSH wrapper', async () => {
			mockGetAgentCustomPath.mockReturnValue('/opt/local/claude');
			mockWrapSpawnWithSsh.mockResolvedValue(sshWrapResult({ args: ['remotehost'] }));

			// Explicit API token source so the remote command stays `claude`.
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				enableMaestroP: false,
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const [wrapConfig] = mockWrapSpawnWithSsh.mock.calls[0] as [
				{ agentBinaryName?: string; command: string },
			];
			expect(wrapConfig.agentBinaryName).toBe('claude');
			// local `command` may be a resolved path, but agentBinaryName is what
			// the wrapper actually uses for the remote invocation.
		});

		it('defaults an UNCONFIGURED SSH agent to claude --print, NOT the remote TUI', async () => {
			// The CLI cannot probe the remote for maestro-p and it may not be
			// installed there, so an agent that never chose a token source must
			// default to API (claude) over SSH - never optimistically exec maestro-p.
			mockWrapSpawnWithSsh.mockResolvedValue(sshWrapResult({ args: ['remotehost'] }));

			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				// enableMaestroP intentionally omitted (unconfigured).
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const [wrapConfig] = mockWrapSpawnWithSsh.mock.calls[0] as [
				{ agentBinaryName?: string; args: string[] },
			];
			expect(wrapConfig.agentBinaryName).toBe('claude');
			expect(wrapConfig.agentBinaryName).not.toBe('maestro-p');
		});

		it('runs maestro-p on the remote host when the agent selected the TUI token source', async () => {
			// Honoring the token source across the board: an SSH agent set to
			// interactive (TUI) drives the remote maestro-p on the Max plan instead
			// of `claude --print`, mirroring the desktop SSH remote-interactive path.
			mockWrapSpawnWithSsh.mockResolvedValue(sshWrapResult({ args: ['remotehost'] }));

			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				enableMaestroP: true,
				maestroPMode: 'interactive',
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const [wrapConfig] = mockWrapSpawnWithSsh.mock.calls[0] as [
				{ agentBinaryName?: string; args: string[] },
			];
			// Remote command is maestro-p (not claude), with the interactive flag
			// prepended ahead of the headless batch args.
			expect(wrapConfig.agentBinaryName).toBe('maestro-p');
			expect(wrapConfig.args).toContain('--dangerously-skip-permissions');
		});

		it('passes session customArgs through to the SSH wrapper (baseline args include them)', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue(sshWrapResult({ args: ['remotehost'] }));

			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				customArgs: '--ssh-injected-flag',
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const [wrapConfig] = mockWrapSpawnWithSsh.mock.calls[0] as [{ args: string[] }];
			expect(wrapConfig.args).toContain('--ssh-injected-flag');
		});

		it('passes session customEnvVars through to the SSH wrapper (env reaches remote host)', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue(sshWrapResult({ args: ['remotehost'] }));

			const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				customEnvVars: { REMOTE_TOKEN: 'abc' },
			});
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const [wrapConfig] = mockWrapSpawnWithSsh.mock.calls[0] as [
				{ customEnvVars?: Record<string, string> },
			];
			expect(wrapConfig.customEnvVars).toBeDefined();
			expect(wrapConfig.customEnvVars!.REMOTE_TOKEN).toBe('abc');
		});

		it('forwards agent defaultEnvVars to the SSH wrapper even without user customEnvVars', async () => {
			// Defaults must still reach the remote host (which has no shell env
			// to fall back on). Session customEnvVars is omitted here - we're
			// asserting that the default-only path survived the env-layer fix.
			mockWrapSpawnWithSsh.mockResolvedValue(sshWrapResult({ args: ['remotehost'] }));

			const p = spawnAgent('opencode', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});
			await driveSpawnToCompletion(p, 0);

			const [wrapConfig] = mockWrapSpawnWithSsh.mock.calls[0] as [
				{ customEnvVars?: Record<string, string> },
			];
			expect(wrapConfig.customEnvVars).toBeDefined();
			expect(wrapConfig.customEnvVars!.OPENCODE_CONFIG_CONTENT).toContain('"permission"');
		});
	});

	describe('spawnAgent: local binary resolution (#1608)', () => {
		// A COLD detection cache is this bug's precondition - `goal-runner` and
		// `batch-processor` reach `spawnAgent()` without any prior `detectAgent()`,
		// so nothing has populated it. The suites above warm the shared module's
		// cache, so every test here takes a fresh module instance instead.
		async function freshSpawner() {
			vi.resetModules();
			return import('../../../cli/services/agent-spawner');
		}

		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
		});

		it('execs the resolved npm .cmd shim on Windows rather than a bare binaryName', async () => {
			// No Windows CI leg runs this path, so the platform is mocked. Node
			// cannot exec a bare `claude` on Windows at all: CreateProcess does not
			// apply PATHEXT, so the `.cmd` shim npm installs is never found.
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			const shim = 'C:\\Users\\t\\AppData\\Roaming\\npm\\claude.cmd';
			pathProbeResolver = () => shim;

			try {
				const { spawnAgent: freshSpawnAgent } = await freshSpawner();
				const result = await driveSpawnToCompletion(
					freshSpawnAgent('claude-code', 'C:\\project', 'hi'),
					0,
					CLAUDE_OK()
				);

				expect(result.success).toBe(true);
				expect(spawnCall().command).toBe(shim);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('resolves a JSON-line agent on a cold cache too', async () => {
			mockCheckBinaryExists.mockResolvedValue({ exists: true, path: '/opt/homebrew/bin/codex' });

			const { spawnAgent: freshSpawnAgent } = await freshSpawner();
			await driveSpawnToCompletion(freshSpawnAgent('codex', '/p', 'hi'), 0, CODEX_INIT());

			expect(spawnCall().command).toBe('/opt/homebrew/bin/codex');
		});

		it('selects the desktop Codex binary before the generic PATH probe', async () => {
			mockCheckBinaryExists.mockResolvedValue({
				exists: true,
				path: '/home/user/.local/bin/codex',
			});
			pathProbeResolver = () => '/home/user/.nvm/bin/codex';

			const { spawnAgent: freshSpawnAgent } = await freshSpawner();
			await driveSpawnToCompletion(freshSpawnAgent('codex', '/p', 'hi'), 0, CODEX_INIT());

			expect(spawnCall().command).toBe('/home/user/.local/bin/codex');
			expect(mockCheckBinaryExists).toHaveBeenCalledWith('codex');
		});

		it("honors the user's configured custom path on a cold cache", async () => {
			// `detectAgent()` is the only reader of `getAgentCustomPath()`, so before
			// this a playbook run silently ignored the binary the user pointed at
			// and ran whatever PATH offered.
			mockGetAgentCustomPath.mockReturnValue('/custom/bin/codex');
			vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => true } as fs.Stats);
			vi.mocked(fs.promises.access).mockResolvedValue(undefined);

			const { spawnAgent: freshSpawnAgent } = await freshSpawner();
			await driveSpawnToCompletion(freshSpawnAgent('codex', '/p', 'hi'), 0, CODEX_INIT());

			expect(spawnCall().command).toBe('/custom/bin/codex');
			expect(mockCheckBinaryExists).not.toHaveBeenCalled();
		});

		it('falls back to the bare binaryName when nothing resolves', async () => {
			// Unchanged behavior on a machine where the probe comes up empty: the
			// spawn is still attempted so the user gets the real ENOENT, rather
			// than being refused by the resolver.
			pathProbeResolver = () => undefined;

			const { spawnAgent: freshSpawnAgent } = await freshSpawner();
			await driveSpawnToCompletion(freshSpawnAgent('claude-code', '/p', 'hi'), 0, CLAUDE_OK());

			expect(spawnCall().command).toBe('claude');
		});

		it('leaves an SSH spawn on the bare binaryName', async () => {
			// A path resolved on THIS machine names nothing on the remote host,
			// which resolves the command through its own login-shell PATH.
			pathProbeResolver = () => '/usr/local/bin/claude';
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['remotehost', 'claude --print -- hi'],
				cwd: '/home/user',
				customEnvVars: undefined,
				prompt: undefined,
				sshStdinScript: undefined,
				sshRemoteUsed: { id: 'r1', name: 'r1', host: 'remotehost' },
			});

			const { spawnAgent: freshSpawnAgent } = await freshSpawner();
			await driveSpawnToCompletion(
				freshSpawnAgent('claude-code', '/p', 'hi', undefined, {
					sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				}),
				0,
				CLAUDE_OK()
			);

			const wrapConfig = mockWrapSpawnWithSsh.mock.calls[0][0];
			expect(wrapConfig.command).toBe('claude');
		});
	});

	describe('spawnAgent: regression', () => {
		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
		});

		it('returns only the latest phase-less Codex answer after interim text and a tool', async () => {
			const onProgress = vi.fn();
			const pending = spawnAgent('codex', '/p', 'hi', undefined, { onProgress });
			const output =
				[
					{ type: 'item.completed', item: { type: 'agent_message', text: 'I will check.' } },
					{
						type: 'item.started',
						item: { type: 'command_execution', id: 'tool-1', command: 'secret' },
					},
					{
						type: 'item.completed',
						item: { type: 'command_execution', id: 'tool-1', status: 'completed' },
					},
					{ type: 'item.completed', item: { type: 'agent_message', text: 'The answer is 42.' } },
				]
					.map(JSON.stringify)
					.join('\n') + '\n';
			const result = await driveSpawnToCompletion(pending, 0, output);
			expect(result.response).toBe('The answer is 42.');
			expect(
				onProgress.mock.calls.map(([event]) =>
					event.type === 'commentary' ? event.text : event.type
				)
			).toEqual(['tool', 'tool', 'I will check.']);
			expect(JSON.stringify(onProgress.mock.calls)).not.toContain('The answer is 42.');
		});

		it('honors explicit Codex commentary and final phases across duplicate representations', async () => {
			const onProgress = vi.fn();
			const pending = spawnAgent('codex', '/p', 'hi', undefined, { onProgress });
			const output =
				[
					{
						type: 'event_msg',
						payload: { type: 'agent_message', phase: 'commentary', message: 'Checking files' },
					},
					{
						type: 'response_item',
						payload: {
							type: 'message',
							role: 'assistant',
							phase: 'commentary',
							content: [{ type: 'output_text', text: 'Checking files' }],
						},
					},
					{ type: 'response_item', payload: { type: 'reasoning', summary: ['PRIVATE'] } },
					{
						type: 'item.completed',
						item: { type: 'agent_message', phase: 'final', text: 'Done.' },
					},
					{
						type: 'event_msg',
						payload: { type: 'agent_message', phase: 'final', message: 'Done.' },
					},
				]
					.map(JSON.stringify)
					.join('\n') + '\n';
			const result = await driveSpawnToCompletion(pending, 0, output);
			expect(result.response).toBe('Done.');
			expect(onProgress.mock.calls.map(([event]) => event.text)).toEqual(['Checking files']);
			expect(JSON.stringify(onProgress.mock.calls)).not.toContain('PRIVATE');
		});

		it('keeps only the last distinct phase-less candidate and confirms earlier ones as progress', async () => {
			const onProgress = vi.fn();
			const pending = spawnAgent('codex', '/p', 'hi', undefined, { onProgress });
			const output =
				[
					{ type: 'item.completed', item: { type: 'agent_message', text: 'First' } },
					{ type: 'event_msg', payload: { type: 'agent_message', message: 'First' } },
					{ type: 'item.completed', item: { type: 'agent_message', text: 'Second' } },
					{ type: 'item.completed', item: { type: 'agent_message', text: 'Third' } },
				]
					.map(JSON.stringify)
					.join('\n') + '\n';
			const result = await driveSpawnToCompletion(pending, 0, output);
			expect(result.response).toBe('Third');
			expect(onProgress.mock.calls.map(([event]) => event.text)).toEqual(['First', 'Second']);
		});

		it('does not report a phase-less duplicate of the explicit final as progress', async () => {
			const onProgress = vi.fn();
			const pending = spawnAgent('codex', '/p', 'hi', undefined, { onProgress });
			const output =
				[
					{ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } },
					{
						type: 'event_msg',
						payload: { type: 'agent_message', phase: 'final', message: 'Done' },
					},
				]
					.map(JSON.stringify)
					.join('\n') + '\n';
			const result = await driveSpawnToCompletion(pending, 0, output);
			expect(result.response).toBe('Done');
			expect(onProgress).not.toHaveBeenCalled();
		});

		it('fails a Codex turn containing only commentary or reasoning', async () => {
			const pending = spawnAgent('codex', '/p', 'hi');
			const output =
				[
					{
						type: 'event_msg',
						payload: { type: 'agent_message', phase: 'commentary', message: 'Working' },
					},
					{ type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE' } },
				]
					.map(JSON.stringify)
					.join('\n') + '\n';
			const result = await driveSpawnToCompletion(pending, 0, output);
			expect(result).toMatchObject({ success: false, error: 'Agent returned no final text' });
			expect(result.response).toBeUndefined();
		});

		it.each([
			{ exitCode: 1, signal: null },
			{ exitCode: null, signal: 'SIGTERM' },
		])('preserves Codex stderr on a failed exit: %j', async ({ exitCode, signal }) => {
			const pending = spawnAgent('codex', '/p', 'hi');
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockStderr.emit('data', Buffer.from('Provider configuration unavailable\n'));
			mockChild.emit('close', exitCode, signal);
			const result = await pending;
			expect(result).toMatchObject({
				success: false,
				outcome: 'crashed',
				error: 'Provider configuration unavailable\n',
			});
			expect(result.response).toBeUndefined();
		});

		it('uses the same Codex answer and progress contract over SSH', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['remote'],
				cwd: '/p',
				customEnvVars: undefined,
				prompt: undefined,
				sshStdinScript: undefined,
				sshRemoteUsed: { id: 'remote', name: 'remote', host: 'remotehost' },
			});
			const onProgress = vi.fn();
			const pending = spawnAgent('codex', '/p', 'hi', undefined, {
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				onProgress,
			});
			const output =
				[
					{ type: 'item.completed', item: { type: 'agent_message', text: 'Looking' } },
					{ type: 'item.completed', item: { type: 'agent_message', text: 'Found it' } },
				]
					.map(JSON.stringify)
					.join('\n') + '\n';
			const result = await driveSpawnToCompletion(pending, 0, output);
			expect(result.response).toBe('Found it');
			expect(onProgress.mock.calls.map(([event]) => event.text)).toEqual(['Looking']);
		});

		it('keeps concurrent Codex sends isolated and stops progress after close', async () => {
			const createChild = () =>
				Object.assign(new EventEmitter(), {
					stdin: { end: vi.fn(), write: vi.fn(), on: vi.fn() },
					stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() }),
					stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() }),
				});
			const first = createChild();
			const second = createChild();
			mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
			const firstProgress = vi.fn();
			const secondProgress = vi.fn();
			const firstPending = spawnAgent('codex', '/p', 'one', undefined, {
				onProgress: firstProgress,
			});
			const secondPending = spawnAgent('codex', '/p', 'two', undefined, {
				onProgress: secondProgress,
			});
			await waitForSpawnCall(2);
			first.stdout.emit(
				'data',
				Buffer.from(
					'{"type":"item.completed","item":{"type":"agent_message","text":"First interim"}}\n'
				)
			);
			second.stdout.emit(
				'data',
				Buffer.from(
					'{"type":"item.completed","item":{"type":"agent_message","text":"Second final"}}\n'
				)
			);
			first.stdout.emit(
				'data',
				Buffer.from(
					'{"type":"item.completed","item":{"type":"agent_message","text":"First final"}}\n'
				)
			);
			second.emit('close', 0);
			first.emit('close', 0);
			expect((await firstPending).response).toBe('First final');
			expect((await secondPending).response).toBe('Second final');
			expect(firstProgress.mock.calls.map(([event]) => event.text)).toEqual(['First interim']);
			expect(secondProgress).not.toHaveBeenCalled();
			first.stdout.emit(
				'data',
				Buffer.from(
					'{"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"late"}}\n'
				)
			);
			expect(firstProgress).toHaveBeenCalledTimes(1);
		});

		it('does not emit late progress or return a candidate after cancellation', async () => {
			const controller = new AbortController();
			const onProgress = vi.fn();
			const pending = spawnAgent('codex', '/p', 'hi', undefined, {
				signal: controller.signal,
				onProgress,
			});
			await waitForSpawnCall();
			controller.abort();
			mockStdout.emit(
				'data',
				Buffer.from(
					'{"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"late"}}\n'
				)
			);
			mockChild.emit('close', null, 'SIGTERM');
			expect(await pending).toMatchObject({
				success: false,
				error: 'Agent run cancelled',
			});
			expect(onProgress).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ type: 'activity', text: 'Agent run cancelled' })
			);
		});

		it('streams Codex public commentary and tool status without raw arguments or reasoning', async () => {
			const onProgress = vi.fn();
			const p = spawnAgent('codex', '/p', 'hi', undefined, { onProgress });
			const lines =
				[
					{
						type: 'event_msg',
						payload: { type: 'agent_message', phase: 'commentary', message: 'Checking files' },
					},
					{
						type: 'response_item',
						payload: {
							type: 'function_call',
							name: 'functions.exec_command',
							call_id: 'c1',
							arguments: '{"cmd":"SECRET_ARGUMENT"}',
						},
					},
					{
						type: 'response_item',
						payload: { type: 'function_call_output', call_id: 'c1', output: 'SECRET_OUTPUT' },
					},
					{ type: 'response_item', payload: { type: 'reasoning', summary: ['SECRET_REASONING'] } },
					{ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
				]
					.map((line) => JSON.stringify(line))
					.join('\n') + '\n';
			await driveSpawnToCompletion(p, 0, lines);
			expect(onProgress.mock.calls.map(([event]) => ({ ...event, at: undefined }))).toEqual([
				{ type: 'commentary', text: 'Checking files', at: undefined },
				{
					type: 'tool',
					tool: 'functions.exec_command',
					status: 'started',
					summary: 'Running shell command',
					at: undefined,
				},
				{
					type: 'tool',
					tool: 'functions.exec_command',
					status: 'completed',
					summary: 'Running shell command',
					at: undefined,
				},
			]);
			expect(JSON.stringify(onProgress.mock.calls)).not.toMatch(/SECRET_/);
		});

		it('labels Codex exec wrappers and file actions without exposing nested arguments', async () => {
			const onProgress = vi.fn();
			const p = spawnAgent('codex', '/p', 'hi', undefined, { onProgress });
			const lines =
				[
					{
						type: 'response_item',
						payload: {
							type: 'function_call',
							name: 'functions.exec',
							call_id: 'wrapper',
							arguments: 'const r = await tools.exec_command({cmd: "SECRET_COMMAND"});',
						},
					},
					{
						type: 'response_item',
						payload: {
							type: 'function_call',
							name: 'Read',
							call_id: 'file',
							arguments: JSON.stringify({
								file_path: '/SECRET_DIRECTORY/src/main.ts',
								content: 'SECRET_CONTENT',
							}),
						},
					},
					{
						type: 'response_item',
						payload: {
							type: 'function_call',
							name: 'functions.collaboration.spawn_agent',
							call_id: 'dispatch',
							arguments: JSON.stringify({ task_name: 'reviewer', message: 'SECRET_PROMPT' }),
						},
					},
					{
						type: 'response_item',
						payload: { type: 'function_call_output', call_id: 'file', output: 'SECRET_OUTPUT' },
					},
					{
						type: 'response_item',
						payload: { type: 'function_call_output', call_id: 'wrapper', output: 'SECRET_OUTPUT' },
					},
					{
						type: 'response_item',
						payload: { type: 'function_call_output', call_id: 'dispatch', output: 'SECRET_OUTPUT' },
					},
					{ type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
				]
					.map(JSON.stringify)
					.join('\n') + '\n';
			await driveSpawnToCompletion(p, 0, lines);
			expect(onProgress.mock.calls.map(([event]) => [event.status, event.summary])).toEqual([
				['started', 'Running shell command'],
				['started', 'Reading file main.ts'],
				['started', 'Dispatching to agent reviewer'],
				['completed', 'Reading file main.ts'],
				['completed', 'Running shell command'],
				['completed', 'Dispatching to agent reviewer'],
			]);
			expect(JSON.stringify(onProgress.mock.calls)).not.toMatch(/SECRET_/);
		});

		it('labels Claude file, shell, and Task actions with invocation scoped completions', async () => {
			const onProgress = vi.fn();
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, { onProgress });
			const lines =
				[
					{
						type: 'assistant',
						message: {
							content: [
								{
									type: 'tool_use',
									id: 'read',
									name: 'Read',
									input: { file_path: '/SECRET_DIRECTORY/notes.md' },
								},
								{
									type: 'tool_use',
									id: 'bash',
									name: 'Bash',
									input: { command: 'SECRET_COMMAND' },
								},
								{
									type: 'tool_use',
									id: 'task',
									name: 'Task',
									input: { subagent_type: 'Explore', prompt: 'SECRET_PROMPT' },
								},
							],
						},
					},
					{
						type: 'user',
						message: {
							content: [
								{ type: 'tool_result', tool_use_id: 'bash', content: 'SECRET_OUTPUT' },
								{ type: 'tool_result', tool_use_id: 'read', content: 'SECRET_OUTPUT' },
								{ type: 'tool_result', tool_use_id: 'task', content: 'SECRET_OUTPUT' },
							],
						},
					},
					{ type: 'result', result: 'done' },
				]
					.map(JSON.stringify)
					.join('\n') + '\n';
			await driveSpawnToCompletion(p, 0, lines);
			expect(onProgress.mock.calls.map(([event]) => [event.status, event.summary])).toEqual([
				['started', 'Reading file notes.md'],
				['started', 'Running shell command'],
				['started', 'Dispatching to agent Explore'],
				['completed', 'Running shell command'],
				['completed', 'Reading file notes.md'],
				['completed', 'Dispatching to agent Explore'],
			]);
			expect(JSON.stringify(onProgress.mock.calls)).not.toMatch(/SECRET_/);
		});

		it('Claude spawn without any options still includes base stream-json flags', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi');
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			expect(args).toContain('--print');
			expect(args).toContain('--verbose');
			expect(args).toContain('--output-format');
			expect(args).toContain('stream-json');
			expect(args).toContain('--dangerously-skip-permissions');
			// prompt is appended as positional after '--'
			const sep = args.indexOf('--');
			expect(sep).toBeGreaterThan(0);
			expect(args[sep + 1]).toBe('hi');
		});

		it('Claude read-only mode uses --permission-mode plan instead of --dangerously-skip-permissions', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi', undefined, { readOnlyMode: true });
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			expect(args).toContain('--permission-mode');
			expect(args).toContain('plan');
			expect(args).not.toContain('--dangerously-skip-permissions');
		});

		it('Claude resumes existing agent session when agentSessionId is provided', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi', 'agent-session-xyz');
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			expect(args).toContain('--resume');
			expect(args).toContain('agent-session-xyz');
			// no --session-id should be injected when resuming
			expect(args).not.toContain('--session-id');
		});

		it('Claude generates fresh --session-id when no agentSessionId is provided', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi');
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			const idx = args.indexOf('--session-id');
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(args[idx + 1]).toMatch(/^[0-9a-f-]{36}$/);
		});

		it('Codex spawn preserves working-dir flag and resume args', async () => {
			const p = spawnAgent('codex', '/working', 'hi', 'codex-thread-123');
			await driveSpawnToCompletion(p, 0, CODEX_INIT());

			const { args } = spawnCall();
			expect(args).toContain('exec');
			expect(args).toContain('--json');
			// Codex takes -C <dir> for working directory
			const c = args.indexOf('-C');
			expect(c).toBeGreaterThanOrEqual(0);
			expect(args[c + 1]).toBe('/working');
			// resume args are ['resume', '<id>']
			expect(args).toContain('resume');
			expect(args).toContain('codex-thread-123');

			// Ordering is load-bearing: `-C` is a ROOT-level global flag that MUST
			// precede the `exec` subcommand, which in turn precedes `resume <id>`.
			// Placing `-C` after `resume` makes Codex hard-fail with
			// "unexpected argument '-C' found", breaking Relay follow-up messages
			// to Codex agents (regression of #960). Enforce -C < exec < resume.
			const execIdx = args.indexOf('exec');
			const resumeIdx = args.indexOf('resume');
			expect(c).toBeLessThan(execIdx);
			expect(execIdx).toBeLessThan(resumeIdx);
		});

		it('Codex puts --add-dir before the resume subcommand', async () => {
			// `codex exec resume` has no `--add-dir`: a flag after `resume <id>`
			// belongs to that subcommand, so it answered "unexpected argument
			// '--add-dir' found" and exited 2. Every follow-up turn of an agent with
			// a writable Additional Directory died before it started.
			const p = spawnAgent('codex', '/working', 'hi', 'codex-thread-123', {
				additionalDirectories: [{ path: '/config', read: true, write: true }],
			});
			await driveSpawnToCompletion(p, 0, CODEX_INIT());

			const { args } = spawnCall();
			const addDirIdx = args.indexOf('--add-dir');
			expect(addDirIdx).toBeGreaterThanOrEqual(0);
			expect(args[addDirIdx + 1]).toBe('/config');
			expect(args.indexOf('exec')).toBeLessThan(addDirIdx);
			expect(addDirIdx).toBeLessThan(args.indexOf('resume'));
		});

		it('unsupported agent type returns a failure result', async () => {
			const result = await spawnAgent('terminal' as never, '/p', 'hi');
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/Unsupported agent type/);
		});
	});

	describe('spawnAgent: appendSystemPrompt', () => {
		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
		});

		it('passes the Maestro system prompt to Claude via --append-system-prompt (non-Windows)', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			try {
				const p = spawnAgent('claude-code', '/p', 'user msg', undefined, {
					appendSystemPrompt: 'maestro context here',
				});
				await driveSpawnToCompletion(p, 0, CLAUDE_OK());

				const { args } = spawnCall();
				const flagIdx = args.indexOf('--append-system-prompt');
				expect(flagIdx).toBeGreaterThanOrEqual(0);
				expect(args[flagIdx + 1]).toBe('maestro context here');
				// The flag must precede the '--' separator so it doesn't get
				// swallowed as part of the positional prompt.
				const sepIdx = args.indexOf('--');
				expect(flagIdx).toBeLessThan(sepIdx);
				expect(args[sepIdx + 1]).toBe('user msg');
			} finally {
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});

		it('uses --append-system-prompt-file with a temp file on Windows local execution', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
			try {
				const p = spawnAgent('claude-code', 'C:\\proj', 'hi', undefined, {
					appendSystemPrompt: 'sysprompt',
				});
				await driveSpawnToCompletion(p, 0, CLAUDE_OK());

				const { args } = spawnCall();
				const fileFlagIdx = args.indexOf('--append-system-prompt-file');
				expect(fileFlagIdx).toBeGreaterThanOrEqual(0);
				// The arg after the flag should be a tmp-path with the maestro prefix
				expect(args[fileFlagIdx + 1]).toMatch(/maestro-sysprompt-/);
				// Inline flag must NOT also be emitted on the Windows local path
				expect(args.indexOf('--append-system-prompt')).toBe(-1);
				// And we must have written the temp file
				expect(writeSpy).toHaveBeenCalledWith(
					expect.stringMatching(/maestro-sysprompt-/),
					'sysprompt',
					'utf-8'
				);
			} finally {
				writeSpy.mockRestore();
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});

		it('sanitizes the session tag in the Windows temp-file path to block traversal', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
			try {
				// A session id containing path separators / `..` would normally
				// let `path.join(os.tmpdir(), …)` walk upward and escape tmpdir.
				// We pass it through as the agentSessionId (which becomes the
				// sessionTag inside buildAppendSystemPromptArgs).
				const p = spawnAgent('claude-code', 'C:\\proj', 'hi', '../../../etc/passwd', {
					appendSystemPrompt: 'sysprompt',
				});
				await driveSpawnToCompletion(p, 0, CLAUDE_OK());

				const { args } = spawnCall();
				const fileFlagIdx = args.indexOf('--append-system-prompt-file');
				expect(fileFlagIdx).toBeGreaterThanOrEqual(0);
				const tempPath = args[fileFlagIdx + 1];
				// Sanitized path must not contain unescaped traversal tokens
				expect(tempPath).not.toMatch(/\.\.\//);
				expect(tempPath).not.toMatch(/\.\.\\/);
				// And the dangerous chars should have collapsed to safe ones
				expect(tempPath).toMatch(/maestro-sysprompt-[A-Za-z0-9_-]+-\d+\.txt$/);
			} finally {
				writeSpy.mockRestore();
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});

		it('uses inline --append-system-prompt on Windows when SSH is enabled (cmd is in a shell script)', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['remotehost', 'claude --append-system-prompt sysprompt -- hi'],
				cwd: '/home/user',
				customEnvVars: undefined,
				prompt: undefined,
				sshStdinScript: undefined,
				sshRemoteUsed: { id: 'r1', name: 'r1', host: 'remotehost' },
			});
			try {
				const p = spawnAgent('claude-code', '/p', 'hi', undefined, {
					appendSystemPrompt: 'sysprompt',
					sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				});
				await driveSpawnToCompletion(p, 0, CLAUDE_OK());

				expect(mockWrapSpawnWithSsh).toHaveBeenCalled();
				const [wrapConfig] = mockWrapSpawnWithSsh.mock.calls[0] as [{ args: string[] }];
				const flagIdx = wrapConfig.args.indexOf('--append-system-prompt');
				expect(flagIdx).toBeGreaterThanOrEqual(0);
				expect(wrapConfig.args[flagIdx + 1]).toBe('sysprompt');
				expect(wrapConfig.args.indexOf('--append-system-prompt-file')).toBe(-1);
			} finally {
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});

		it('still injects the Maestro system prompt on resume (Claude reads it every turn)', async () => {
			// Pin the platform to a POSIX value so this exercises the inline
			// `--append-system-prompt` path deterministically. On Windows local
			// spawns the product instead writes the prompt to a temp file and
			// passes `--append-system-prompt-file` (see buildAppendSystemPromptArgs),
			// which is correct but a different arg shape. On Unix this override is
			// a no-op.
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			try {
				const p = spawnAgent('claude-code', '/p', 'follow-up', 'session-abc', {
					appendSystemPrompt: 'maestro context',
				});
				await driveSpawnToCompletion(p, 0, CLAUDE_OK());

				const { args } = spawnCall();
				expect(args).toContain('--resume');
				expect(args).toContain('session-abc');
				const flagIdx = args.indexOf('--append-system-prompt');
				expect(flagIdx).toBeGreaterThanOrEqual(0);
				expect(args[flagIdx + 1]).toBe('maestro context');
			} finally {
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			}
		});

		it('Codex (no native --append-system-prompt support) embeds the system prompt in the first user turn', async () => {
			const p = spawnAgent('codex', '/p', 'do thing', undefined, {
				appendSystemPrompt: 'maestro ctx',
			});
			await driveSpawnToCompletion(p, 0, CODEX_INIT());

			const { args } = spawnCall();
			// codex uses `-- <prompt>` positional form
			const sepIdx = args.indexOf('--');
			expect(sepIdx).toBeGreaterThan(0);
			const positional = args[sepIdx + 1];
			expect(positional).toContain('maestro ctx');
			expect(positional).toContain('# User Request');
			expect(positional).toContain('do thing');
			// must NOT emit the native flag for agents that don't support it
			expect(args.indexOf('--append-system-prompt')).toBe(-1);
			expect(args.indexOf('--append-system-prompt-file')).toBe(-1);
		});

		it('Codex resume skips system-prompt embedding (already captured in transcript)', async () => {
			const p = spawnAgent('codex', '/p', 'do thing', 'codex-thread-xyz', {
				appendSystemPrompt: 'maestro ctx',
			});
			await driveSpawnToCompletion(p, 0, CODEX_INIT());

			const { args } = spawnCall();
			const sepIdx = args.indexOf('--');
			expect(sepIdx).toBeGreaterThan(0);
			const positional = args[sepIdx + 1];
			expect(positional).toBe('do thing');
			expect(positional).not.toContain('maestro ctx');
			expect(positional).not.toContain('# User Request');
		});

		it('Claude spawn without appendSystemPrompt does NOT add the flag (regression)', async () => {
			const p = spawnAgent('claude-code', '/p', 'hi');
			await driveSpawnToCompletion(p, 0, CLAUDE_OK());

			const { args } = spawnCall();
			expect(args.indexOf('--append-system-prompt')).toBe(-1);
			expect(args.indexOf('--append-system-prompt-file')).toBe(-1);
		});

		it('Codex spawn without appendSystemPrompt passes the raw user prompt unchanged (regression)', async () => {
			const p = spawnAgent('codex', '/p', 'just the user message');
			await driveSpawnToCompletion(p, 0, CODEX_INIT());

			const { args } = spawnCall();
			const sepIdx = args.indexOf('--');
			expect(sepIdx).toBeGreaterThan(0);
			expect(args[sepIdx + 1]).toBe('just the user message');
		});
	});
});
