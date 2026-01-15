/**
 * Tests for src/shared/templateVariables.ts
 *
 * This file tests the template variable substitution system used for
 * Auto Run and Custom AI Commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TEMPLATE_VARIABLES,
  TEMPLATE_VARIABLES_GENERAL,
  substituteTemplateVariables,
  TemplateContext,
  TemplateSessionInfo,
} from '../../shared/templateVariables';

// Helper to create a minimal session for testing
function createTestSession(overrides: Partial<TemplateSessionInfo> = {}): TemplateSessionInfo {
  return {
    id: 'test-session-123',
    name: 'Test Session',
    toolType: 'claude-code',
    cwd: '/Users/test/project',
    ...overrides,
  };
}

// Helper to create a minimal context for testing
function createTestContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    session: createTestSession(),
    ...overrides,
  };
}

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

  it('should include key agent variables', () => {
    const variables = TEMPLATE_VARIABLES.map((v) => v.variable);
    expect(variables).toContain('{{AGENT_NAME}}');
    expect(variables).toContain('{{AGENT_PATH}}');
    expect(variables).toContain('{{AGENT_GROUP}}');
    expect(variables).toContain('{{AGENT_SESSION_ID}}');
    expect(variables).toContain('{{AGENT_HISTORY_PATH}}');
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

  describe('Agent Variables', () => {
    it('should replace {{AGENT_NAME}} with session.name', () => {
      const context = createTestContext({
        session: createTestSession({ name: 'Agent Alpha' }),
      });
      const result = substituteTemplateVariables('Agent: {{AGENT_NAME}}', context);
      expect(result).toBe('Agent: Agent Alpha');
    });

    it('should replace {{AGENT_GROUP}} with groupName', () => {
      const context = createTestContext({
        session: createTestSession(),
        groupName: 'Backend Team',
      });
      const result = substituteTemplateVariables('Group: {{AGENT_GROUP}}', context);
      expect(result).toBe('Group: Backend Team');
    });

    it('should replace {{AGENT_GROUP}} with empty string when groupName is undefined', () => {
      const context = createTestContext({
        session: createTestSession(),
        groupName: undefined,
      });
      const result = substituteTemplateVariables('Group: {{AGENT_GROUP}}', context);
      expect(result).toBe('Group: ');
    });

    it('should replace {{AGENT_SESSION_ID}} with agentSessionId', () => {
      const context = createTestContext({
        session: createTestSession({ agentSessionId: 'claude-session-789' }),
      });
      const result = substituteTemplateVariables('Agent: {{AGENT_SESSION_ID}}', context);
      expect(result).toBe('Agent: claude-session-789');
    });

    it('should replace {{AGENT_SESSION_ID}} with empty string when agentSessionId is undefined', () => {
      const context = createTestContext({
        session: createTestSession({ agentSessionId: undefined }),
      });
      const result = substituteTemplateVariables('Agent: {{AGENT_SESSION_ID}}', context);
      expect(result).toBe('Agent: ');
    });

    it('should replace {{TOOL_TYPE}} with session.toolType', () => {
      const context = createTestContext({
        session: createTestSession({ toolType: 'aider' }),
      });
      const result = substituteTemplateVariables('Tool: {{TOOL_TYPE}}', context);
      expect(result).toBe('Tool: aider');
    });

    it('should replace {{TAB_NAME}} with session.name', () => {
      const context = createTestContext({
        session: createTestSession({ name: 'My Custom Tab' }),
      });
      const result = substituteTemplateVariables('Tab: {{TAB_NAME}}', context);
      expect(result).toBe('Tab: My Custom Tab');
    });

    it('should have {{TAB_NAME}} and {{SESSION_NAME}} as aliases (both return session.name)', () => {
      const context = createTestContext({
        session: createTestSession({ name: 'Aliased Name' }),
      });
      const result1 = substituteTemplateVariables('{{TAB_NAME}}', context);
      const result2 = substituteTemplateVariables('{{SESSION_NAME}}', context);
      expect(result1).toBe(result2);
      expect(result1).toBe('Aliased Name');
    });

    it('should replace {{AGENT_HISTORY_PATH}} with historyFilePath', () => {
      const context = createTestContext({
        historyFilePath: '/Users/test/.config/Maestro/history/session-123.json',
      });
      const result = substituteTemplateVariables('History: {{AGENT_HISTORY_PATH}}', context);
      expect(result).toBe('History: /Users/test/.config/Maestro/history/session-123.json');
    });

    it('should replace {{AGENT_HISTORY_PATH}} with empty string when historyFilePath is undefined', () => {
      const context = createTestContext({
        historyFilePath: undefined,
      });
      const result = substituteTemplateVariables('History: {{AGENT_HISTORY_PATH}}', context);
      expect(result).toBe('History: ');
    });
  });

  describe('Legacy Session Variables (backwards compatibility)', () => {
    it('should still replace {{SESSION_ID}} with session.id', () => {
      const context = createTestContext({
        session: createTestSession({ id: 'unique-session-456' }),
      });
      const result = substituteTemplateVariables('ID: {{SESSION_ID}}', context);
      expect(result).toBe('ID: unique-session-456');
    });

    it('should still replace {{SESSION_NAME}} with session.name', () => {
      const context = createTestContext({
        session: createTestSession({ name: 'My Custom Session' }),
      });
      const result = substituteTemplateVariables('Name: {{SESSION_NAME}}', context);
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
      const result = substituteTemplateVariables('Path: {{AGENT_PATH}}', context);
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
      const result = substituteTemplateVariables('Path: {{AGENT_PATH}}', context);
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
      const result = substituteTemplateVariables('Path: {{AGENT_PATH}}', context);
      expect(result).toBe('Path: /current/working/dir');
    });

    it('should replace {{CWD}} with session.cwd', () => {
      const context = createTestContext({
        session: createTestSession({ cwd: '/Users/test/workspace' }),
      });
      const result = substituteTemplateVariables('CWD: {{CWD}}', context);
      expect(result).toBe('CWD: /Users/test/workspace');
    });

    it('should replace {{AUTORUN_FOLDER}} with autoRunFolder from context', () => {
      const context = createTestContext({
        session: createTestSession(),
        autoRunFolder: '/path/to/autorun/docs',
      });
      const result = substituteTemplateVariables('Folder: {{AUTORUN_FOLDER}}', context);
      expect(result).toBe('Folder: /path/to/autorun/docs');
    });

    it('should replace {{AUTORUN_FOLDER}} with session.autoRunFolderPath when autoRunFolder not provided', () => {
      const context = createTestContext({
        session: createTestSession({ autoRunFolderPath: '/session/autorun/path' }),
        autoRunFolder: undefined,
      });
      const result = substituteTemplateVariables('Folder: {{AUTORUN_FOLDER}}', context);
      expect(result).toBe('Folder: /session/autorun/path');
    });

    it('should replace {{AUTORUN_FOLDER}} with empty string when neither available', () => {
      const context = createTestContext({
        session: createTestSession({ autoRunFolderPath: undefined }),
        autoRunFolder: undefined,
      });
      const result = substituteTemplateVariables('Folder: {{AUTORUN_FOLDER}}', context);
      expect(result).toBe('Folder: ');
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
      const result = substituteTemplateVariables('Path: {{PROJECT_PATH}}', context);
      expect(result).toBe('Path: /full/path/to/project');
    });

    it('should still replace {{PROJECT_NAME}} with last path segment', () => {
      const context = createTestContext({
        session: createTestSession({
          fullPath: '/Users/dev/projects/my-awesome-app',
        }),
      });
      const result = substituteTemplateVariables('Project: {{PROJECT_NAME}}', context);
      expect(result).toBe('Project: my-awesome-app');
    });
  });

  describe('Document Variables', () => {
    it('should replace {{DOCUMENT_NAME}} with documentName', () => {
      const context = createTestContext({
        documentName: 'my-playbook',
      });
      const result = substituteTemplateVariables('Doc: {{DOCUMENT_NAME}}', context);
      expect(result).toBe('Doc: my-playbook');
    });

    it('should replace {{DOCUMENT_NAME}} with empty string when documentName is undefined', () => {
      const context = createTestContext({
        documentName: undefined,
      });
      const result = substituteTemplateVariables('Doc: {{DOCUMENT_NAME}}', context);
      expect(result).toBe('Doc: ');
    });

    it('should replace {{DOCUMENT_PATH}} with documentPath', () => {
      const context = createTestContext({
        documentPath: '/Users/dev/playbooks/deploy.md',
      });
      const result = substituteTemplateVariables('Path: {{DOCUMENT_PATH}}', context);
      expect(result).toBe('Path: /Users/dev/playbooks/deploy.md');
    });

    it('should replace {{DOCUMENT_PATH}} with empty string when documentPath is undefined', () => {
      const context = createTestContext({
        documentPath: undefined,
      });
      const result = substituteTemplateVariables('Path: {{DOCUMENT_PATH}}', context);
      expect(result).toBe('Path: ');
    });

    it('should replace {{LOOP_NUMBER}} with 5-digit padded loopNumber', () => {
      const context = createTestContext({
        loopNumber: 5,
      });
      const result = substituteTemplateVariables('Loop: {{LOOP_NUMBER}}', context);
      expect(result).toBe('Loop: 00005');
    });

    it('should replace {{LOOP_NUMBER}} with "00001" when loopNumber is undefined', () => {
      const context = createTestContext({
        loopNumber: undefined,
      });
      const result = substituteTemplateVariables('Loop: {{LOOP_NUMBER}}', context);
      expect(result).toBe('Loop: 00001');
    });

    it('should replace {{LOOP_NUMBER}} with "00000" when loopNumber is 0 (falsy but valid)', () => {
      // Note: loopNumber ?? 1 means 0 would return 0, but null/undefined returns 1
      const context = createTestContext({
        loopNumber: 0,
      });
      const result = substituteTemplateVariables('Loop: {{LOOP_NUMBER}}', context);
      expect(result).toBe('Loop: 00000');
    });
  });

  describe('Date/Time Variables', () => {
    // Tests use mocked date: 2025-03-15T14:30:45.123Z (UTC)
    // Local time depends on timezone, so we test patterns

    it('should replace {{DATE}} with YYYY-MM-DD format', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Date: {{DATE}}', context);
      expect(result).toBe('Date: 2025-03-15');
    });

    it('should replace {{TIME}} with HH:MM:SS format', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Time: {{TIME}}', context);
      // Time depends on local timezone, so check format
      expect(result).toMatch(/^Time: \d{2}:\d{2}:\d{2}$/);
    });

    it('should replace {{DATETIME}} with combined date and time', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('DateTime: {{DATETIME}}', context);
      expect(result).toMatch(/^DateTime: 2025-03-15 \d{2}:\d{2}:\d{2}$/);
    });

    it('should replace {{TIMESTAMP}} with unix timestamp in milliseconds', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('TS: {{TIMESTAMP}}', context);
      expect(result).toBe(`TS: ${mockDate.getTime()}`);
    });

    it('should replace {{DATE_SHORT}} with MM/DD/YY format', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Date: {{DATE_SHORT}}', context);
      // mockDate is 2025-03-15 -> 03/15/25
      expect(result).toBe('Date: 03/15/25');
    });

    it('should replace {{TIME_SHORT}} with HH:MM format', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Time: {{TIME_SHORT}}', context);
      expect(result).toMatch(/^Time: \d{2}:\d{2}$/);
    });

    it('should replace {{YEAR}} with 4-digit year', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Year: {{YEAR}}', context);
      expect(result).toBe('Year: 2025');
    });

    it('should replace {{MONTH}} with zero-padded month', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Month: {{MONTH}}', context);
      expect(result).toBe('Month: 03');
    });

    it('should replace {{DAY}} with zero-padded day', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Day: {{DAY}}', context);
      expect(result).toBe('Day: 15');
    });

    it('should replace {{WEEKDAY}} with day name', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Weekday: {{WEEKDAY}}', context);
      // 2025-03-15 is a Saturday
      expect(result).toBe('Weekday: Saturday');
    });

    it('should handle single-digit month with zero padding', () => {
      // Test with January (month 0)
      vi.setSystemTime(new Date('2025-01-05T10:00:00Z'));
      const context = createTestContext();
      const result = substituteTemplateVariables('{{MONTH}}/{{DAY}}', context);
      expect(result).toBe('01/05');
    });
  });

  describe('Git Variables', () => {
    it('should replace {{GIT_BRANCH}} with gitBranch', () => {
      const context = createTestContext({
        gitBranch: 'feature/new-feature',
      });
      const result = substituteTemplateVariables('Branch: {{GIT_BRANCH}}', context);
      expect(result).toBe('Branch: feature/new-feature');
    });

    it('should replace {{GIT_BRANCH}} with empty string when gitBranch is undefined', () => {
      const context = createTestContext({
        gitBranch: undefined,
      });
      const result = substituteTemplateVariables('Branch: {{GIT_BRANCH}}', context);
      expect(result).toBe('Branch: ');
    });

    it('should replace {{IS_GIT_REPO}} with "true" when isGitRepo is true', () => {
      const context = createTestContext({
        session: createTestSession({ isGitRepo: true }),
      });
      const result = substituteTemplateVariables('Git: {{IS_GIT_REPO}}', context);
      expect(result).toBe('Git: true');
    });

    it('should replace {{IS_GIT_REPO}} with "false" when isGitRepo is false', () => {
      const context = createTestContext({
        session: createTestSession({ isGitRepo: false }),
      });
      const result = substituteTemplateVariables('Git: {{IS_GIT_REPO}}', context);
      expect(result).toBe('Git: false');
    });

    it('should replace {{IS_GIT_REPO}} with "false" when isGitRepo is undefined', () => {
      const context = createTestContext({
        session: createTestSession({ isGitRepo: undefined }),
      });
      const result = substituteTemplateVariables('Git: {{IS_GIT_REPO}}', context);
      expect(result).toBe('Git: false');
    });
  });

  describe('Context Variables', () => {
    it('should replace {{CONTEXT_USAGE}} with contextUsage value', () => {
      const context = createTestContext({
        session: createTestSession({ contextUsage: 75 }),
      });
      const result = substituteTemplateVariables('Usage: {{CONTEXT_USAGE}}%', context);
      expect(result).toBe('Usage: 75%');
    });

    it('should replace {{CONTEXT_USAGE}} with "0" when contextUsage is undefined', () => {
      const context = createTestContext({
        session: createTestSession({ contextUsage: undefined }),
      });
      const result = substituteTemplateVariables('Usage: {{CONTEXT_USAGE}}%', context);
      expect(result).toBe('Usage: 0%');
    });

    it('should handle contextUsage of 0 correctly', () => {
      const context = createTestContext({
        session: createTestSession({ contextUsage: 0 }),
      });
      const result = substituteTemplateVariables('Usage: {{CONTEXT_USAGE}}%', context);
      expect(result).toBe('Usage: 0%');
    });
  });

  describe('Case Insensitivity', () => {
    it('should handle lowercase variables', () => {
      const context = createTestContext({
        session: createTestSession({ id: 'test-id' }),
      });
      const result = substituteTemplateVariables('ID: {{session_id}}', context);
      expect(result).toBe('ID: test-id');
    });

    it('should handle uppercase variables', () => {
      const context = createTestContext({
        session: createTestSession({ id: 'test-id' }),
      });
      const result = substituteTemplateVariables('ID: {{SESSION_ID}}', context);
      expect(result).toBe('ID: test-id');
    });

    it('should handle mixed case variables', () => {
      const context = createTestContext({
        session: createTestSession({ id: 'test-id' }),
      });
      const result = substituteTemplateVariables('ID: {{Session_Id}}', context);
      expect(result).toBe('ID: test-id');
    });

    it('should handle mixed case in same template', () => {
      const context = createTestContext({
        session: createTestSession({ id: 'test-id', name: 'Test' }),
      });
      const result = substituteTemplateVariables(
        '{{session_id}} - {{SESSION_NAME}} - {{Tool_Type}}',
        context
      );
      expect(result).toBe('test-id - Test - claude-code');
    });

    it('should handle all lowercase date variables', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('{{date}} {{year}}', context);
      expect(result).toBe('2025-03-15 2025');
    });
  });

  describe('Edge Cases', () => {
    it('should return empty string for empty template', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('', context);
      expect(result).toBe('');
    });

    it('should return template unchanged when no variables present', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Hello, World!', context);
      expect(result).toBe('Hello, World!');
    });

    it('should leave unknown variables unchanged', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('Unknown: {{UNKNOWN_VAR}}', context);
      expect(result).toBe('Unknown: {{UNKNOWN_VAR}}');
    });

    it('should handle multiple occurrences of same variable', () => {
      const context = createTestContext({
        session: createTestSession({ name: 'MySession' }),
      });
      const result = substituteTemplateVariables(
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
      const result = substituteTemplateVariables(
        'Session {{SESSION_ID}} ({{SESSION_NAME}}) using {{TOOL_TYPE}} on branch {{GIT_BRANCH}}',
        context
      );
      expect(result).toBe(
        'Session sess-1 (Production) using claude-code on branch main'
      );
    });

    it('should handle variables with special characters in surrounding text', () => {
      const context = createTestContext({
        session: createTestSession({ name: 'Test' }),
      });
      const result = substituteTemplateVariables(
        '**{{SESSION_NAME}}** - `{{TOOL_TYPE}}`\n# {{SESSION_NAME}}',
        context
      );
      expect(result).toBe('**Test** - `claude-code`\n# Test');
    });

    it('should handle template with only variables', () => {
      const context = createTestContext({
        session: createTestSession({ id: 'abc', name: 'def' }),
      });
      const result = substituteTemplateVariables('{{SESSION_ID}}{{SESSION_NAME}}', context);
      expect(result).toBe('abcdef');
    });

    it('should handle single curly braces without replacing', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('{SESSION_ID} {not a var}', context);
      expect(result).toBe('{SESSION_ID} {not a var}');
    });

    it('should handle nested-looking braces without replacing', () => {
      const context = createTestContext();
      const result = substituteTemplateVariables('{{{SESSION_ID}}}', context);
      // The regex matches {{SESSION_ID}} inside {}, so should become {<value>}
      expect(result).toMatch(/^\{test-session-123\}$/);
    });

    it('should handle path with trailing slash for PROJECT_NAME', () => {
      const context = createTestContext({
        session: createTestSession({
          fullPath: '/path/to/project/',
        }),
      });
      const result = substituteTemplateVariables('Name: {{PROJECT_NAME}}', context);
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
      const result = substituteTemplateVariables('{{PROJECT_NAME}}', context);
      expect(result).toBe('project');
    });

    it('should handle very long templates efficiently', () => {
      const context = createTestContext({
        session: createTestSession({ name: 'Test' }),
      });
      const longTemplate =
        'Start ' + '{{SESSION_NAME}} '.repeat(100) + 'End';
      const result = substituteTemplateVariables(longTemplate, context);
      expect(result).toContain('Test');
      expect(result.startsWith('Start')).toBe(true);
      expect(result.endsWith('End')).toBe(true);
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

      const result = substituteTemplateVariables(template, context);

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
      const result = substituteTemplateVariables(template, context);

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
      const result = substituteTemplateVariables(template, context);

      expect(result).toBe('LOG_Logger_2025-03-15_loop00007.md');
    });
  });
});
