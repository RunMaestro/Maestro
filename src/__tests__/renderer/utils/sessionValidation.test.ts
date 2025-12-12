import { describe, it, expect } from 'vitest';
import { validateNewSession, SessionValidationResult } from '../../../renderer/utils/sessionValidation';
import type { Session, ToolType } from '../../../renderer/types';

// Helper to create a minimal mock session for testing
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-id',
    name: 'Test Session',
    toolType: 'claude-code' as ToolType,
    state: 'idle',
    cwd: '/Users/test/project',
    fullPath: '/Users/test/project',
    projectRoot: '/Users/test/project',
    isGitRepo: false,
    aiLogs: [],
    shellLogs: [],
    workLog: [],
    contextUsage: 0,
    inputMode: 'ai',
    aiPid: 1234,
    terminalPid: 0,
    port: 3000,
    isLive: false,
    changedFiles: [],
    fileTree: [],
    fileExplorerExpanded: [],
    fileExplorerScrollPos: 0,
    shellCwd: '/Users/test/project',
    aiCommandHistory: [],
    shellCommandHistory: [],
    executionQueue: [],
    activeTimeMs: 0,
    aiTabs: [],
    activeTabId: 'tab-1',
    closedTabHistory: [],
    ...overrides,
  } as Session;
}

describe('sessionValidation', () => {
  describe('validateNewSession', () => {
    describe('name uniqueness', () => {
      it('returns valid when no sessions exist', () => {
        const result = validateNewSession('New Session', '/path/to/project', 'claude-code', []);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.errorField).toBeUndefined();
      });

      it('returns valid when name is unique', () => {
        const existingSessions = [
          createMockSession({ name: 'Existing Session' }),
        ];
        const result = validateNewSession('New Session', '/path/to/project', 'claude-code', existingSessions);
        expect(result.valid).toBe(true);
      });

      it('returns error when name already exists (exact match)', () => {
        const existingSessions = [
          createMockSession({ name: 'My Project' }),
        ];
        const result = validateNewSession('My Project', '/different/path', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('name');
        expect(result.error).toContain('My Project');
        expect(result.error).toContain('already exists');
      });

      it('returns error when name matches case-insensitively', () => {
        const existingSessions = [
          createMockSession({ name: 'My Project' }),
        ];
        const result = validateNewSession('my project', '/different/path', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('name');
      });

      it('returns error when name matches with different casing (uppercase)', () => {
        const existingSessions = [
          createMockSession({ name: 'my project' }),
        ];
        const result = validateNewSession('MY PROJECT', '/different/path', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('name');
      });

      it('handles names with leading/trailing whitespace in comparison', () => {
        const existingSessions = [
          createMockSession({ name: 'My Project' }),
        ];
        // Note: The validation function expects trimmed input from the caller
        // This tests that exact matches work correctly
        const result = validateNewSession('My Project', '/different/path', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
      });

      it('allows similar but different names', () => {
        const existingSessions = [
          createMockSession({ name: 'My Project' }),
        ];
        const result = validateNewSession('My Project 2', '/different/path', 'claude-code', existingSessions);
        expect(result.valid).toBe(true);
      });
    });

    describe('directory uniqueness per provider', () => {
      it('returns valid when directory is unique', () => {
        const existingSessions = [
          createMockSession({ projectRoot: '/Users/test/project-a' }),
        ];
        const result = validateNewSession('New Session', '/Users/test/project-b', 'claude-code', existingSessions);
        expect(result.valid).toBe(true);
      });

      it('returns error when directory already exists for same provider', () => {
        const existingSessions = [
          createMockSession({
            name: 'Existing Agent',
            projectRoot: '/Users/test/project',
            toolType: 'claude-code'
          }),
        ];
        const result = validateNewSession('New Session', '/Users/test/project', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('directory');
        expect(result.error).toContain('Claude Code');
        expect(result.error).toContain('Existing Agent');
      });

      it('allows same directory with different provider', () => {
        const existingSessions = [
          createMockSession({
            name: 'Claude Agent',
            projectRoot: '/Users/test/project',
            toolType: 'claude-code'
          }),
        ];
        // Different provider (aider) can use same directory
        const result = validateNewSession('Aider Agent', '/Users/test/project', 'aider', existingSessions);
        expect(result.valid).toBe(true);
      });

      it('handles directory comparison case-insensitively', () => {
        const existingSessions = [
          createMockSession({
            projectRoot: '/Users/Test/Project',
            toolType: 'claude-code'
          }),
        ];
        const result = validateNewSession('New Session', '/users/test/project', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('directory');
      });

      it('normalizes trailing slashes in directory comparison', () => {
        const existingSessions = [
          createMockSession({
            projectRoot: '/Users/test/project/',
            toolType: 'claude-code'
          }),
        ];
        const result = validateNewSession('New Session', '/Users/test/project', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('directory');
      });

      it('normalizes multiple trailing slashes', () => {
        const existingSessions = [
          createMockSession({
            projectRoot: '/Users/test/project///',
            toolType: 'claude-code'
          }),
        ];
        const result = validateNewSession('New Session', '/Users/test/project', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('directory');
      });

      it('uses cwd as fallback when projectRoot is not set', () => {
        const existingSessions = [
          createMockSession({
            cwd: '/Users/test/project',
            projectRoot: undefined as unknown as string,
            toolType: 'claude-code'
          }),
        ];
        const result = validateNewSession('New Session', '/Users/test/project', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('directory');
      });
    });

    describe('multiple sessions', () => {
      it('validates against all existing sessions', () => {
        const existingSessions = [
          createMockSession({ name: 'Session 1', projectRoot: '/path/one', toolType: 'claude-code' }),
          createMockSession({ name: 'Session 2', projectRoot: '/path/two', toolType: 'claude-code' }),
          createMockSession({ name: 'Session 3', projectRoot: '/path/three', toolType: 'aider' }),
        ];

        // Unique name and directory
        expect(validateNewSession('Session 4', '/path/four', 'claude-code', existingSessions).valid).toBe(true);

        // Duplicate name
        expect(validateNewSession('Session 2', '/path/four', 'claude-code', existingSessions).valid).toBe(false);

        // Duplicate directory for same provider
        expect(validateNewSession('Session 4', '/path/two', 'claude-code', existingSessions).valid).toBe(false);

        // Same directory but different provider is OK
        expect(validateNewSession('Session 4', '/path/two', 'aider', existingSessions).valid).toBe(true);
      });

      it('name check takes priority over directory check', () => {
        const existingSessions = [
          createMockSession({ name: 'My Agent', projectRoot: '/path/one', toolType: 'claude-code' }),
        ];
        // Both name and directory match - should get name error
        const result = validateNewSession('My Agent', '/path/one', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('name');
      });
    });

    describe('provider display names', () => {
      it('shows correct display name for claude-code', () => {
        const existingSessions = [
          createMockSession({
            name: 'Existing',
            projectRoot: '/path',
            toolType: 'claude-code'
          }),
        ];
        const result = validateNewSession('New', '/path', 'claude-code', existingSessions);
        expect(result.error).toContain('Claude Code');
      });

      it('shows correct display name for aider', () => {
        const existingSessions = [
          createMockSession({
            name: 'Existing',
            projectRoot: '/path',
            toolType: 'aider'
          }),
        ];
        const result = validateNewSession('New', '/path', 'aider', existingSessions);
        expect(result.error).toContain('Aider');
      });

      it('shows correct display name for terminal', () => {
        const existingSessions = [
          createMockSession({
            name: 'Existing',
            projectRoot: '/path',
            toolType: 'terminal'
          }),
        ];
        const result = validateNewSession('New', '/path', 'terminal', existingSessions);
        expect(result.error).toContain('Terminal');
      });
    });

    describe('edge cases', () => {
      it('handles empty session list', () => {
        const result = validateNewSession('Any Name', '/any/path', 'claude-code', []);
        expect(result.valid).toBe(true);
      });

      it('handles sessions with undefined toolType gracefully', () => {
        const existingSessions = [
          createMockSession({
            name: 'Existing',
            projectRoot: '/path',
            toolType: undefined as unknown as ToolType
          }),
        ];
        // Should not crash, and should allow the new session since toolTypes don't match
        const result = validateNewSession('New', '/path', 'claude-code', existingSessions);
        expect(result.valid).toBe(true);
      });

      it('handles very long paths', () => {
        const longPath = '/Users/test/' + 'a'.repeat(500) + '/project';
        const existingSessions = [
          createMockSession({ projectRoot: longPath, toolType: 'claude-code' }),
        ];
        const result = validateNewSession('New Session', longPath, 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('directory');
      });

      it('handles paths with special characters', () => {
        const specialPath = '/Users/test/my project (2024)/code-base';
        const existingSessions = [
          createMockSession({ projectRoot: specialPath, toolType: 'claude-code' }),
        ];
        const result = validateNewSession('New Session', specialPath, 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('directory');
      });

      it('handles unicode in session names', () => {
        const existingSessions = [
          createMockSession({ name: 'Project café 日本語' }),
        ];
        const result = validateNewSession('Project café 日本語', '/different/path', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('name');
      });

      it('handles emoji in session names', () => {
        const existingSessions = [
          createMockSession({ name: '🚀 My Project' }),
        ];
        const result = validateNewSession('🚀 My Project', '/different/path', 'claude-code', existingSessions);
        expect(result.valid).toBe(false);
        expect(result.errorField).toBe('name');
      });
    });

    describe('return value contract', () => {
      it('returns SessionValidationResult interface for valid result', () => {
        const result: SessionValidationResult = validateNewSession('Test', '/path', 'claude-code', []);
        expect(result).toHaveProperty('valid');
        expect(typeof result.valid).toBe('boolean');
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.errorField).toBeUndefined();
      });

      it('returns SessionValidationResult interface for invalid result', () => {
        const existingSessions = [createMockSession({ name: 'Test' })];
        const result: SessionValidationResult = validateNewSession('Test', '/path', 'claude-code', existingSessions);
        expect(result).toHaveProperty('valid');
        expect(result).toHaveProperty('error');
        expect(result).toHaveProperty('errorField');
        expect(typeof result.valid).toBe('boolean');
        expect(typeof result.error).toBe('string');
        expect(result.errorField).toBe('name');
      });
    });
  });
});
