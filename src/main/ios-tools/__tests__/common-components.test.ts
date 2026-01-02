/**
 * Tests for iOS Common Components
 *
 * These tests verify that the common flows, screens, and assertions
 * are properly structured and can be loaded/parsed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml');

import {
  ensurePlaybooksDirectory,
  getCommonFlowsDir,
  getCommonScreensDir,
  getCommonAssertionsDir,
} from '../playbook-loader';

// =============================================================================
// Test Setup
// =============================================================================

const PLAYBOOKS_DIR = path.join(os.homedir(), '.maestro', 'playbooks', 'iOS');

// Initialize directories immediately
ensurePlaybooksDirectory(PLAYBOOKS_DIR);
const flowsDir = getCommonFlowsDir(PLAYBOOKS_DIR);
const screensDir = getCommonScreensDir(PLAYBOOKS_DIR);
const assertionsDir = getCommonAssertionsDir(PLAYBOOKS_DIR);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Load and parse a YAML file (supports multi-document YAML with ---)
 */
function loadYamlFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, 'utf-8');
  // Use loadAll for multi-document YAML files (like Maestro flows with config section)
  const docs = yaml.loadAll(content);
  // Return first document if single, or array if multiple
  return docs.length === 1 ? docs[0] : docs;
}

/**
 * Check if a YAML file is valid (can be parsed without errors)
 * Supports multi-document YAML files with --- separators
 */
