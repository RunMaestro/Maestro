/**
 * Tests for iOS Selected Assertions
 *
 * Tests the assertSelected and assertNotSelected functions
 * for verifying element selection state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('../../../../main/ios-tools/simulator', () => ({
  getBootedSimulators: vi.fn(),
  getSimulator: vi.fn(),
}));

vi.mock('../../../../main/ios-tools/capture', () => ({
  screenshot: vi.fn(),
}));

vi.mock('../../../../main/ios-tools/inspect-simple', () => ({
  inspect: vi.fn(),
}));

vi.mock('../../../../main/ios-tools/artifacts', () => ({
  getSnapshotDirectory: vi.fn(),
}));

vi.mock('../../../../main/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  assertSelected,
  assertNotSelected,
  assertSelectedById,
  assertSelectedByLabel,
  assertSelectedByText,
  assertNotSelectedById,
  assertNotSelectedByLabel,
  assertNotSelectedByText,
} from '../../../../main/ios-tools/assertions/selected';
import { getBootedSimulators, getSimulator } from '../../../../main/ios-tools/simulator';
import { screenshot } from '../../../../main/ios-tools/capture';
import { inspect } from '../../../../main/ios-tools/inspect-simple';
import { getSnapshotDirectory } from '../../../../main/ios-tools/artifacts';

describe('selected assertions', () => {
  const mockUdid = 'test-udid-12345';
  const mockSessionId = 'test-session';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for booted simulators
    vi.mocked(getBootedSimulators).mockResolvedValue({
      success: true,
      data: [{ udid: mockUdid, name: 'iPhone 15', state: 'Booted' }],
    });

    // Default mock for simulator info
    vi.mocked(getSimulator).mockResolvedValue({
      success: true,
      data: {
        udid: mockUdid,
        name: 'iPhone 15',
        state: 'Booted',
        iosVersion: '17.0',
      },
    });

    // Default mock for artifact directory
    vi.mocked(getSnapshotDirectory).mockResolvedValue('/tmp/artifacts/test');

    // Default mock for screenshot
    vi.mocked(screenshot).mockResolvedValue({
      success: true,
      data: { path: '/tmp/artifacts/test/screenshot.png' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('assertSelected', () => {
    it('should pass when element is selected', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'home_tab',
                label: 'Home',
                visible: true,
                enabled: true,
                selected: true,
                frame: { x: 0, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 1, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      const result = await assertSelected({
        sessionId: mockSessionId,
        target: { identifier: 'home_tab' },
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.wasSelected).toBe(true);
    });

    it('should fail when element is not selected', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'settings_tab',
                label: 'Settings',
                visible: true,
                enabled: true,
                selected: false,
                frame: { x: 100, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 1, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      const result = await assertSelected({
        sessionId: mockSessionId,
        target: { identifier: 'settings_tab' },
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('timeout');
      expect(result.data?.data?.wasSelected).toBe(false);
    });

    it('should fail when element is not found', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [],
          },
          elements: [],
          stats: { totalElements: 1, interactableElements: 0, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      const result = await assertSelected({
        sessionId: mockSessionId,
        target: { identifier: 'nonexistent' },
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('timeout');
    });

    it('should fail when element is not visible and requireVisible is true', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'hidden_tab',
                visible: false,  // Element is not visible
                enabled: true,
                selected: true,
                frame: { x: 0, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 0, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      const result = await assertSelected({
        sessionId: mockSessionId,
        target: { identifier: 'hidden_tab' },
        requireVisible: true,
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('timeout');
      // On timeout, lastData includes the element's visibility state
      // Check that the assertion correctly identified the element was not visible
      expect(result.data?.data?.visibilityRequired).toBe(true);
    });

    it('should return error when no simulator is booted', async () => {
      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [],
      });

      const result = await assertSelected({
        sessionId: mockSessionId,
        target: { identifier: 'home_tab' },
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
    });
  });

  describe('assertNotSelected', () => {
    it('should pass when element is not selected', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'settings_tab',
                label: 'Settings',
                visible: true,
                enabled: true,
                selected: false,
                frame: { x: 100, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 1, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      const result = await assertNotSelected({
        sessionId: mockSessionId,
        target: { identifier: 'settings_tab' },
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.wasSelected).toBe(false);
    });

    it('should fail when element is still selected', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'home_tab',
                label: 'Home',
                visible: true,
                enabled: true,
                selected: true,
                frame: { x: 0, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 1, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      const result = await assertNotSelected({
        sessionId: mockSessionId,
        target: { identifier: 'home_tab' },
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('timeout');
      expect(result.data?.data?.wasSelected).toBe(true);
    });
  });

  describe('convenience functions', () => {
    beforeEach(() => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'home_tab',
                label: 'Home',
                visible: true,
                enabled: true,
                selected: true,
                frame: { x: 0, y: 0, width: 100, height: 50 },
                children: [
                  {
                    type: 'StaticText',
                    value: 'Home',
                    visible: true,
                    enabled: true,
                    selected: true,
                    frame: { x: 10, y: 10, width: 80, height: 30 },
                    children: [],
                  },
                ],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 3, interactableElements: 1, buttons: 0, textFields: 0, textElements: 1, images: 0 },
        },
      });
    });

    it('assertSelectedById should find by identifier', async () => {
      const result = await assertSelectedById('home_tab', {
        sessionId: mockSessionId,
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.matchedBy).toBe('identifier');
    });

    it('assertSelectedByLabel should find by label', async () => {
      const result = await assertSelectedByLabel('Home', {
        sessionId: mockSessionId,
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.matchedBy).toBe('label');
    });

    it('assertSelectedByText should find by text content', async () => {
      const result = await assertSelectedByText('Home', {
        sessionId: mockSessionId,
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.matchedBy).toBe('text');
    });

    it('assertNotSelectedById should find by identifier', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'settings_tab',
                label: 'Settings',
                visible: true,
                enabled: true,
                selected: false,
                frame: { x: 100, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 1, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      const result = await assertNotSelectedById('settings_tab', {
        sessionId: mockSessionId,
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.matchedBy).toBe('identifier');
    });

    it('assertNotSelectedByLabel should find by label', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'settings_tab',
                label: 'Settings',
                visible: true,
                enabled: true,
                selected: false,
                frame: { x: 100, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 1, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      const result = await assertNotSelectedByLabel('Settings', {
        sessionId: mockSessionId,
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.matchedBy).toBe('label');
    });

    it('assertNotSelectedByText should find by text content', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'StaticText',
                value: 'Settings',
                visible: true,
                enabled: true,
                selected: false,
                frame: { x: 100, y: 10, width: 80, height: 30 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 0, buttons: 0, textFields: 0, textElements: 1, images: 0 },
        },
      });

      const result = await assertNotSelectedByText('Settings', {
        sessionId: mockSessionId,
        polling: { timeout: 100, interval: 50 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.data?.matchedBy).toBe('text');
    });
  });

  describe('screenshot capture', () => {
    it('should capture screenshot on failure when captureOnFailure is true', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [],
          },
          elements: [],
          stats: { totalElements: 1, interactableElements: 0, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      await assertSelected({
        sessionId: mockSessionId,
        target: { identifier: 'nonexistent' },
        captureOnFailure: true,
        polling: { timeout: 100, interval: 50 },
      });

      expect(screenshot).toHaveBeenCalled();
    });

    it('should not capture screenshot on success when captureOnSuccess is false', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'home_tab',
                visible: true,
                enabled: true,
                selected: true,
                frame: { x: 0, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 1, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      await assertSelected({
        sessionId: mockSessionId,
        target: { identifier: 'home_tab' },
        captureOnSuccess: false,
        captureOnFailure: false,
        polling: { timeout: 100, interval: 50 },
      });

      expect(screenshot).not.toHaveBeenCalled();
    });

    it('should capture screenshot on success when captureOnSuccess is true', async () => {
      vi.mocked(inspect).mockResolvedValue({
        success: true,
        data: {
          id: 'inspect-1',
          timestamp: new Date().toISOString(),
          simulator: { udid: mockUdid, name: 'iPhone 15', iosVersion: '17.0' },
          tree: {
            type: 'Application',
            identifier: 'app',
            visible: true,
            enabled: true,
            frame: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                type: 'Tab',
                identifier: 'home_tab',
                visible: true,
                enabled: true,
                selected: true,
                frame: { x: 0, y: 0, width: 100, height: 50 },
                children: [],
              },
            ],
          },
          elements: [],
          stats: { totalElements: 2, interactableElements: 1, buttons: 0, textFields: 0, textElements: 0, images: 0 },
        },
      });

      await assertSelected({
        sessionId: mockSessionId,
        target: { identifier: 'home_tab' },
        captureOnSuccess: true,
        captureOnFailure: false,
        polling: { timeout: 100, interval: 50 },
      });

      expect(screenshot).toHaveBeenCalled();
    });
  });
});
