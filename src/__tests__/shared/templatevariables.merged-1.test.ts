// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/templateVariables.test.ts
// Source: src/__tests__/shared/templateVariables.upstream.test.ts
// Source: src/__tests__/shared/crossAgentContext.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	findCueUntrustedTemplateVariables,
	cueEventCarriesUntrustedText,
	TEMPLATE_VARIABLES,
	TEMPLATE_VARIABLES_GENERAL,
	substituteTemplateVariables as s1_substituteTemplateVariables,
	TemplateContext as S1_TemplateContext,
	TemplateSessionInfo as S1_TemplateSessionInfo,
} from '../../shared/templateVariables';
import {
	substituteTemplateVariables as s2_substituteTemplateVariables,
	TemplateContext as S2_TemplateContext,
	TemplateSessionInfo as S2_TemplateSessionInfo,
} from '../../shared/templateVariables';
import {
	inferMentionTiming,
	parseAgentMentions,
	messageStartsWithAgentMention,
	inferContextStrategy,
	selectContextWindow,
	deriveConsultSubject,
	DEFAULT_RECENT_TURNS,
	MENTION_ROUTINGS,
	isMentionRouting,
	parseMentionRoutingField,
} from '../../shared/crossAgentContext';
import type { LogEntry } from '../../renderer/types';
// Source: src/__tests__/shared/templateVariables.test.ts
describe('', () => {
	// Helper to create a minimal session for testing
	function createTestSession(
		overrides: Partial<S1_TemplateSessionInfo> = {}
	): S1_TemplateSessionInfo {
		return {
			id: 'test-session-123',
			name: 'Test Session',
			toolType: 'claude-code',
			cwd: '/Users/test/project',
			...overrides,
		};
	}
	// Helper to create a minimal context for testing
	function createTestContext(overrides: Partial<S1_TemplateContext> = {}): S1_TemplateContext {
		return {
			session: createTestSession(),
			...overrides,
		};
	}
	describe('plugin Cue metadata trust boundary', () => {
		it('classifies substituted metadata as outside text even in lower-case command templates', () => {
			const command = 'process --payload "{{cue_plugin_metadata}}"';
			expect(findCueUntrustedTemplateVariables([command])).toEqual([
				expect.objectContaining({
					variable: 'CUE_PLUGIN_METADATA',
					contextKey: 'pluginMetadata',
					events: ['plugin.event'],
				}),
			]);
			expect(cueEventCarriesUntrustedText('plugin.event')).toBe(true);
			expect(
				findCueUntrustedTemplateVariables(['{{CUE_PLUGIN_ID}} {{CUE_PLUGIN_EVENT_ID}}'])
			).toEqual([]);
		});
	});
	describe('TEMPLATE_VARIABLES constant', () => {
		it('should export an array', () => {
			expect(Array.isArray(TEMPLATE_VARIABLES)).toBe(true);
		});
		it('should contain expected number of variables', () => {
			// Based on the source file, there are 27 template variables defined
			expect(TEMPLATE_VARIABLES.length).toBeGreaterThanOrEqual(20);
		});
		it('should have required fields for each entry', () => {
			TEMPLATE_VARIABLES.forEach((entry) => {
				expect(entry).toHaveProperty('variable');
				expect(entry).toHaveProperty('description');
				expect(typeof entry.variable).toBe('string');
				expect(typeof entry.description).toBe('string');
			});
		});
		it('should have all variables wrapped in double braces', () => {
			TEMPLATE_VARIABLES.forEach((entry) => {
				expect(entry.variable).toMatch(/^\{\{[A-Z_]+\}\}$/);
			});
		});
		it('should include conductor variables', () => {
			const variables = TEMPLATE_VARIABLES.map((v) => v.variable);
			expect(variables).toContain('{{CONDUCTOR_PROFILE}}');
		});
		it('should include key agent variables', () => {
			const variables = TEMPLATE_VARIABLES.map((v) => v.variable);
			expect(variables).toContain('{{AGENT_ID}}');
			expect(variables).toContain('{{AGENT_NAME}}');
			expect(variables).toContain('{{AGENT_PATH}}');
			expect(variables).toContain('{{AGENT_GROUP}}');
			expect(variables).toContain('{{AGENT_SESSION_ID}}');
			expect(variables).toContain('{{AGENT_HISTORY_PATH}}');
			expect(variables).toContain('{{AGENT_JOURNEY_PATH}}');
			expect(variables).toContain('{{COMPUTER_HISTORY_DIR}}');
			expect(variables).toContain('{{MAESTRO_RUN_PATH}}');
			expect(variables).toContain('{{TAB_ID}}');
			expect(variables).toContain('{{TAB_NAME}}');
			expect(variables).toContain('{{TOOL_TYPE}}');
		});
		it('should include key path variables', () => {
			const variables = TEMPLATE_VARIABLES.map((v) => v.variable);
			expect(variables).toContain('{{CWD}}');
		});
		it('should include date/time variables', () => {
			const variables = TEMPLATE_VARIABLES.map((v) => v.variable);
			expect(variables).toContain('{{DATE}}');
			expect(variables).toContain('{{TIME}}');
			expect(variables).toContain('{{DATETIME}}');
			expect(variables).toContain('{{TIMESTAMP}}');
		});
		it('should include git variables', () => {
			const variables = TEMPLATE_VARIABLES.map((v) => v.variable);
			expect(variables).toContain('{{GIT_BRANCH}}');
			expect(variables).toContain('{{IS_GIT_REPO}}');
		});
		it('should include deep link variables', () => {
			const variables = TEMPLATE_VARIABLES.map((v) => v.variable);
			expect(variables).toContain('{{AGENT_DEEP_LINK}}');
			expect(variables).toContain('{{TAB_DEEP_LINK}}');
			expect(variables).toContain('{{GROUP_DEEP_LINK}}');
		});
		it('should mark Auto Run-only variables with autoRunOnly flag', () => {
			const autoRunOnlyVars = TEMPLATE_VARIABLES.filter((v) => v.autoRunOnly);
			const autoRunOnlyNames = autoRunOnlyVars.map((v) => v.variable);
			expect(autoRunOnlyNames).toContain('{{AUTORUN_FOLDER}}');
			expect(autoRunOnlyNames).toContain('{{DOCUMENT_NAME}}');
			expect(autoRunOnlyNames).toContain('{{DOCUMENT_PATH}}');
			expect(autoRunOnlyNames).toContain('{{LOOP_NUMBER}}');
		});
	});
	describe('TEMPLATE_VARIABLES_GENERAL constant', () => {
		it('should export an array', () => {
			expect(Array.isArray(TEMPLATE_VARIABLES_GENERAL)).toBe(true);
		});
		it('should exclude Auto Run-only variables', () => {
			const variables = TEMPLATE_VARIABLES_GENERAL.map((v) => v.variable);
			expect(variables).not.toContain('{{AUTORUN_FOLDER}}');
			expect(variables).not.toContain('{{DOCUMENT_NAME}}');
			expect(variables).not.toContain('{{DOCUMENT_PATH}}');
			expect(variables).not.toContain('{{LOOP_NUMBER}}');
		});
		it('should include general variables', () => {
			const variables = TEMPLATE_VARIABLES_GENERAL.map((v) => v.variable);
			expect(variables).toContain('{{AGENT_NAME}}');
			expect(variables).toContain('{{AGENT_PATH}}');
			expect(variables).toContain('{{TAB_NAME}}');
			expect(variables).toContain('{{DATE}}');
			expect(variables).toContain('{{GIT_BRANCH}}');
		});
		it('should have fewer items than TEMPLATE_VARIABLES', () => {
			expect(TEMPLATE_VARIABLES_GENERAL.length).toBeLessThan(TEMPLATE_VARIABLES.length);
		});
	});
	describe('substituteTemplateVariables', () => {
		// Mock Date for consistent date/time testing
		const mockDate = new Date('2025-03-15T14:30:45.123Z');
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(mockDate);
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		describe('Conductor Variables', () => {
			it('should replace {{CONDUCTOR_PROFILE}} with conductorProfile', () => {
				const context = createTestContext({
					conductorProfile: 'Senior developer specializing in TypeScript and React',
				});
				const result = s1_substituteTemplateVariables('Profile: {{CONDUCTOR_PROFILE}}', context);
				expect(result).toBe('Profile: Senior developer specializing in TypeScript and React');
			});
			it('should replace {{CONDUCTOR_PROFILE}} with empty string when conductorProfile is undefined', () => {
				const context = createTestContext({
					conductorProfile: undefined,
				});
				const result = s1_substituteTemplateVariables('Profile: {{CONDUCTOR_PROFILE}}', context);
				expect(result).toBe('Profile: ');
			});
		});
		describe('Agent Variables', () => {
			it('should replace {{AGENT_ID}} with session.id', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'agent-uuid-abc-123' }),
				});
				const result = s1_substituteTemplateVariables('ID: {{AGENT_ID}}', context);
				expect(result).toBe('ID: agent-uuid-abc-123');
			});
			it('should replace {{AGENT_NAME}} with session.name', () => {
				const context = createTestContext({
					session: createTestSession({ name: 'Agent Alpha' }),
				});
				const result = s1_substituteTemplateVariables('Agent: {{AGENT_NAME}}', context);
				expect(result).toBe('Agent: Agent Alpha');
			});
			it('should replace {{AGENT_GROUP}} with groupName', () => {
				const context = createTestContext({
					session: createTestSession(),
					groupName: 'Backend Team',
				});
				const result = s1_substituteTemplateVariables('Group: {{AGENT_GROUP}}', context);
				expect(result).toBe('Group: Backend Team');
			});
			it('should replace {{AGENT_GROUP}} with empty string when groupName is undefined', () => {
				const context = createTestContext({
					session: createTestSession(),
					groupName: undefined,
				});
				const result = s1_substituteTemplateVariables('Group: {{AGENT_GROUP}}', context);
				expect(result).toBe('Group: ');
			});
			it('should replace {{AGENT_SESSION_ID}} with agentSessionId', () => {
				const context = createTestContext({
					session: createTestSession({ agentSessionId: 'claude-session-789' }),
				});
				const result = s1_substituteTemplateVariables('Agent: {{AGENT_SESSION_ID}}', context);
				expect(result).toBe('Agent: claude-session-789');
			});
			it('should replace {{AGENT_SESSION_ID}} with empty string when agentSessionId is undefined', () => {
				const context = createTestContext({
					session: createTestSession({ agentSessionId: undefined }),
				});
				const result = s1_substituteTemplateVariables('Agent: {{AGENT_SESSION_ID}}', context);
				expect(result).toBe('Agent: ');
			});
			it('should replace {{TOOL_TYPE}} with session.toolType', () => {
				const context = createTestContext({
					session: createTestSession({ toolType: 'factory-droid' }),
				});
				const result = s1_substituteTemplateVariables('Tool: {{TOOL_TYPE}}', context);
				expect(result).toBe('Tool: factory-droid');
			});
			it('should replace {{TAB_NAME}} with session.name', () => {
				const context = createTestContext({
					session: createTestSession({ name: 'My Custom Tab' }),
				});
				const result = s1_substituteTemplateVariables('Tab: {{TAB_NAME}}', context);
				expect(result).toBe('Tab: My Custom Tab');
			});
			it('should replace {{TAB_ID}} with the active tab id', () => {
				const context = createTestContext({ activeTabId: 'tab-abc-123' });
				const result = s1_substituteTemplateVariables('Tab: {{TAB_ID}}', context);
				expect(result).toBe('Tab: tab-abc-123');
			});
			it('should replace {{TAB_ID}} with an empty string when there is no tab (headless spawn)', () => {
				const context = createTestContext({ activeTabId: undefined });
				const result = s1_substituteTemplateVariables('Tab: {{TAB_ID}}', context);
				expect(result).toBe('Tab: ');
			});
			it('should have {{TAB_NAME}} and {{SESSION_NAME}} as aliases (both return session.name)', () => {
				const context = createTestContext({
					session: createTestSession({ name: 'Aliased Name' }),
				});
				const result1 = s1_substituteTemplateVariables('{{TAB_NAME}}', context);
				const result2 = s1_substituteTemplateVariables('{{SESSION_NAME}}', context);
				expect(result1).toBe(result2);
				expect(result1).toBe('Aliased Name');
			});
			it('should replace {{AGENT_HISTORY_PATH}} with historyFilePath', () => {
				const context = createTestContext({
					historyFilePath: '/Users/test/.config/Maestro/history/session-123.json',
				});
				const result = s1_substituteTemplateVariables('History: {{AGENT_HISTORY_PATH}}', context);
				expect(result).toBe('History: /Users/test/.config/Maestro/history/session-123.json');
			});
			it('should replace {{AGENT_HISTORY_PATH}} with empty string when historyFilePath is undefined', () => {
				const context = createTestContext({
					historyFilePath: undefined,
				});
				const result = s1_substituteTemplateVariables('History: {{AGENT_HISTORY_PATH}}', context);
				expect(result).toBe('History: ');
			});
			it('should replace {{AGENT_JOURNEY_PATH}} with journeyFilePath, and with nothing when unset', () => {
				const file = '/Users/test/.config/Maestro/journey/session-123.jsonl';
				expect(
					s1_substituteTemplateVariables(
						'Journey: {{AGENT_JOURNEY_PATH}}',
						createTestContext({ journeyFilePath: file })
					)
				).toBe(`Journey: ${file}`);
				expect(
					s1_substituteTemplateVariables('Journey: {{AGENT_JOURNEY_PATH}}', createTestContext({}))
				).toBe('Journey: ');
			});
			it('should replace {{MAESTRO_RUN_PATH}} with maestroRunPath, and with nothing when unset', () => {
				const context = createTestContext({
					maestroRunPath: '/a/MaestroRun.app/Contents/MacOS/maestro-run',
				});
				expect(s1_substituteTemplateVariables('[{{MAESTRO_RUN_PATH}}]', context)).toBe(
					'[/a/MaestroRun.app/Contents/MacOS/maestro-run]'
				);
				expect(s1_substituteTemplateVariables('[{{MAESTRO_RUN_PATH}}]', createTestContext())).toBe(
					'[]'
				);
			});
			it('should replace {{COMPUTER_HISTORY_DIR}} with computerHistoryDir', () => {
				const context = createTestContext({ computerHistoryDir: '/data/computer-history' });
				const result = s1_substituteTemplateVariables('Store: {{COMPUTER_HISTORY_DIR}}', context);
				expect(result).toBe('Store: /data/computer-history');
			});
			it('should render {{COMPUTER_HISTORY_DIR}} empty when not supplied (SSH agents)', () => {
				const result = s1_substituteTemplateVariables(
					'Store: [{{COMPUTER_HISTORY_DIR}}]',
					createTestContext()
				);
				expect(result).toBe('Store: []');
			});
		});
		describe('Legacy Session Variables (backwards compatibility)', () => {
			it('should still replace {{SESSION_ID}} with session.id', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'unique-session-456' }),
				});
				const result = s1_substituteTemplateVariables('ID: {{SESSION_ID}}', context);
				expect(result).toBe('ID: unique-session-456');
			});
			it('should still replace {{SESSION_NAME}} with session.name', () => {
				const context = createTestContext({
					session: createTestSession({ name: 'My Custom Session' }),
				});
				const result = s1_substituteTemplateVariables('Name: {{SESSION_NAME}}', context);
				expect(result).toBe('Name: My Custom Session');
			});
		});
		describe('Path Variables', () => {
			it('should replace {{AGENT_PATH}} with session.fullPath when available', () => {
				const context = createTestContext({
					session: createTestSession({
						fullPath: '/full/path/to/project',
						projectRoot: '/project/root',
						cwd: '/current/working/dir',
					}),
				});
				const result = s1_substituteTemplateVariables('Path: {{AGENT_PATH}}', context);
				expect(result).toBe('Path: /full/path/to/project');
			});
			it('should replace {{AGENT_PATH}} with session.projectRoot when fullPath not available', () => {
				const context = createTestContext({
					session: createTestSession({
						fullPath: undefined,
						projectRoot: '/project/root',
						cwd: '/current/working/dir',
					}),
				});
				const result = s1_substituteTemplateVariables('Path: {{AGENT_PATH}}', context);
				expect(result).toBe('Path: /project/root');
			});
			it('should replace {{AGENT_PATH}} with session.cwd as fallback', () => {
				const context = createTestContext({
					session: createTestSession({
						fullPath: undefined,
						projectRoot: undefined,
						cwd: '/current/working/dir',
					}),
				});
				const result = s1_substituteTemplateVariables('Path: {{AGENT_PATH}}', context);
				expect(result).toBe('Path: /current/working/dir');
			});
			it('should replace {{CWD}} with session.cwd', () => {
				const context = createTestContext({
					session: createTestSession({ cwd: '/Users/test/workspace' }),
				});
				const result = s1_substituteTemplateVariables('CWD: {{CWD}}', context);
				expect(result).toBe('CWD: /Users/test/workspace');
			});
			it('should replace {{AUTORUN_FOLDER}} with autoRunFolder from context', () => {
				const context = createTestContext({
					session: createTestSession(),
					autoRunFolder: '/path/to/autorun/docs',
				});
				const result = s1_substituteTemplateVariables('Folder: {{AUTORUN_FOLDER}}', context);
				expect(result).toBe('Folder: /path/to/autorun/docs');
			});
			it('should replace {{AUTORUN_FOLDER}} with session.autoRunFolderPath when autoRunFolder not provided', () => {
				const context = createTestContext({
					session: createTestSession({ autoRunFolderPath: '/session/autorun/path' }),
					autoRunFolder: undefined,
				});
				const result = s1_substituteTemplateVariables('Folder: {{AUTORUN_FOLDER}}', context);
				expect(result).toBe('Folder: /session/autorun/path');
			});
			it('should fall back to derived path from session.cwd when neither autoRunFolder nor autoRunFolderPath available', () => {
				const context = createTestContext({
					session: createTestSession({ autoRunFolderPath: undefined }),
					autoRunFolder: undefined,
				});
				const result = s1_substituteTemplateVariables('Folder: {{AUTORUN_FOLDER}}', context);
				expect(result).toBe('Folder: /Users/test/project/.maestro/playbooks');
			});
			it('should prefer fullPath over projectRoot over cwd for AUTORUN_FOLDER fallback', () => {
				const context = createTestContext({
					session: createTestSession({
						autoRunFolderPath: undefined,
						fullPath: '/full/path',
						projectRoot: '/project/root',
						cwd: '/cwd',
					}),
					autoRunFolder: undefined,
				});
				const result = s1_substituteTemplateVariables('Folder: {{AUTORUN_FOLDER}}', context);
				expect(result).toBe('Folder: /full/path/.maestro/playbooks');
			});
			it('should replace {{WORKTREE_BASE_PATH}} with the configured worktree directory', () => {
				const context = createTestContext({
					session: createTestSession({
						worktreeConfig: { basePath: '/Users/test/Project-WorkTrees' },
					}),
				});
				const result = s1_substituteTemplateVariables('Worktrees: {{WORKTREE_BASE_PATH}}', context);
				expect(result).toBe('Worktrees: /Users/test/Project-WorkTrees');
			});
			it('should render {{WORKTREE_BASE_PATH}} empty when no worktree directory is configured', () => {
				// Deliberately no fallback: a guessed path is exactly where an agent
				// would `git worktree add` by hand, producing a checkout the desktop
				// never registers. Empty tells the prompt to use create-worktree.
				const context = createTestContext({
					session: createTestSession({ worktreeConfig: undefined }),
				});
				const result = s1_substituteTemplateVariables('Worktrees: {{WORKTREE_BASE_PATH}}', context);
				expect(result).toBe('Worktrees: ');
			});
		});
		describe('Legacy Project Variables (backwards compatibility)', () => {
			it('should still replace {{PROJECT_PATH}} with session.fullPath when available', () => {
				const context = createTestContext({
					session: createTestSession({
						fullPath: '/full/path/to/project',
						projectRoot: '/project/root',
						cwd: '/current/working/dir',
					}),
				});
				const result = s1_substituteTemplateVariables('Path: {{PROJECT_PATH}}', context);
				expect(result).toBe('Path: /full/path/to/project');
			});
			it('should still replace {{PROJECT_NAME}} with last path segment', () => {
				const context = createTestContext({
					session: createTestSession({
						fullPath: '/Users/dev/projects/my-awesome-app',
					}),
				});
				const result = s1_substituteTemplateVariables('Project: {{PROJECT_NAME}}', context);
				expect(result).toBe('Project: my-awesome-app');
			});
		});
		describe('Document Variables', () => {
			it('should replace {{DOCUMENT_NAME}} with documentName', () => {
				const context = createTestContext({
					documentName: 'my-playbook',
				});
				const result = s1_substituteTemplateVariables('Doc: {{DOCUMENT_NAME}}', context);
				expect(result).toBe('Doc: my-playbook');
			});
			it('should replace {{DOCUMENT_NAME}} with empty string when documentName is undefined', () => {
				const context = createTestContext({
					documentName: undefined,
				});
				const result = s1_substituteTemplateVariables('Doc: {{DOCUMENT_NAME}}', context);
				expect(result).toBe('Doc: ');
			});
			it('should replace {{DOCUMENT_PATH}} with documentPath', () => {
				const context = createTestContext({
					documentPath: '/Users/dev/playbooks/deploy.md',
				});
				const result = s1_substituteTemplateVariables('Path: {{DOCUMENT_PATH}}', context);
				expect(result).toBe('Path: /Users/dev/playbooks/deploy.md');
			});
			it('should replace {{DOCUMENT_PATH}} with empty string when documentPath is undefined', () => {
				const context = createTestContext({
					documentPath: undefined,
				});
				const result = s1_substituteTemplateVariables('Path: {{DOCUMENT_PATH}}', context);
				expect(result).toBe('Path: ');
			});
			it('should replace {{LOOP_NUMBER}} with 5-digit padded loopNumber', () => {
				const context = createTestContext({
					loopNumber: 5,
				});
				const result = s1_substituteTemplateVariables('Loop: {{LOOP_NUMBER}}', context);
				expect(result).toBe('Loop: 00005');
			});
			it('should replace {{LOOP_NUMBER}} with "00001" when loopNumber is undefined', () => {
				const context = createTestContext({
					loopNumber: undefined,
				});
				const result = s1_substituteTemplateVariables('Loop: {{LOOP_NUMBER}}', context);
				expect(result).toBe('Loop: 00001');
			});
			it('should replace {{LOOP_NUMBER}} with "00000" when loopNumber is 0 (falsy but valid)', () => {
				// Note: loopNumber ?? 1 means 0 would return 0, but null/undefined returns 1
				const context = createTestContext({
					loopNumber: 0,
				});
				const result = s1_substituteTemplateVariables('Loop: {{LOOP_NUMBER}}', context);
				expect(result).toBe('Loop: 00000');
			});
			it('should replace {{LOOP_NUMBER_HUMAN}} with the unpadded loopNumber', () => {
				const context = createTestContext({
					loopNumber: 5,
				});
				const result = s1_substituteTemplateVariables('Iteration: {{LOOP_NUMBER_HUMAN}}', context);
				expect(result).toBe('Iteration: 5');
			});
			it('should replace {{LOOP_NUMBER_HUMAN}} with "1" when loopNumber is undefined', () => {
				const context = createTestContext({
					loopNumber: undefined,
				});
				const result = s1_substituteTemplateVariables('Iteration: {{LOOP_NUMBER_HUMAN}}', context);
				expect(result).toBe('Iteration: 1');
			});
		});
		describe('Date/Time Variables', () => {
			// Tests use mocked date: 2025-03-15T14:30:45.123Z (UTC)
			// Local time depends on timezone, so we test patterns
			it('should replace {{DATE}} with YYYY-MM-DD format', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Date: {{DATE}}', context);
				expect(result).toBe('Date: 2025-03-15');
			});
			it('should replace {{TIME}} with HH:MM:SS format', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Time: {{TIME}}', context);
				// Time depends on local timezone, so check format
				expect(result).toMatch(/^Time: \d{2}:\d{2}:\d{2}$/);
			});
			it('should replace {{DATETIME}} with combined date and time', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('DateTime: {{DATETIME}}', context);
				expect(result).toMatch(/^DateTime: 2025-03-15 \d{2}:\d{2}:\d{2}$/);
			});
			it('should replace {{TIMESTAMP}} with unix timestamp in milliseconds', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('TS: {{TIMESTAMP}}', context);
				expect(result).toBe(`TS: ${mockDate.getTime()}`);
			});
			it('should replace {{DATE_SHORT}} with MM/DD/YY format', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Date: {{DATE_SHORT}}', context);
				// mockDate is 2025-03-15 -> 03/15/25
				expect(result).toBe('Date: 03/15/25');
			});
			it('should replace {{TIME_SHORT}} with HH:MM format', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Time: {{TIME_SHORT}}', context);
				expect(result).toMatch(/^Time: \d{2}:\d{2}$/);
			});
			it('should replace {{YEAR}} with 4-digit year', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Year: {{YEAR}}', context);
				expect(result).toBe('Year: 2025');
			});
			it('should replace {{MONTH}} with zero-padded month', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Month: {{MONTH}}', context);
				expect(result).toBe('Month: 03');
			});
			it('should replace {{DAY}} with zero-padded day', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Day: {{DAY}}', context);
				expect(result).toBe('Day: 15');
			});
			it('should replace {{WEEKDAY}} with day name', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Weekday: {{WEEKDAY}}', context);
				// 2025-03-15 is a Saturday
				expect(result).toBe('Weekday: Saturday');
			});
			it('should handle single-digit month with zero padding', () => {
				// Test with January (month 0)
				vi.setSystemTime(new Date('2025-01-05T10:00:00Z'));
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('{{MONTH}}/{{DAY}}', context);
				expect(result).toBe('01/05');
			});
		});
		describe('Git Variables', () => {
			it('should replace {{GIT_BRANCH}} with gitBranch', () => {
				const context = createTestContext({
					gitBranch: 'feature/new-feature',
				});
				const result = s1_substituteTemplateVariables('Branch: {{GIT_BRANCH}}', context);
				expect(result).toBe('Branch: feature/new-feature');
			});
			it('should replace {{GIT_BRANCH}} with empty string when gitBranch is undefined', () => {
				const context = createTestContext({
					gitBranch: undefined,
				});
				const result = s1_substituteTemplateVariables('Branch: {{GIT_BRANCH}}', context);
				expect(result).toBe('Branch: ');
			});
			it('should replace {{IS_GIT_REPO}} with "true" when isGitRepo is true', () => {
				const context = createTestContext({
					session: createTestSession({ isGitRepo: true }),
				});
				const result = s1_substituteTemplateVariables('Git: {{IS_GIT_REPO}}', context);
				expect(result).toBe('Git: true');
			});
			it('should replace {{IS_GIT_REPO}} with "false" when isGitRepo is false', () => {
				const context = createTestContext({
					session: createTestSession({ isGitRepo: false }),
				});
				const result = s1_substituteTemplateVariables('Git: {{IS_GIT_REPO}}', context);
				expect(result).toBe('Git: false');
			});
			it('should replace {{IS_GIT_REPO}} with "false" when isGitRepo is undefined', () => {
				const context = createTestContext({
					session: createTestSession({ isGitRepo: undefined }),
				});
				const result = s1_substituteTemplateVariables('Git: {{IS_GIT_REPO}}', context);
				expect(result).toBe('Git: false');
			});
		});
		describe('Context Variables', () => {
			it('should replace {{CONTEXT_USAGE}} with contextUsage value', () => {
				const context = createTestContext({
					session: createTestSession({ contextUsage: 75 }),
				});
				const result = s1_substituteTemplateVariables('Usage: {{CONTEXT_USAGE}}%', context);
				expect(result).toBe('Usage: 75%');
			});
			it('should replace {{CONTEXT_USAGE}} with "0" when contextUsage is undefined', () => {
				const context = createTestContext({
					session: createTestSession({ contextUsage: undefined }),
				});
				const result = s1_substituteTemplateVariables('Usage: {{CONTEXT_USAGE}}%', context);
				expect(result).toBe('Usage: 0%');
			});
			it('should handle contextUsage of 0 correctly', () => {
				const context = createTestContext({
					session: createTestSession({ contextUsage: 0 }),
				});
				const result = s1_substituteTemplateVariables('Usage: {{CONTEXT_USAGE}}%', context);
				expect(result).toBe('Usage: 0%');
			});
		});
		describe('Deep Link Variables', () => {
			it('should replace {{AGENT_DEEP_LINK}} with session deep link URL', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'sess-abc' }),
				});
				const result = s1_substituteTemplateVariables('Link: {{AGENT_DEEP_LINK}}', context);
				expect(result).toBe('Link: maestro://session/sess-abc');
			});
			it('should replace {{TAB_DEEP_LINK}} with session+tab deep link when activeTabId provided', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'sess-abc' }),
					activeTabId: 'tab-def',
				});
				const result = s1_substituteTemplateVariables('Link: {{TAB_DEEP_LINK}}', context);
				expect(result).toBe('Link: maestro://session/sess-abc/tab/tab-def');
			});
			it('should replace {{TAB_DEEP_LINK}} with session-only link when no activeTabId', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'sess-abc' }),
				});
				const result = s1_substituteTemplateVariables('Link: {{TAB_DEEP_LINK}}', context);
				expect(result).toBe('Link: maestro://session/sess-abc');
			});
			it('should replace {{GROUP_DEEP_LINK}} with group deep link when groupId provided', () => {
				const context = createTestContext({
					groupId: 'grp-789',
				});
				const result = s1_substituteTemplateVariables('Link: {{GROUP_DEEP_LINK}}', context);
				expect(result).toBe('Link: maestro://group/grp-789');
			});
			it('should replace {{GROUP_DEEP_LINK}} with empty string when no groupId', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Link: {{GROUP_DEEP_LINK}}', context);
				expect(result).toBe('Link: ');
			});
			it('should URI-encode special characters in deep link IDs', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'id/with/slashes' }),
					activeTabId: 'tab?special',
					groupId: 'group#hash',
				});
				const agentResult = s1_substituteTemplateVariables('{{AGENT_DEEP_LINK}}', context);
				const tabResult = s1_substituteTemplateVariables('{{TAB_DEEP_LINK}}', context);
				const groupResult = s1_substituteTemplateVariables('{{GROUP_DEEP_LINK}}', context);
				expect(agentResult).toContain(encodeURIComponent('id/with/slashes'));
				expect(tabResult).toContain(encodeURIComponent('tab?special'));
				expect(groupResult).toContain(encodeURIComponent('group#hash'));
			});
		});
		describe('Case Insensitivity', () => {
			it('should handle lowercase variables', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'test-id' }),
				});
				const result = s1_substituteTemplateVariables('ID: {{session_id}}', context);
				expect(result).toBe('ID: test-id');
			});
			it('should handle uppercase variables', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'test-id' }),
				});
				const result = s1_substituteTemplateVariables('ID: {{SESSION_ID}}', context);
				expect(result).toBe('ID: test-id');
			});
			it('should handle mixed case variables', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'test-id' }),
				});
				const result = s1_substituteTemplateVariables('ID: {{Session_Id}}', context);
				expect(result).toBe('ID: test-id');
			});
			it('should handle mixed case in same template', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'test-id', name: 'Test' }),
				});
				const result = s1_substituteTemplateVariables(
					'{{session_id}} - {{SESSION_NAME}} - {{Tool_Type}}',
					context
				);
				expect(result).toBe('test-id - Test - claude-code');
			});
			it('should handle all lowercase date variables', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('{{date}} {{year}}', context);
				expect(result).toBe('2025-03-15 2025');
			});
		});
		describe('Edge Cases', () => {
			it('should return empty string for empty template', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('', context);
				expect(result).toBe('');
			});
			it('should return template unchanged when no variables present', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Hello, World!', context);
				expect(result).toBe('Hello, World!');
			});
			it('should leave unknown variables unchanged', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('Unknown: {{UNKNOWN_VAR}}', context);
				expect(result).toBe('Unknown: {{UNKNOWN_VAR}}');
			});
			it('should handle multiple occurrences of same variable', () => {
				const context = createTestContext({
					session: createTestSession({ name: 'MySession' }),
				});
				const result = s1_substituteTemplateVariables(
					'{{SESSION_NAME}} is called {{SESSION_NAME}}',
					context
				);
				expect(result).toBe('MySession is called MySession');
			});
			it('should handle multiple different variables in one template', () => {
				const context = createTestContext({
					session: createTestSession({
						id: 'sess-1',
						name: 'Production',
						toolType: 'claude-code',
					}),
					gitBranch: 'main',
				});
				const result = s1_substituteTemplateVariables(
					'Session {{SESSION_ID}} ({{SESSION_NAME}}) using {{TOOL_TYPE}} on branch {{GIT_BRANCH}}',
					context
				);
				expect(result).toBe('Session sess-1 (Production) using claude-code on branch main');
			});
			it('should handle variables with special characters in surrounding text', () => {
				const context = createTestContext({
					session: createTestSession({ name: 'Test' }),
				});
				const result = s1_substituteTemplateVariables(
					'**{{SESSION_NAME}}** - `{{TOOL_TYPE}}`\n# {{SESSION_NAME}}',
					context
				);
				expect(result).toBe('**Test** - `claude-code`\n# Test');
			});
			it('should handle template with only variables', () => {
				const context = createTestContext({
					session: createTestSession({ id: 'abc', name: 'def' }),
				});
				const result = s1_substituteTemplateVariables('{{SESSION_ID}}{{SESSION_NAME}}', context);
				expect(result).toBe('abcdef');
			});
			it('should handle single curly braces without replacing', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('{SESSION_ID} {not a var}', context);
				expect(result).toBe('{SESSION_ID} {not a var}');
			});
			it('should handle nested-looking braces without replacing', () => {
				const context = createTestContext();
				const result = s1_substituteTemplateVariables('{{{SESSION_ID}}}', context);
				// The regex matches {{SESSION_ID}} inside {}, so should become {<value>}
				expect(result).toMatch(/^\{test-session-123\}$/);
			});
			it('should handle path with trailing slash for PROJECT_NAME', () => {
				const context = createTestContext({
					session: createTestSession({
						fullPath: '/path/to/project/',
					}),
				});
				const result = s1_substituteTemplateVariables('Name: {{PROJECT_NAME}}', context);
				// split(/[/\\]/).filter(Boolean).pop() correctly handles trailing slashes
				expect(result).toBe('Name: project');
			});
			it('should handle Windows-style paths', () => {
				const context = createTestContext({
					session: createTestSession({
						fullPath: 'C:\\Users\\dev\\project',
						cwd: 'C:\\Users\\dev\\project',
					}),
				});
				// Windows paths now split on both / and \ to extract the last segment
				const result = s1_substituteTemplateVariables('{{PROJECT_NAME}}', context);
				expect(result).toBe('project');
			});
			it('should handle very long templates efficiently', () => {
				const context = createTestContext({
					session: createTestSession({ name: 'Test' }),
				});
				const longTemplate = 'Start ' + '{{SESSION_NAME}} '.repeat(100) + 'End';
				const result = s1_substituteTemplateVariables(longTemplate, context);
				expect(result).toContain('Test');
				expect(result.startsWith('Start')).toBe(true);
				expect(result.endsWith('End')).toBe(true);
			});
		});
		describe('Cue Variables', () => {
			it('should replace file change type variable', () => {
				const context = createTestContext({
					cue: {
						eventType: 'file.changed',
						fileChangeType: 'add',
					},
				});
				const result = s1_substituteTemplateVariables('Type: {{CUE_FILE_CHANGE_TYPE}}', context);
				expect(result).toBe('Type: add');
			});
			it('should replace agent.completed source metadata variables', () => {
				const context = createTestContext({
					cue: {
						eventType: 'agent.completed',
						sourceSession: 'builder',
						sourceOutput: 'Build succeeded',
						sourceStatus: 'completed',
						sourceExitCode: '0',
						sourceDuration: '15000',
						sourceTriggeredBy: 'lint-on-save',
					},
				});
				const result = s1_substituteTemplateVariables(
					'{{CUE_SOURCE_STATUS}} exit={{CUE_SOURCE_EXIT_CODE}} dur={{CUE_SOURCE_DURATION}} by={{CUE_SOURCE_TRIGGERED_BY}}',
					context
				);
				expect(result).toBe('completed exit=0 dur=15000 by=lint-on-save');
			});
			it('should replace {{CUE_SOURCE_AGENT_ID}} when sourceAgentId is set', () => {
				const context = createTestContext({
					cue: {
						sourceAgentId: 'agent-abc-123',
					},
				});
				const result = s1_substituteTemplateVariables('Target: {{CUE_SOURCE_AGENT_ID}}', context);
				expect(result).toBe('Target: agent-abc-123');
			});
			it('should replace {{CUE_SOURCE_AGENT_ID}} with empty string when not set', () => {
				const context = createTestContext({ cue: {} });
				const result = s1_substituteTemplateVariables('Target: {{CUE_SOURCE_AGENT_ID}}', context);
				expect(result).toBe('Target: ');
			});
			it('should default missing cue variables to empty string', () => {
				const context = createTestContext({ cue: {} });
				const result = s1_substituteTemplateVariables(
					'[{{CUE_FILE_CHANGE_TYPE}}][{{CUE_SOURCE_STATUS}}][{{CUE_SOURCE_EXIT_CODE}}][{{CUE_SOURCE_DURATION}}][{{CUE_SOURCE_TRIGGERED_BY}}]',
					context
				);
				expect(result).toBe('[][][][][]');
			});
		});
		describe('Real-world Template Examples', () => {
			it('should substitute an Auto Run prompt template', () => {
				const context = createTestContext({
					session: createTestSession({
						id: 'maestro-123',
						name: 'Backend Dev',
						toolType: 'claude-code',
						cwd: '/Users/dev/myproject',
						fullPath: '/Users/dev/myproject',
					}),
					gitBranch: 'feature/api-v2',
					loopNumber: 3,
					documentName: 'refactoring',
					documentPath: '/Users/dev/playbooks/refactoring.md',
				});
				const template = `# Context

Your name is **{{AGENT_NAME}}**, a Maestro-managed AI agent.

- **Agent Path:** {{AGENT_PATH}}
- **Git Branch:** {{GIT_BRANCH}}
- **Loop Iteration:** {{LOOP_NUMBER}}
- **Date:** {{DATE}}

## Task
Please complete the tasks in {{DOCUMENT_NAME}}.`;
				const result = s1_substituteTemplateVariables(template, context);
				expect(result).toContain('Your name is **Backend Dev**');
				expect(result).toContain('**Agent Path:** /Users/dev/myproject');
				expect(result).toContain('**Git Branch:** feature/api-v2');
				expect(result).toContain('**Loop Iteration:** 00003');
				expect(result).toContain('**Date:** 2025-03-15');
				expect(result).toContain('tasks in refactoring');
			});
			it('should substitute a commit message template', () => {
				const context = createTestContext({
					session: createTestSession({
						name: 'Reviewer',
						toolType: 'claude-code',
					}),
					gitBranch: 'main',
				});
				const template = '[{{TOOL_TYPE}}] Auto-commit by {{SESSION_NAME}} on {{DATE}}';
				const result = s1_substituteTemplateVariables(template, context);
				expect(result).toBe('[claude-code] Auto-commit by Reviewer on 2025-03-15');
			});
			it('should substitute a log file template', () => {
				const context = createTestContext({
					session: createTestSession({
						id: 'session-456',
						name: 'Logger',
					}),
					loopNumber: 7,
				});
				const template = 'LOG_{{SESSION_NAME}}_{{DATE}}_loop{{LOOP_NUMBER}}.md';
				const result = s1_substituteTemplateVariables(template, context);
				expect(result).toBe('LOG_Logger_2025-03-15_loop00007.md');
			});
		});
	});
});
// Source: src/__tests__/shared/templateVariables.upstream.test.ts
describe('', () => {
	// ─── Helpers ─────────────────────────────────────────────────────────────────
	function createTestSession(
		overrides: Partial<S2_TemplateSessionInfo> = {}
	): S2_TemplateSessionInfo {
		return {
			id: 'test-session',
			name: 'Test Agent',
			toolType: 'claude-code',
			cwd: '/tmp/project',
			...overrides,
		};
	}
	function createTestContext(overrides: Partial<S2_TemplateContext> = {}): S2_TemplateContext {
		return {
			session: createTestSession(),
			...overrides,
		};
	}
	// ─── Tests ──────────────────────────────────────────────────────────────────
	describe('substituteTemplateVariables - per-source upstream output', () => {
		// Pin Date so date/time variables don't interfere with assertions
		const mockDate = new Date('2026-04-15T10:00:00.000Z');
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(mockDate);
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		describe('CUE_OUTPUT_<NAME> substitution', () => {
			it('replaces {{CUE_OUTPUT_AGENT_A}} with the per-source output value', () => {
				const context = createTestContext({
					cue: {
						output_AGENT_A: 'hello from A',
					} as any,
				});
				const result = s2_substituteTemplateVariables('Analyze: {{CUE_OUTPUT_AGENT_A}}', context);
				expect(result).toBe('Analyze: hello from A');
			});
			it('replaces multiple per-source output variables in the same template', () => {
				const context = createTestContext({
					cue: {
						output_AGENT_A: 'result-a',
						output_AGENT_B: 'result-b',
					} as any,
				});
				const result = s2_substituteTemplateVariables(
					'A: {{CUE_OUTPUT_AGENT_A}}, B: {{CUE_OUTPUT_AGENT_B}}',
					context
				);
				expect(result).toBe('A: result-a, B: result-b');
			});
		});
		describe('CUE_FORWARDED_<NAME> substitution', () => {
			it('replaces {{CUE_FORWARDED_AGENT_B}} with the forwarded output value', () => {
				const context = createTestContext({
					cue: {
						forwarded_AGENT_B: 'fwd-from-b',
					} as any,
				});
				const result = s2_substituteTemplateVariables(
					'Forward: {{CUE_FORWARDED_AGENT_B}}',
					context
				);
				expect(result).toBe('Forward: fwd-from-b');
			});
		});
		describe('case insensitivity', () => {
			it('substitutes {{cue_output_agent_a}} (lowercase) with the correct value', () => {
				const context = createTestContext({
					cue: {
						output_AGENT_A: 'hello',
					} as any,
				});
				const result = s2_substituteTemplateVariables('Result: {{cue_output_agent_a}}', context);
				expect(result).toBe('Result: hello');
			});
			it('substitutes {{Cue_Forwarded_Agent_B}} (mixed case) with the correct value', () => {
				const context = createTestContext({
					cue: {
						forwarded_AGENT_B: 'fwd',
					} as any,
				});
				const result = s2_substituteTemplateVariables('Got: {{Cue_Forwarded_Agent_B}}', context);
				expect(result).toBe('Got: fwd');
			});
		});
		describe('no per-source outputs', () => {
			it('leaves {{CUE_OUTPUT_AGENT_X}} unreplaced when no cue context exists', () => {
				const context = createTestContext();
				const result = s2_substituteTemplateVariables('Value: {{CUE_OUTPUT_AGENT_X}}', context);
				// No cue context → variable not in replacements map → left as-is
				expect(result).toBe('Value: {{CUE_OUTPUT_AGENT_X}}');
			});
			it('leaves {{CUE_OUTPUT_AGENT_X}} unreplaced when cue context has no matching key', () => {
				const context = createTestContext({
					cue: {
						eventType: 'agent.completed',
					},
				});
				const result = s2_substituteTemplateVariables('Value: {{CUE_OUTPUT_AGENT_X}}', context);
				expect(result).toBe('Value: {{CUE_OUTPUT_AGENT_X}}');
			});
		});
		describe('coexistence with standard CUE variables', () => {
			it('substitutes both standard CUE_SOURCE_OUTPUT and dynamic CUE_OUTPUT_AGENT_A', () => {
				const context = createTestContext({
					cue: {
						sourceOutput: 'combined output',
						output_AGENT_A: 'individual-a',
					} as any,
				});
				const result = s2_substituteTemplateVariables(
					'All: {{CUE_SOURCE_OUTPUT}} | Just A: {{CUE_OUTPUT_AGENT_A}}',
					context
				);
				expect(result).toBe('All: combined output | Just A: individual-a');
			});
		});
	});
});
// Source: src/__tests__/shared/crossAgentContext.test.ts
describe('', () => {
	// Minimal LogEntry factory - only the fields the heuristics read matter.
	function log(id: string, source: LogEntry['source'], text = id): LogEntry {
		return { id, source, text, timestamp: 0 };
	}
	// ============================================================================
	// parseAgentMentions
	// ============================================================================
	describe('parseAgentMentions', () => {
		it('returns [] for an empty string', () => {
			expect(parseAgentMentions('')).toEqual([]);
		});
		it('parses a single mention (single @)', () => {
			expect(parseAgentMentions('hey @review-bot look at this')).toEqual([
				{ token: '@review-bot', mentionName: 'review-bot', startIndex: 4, endIndex: 15 },
			]);
		});
		it('parses multiple mentions in one message', () => {
			const result = parseAgentMentions('cc @alice and @bob');
			expect(result.map((m) => m.mentionName)).toEqual(['alice', 'bob']);
		});
		it('parses "@a @b @c-d-e" as three mentions', () => {
			const result = parseAgentMentions('@a @b @c-d-e');
			expect(result.map((m) => m.mentionName)).toEqual(['a', 'b', 'c-d-e']);
		});
		it('ignores a single "@"', () => {
			expect(parseAgentMentions('email me @ noon')).toEqual([]);
		});
		it('skips a file-shaped body (path or dotted extension), not an agent', () => {
			expect(parseAgentMentions('see @src/main/index.ts')).toEqual([]);
			expect(parseAgentMentions('open @notes.md now')).toEqual([]);
		});
		it('parses a dotted agent name when it is in the roster (the @RunMaestro.ai regression)', () => {
			const roster = new Set(['runmaestro.ai']);
			const result = parseAgentMentions('ping @RunMaestro.ai now', roster);
			expect(result.map((m) => m.mentionName)).toEqual(['RunMaestro.ai']);
			// Slice bounds still map back to the exact token.
			const [mention] = result;
			expect('ping @RunMaestro.ai now'.slice(mention.startIndex, mention.endIndex)).toBe(
				'@RunMaestro.ai'
			);
		});
		it('parses all three mentions when the middle agent name carries a dot', () => {
			const roster = new Set(['maestro-marketing', 'runmaestro.ai', 'pedtome-pedsidian']);
			const result = parseAgentMentions(
				'next? @Maestro-Marketing @RunMaestro.ai @PedTome-Pedsidian',
				roster
			);
			expect(result.map((m) => m.mentionName)).toEqual([
				'Maestro-Marketing',
				'RunMaestro.ai',
				'PedTome-Pedsidian',
			]);
		});
		it('still skips a dotted body that is NOT in the roster', () => {
			expect(parseAgentMentions('open @notes.md now', new Set(['runmaestro.ai']))).toEqual([]);
		});
		it('skips mid-word mentions like "foo@bar"', () => {
			expect(parseAgentMentions('foo@bar')).toEqual([]);
		});
		it('does not dispatch a mention embedded in a URL/path (host/@name)', () => {
			expect(parseAgentMentions('see https://github.com/@codex')).toEqual([]);
			expect(parseAgentMentions('open ./@codex')).toEqual([]);
		});
		it('skips malformed "@@" and "@@@" runs rather than crashing', () => {
			expect(parseAgentMentions('@@double')).toEqual([]);
			expect(parseAgentMentions('@@@triple')).toEqual([]);
		});
		it('captures capitalized names (matches normalizeMentionName output)', () => {
			const result = parseAgentMentions('ping @Review-Bot now');
			expect(result.map((m) => m.mentionName)).toEqual(['Review-Bot']);
		});
		it('produces index ranges that slice back to the token', () => {
			const input = 'hi @bob bye';
			const [mention] = parseAgentMentions(input);
			expect(input.slice(mention.startIndex, mention.endIndex)).toBe(mention.token);
			expect(mention.token).toBe('@bob');
		});
	});
	// ============================================================================
	// messageStartsWithAgentMention (gates "route to remote agents only")
	// ============================================================================
	describe('messageStartsWithAgentMention', () => {
		it('is true when an agent mention leads the message', () => {
			expect(messageStartsWithAgentMention('@Backend what do you think?')).toBe(true);
			expect(messageStartsWithAgentMention('@review-bot @codex thoughts?')).toBe(true);
		});
		it('ignores leading whitespace before the mention', () => {
			expect(messageStartsWithAgentMention('   @Backend hi')).toBe(true);
		});
		it('is false when the mention appears later in the message', () => {
			expect(messageStartsWithAgentMention('hey @Backend, thoughts?')).toBe(false);
		});
		it('is false when the message leads with a FILE mention (a local question)', () => {
			expect(messageStartsWithAgentMention('@src/app.ts explain this')).toBe(false);
			expect(messageStartsWithAgentMention('@notes.md summarize')).toBe(false);
		});
		it('is true when the leading agent name carries a dot and is in the roster', () => {
			const roster = new Set(['runmaestro.ai']);
			expect(messageStartsWithAgentMention('@RunMaestro.ai fix this', roster)).toBe(true);
			// Without the roster the dotted name reads as a file, so the local send stands.
			expect(messageStartsWithAgentMention('@RunMaestro.ai fix this')).toBe(false);
		});
		it('is false for plain text and empty input', () => {
			expect(messageStartsWithAgentMention('just some prose')).toBe(false);
			expect(messageStartsWithAgentMention('')).toBe(false);
		});
	});
	// ============================================================================
	// inferContextStrategy
	// ============================================================================
	describe('inferContextStrategy', () => {
		it('returns "full" for a plain message', () => {
			expect(inferContextStrategy('take a look at the login bug')).toEqual({ kind: 'full' });
		});
		it('returns "full" for a message that only contains a mention', () => {
			expect(inferContextStrategy('@bob can you help')).toEqual({ kind: 'full' });
		});
		it('recognizes "share the last 10 messages with @b" as recent-messages: 10', () => {
			expect(inferContextStrategy('share the last 10 messages with @b')).toEqual({
				kind: 'recent-messages',
				messages: 10,
			});
		});
		it('recognizes "last 3 turns" as recent-turns: 3', () => {
			expect(inferContextStrategy('send the last 3 turns to @b')).toEqual({
				kind: 'recent-turns',
				turns: 3,
			});
		});
		it('recognizes "last 2 exchanges" as recent-turns: 2', () => {
			expect(inferContextStrategy('forward the last 2 exchanges')).toEqual({
				kind: 'recent-turns',
				turns: 2,
			});
		});
		it('treats a unit-less "share the last 4" as recent-messages: 4', () => {
			expect(inferContextStrategy('share the last 4 with @b')).toEqual({
				kind: 'recent-messages',
				messages: 4,
			});
		});
		it('matches case-insensitively', () => {
			expect(inferContextStrategy('SHARE THE LAST 5 MESSAGES')).toEqual({
				kind: 'recent-messages',
				messages: 5,
			});
		});
		it('recognizes "pull @b in on this recent matter" as recent-turns: 5', () => {
			expect(inferContextStrategy('pull @b in on this recent matter')).toEqual({
				kind: 'recent-turns',
				turns: DEFAULT_RECENT_TURNS,
			});
		});
		it('recognizes "most recent" as a soft recent-turns hint', () => {
			expect(inferContextStrategy('@b the most recent stuff is relevant')).toEqual({
				kind: 'recent-turns',
				turns: DEFAULT_RECENT_TURNS,
			});
		});
		it('lets an explicit number override a soft hint when both are present', () => {
			expect(inferContextStrategy('@b share the last 3 messages about this thread')).toEqual({
				kind: 'recent-messages',
				messages: 3,
			});
		});
	});
	// ============================================================================
	// selectContextWindow
	// ============================================================================
	describe('selectContextWindow', () => {
		it('returns a shallow clone (not the input reference) for "full"', () => {
			const logs = [log('u1', 'user'), log('a1', 'ai')];
			const result = selectContextWindow(logs, { kind: 'full' });
			expect(result).not.toBe(logs);
			expect(result).toEqual(logs);
		});
		it('returns the last 3 conversational entries plus interleaved tool entries', () => {
			// 2 users + 2 ai + 1 tool. Conversational: u1, a1, u2, a2.
			const logs = [
				log('u1', 'user'),
				log('a1', 'ai'),
				log('u2', 'user'),
				log('t1', 'tool'),
				log('a2', 'ai'),
			];
			const result = selectContextWindow(logs, { kind: 'recent-messages', messages: 3 });
			// Last 3 conversational are a1, u2, a2; t1 falls inside the window.
			expect(result.map((e) => e.id)).toEqual(['a1', 'u2', 't1', 'a2']);
		});
		it('returns the most recent user+ai pair for recent-turns: 1', () => {
			const logs = [log('u1', 'user'), log('a1', 'ai'), log('u2', 'user'), log('a2', 'ai')];
			const result = selectContextWindow(logs, { kind: 'recent-turns', turns: 1 });
			expect(result.map((e) => e.id)).toEqual(['u2', 'a2']);
		});
		it('returns the whole transcript when fewer conversational entries exist than requested', () => {
			const logs = [log('u1', 'user'), log('a1', 'ai')];
			const result = selectContextWindow(logs, { kind: 'recent-messages', messages: 5 });
			expect(result.map((e) => e.id)).toEqual(['u1', 'a1']);
		});
		it('returns [] for a non-positive count', () => {
			const logs = [log('u1', 'user'), log('a1', 'ai')];
			expect(selectContextWindow(logs, { kind: 'recent-messages', messages: 0 })).toEqual([]);
		});
	});
	describe('deriveConsultSubject', () => {
		it('strips a leading @mention and keeps the prose', () => {
			expect(deriveConsultSubject('@rc which branch should I build the drafts feature on?')).toBe(
				'which branch should I build the drafts feature on?'
			);
		});
		it('strips mid-sentence mentions and collapses whitespace', () => {
			expect(deriveConsultSubject('hey @Backend,   thoughts   on\nthe API?')).toBe(
				'hey , thoughts on the API?'
			);
		});
		it('truncates past maxLen with an ellipsis', () => {
			const subject = deriveConsultSubject('@rc ' + 'a'.repeat(100), 10);
			expect(subject).toBe('aaaaaaaaa…');
			expect(subject.length).toBe(10);
		});
		it('returns empty string when only a mention with no prose', () => {
			expect(deriveConsultSubject('@rc')).toBe('');
			expect(deriveConsultSubject('   @rc   ')).toBe('');
		});
	});
	// ============================================================================
	// inferMentionTiming
	// ============================================================================
	describe('inferMentionTiming', () => {
		it.each([
			// Hand-off: this turn's result is the mentioned agent's input.
			[
				"then let's kick it off with an ask about MNQ trading and feed whatever we learn over to @Kensho",
				'handoff',
			],
			['review this and send the results to @Docs', 'handoff'],
			['finish the refactor, then hand it off to @QA', 'handoff'],
			['fix the bug and let @Docs know', 'handoff'],
			['tell @Docs what you find', 'handoff'],
			['keep @PM posted', 'handoff'],
			// Consult first: the mentioned agent's answer is this turn's input.
			['check with @Backend first and then write the migration', 'consult-first'],
			['based on what @Backend says, update the schema', 'consult-first'],
			['ask @Backend about the schema, then write the migration', 'consult-first'],
			['once @Backend replies, summarize it', 'consult-first'],
			['first ask @Backend, then decide', 'consult-first'],
			// Parallel: no ordering cue.
			['what does @Backend think about this too?', 'parallel'],
			['work with @Backend on this', 'parallel'],
			// A weak relay verb alone hands over WORK, not a result.
			['send this to @Docs for a review', 'parallel'],
			['tell @Docs to review the readme', 'parallel'],
		])('%s -> %s', (message, expected) => {
			expect(inferMentionTiming(message)).toBe(expected);
		});
		it('judges each mention by its own clause', () => {
			// The "first" belongs to the second sentence's mention only... and still
			// wins, because waiting costs less than running ahead of a needed answer.
			expect(inferMentionTiming('Loop in @A. Check with @B first.')).toBe('consult-first');
			// A relay verb in an EARLIER sentence does not leak into this mention.
			expect(inferMentionTiming('Send the report to finance. What does @A think?')).toBe(
				'parallel'
			);
		});
		it('prefers consult-first over hand-off when mentions disagree', () => {
			expect(inferMentionTiming('ask @A first, then send the result to @B')).toBe('consult-first');
		});
		it('is parallel when there is no agent mention', () => {
			expect(inferMentionTiming('send the results to finance')).toBe('parallel');
		});
	});
	describe('isMentionRouting', () => {
		it.each(['parallel', 'consult-first', 'handoff', 'only'])('accepts %s', (mode) => {
			expect(isMentionRouting(mode)).toBe(true);
		});
		it.each(['Parallel', 'consult_first', 'hand-off', '', ' only', undefined, null, 1, ['only']])(
			'rejects %j',
			(value) => {
				expect(isMentionRouting(value)).toBe(false);
			}
		);
		it('lists exactly the four routings, the default first', () => {
			expect(MENTION_ROUTINGS).toEqual(['parallel', 'consult-first', 'handoff', 'only']);
		});
	});
	describe('parseMentionRoutingField', () => {
		it('treats an absent field as no override', () => {
			expect(parseMentionRoutingField(undefined)).toEqual({ ok: true });
			expect(parseMentionRoutingField(null)).toEqual({ ok: true });
		});
		it('returns a valid routing', () => {
			expect(parseMentionRoutingField('handoff')).toEqual({ ok: true, routing: 'handoff' });
		});
		it('refuses an unknown routing and names the valid ones', () => {
			const result = parseMentionRoutingField('sideways');
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain('"sideways"');
			expect(result.error).toContain('parallel, consult-first, handoff, only');
		});
	});
});