function isValidYaml(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Use loadAll to handle multi-document YAML files
    yaml.loadAll(content);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Common Flows Tests
// =============================================================================

describe('Common Flows', () => {
  describe('login.yaml', () => {
    const loginFlowPath = path.join(flowsDir, 'login.yaml');

    it('should exist', () => {
      expect(fs.existsSync(loginFlowPath)).toBe(true);
    });

    it('should be valid YAML', () => {
      expect(isValidYaml(loginFlowPath)).toBe(true);
    });

    it('should contain required flow elements', () => {
      const content = fs.readFileSync(loginFlowPath, 'utf-8');

      // Should reference key environment variables
      expect(content).toContain('LOGIN_EMAIL');
      expect(content).toContain('LOGIN_PASSWORD');

      // Should have common actions
      expect(content).toContain('tapOn');
      expect(content).toContain('inputText');

      // Should wait for result
      expect(content).toContain('extendedWaitUntil');
    });

    it('should have documented environment variables', () => {
      const content = fs.readFileSync(loginFlowPath, 'utf-8');

      // Check for documentation header
      expect(content).toContain('Environment Variables:');
      expect(content).toContain('LOGIN_EMAIL_FIELD');
      expect(content).toContain('LOGIN_PASSWORD_FIELD');
      expect(content).toContain('LOGIN_BUTTON');
    });
  });

  describe('logout.yaml', () => {
    const logoutFlowPath = path.join(flowsDir, 'logout.yaml');

    it('should exist', () => {
      expect(fs.existsSync(logoutFlowPath)).toBe(true);
    });

    it('should be valid YAML', () => {
      expect(isValidYaml(logoutFlowPath)).toBe(true);
    });

    it('should contain required flow elements', () => {
      const content = fs.readFileSync(logoutFlowPath, 'utf-8');

      // Should reference logout button
      expect(content).toContain('LOGOUT_BUTTON');

      // Should have tap actions
      expect(content).toContain('tapOn');

      // Should verify logout success
      expect(content).toContain('extendedWaitUntil');
    });

    it('should support confirmation dialog handling', () => {
      const content = fs.readFileSync(logoutFlowPath, 'utf-8');
      expect(content).toContain('LOGOUT_CONFIRM_BUTTON');
    });
  });

  describe('navigate-to-settings.yaml', () => {
    const settingsFlowPath = path.join(flowsDir, 'navigate-to-settings.yaml');

    it('should exist', () => {
      expect(fs.existsSync(settingsFlowPath)).toBe(true);
    });

    it('should be valid YAML', () => {
      expect(isValidYaml(settingsFlowPath)).toBe(true);
    });

    it('should support multiple navigation patterns', () => {
      const content = fs.readFileSync(settingsFlowPath, 'utf-8');

      // Should support tab bar navigation
      expect(content).toContain('NAVIGATION_VIA_TAB');
      expect(content).toContain('SETTINGS_TAB');

      // Should support profile-based navigation
      expect(content).toContain('NAVIGATION_VIA_PROFILE');
      expect(content).toContain('PROFILE_BUTTON');
    });
  });

  describe('clear-data.yaml', () => {
    const clearDataFlowPath = path.join(flowsDir, 'clear-data.yaml');

    it('should exist', () => {
      expect(fs.existsSync(clearDataFlowPath)).toBe(true);
    });

    it('should be valid YAML', () => {
      expect(isValidYaml(clearDataFlowPath)).toBe(true);
    });

    it('should support multiple clear types', () => {
      const content = fs.readFileSync(clearDataFlowPath, 'utf-8');

      expect(content).toContain('CLEAR_CACHE_BUTTON');
      expect(content).toContain('CLEAR_DATA_BUTTON');
      expect(content).toContain('CLEAR_ALL_BUTTON');
      expect(content).toContain('CLEAR_TYPE');
    });

    it('should support navigation to settings', () => {
      const content = fs.readFileSync(clearDataFlowPath, 'utf-8');
      expect(content).toContain('NAVIGATE_TO_SETTINGS');
    });
  });
});

// =============================================================================
// Standard Screens Tests
// =============================================================================

describe('Standard Screens', () => {
  const standardScreensPath = path.join(screensDir, 'standard-screens.yaml');

  it('should exist', () => {
    expect(fs.existsSync(standardScreensPath)).toBe(true);
  });

  it('should be valid YAML', () => {
    expect(isValidYaml(standardScreensPath)).toBe(true);
  });

  it('should define standard screen types', () => {
    const config = loadYamlFile(standardScreensPath) as Record<string, unknown>;
    const screens = config.screens as Record<string, unknown>;

    expect(screens).toBeDefined();
    expect(screens.splash).toBeDefined();
    expect(screens.login).toBeDefined();
    expect(screens.home).toBeDefined();
    expect(screens.settings).toBeDefined();
    expect(screens.profile).toBeDefined();
  });

  it('should include screen elements', () => {
    const config = loadYamlFile(standardScreensPath) as Record<string, unknown>;
    const screens = config.screens as Record<string, Record<string, unknown>>;

    // Login screen should have required fields
    const loginScreen = screens.login;
    expect(loginScreen.wait_for).toBeDefined();
    expect(loginScreen.elements).toBeDefined();
    expect(Array.isArray(loginScreen.elements)).toBe(true);

    // Should have email and password fields
    const elements = loginScreen.elements as Array<{ id?: string }>;
    const elementIds = elements.map((e) => e.id);
    expect(elementIds).toContain('email_field');
    expect(elementIds).toContain('password_field');
  });

  it('should include timeouts for screens', () => {
    const config = loadYamlFile(standardScreensPath) as Record<string, unknown>;
    const screens = config.screens as Record<string, Record<string, unknown>>;

    // All screens should have timeouts
    for (const [screenName, screenDef] of Object.entries(screens)) {
      expect(screenDef.timeout, `Screen '${screenName}' should have timeout`).toBeDefined();
      expect(typeof screenDef.timeout).toBe('number');
    }
  });

  it('should include tab bar definitions', () => {
    const config = loadYamlFile(standardScreensPath) as Record<string, unknown>;
    expect(config.tab_bar).toBeDefined();

    const tabBar = config.tab_bar as Record<string, unknown>;
    expect(tabBar.home).toBeDefined();
    expect(tabBar.settings).toBeDefined();
  });

  it('should include navigation elements', () => {
    const config = loadYamlFile(standardScreensPath) as Record<string, unknown>;
    expect(config.navigation).toBeDefined();

    const navigation = config.navigation as Record<string, unknown>;
    expect(navigation.back_button).toBeDefined();
    expect(navigation.close_button).toBeDefined();
  });
});

// =============================================================================
// Standard Assertions Tests
// =============================================================================

describe('Standard Assertions', () => {
  const standardAssertionsPath = path.join(assertionsDir, 'standard-assertions.yaml');

  it('should exist', () => {
    expect(fs.existsSync(standardAssertionsPath)).toBe(true);
  });

  it('should be valid YAML', () => {
    expect(isValidYaml(standardAssertionsPath)).toBe(true);
  });

  it('should define standard assertion groups', () => {
    const config = loadYamlFile(standardAssertionsPath) as Record<string, unknown>;
    const assertions = config.assertions as Record<string, unknown>;

    expect(assertions).toBeDefined();

    // App launch assertions
    expect(assertions.app_launched).toBeDefined();
    expect(assertions.app_responsive).toBeDefined();

    // Authentication assertions
    expect(assertions.user_logged_in).toBeDefined();
    expect(assertions.user_logged_out).toBeDefined();

    // Error state assertions
    expect(assertions.no_errors).toBeDefined();
    expect(assertions.no_crash).toBeDefined();
  });

  it('should have checks array for each assertion', () => {
    const config = loadYamlFile(standardAssertionsPath) as Record<string, unknown>;
    const assertions = config.assertions as Record<string, Record<string, unknown>>;

    for (const [assertionName, assertionDef] of Object.entries(assertions)) {
      expect(assertionDef.checks, `Assertion '${assertionName}' should have checks array`).toBeDefined();
      expect(Array.isArray(assertionDef.checks), `Assertion '${assertionName}' checks should be array`).toBe(true);
      expect(assertionDef.checks.length, `Assertion '${assertionName}' should have at least one check`).toBeGreaterThan(0);
    }
  });

  it('should have descriptions for assertions', () => {
    const config = loadYamlFile(standardAssertionsPath) as Record<string, unknown>;
    const assertions = config.assertions as Record<string, Record<string, unknown>>;

    for (const [assertionName, assertionDef] of Object.entries(assertions)) {
      expect(assertionDef.description, `Assertion '${assertionName}' should have description`).toBeDefined();
      expect(typeof assertionDef.description).toBe('string');
    }
  });

  it('should define composite assertions', () => {
    const config = loadYamlFile(standardAssertionsPath) as Record<string, unknown>;
    expect(config.composite).toBeDefined();

    const composite = config.composite as Record<string, Record<string, unknown>>;

    expect(composite.healthy_app_state).toBeDefined();
    expect(composite.healthy_app_state.includes).toBeDefined();

    expect(composite.ready_for_interaction).toBeDefined();
    expect(composite.authenticated_session).toBeDefined();
  });

  it('should include crash detection assertions', () => {
    const config = loadYamlFile(standardAssertionsPath) as Record<string, unknown>;
    const assertions = config.assertions as Record<string, Record<string, unknown>>;

    const noCrash = assertions.no_crash;
    expect(noCrash).toBeDefined();

    const checks = noCrash.checks as Array<{ containsText?: string; id?: string }>;

    // Should check for crash dialogs
    expect(checks.some((c) => c.id === 'crash_dialog' || c.containsText?.includes('stopped'))).toBe(true);
  });
});

// =============================================================================
// Directory Structure Tests
// =============================================================================

describe('Common Components Directory Structure', () => {
  it('should have flows directory', () => {
    expect(fs.existsSync(flowsDir)).toBe(true);
    expect(fs.statSync(flowsDir).isDirectory()).toBe(true);
  });

  it('should have screens directory', () => {
    expect(fs.existsSync(screensDir)).toBe(true);
    expect(fs.statSync(screensDir).isDirectory()).toBe(true);
  });

  it('should have assertions directory', () => {
    expect(fs.existsSync(assertionsDir)).toBe(true);
    expect(fs.statSync(assertionsDir).isDirectory()).toBe(true);
  });

  it('should have all expected flow files', () => {
    const expectedFlows = ['login.yaml', 'logout.yaml', 'navigate-to-settings.yaml', 'clear-data.yaml'];

    for (const flowFile of expectedFlows) {
      const flowPath = path.join(flowsDir, flowFile);
      expect(fs.existsSync(flowPath), `Expected flow file: ${flowFile}`).toBe(true);
    }
  });

  it('should have standard-screens.yaml', () => {
    const screensPath = path.join(screensDir, 'standard-screens.yaml');
    expect(fs.existsSync(screensPath)).toBe(true);
  });

  it('should have standard-assertions.yaml', () => {
    const assertionsPath = path.join(assertionsDir, 'standard-assertions.yaml');
    expect(fs.existsSync(assertionsPath)).toBe(true);
  });
});

// =============================================================================
// Cross-Component Consistency Tests
// =============================================================================

describe('Cross-Component Consistency', () => {
  it('should use consistent element IDs across flows and screens', () => {
    // Load screens definition
    const screensPath = path.join(screensDir, 'standard-screens.yaml');
    const screensConfig = loadYamlFile(screensPath) as Record<string, Record<string, Record<string, unknown>>>;
    const screens = screensConfig.screens;

    // Get login screen element IDs
    const loginElements = screens.login.elements as Array<{ id: string }>;
    const loginElementIds = new Set(loginElements.map((e) => e.id));

    // Load login flow
    const loginFlowPath = path.join(flowsDir, 'login.yaml');
    const loginFlowContent = fs.readFileSync(loginFlowPath, 'utf-8');

    // Check that the default IDs in the flow match the screen definitions
    // The flow uses ${LOGIN_EMAIL_FIELD:-email_field} pattern, so defaults should match
    expect(loginElementIds.has('email_field')).toBe(true);
    expect(loginElementIds.has('password_field')).toBe(true);
    expect(loginFlowContent).toContain('email_field');
    expect(loginFlowContent).toContain('password_field');
  });

  it('should reference valid assertion patterns in flows', () => {
    // The flows don't directly reference assertions, but they should use similar patterns
    const assertionsPath = path.join(assertionsDir, 'standard-assertions.yaml');
    const assertionsConfig = loadYamlFile(assertionsPath) as Record<string, unknown>;

    // Verify assertions file has the patterns used in flows
    const content = JSON.stringify(assertionsConfig);

    // Common patterns used in flows
    expect(content).toContain('assertVisible');
    expect(content).toContain('assertNotVisible');
  });
});
