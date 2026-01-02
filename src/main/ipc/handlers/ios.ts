/**
 * iOS IPC Handlers
 *
 * IPC handlers for iOS tooling operations.
 * Exposes iOS simulator, screenshot, and log functionality to the renderer.
 */

import { ipcMain } from 'electron';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import * as iosTools from '../../ios-tools';

const LOG_CONTEXT = '[iOS-IPC]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
  context: LOG_CONTEXT,
  operation,
  logSuccess,
});

/**
 * Register all iOS-related IPC handlers.
 */
export function registerIOSHandlers(): void {
  // ==========================================================================
  // Xcode Detection
  // ==========================================================================

  // Detect Xcode installation
  ipcMain.handle(
    'ios:xcode:detect',
    createIpcHandler(handlerOpts('detectXcode'), async () => {
      return iosTools.detectXcode();
    })
  );

  // Get Xcode version
  ipcMain.handle(
    'ios:xcode:version',
    createIpcHandler(handlerOpts('getXcodeVersion'), async () => {
      return iosTools.getXcodeVersion();
    })
  );

  // Get full Xcode info
  ipcMain.handle(
    'ios:xcode:info',
    createIpcHandler(handlerOpts('getXcodeInfo'), async () => {
      return iosTools.getXcodeInfo();
    })
  );

  // Validate Xcode installation
  ipcMain.handle(
    'ios:xcode:validate',
    createIpcHandler(handlerOpts('validateXcode'), async () => {
      return iosTools.validateXcodeInstallation();
    })
  );

  // List iOS SDKs
  ipcMain.handle(
    'ios:xcode:sdks',
    createIpcHandler(handlerOpts('listSDKs'), async () => {
      return iosTools.listSDKs();
    })
  );

  // ==========================================================================
  // Simulator Management
  // ==========================================================================

  // List all simulators
  ipcMain.handle(
    'ios:simulator:list',
    createIpcHandler(handlerOpts('listSimulators', false), async () => {
      return iosTools.listSimulators();
    })
  );

  // Get booted simulators
  ipcMain.handle(
    'ios:simulator:booted',
    createIpcHandler(handlerOpts('getBootedSimulators', false), async () => {
      return iosTools.getBootedSimulators();
    })
  );

  // Get specific simulator
  ipcMain.handle(
    'ios:simulator:get',
    createIpcHandler(handlerOpts('getSimulator'), async (udid: string) => {
      return iosTools.getSimulator(udid);
    })
  );

  // Boot simulator
  ipcMain.handle(
    'ios:simulator:boot',
    createIpcHandler(
      handlerOpts('bootSimulator'),
      async (udid: string, options?: { timeout?: number; waitForBoot?: boolean }) => {
        return iosTools.bootSimulator({
          udid,
          ...options,
        });
      }
    )
  );

  // Shutdown simulator
  ipcMain.handle(
    'ios:simulator:shutdown',
    createIpcHandler(handlerOpts('shutdownSimulator'), async (udid: string) => {
      return iosTools.shutdownSimulator(udid);
    })
  );

  // Erase simulator
  ipcMain.handle(
    'ios:simulator:erase',
    createIpcHandler(handlerOpts('eraseSimulator'), async (udid: string) => {
      return iosTools.eraseSimulator(udid);
    })
  );

  // ==========================================================================
  // App Installation & Lifecycle
  // ==========================================================================

  // Install app
  ipcMain.handle(
    'ios:app:install',
    createIpcHandler(handlerOpts('installApp'), async (udid: string, appPath: string) => {
      return iosTools.installApp({ udid, appPath });
    })
  );

  // Uninstall app
  ipcMain.handle(
    'ios:app:uninstall',
    createIpcHandler(handlerOpts('uninstallApp'), async (udid: string, bundleId: string) => {
      return iosTools.uninstallApp(udid, bundleId);
    })
  );

  // Launch app
  ipcMain.handle(
    'ios:app:launch',
    createIpcHandler(
      handlerOpts('launchApp'),
      async (
        udid: string,
        bundleId: string,
        options?: { args?: string[]; env?: Record<string, string> }
      ) => {
        return iosTools.launchApp({
          udid,
          bundleId,
          ...options,
        });
      }
    )
  );

  // Terminate app
  ipcMain.handle(
    'ios:app:terminate',
    createIpcHandler(handlerOpts('terminateApp'), async (udid: string, bundleId: string) => {
      return iosTools.terminateApp(udid, bundleId);
    })
  );

  // Get app container
  ipcMain.handle(
    'ios:app:container',
    createIpcHandler(
      handlerOpts('getAppContainer'),
      async (
        udid: string,
        bundleId: string,
        containerType?: 'app' | 'data' | 'groups'
      ) => {
        return iosTools.getAppContainer(udid, bundleId, containerType);
      }
    )
  );

  // Open URL
  ipcMain.handle(
    'ios:app:openurl',
    createIpcHandler(handlerOpts('openURL'), async (udid: string, url: string) => {
      return iosTools.openURL(udid, url);
    })
  );

  // ==========================================================================
  // Screenshot & Recording
  // ==========================================================================

  // Capture screenshot
  ipcMain.handle(
    'ios:capture:screenshot',
    createIpcHandler(
      handlerOpts('screenshot'),
      async (
        udid: string,
        outputPath: string,
        options?: { display?: 'internal' | 'external'; mask?: 'ignored' | 'alpha' | 'black' }
      ) => {
        return iosTools.screenshot({
          udid,
          outputPath,
          ...options,
        });
      }
    )
  );

  // Capture screenshot with auto-naming
  ipcMain.handle(
    'ios:capture:screenshotAuto',
    createIpcHandler(
      handlerOpts('captureScreenshot'),
      async (udid: string, directory: string, prefix?: string) => {
        return iosTools.captureScreenshot(udid, directory, prefix);
      }
    )
  );

  // Start video recording
  ipcMain.handle(
    'ios:capture:startRecording',
    createIpcHandler(
      handlerOpts('startRecording'),
      async (
        udid: string,
        outputPath: string,
        options?: { codec?: 'h264' | 'hevc' }
      ) => {
        return iosTools.startRecording({
          udid,
          outputPath,
          ...options,
        });
      }
    )
  );

  // Stop video recording
  ipcMain.handle(
    'ios:capture:stopRecording',
    createIpcHandler(handlerOpts('stopRecording'), async (udid: string) => {
      return iosTools.stopRecording(udid);
    })
  );

  // Check if recording
  ipcMain.handle(
    'ios:capture:isRecording',
    createIpcHandler(handlerOpts('isRecording', false), async (udid: string) => {
      return { success: true, data: iosTools.isRecording(udid) };
    })
  );

  // Get screen size
  ipcMain.handle(
    'ios:capture:screenSize',
    createIpcHandler(handlerOpts('getScreenSize'), async (udid: string) => {
      return iosTools.getScreenSize(udid);
    })
  );

  // ==========================================================================
  // Log Collection
  // ==========================================================================

  // Get system logs
  ipcMain.handle(
    'ios:logs:system',
    createIpcHandler(
      handlerOpts('getSystemLog'),
      async (
        udid: string,
        options?: {
          since?: string;
          level?: 'default' | 'info' | 'debug' | 'error' | 'fault';
          process?: string;
          predicate?: string;
          limit?: number;
        }
      ) => {
        return iosTools.getSystemLog({
          udid,
          ...options,
        });
      }
    )
  );

  // Get system logs as text
  ipcMain.handle(
    'ios:logs:systemText',
    createIpcHandler(handlerOpts('getSystemLogText'), async (udid: string, since?: string) => {
      return iosTools.getSystemLogText(udid, since);
    })
  );

  // Get crash logs
  ipcMain.handle(
    'ios:logs:crash',
    createIpcHandler(
      handlerOpts('getCrashLogs'),
      async (
        udid: string,
        options?: {
          bundleId?: string;
          since?: string;
          limit?: number;
          includeContent?: boolean;
        }
      ) => {
        return iosTools.getCrashLogs({
          udid,
          since: options?.since ? new Date(options.since) : undefined,
          bundleId: options?.bundleId,
          limit: options?.limit,
          includeContent: options?.includeContent,
        });
      }
    )
  );

  // Check for recent crashes
  ipcMain.handle(
    'ios:logs:hasRecentCrashes',
    createIpcHandler(
      handlerOpts('hasRecentCrashes'),
      async (udid: string, bundleId: string, since: string) => {
        return iosTools.hasRecentCrashes(udid, bundleId, new Date(since));
      }
    )
  );

  // Get diagnostics
  ipcMain.handle(
    'ios:logs:diagnostics',
    createIpcHandler(handlerOpts('getDiagnostics'), async (udid: string, outputPath: string) => {
      return iosTools.getDiagnostics(udid, outputPath);
    })
  );

  // ==========================================================================
  // Snapshot
  // ==========================================================================

  // Capture full snapshot (screenshot + logs + crash detection)
  ipcMain.handle(
    'ios:snapshot:capture',
    createIpcHandler(
      handlerOpts('captureSnapshot'),
      async (options: {
        udid?: string;
        bundleId?: string;
        sessionId: string;
        logDuration?: number;
        includeCrashContent?: boolean;
      }) => {
        return iosTools.captureSnapshot(options);
      }
    )
  );

  // Format snapshot for agent output
  ipcMain.handle(
    'ios:snapshot:format',
    createIpcHandler(
      handlerOpts('formatSnapshot'),
      async (result: iosTools.SnapshotResult) => {
        const formatted = iosTools.formatSnapshotForAgent(result);
        return { success: true, data: formatted };
      }
    )
  );

  // Format snapshot as JSON
  ipcMain.handle(
    'ios:snapshot:formatJson',
    createIpcHandler(
      handlerOpts('formatSnapshotJson'),
      async (result: iosTools.SnapshotResult) => {
        const json = iosTools.formatSnapshotAsJson(result);
        return { success: true, data: json };
      }
    )
  );

  // ==========================================================================
  // Artifact Management
  // ==========================================================================

  // Get artifact directory for session
  ipcMain.handle(
    'ios:artifacts:getDirectory',
    createIpcHandler(handlerOpts('getArtifactDirectory'), async (sessionId: string) => {
      const dir = await iosTools.getArtifactDirectory(sessionId);
      return { success: true, data: dir };
    })
  );

  // List artifacts for session
  ipcMain.handle(
    'ios:artifacts:list',
    createIpcHandler(handlerOpts('listArtifacts'), async (sessionId: string) => {
      const artifacts = await iosTools.listSessionArtifacts(sessionId);
      return { success: true, data: artifacts };
    })
  );

  // Prune old artifacts
  ipcMain.handle(
    'ios:artifacts:prune',
    createIpcHandler(
      handlerOpts('pruneArtifacts'),
      async (sessionId: string, keepCount?: number) => {
        await iosTools.pruneSessionArtifacts(sessionId, keepCount);
        return { success: true };
      }
    )
  );

  // Get artifacts size
  ipcMain.handle(
    'ios:artifacts:size',
    createIpcHandler(handlerOpts('getArtifactsSize'), async (sessionId: string) => {
      const size = await iosTools.getSessionArtifactsSize(sessionId);
      return { success: true, data: size };
    })
  );

  // ==========================================================================
  // UI Inspection
  // ==========================================================================

  // Inspect UI hierarchy
  ipcMain.handle(
    'ios:inspect',
    createIpcHandler(
      handlerOpts('inspect'),
      async (options: {
        udid?: string;
        bundleId?: string;
        sessionId: string;
        captureScreenshot?: boolean;
        timeout?: number;
      }) => {
        return iosTools.inspect(options);
      }
    )
  );

  // Format inspection result for agent
  ipcMain.handle(
    'ios:inspect:format',
    createIpcHandler(
      handlerOpts('formatInspect'),
      async (result: iosTools.InspectResult, options?: iosTools.FormatOptions) => {
        const formatted = iosTools.formatInspectForAgent(result, options);
        return { success: true, data: formatted };
      }
    )
  );

  // Format inspection result as JSON
  ipcMain.handle(
    'ios:inspect:formatJson',
    createIpcHandler(
      handlerOpts('formatInspectJson'),
      async (result: iosTools.InspectResult) => {
        const json = iosTools.formatInspectAsJson(result);
        return { success: true, data: json };
      }
    )
  );

  // Format inspection result as element list
  ipcMain.handle(
    'ios:inspect:formatList',
    createIpcHandler(
      handlerOpts('formatInspectList'),
      async (result: iosTools.InspectResult) => {
        const list = iosTools.formatInspectAsElementList(result);
        return { success: true, data: list };
      }
    )
  );

  // Format inspection result compact
  ipcMain.handle(
    'ios:inspect:formatCompact',
    createIpcHandler(
      handlerOpts('formatInspectCompact'),
      async (result: iosTools.InspectResult) => {
        const compact = iosTools.formatInspectCompact(result);
        return { success: true, data: compact };
      }
    )
  );

  // ==========================================================================
  // UI Analysis
  // ==========================================================================

  // Find elements matching query
  ipcMain.handle(
    'ios:ui:findElements',
    createIpcHandler(
      handlerOpts('findElements'),
      async (tree: iosTools.UIElement, query: iosTools.ElementQuery) => {
        const result = iosTools.findElements(tree, query);
        return { success: true, data: result };
      }
    )
  );

  // Find single element
  ipcMain.handle(
    'ios:ui:findElement',
    createIpcHandler(
      handlerOpts('findElement'),
      async (tree: iosTools.UIElement, query: iosTools.ElementQuery) => {
        const element = iosTools.findElement(tree, query);
        return { success: true, data: element };
      }
    )
  );

  // Find by identifier
  ipcMain.handle(
    'ios:ui:findByIdentifier',
    createIpcHandler(
      handlerOpts('findByIdentifier'),
      async (tree: iosTools.UIElement, identifier: string) => {
        const element = iosTools.findByIdentifier(tree, identifier);
        return { success: true, data: element };
      }
    )
  );

  // Find by label
  ipcMain.handle(
    'ios:ui:findByLabel',
    createIpcHandler(
      handlerOpts('findByLabel'),
      async (tree: iosTools.UIElement, label: string) => {
        const element = iosTools.findByLabel(tree, label);
        return { success: true, data: element };
      }
    )
  );

  // Get interactable elements
  ipcMain.handle(
    'ios:ui:getInteractables',
    createIpcHandler(
      handlerOpts('getInteractables'),
      async (tree: iosTools.UIElement, visibleOnly?: boolean) => {
        const elements = iosTools.getInteractableElements(tree, visibleOnly);
        return { success: true, data: elements };
      }
    )
  );

  // Get buttons
  ipcMain.handle(
    'ios:ui:getButtons',
    createIpcHandler(handlerOpts('getButtons'), async (tree: iosTools.UIElement) => {
      const buttons = iosTools.getButtons(tree);
      return { success: true, data: buttons };
    })
  );

  // Get text fields
  ipcMain.handle(
    'ios:ui:getTextFields',
    createIpcHandler(handlerOpts('getTextFields'), async (tree: iosTools.UIElement) => {
      const fields = iosTools.getTextFields(tree);
      return { success: true, data: fields };
    })
  );

  // Get text elements
  ipcMain.handle(
    'ios:ui:getTextElements',
    createIpcHandler(handlerOpts('getTextElements'), async (tree: iosTools.UIElement) => {
      const texts = iosTools.getTextElements(tree);
      return { success: true, data: texts };
    })
  );

  // Describe element
  ipcMain.handle(
    'ios:ui:describeElement',
    createIpcHandler(handlerOpts('describeElement'), async (element: iosTools.UIElement) => {
      const description = iosTools.describeElement(element);
      return { success: true, data: description };
    })
  );

  // Get best identifier for element
  ipcMain.handle(
    'ios:ui:getBestIdentifier',
    createIpcHandler(
      handlerOpts('getBestIdentifier'),
      async (element: iosTools.UIElement, elements?: iosTools.UIElement[]) => {
        const identifier = iosTools.getBestIdentifier(element, elements);
        return { success: true, data: identifier };
      }
    )
  );

  logger.debug(`${LOG_CONTEXT} iOS IPC handlers registered`);
}
