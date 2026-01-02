/**
 * iOS IPC Handlers
 *
 * IPC handlers for iOS tooling operations.
 * Exposes iOS simulator, screenshot, and log functionality to the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import * as iosTools from '../../ios-tools';
import { LogEntry } from '../../ios-tools/types';

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

  // Start log streaming
  // Returns the stream ID; log entries are sent via 'ios:logs:stream:data' events
  ipcMain.handle(
    'ios:logs:stream:start',
    createIpcHandler(
      handlerOpts('streamLog'),
      async (
        udid: string,
        options?: {
          level?: 'default' | 'info' | 'debug' | 'error' | 'fault';
          process?: string;
          predicate?: string;
          subsystem?: string;
        }
      ) => {
        const mainWindow = BrowserWindow.getAllWindows()[0];

        const result = await iosTools.streamLog(
          {
            udid,
            ...options,
          },
          // onLog callback - send to renderer
          (entry: LogEntry) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('ios:logs:stream:data', result.data?.id, entry);
            }
          },
          // onError callback - send to renderer
          (error: string) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('ios:logs:stream:error', result.data?.id, error);
            }
          }
        );

        if (!result.success) {
          return result;
        }

        // Return just the stream ID (handle methods aren't serializable)
        return {
          success: true,
          data: { id: result.data!.id },
        };
      }
    )
  );

  // Stop log streaming
  ipcMain.handle(
    'ios:logs:stream:stop',
    createIpcHandler(handlerOpts('stopLogStream'), async (streamId: string) => {
      return iosTools.stopLogStream(streamId);
    })
  );

  // Get active log streams
  ipcMain.handle(
    'ios:logs:stream:active',
    createIpcHandler(handlerOpts('getActiveLogStreams', false), async () => {
      const streams = iosTools.getActiveLogStreams();
      // Convert Map to object for serialization
      const result: Record<string, string> = {};
      for (const [id, udid] of streams) {
        result[id] = udid;
      }
      return { success: true, data: result };
    })
  );

  // Stop all log streams (optionally for a specific simulator)
  ipcMain.handle(
    'ios:logs:stream:stopAll',
    createIpcHandler(handlerOpts('stopAllLogStreams'), async (udid?: string) => {
      const count = iosTools.stopAllLogStreams(udid);
      return { success: true, data: count };
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

  // List snapshots for a session (convenience alias for ios:artifacts:list)
  ipcMain.handle(
    'ios:snapshot:list',
    createIpcHandler(handlerOpts('listSnapshots'), async (sessionId: string) => {
      const snapshots = await iosTools.listSessionArtifacts(sessionId);
      return { success: true, data: snapshots };
    })
  );

  // Cleanup old snapshots (convenience alias for ios:artifacts:prune)
  ipcMain.handle(
    'ios:snapshot:cleanup',
    createIpcHandler(
      handlerOpts('cleanupSnapshots'),
      async (sessionId: string, keepCount?: number) => {
        await iosTools.pruneSessionArtifacts(sessionId, keepCount);
        return { success: true };
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

  // ==========================================================================
  // Maestro CLI
  // ==========================================================================

  // Detect Maestro CLI installation
  ipcMain.handle(
    'ios:maestro:detect',
    createIpcHandler(handlerOpts('detectMaestroCli'), async () => {
      return iosTools.detectMaestroCli();
    })
  );

  // Quick check if Maestro is available
  ipcMain.handle(
    'ios:maestro:isAvailable',
    createIpcHandler(handlerOpts('isMaestroAvailable', false), async () => {
      const available = await iosTools.isMaestroAvailable();
      return { success: true, data: available };
    })
  );

  // Get full Maestro CLI info
  ipcMain.handle(
    'ios:maestro:info',
    createIpcHandler(handlerOpts('getMaestroInfo'), async () => {
      return iosTools.getMaestroInfo();
    })
  );

  // Validate Maestro version meets minimum requirements
  ipcMain.handle(
    'ios:maestro:validateVersion',
    createIpcHandler(handlerOpts('validateMaestroVersion'), async (minVersion: string) => {
      return iosTools.validateMaestroVersion(minVersion);
    })
  );

  // Get installation instructions
  ipcMain.handle(
    'ios:maestro:installInstructions',
    createIpcHandler(handlerOpts('getInstallInstructions', false), async () => {
      const instructions = iosTools.getInstallInstructions();
      return { success: true, data: instructions };
    })
  );

  // ==========================================================================
  // Flow Generation
  // ==========================================================================

  // Generate flow YAML from steps
  ipcMain.handle(
    'ios:flow:generate',
    createIpcHandler(
      handlerOpts('generateFlow'),
      async (steps: iosTools.FlowStep[], config?: iosTools.FlowConfig) => {
        return iosTools.generateFlow(steps, config);
      }
    )
  );

  // Generate and save flow to file
  ipcMain.handle(
    'ios:flow:generateFile',
    createIpcHandler(
      handlerOpts('generateFlowFile'),
      async (steps: iosTools.FlowStep[], outputPath: string, config?: iosTools.FlowConfig) => {
        return iosTools.generateFlowFile(steps, outputPath, config);
      }
    )
  );

  // Generate flow from action strings
  ipcMain.handle(
    'ios:flow:generateFromStrings',
    createIpcHandler(
      handlerOpts('generateFlowFromStrings'),
      async (actions: string[], config?: iosTools.FlowConfig) => {
        return iosTools.generateFlowFromStrings(actions, config);
      }
    )
  );

  // Parse a single action string
  ipcMain.handle(
    'ios:flow:parseAction',
    createIpcHandler(handlerOpts('parseActionString', false), async (actionString: string) => {
      const step = iosTools.parseActionString(actionString);
      return { success: true, data: step };
    })
  );

  // ==========================================================================
  // Flow Runner
  // ==========================================================================

  // Run a Maestro flow
  ipcMain.handle(
    'ios:flow:run',
    createIpcHandler(
      handlerOpts('runFlow'),
      async (options: iosTools.FlowRunOptions) => {
        return iosTools.runFlow(options);
      }
    )
  );

  // Run a flow with retry support
  ipcMain.handle(
    'ios:flow:runWithRetry',
    createIpcHandler(
      handlerOpts('runFlowWithRetry'),
      async (options: iosTools.FlowRunWithRetryOptions) => {
        return iosTools.runFlowWithRetry(options);
      }
    )
  );

  // Run multiple flows in sequence
  ipcMain.handle(
    'ios:flow:runBatch',
    createIpcHandler(
      handlerOpts('runFlows'),
      async (flowPaths: string[], options: Omit<iosTools.FlowRunOptions, 'flowPath'>) => {
        return iosTools.runFlows(flowPaths, options);
      }
    )
  );

  // Validate a flow file
  ipcMain.handle(
    'ios:flow:validate',
    createIpcHandler(handlerOpts('validateFlow'), async (flowPath: string) => {
      return iosTools.validateFlow(flowPath);
    })
  );

  // Validate a flow file using Maestro CLI
  ipcMain.handle(
    'ios:flow:validateWithMaestro',
    createIpcHandler(handlerOpts('validateFlowWithMaestro'), async (flowPath: string) => {
      return iosTools.validateFlowWithMaestro(flowPath);
    })
  );

  // ==========================================================================
  // Flow Result Formatting
  // ==========================================================================

  // Format flow result for agent output
  ipcMain.handle(
    'ios:flow:formatResult',
    createIpcHandler(
      handlerOpts('formatFlowResult'),
      async (result: iosTools.FlowRunResult, options?: iosTools.FlowFormatOptions) => {
        const formatted = iosTools.formatFlowResult(result, options);
        return { success: true, data: formatted };
      }
    )
  );

  // Format flow result as JSON
  ipcMain.handle(
    'ios:flow:formatResultJson',
    createIpcHandler(
      handlerOpts('formatFlowResultAsJson'),
      async (result: iosTools.FlowRunResult) => {
        const json = iosTools.formatFlowResultAsJson(result);
        return { success: true, data: json };
      }
    )
  );

  // Format flow result compact
  ipcMain.handle(
    'ios:flow:formatResultCompact',
    createIpcHandler(
      handlerOpts('formatFlowResultCompact'),
      async (result: iosTools.FlowRunResult) => {
        const compact = iosTools.formatFlowResultCompact(result);
        return { success: true, data: compact };
      }
    )
  );

  // Format batch flow result
  ipcMain.handle(
    'ios:flow:formatBatchResult',
    createIpcHandler(
      handlerOpts('formatBatchFlowResult'),
      async (result: iosTools.BatchFlowResult, options?: iosTools.FlowFormatOptions) => {
        const formatted = iosTools.formatBatchFlowResult(result, options);
        return { success: true, data: formatted };
      }
    )
  );

  // ==========================================================================
  // Verification & Assertions
  // ==========================================================================

  // Assert element is visible
  ipcMain.handle(
    'ios:assert:visible',
    createIpcHandler(
      handlerOpts('assertVisible'),
      async (options: iosTools.AssertVisibleOptions) => {
        return iosTools.assertVisible(options);
      }
    )
  );

  // Assert element is visible by identifier
  ipcMain.handle(
    'ios:assert:visibleById',
    createIpcHandler(
      handlerOpts('assertVisibleById'),
      async (identifier: string, options: Omit<iosTools.AssertVisibleOptions, 'target'>) => {
        return iosTools.assertVisibleById(identifier, options);
      }
    )
  );

  // Assert element is visible by label
  ipcMain.handle(
    'ios:assert:visibleByLabel',
    createIpcHandler(
      handlerOpts('assertVisibleByLabel'),
      async (label: string, options: Omit<iosTools.AssertVisibleOptions, 'target'>) => {
        return iosTools.assertVisibleByLabel(label, options);
      }
    )
  );

  // Assert element is visible by text
  ipcMain.handle(
    'ios:assert:visibleByText',
    createIpcHandler(
      handlerOpts('assertVisibleByText'),
      async (text: string, options: Omit<iosTools.AssertVisibleOptions, 'target'>) => {
        return iosTools.assertVisibleByText(text, options);
      }
    )
  );

  // Assert element is NOT visible
  ipcMain.handle(
    'ios:assert:notVisible',
    createIpcHandler(
      handlerOpts('assertNotVisible'),
      async (options: iosTools.AssertVisibleOptions) => {
        return iosTools.assertNotVisible(options);
      }
    )
  );

  // Assert no crash for app
  ipcMain.handle(
    'ios:assert:noCrash',
    createIpcHandler(
      handlerOpts('assertNoCrash'),
      async (options: iosTools.AssertNoCrashOptions) => {
        return iosTools.assertNoCrash(options);
      }
    )
  );

  // Quick check if app has crashed
  ipcMain.handle(
    'ios:assert:hasCrashed',
    createIpcHandler(
      handlerOpts('hasCrashed'),
      async (bundleId: string, udid: string, since: string) => {
        return iosTools.hasCrashed(bundleId, udid, new Date(since));
      }
    )
  );

  // Wait for app to not crash for duration
  ipcMain.handle(
    'ios:assert:waitForNoCrash',
    createIpcHandler(
      handlerOpts('waitForNoCrash'),
      async (options: iosTools.AssertNoCrashOptions & { monitorDuration: number }) => {
        return iosTools.waitForNoCrash(options);
      }
    )
  );

  // Format verification result for agent
  ipcMain.handle(
    'ios:verify:formatResult',
    createIpcHandler(
      handlerOpts('formatVerificationResult'),
      async (result: iosTools.VerificationResult, options?: iosTools.VerificationFormatOptions) => {
        const formatted = iosTools.formatVerificationResult(result, options);
        return { success: true, data: formatted };
      }
    )
  );

  // Format verification result as JSON
  ipcMain.handle(
    'ios:verify:formatResultJson',
    createIpcHandler(
      handlerOpts('formatVerificationAsJson'),
      async (result: iosTools.VerificationResult) => {
        const json = iosTools.formatVerificationAsJson(result);
        return { success: true, data: json };
      }
    )
  );

  // Format verification result compact
  ipcMain.handle(
    'ios:verify:formatResultCompact',
    createIpcHandler(
      handlerOpts('formatVerificationCompact'),
      async (result: iosTools.VerificationResult) => {
        const compact = iosTools.formatVerificationCompact(result);
        return { success: true, data: compact };
      }
    )
  );

  // Format batch verification results
  ipcMain.handle(
    'ios:verify:formatBatch',
    createIpcHandler(
      handlerOpts('formatVerificationBatch'),
      async (results: iosTools.VerificationResult[], options?: iosTools.VerificationFormatOptions) => {
        const formatted = iosTools.formatVerificationBatch(results, options);
        return { success: true, data: formatted };
      }
    )
  );

  // ==========================================================================
  // Feature Ship Loop
  // ==========================================================================

  // Run the Feature Ship Loop
  ipcMain.handle(
    'ios:shipLoop:run',
    createIpcHandler(
      handlerOpts('runShipLoop'),
      async (options: iosTools.ShipLoopOptions) => {
        return iosTools.runShipLoop(options);
      }
    )
  );

  // Format ship loop result for agent output
  ipcMain.handle(
    'ios:shipLoop:formatResult',
    createIpcHandler(
      handlerOpts('formatShipLoopResult'),
      async (result: iosTools.ShipLoopResult) => {
        const formatted = iosTools.formatShipLoopResult(result);
        return { success: true, data: formatted };
      }
    )
  );

  // Format ship loop result as JSON
  ipcMain.handle(
    'ios:shipLoop:formatResultJson',
    createIpcHandler(
      handlerOpts('formatShipLoopResultAsJson'),
      async (result: iosTools.ShipLoopResult) => {
        const json = iosTools.formatShipLoopResultAsJson(result);
        return { success: true, data: json };
      }
    )
  );

  // Format ship loop result compact
  ipcMain.handle(
    'ios:shipLoop:formatResultCompact',
    createIpcHandler(
      handlerOpts('formatShipLoopResultCompact'),
      async (result: iosTools.ShipLoopResult) => {
        const compact = iosTools.formatShipLoopResultCompact(result);
        return { success: true, data: compact };
      }
    )
  );

  // ==========================================================================
  // Test Execution
  // ==========================================================================

  // Run XCTest unit tests
  ipcMain.handle(
    'ios:test:run',
    createIpcHandler(
      handlerOpts('runTests'),
      async (options: iosTools.TestRunOptions) => {
        return iosTools.runTests(options);
      }
    )
  );

  // Run XCUITest UI tests
  ipcMain.handle(
    'ios:test:runUI',
    createIpcHandler(
      handlerOpts('runUITests'),
      async (options: iosTools.TestRunOptions) => {
        return iosTools.runUITests(options);
      }
    )
  );

  // Parse test results from xcresult bundle
  ipcMain.handle(
    'ios:test:parseResults',
    createIpcHandler(
      handlerOpts('parseTestResults'),
      async (resultBundlePath: string) => {
        return iosTools.parseTestResults(resultBundlePath);
      }
    )
  );

  // List available tests in a project
  ipcMain.handle(
    'ios:test:list',
    createIpcHandler(
      handlerOpts('listTests'),
      async (projectPath: string, scheme: string) => {
        return iosTools.listTests(projectPath, scheme);
      }
    )
  );

  logger.debug(`${LOG_CONTEXT} iOS IPC handlers registered`);
}
