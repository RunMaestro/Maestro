/**
 * iOS IPC Handlers
 *
 * IPC handlers for iOS tooling operations.
 * Exposes iOS simulator, screenshot, and log functionality to the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import * as iosTools from '../../ios-tools';
import { LogEntry } from '../../ios-tools/types';

const LOG_CONTEXT = '[iOS-IPC]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string) => ({
  context: LOG_CONTEXT,
  operation,
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
    withIpcErrorLogging(handlerOpts('detectXcode'), async () => {
      return iosTools.detectXcode();
    })
  );

  // Get Xcode version
  ipcMain.handle(
    'ios:xcode:version',
    withIpcErrorLogging(handlerOpts('getXcodeVersion'), async () => {
      return iosTools.getXcodeVersion();
    })
  );

  // Get full Xcode info
  ipcMain.handle(
    'ios:xcode:info',
    withIpcErrorLogging(handlerOpts('getXcodeInfo'), async () => {
      return iosTools.getXcodeInfo();
    })
  );

  // Validate Xcode installation
  ipcMain.handle(
    'ios:xcode:validate',
    withIpcErrorLogging(handlerOpts('validateXcode'), async () => {
      return iosTools.validateXcodeInstallation();
    })
  );

  // List iOS SDKs
  ipcMain.handle(
    'ios:xcode:sdks',
    withIpcErrorLogging(handlerOpts('listSDKs'), async () => {
      return iosTools.listSDKs();
    })
  );

  // ==========================================================================
  // Simulator Management
  // ==========================================================================

  // List all simulators
  ipcMain.handle(
    'ios:simulator:list',
    withIpcErrorLogging(handlerOpts('listSimulators'), async () => {
      return iosTools.listSimulators();
    })
  );

  // Get booted simulators
  ipcMain.handle(
    'ios:simulator:booted',
    withIpcErrorLogging(handlerOpts('getBootedSimulators'), async () => {
      return iosTools.getBootedSimulators();
    })
  );

  // Get specific simulator
  ipcMain.handle(
    'ios:simulator:get',
    withIpcErrorLogging(handlerOpts('getSimulator'), async (udid: string) => {
      return iosTools.getSimulator(udid);
    })
  );

  // Boot simulator
  ipcMain.handle(
    'ios:simulator:boot',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('shutdownSimulator'), async (udid: string) => {
      return iosTools.shutdownSimulator(udid);
    })
  );

  // Erase simulator
  ipcMain.handle(
    'ios:simulator:erase',
    withIpcErrorLogging(handlerOpts('eraseSimulator'), async (udid: string) => {
      return iosTools.eraseSimulator(udid);
    })
  );

  // ==========================================================================
  // App Installation & Lifecycle
  // ==========================================================================

  // Install app
  ipcMain.handle(
    'ios:app:install',
    withIpcErrorLogging(handlerOpts('installApp'), async (udid: string, appPath: string) => {
      return iosTools.installApp({ udid, appPath });
    })
  );

  // Uninstall app
  ipcMain.handle(
    'ios:app:uninstall',
    withIpcErrorLogging(handlerOpts('uninstallApp'), async (udid: string, bundleId: string) => {
      return iosTools.uninstallApp(udid, bundleId);
    })
  );

  // Launch app
  ipcMain.handle(
    'ios:app:launch',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('terminateApp'), async (udid: string, bundleId: string) => {
      return iosTools.terminateApp(udid, bundleId);
    })
  );

  // Get app container
  ipcMain.handle(
    'ios:app:container',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('openURL'), async (udid: string, url: string) => {
      return iosTools.openURL(udid, url);
    })
  );

  // ==========================================================================
  // Screenshot & Recording
  // ==========================================================================

  // Capture screenshot
  ipcMain.handle(
    'ios:capture:screenshot',
    withIpcErrorLogging(
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
    withIpcErrorLogging(
      handlerOpts('captureScreenshot'),
      async (udid: string, directory: string, prefix?: string) => {
        return iosTools.captureScreenshot(udid, directory, prefix);
      }
    )
  );

  // Start video recording
  ipcMain.handle(
    'ios:capture:startRecording',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('stopRecording'), async (udid: string) => {
      return iosTools.stopRecording(udid);
    })
  );

  // Check if recording
  ipcMain.handle(
    'ios:capture:isRecording',
    withIpcErrorLogging(handlerOpts('isRecording'), async (udid: string) => {
      return { success: true, data: iosTools.isRecording(udid) };
    })
  );

  // Get screen size
  ipcMain.handle(
    'ios:capture:screenSize',
    withIpcErrorLogging(handlerOpts('getScreenSize'), async (udid: string) => {
      return iosTools.getScreenSize(udid);
    })
  );

  // ==========================================================================
  // Log Collection
  // ==========================================================================

  // Get system logs
  ipcMain.handle(
    'ios:logs:system',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('getSystemLogText'), async (udid: string, since?: string) => {
      return iosTools.getSystemLogText(udid, since);
    })
  );

  // Get crash logs
  ipcMain.handle(
    'ios:logs:crash',
    withIpcErrorLogging(
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
    withIpcErrorLogging(
      handlerOpts('hasRecentCrashes'),
      async (udid: string, bundleId: string, since: string) => {
        return iosTools.hasRecentCrashes(udid, bundleId, new Date(since));
      }
    )
  );

  // Get diagnostics
  ipcMain.handle(
    'ios:logs:diagnostics',
    withIpcErrorLogging(handlerOpts('getDiagnostics'), async (udid: string, outputPath: string) => {
      return iosTools.getDiagnostics(udid, outputPath);
    })
  );

  // Start log streaming
  // Returns the stream ID; log entries are sent via 'ios:logs:stream:data' events
  ipcMain.handle(
    'ios:logs:stream:start',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('stopLogStream'), async (streamId: string) => {
      return iosTools.stopLogStream(streamId);
    })
  );

  // Get active log streams
  ipcMain.handle(
    'ios:logs:stream:active',
    withIpcErrorLogging(handlerOpts('getActiveLogStreams'), async () => {
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
    withIpcErrorLogging(handlerOpts('stopAllLogStreams'), async (udid?: string) => {
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('listSnapshots'), async (sessionId: string) => {
      const snapshots = await iosTools.listSessionArtifacts(sessionId);
      return { success: true, data: snapshots };
    })
  );

  // Cleanup old snapshots (convenience alias for ios:artifacts:prune)
  ipcMain.handle(
    'ios:snapshot:cleanup',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('getArtifactDirectory'), async (sessionId: string) => {
      const dir = await iosTools.getArtifactDirectory(sessionId);
      return { success: true, data: dir };
    })
  );

  // List artifacts for session
  ipcMain.handle(
    'ios:artifacts:list',
    withIpcErrorLogging(handlerOpts('listArtifacts'), async (sessionId: string) => {
      const artifacts = await iosTools.listSessionArtifacts(sessionId);
      return { success: true, data: artifacts };
    })
  );

  // Prune old artifacts
  ipcMain.handle(
    'ios:artifacts:prune',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('getArtifactsSize'), async (sessionId: string) => {
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('getButtons'), async (tree: iosTools.UIElement) => {
      const buttons = iosTools.getButtons(tree);
      return { success: true, data: buttons };
    })
  );

  // Get text fields
  ipcMain.handle(
    'ios:ui:getTextFields',
    withIpcErrorLogging(handlerOpts('getTextFields'), async (tree: iosTools.UIElement) => {
      const fields = iosTools.getTextFields(tree);
      return { success: true, data: fields };
    })
  );

  // Get text elements
  ipcMain.handle(
    'ios:ui:getTextElements',
    withIpcErrorLogging(handlerOpts('getTextElements'), async (tree: iosTools.UIElement) => {
      const texts = iosTools.getTextElements(tree);
      return { success: true, data: texts };
    })
  );

  // Describe element
  ipcMain.handle(
    'ios:ui:describeElement',
    withIpcErrorLogging(handlerOpts('describeElement'), async (element: iosTools.UIElement) => {
      const description = iosTools.describeElement(element);
      return { success: true, data: description };
    })
  );

  // Get best identifier for element
  ipcMain.handle(
    'ios:ui:getBestIdentifier',
    withIpcErrorLogging(
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
    withIpcErrorLogging(handlerOpts('detectMaestroCli'), async () => {
      return iosTools.detectMaestroCli();
    })
  );

  // Quick check if Maestro is available
  ipcMain.handle(
    'ios:maestro:isAvailable',
    withIpcErrorLogging(handlerOpts('isMaestroAvailable'), async () => {
      const available = await iosTools.isMaestroAvailable();
      return { success: true, data: available };
    })
  );

  // Get full Maestro CLI info
  ipcMain.handle(
    'ios:maestro:info',
    withIpcErrorLogging(handlerOpts('getMaestroInfo'), async () => {
      return iosTools.getMaestroInfo();
    })
  );

  // Validate Maestro version meets minimum requirements
  ipcMain.handle(
    'ios:maestro:validateVersion',
    withIpcErrorLogging(handlerOpts('validateMaestroVersion'), async (minVersion: string) => {
      return iosTools.validateMaestroVersion(minVersion);
    })
  );

  // Get installation instructions
  ipcMain.handle(
    'ios:maestro:installInstructions',
    withIpcErrorLogging(handlerOpts('getInstallInstructions'), async () => {
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
    withIpcErrorLogging(
      handlerOpts('generateFlow'),
      async (steps: iosTools.FlowStep[], config?: iosTools.FlowConfig) => {
        return iosTools.generateFlow(steps, config);
      }
    )
  );

  // Generate and save flow to file
  ipcMain.handle(
    'ios:flow:generateFile',
    withIpcErrorLogging(
      handlerOpts('generateFlowFile'),
      async (steps: iosTools.FlowStep[], outputPath: string, config?: iosTools.FlowConfig) => {
        return iosTools.generateFlowFile(steps, outputPath, config);
      }
    )
  );

  // Generate flow from action strings
  ipcMain.handle(
    'ios:flow:generateFromStrings',
    withIpcErrorLogging(
      handlerOpts('generateFlowFromStrings'),
      async (actions: string[], config?: iosTools.FlowConfig) => {
        return iosTools.generateFlowFromStrings(actions, config);
      }
    )
  );

  // Parse a single action string
  ipcMain.handle(
    'ios:flow:parseAction',
    withIpcErrorLogging(handlerOpts('parseActionString'), async (actionString: string) => {
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
    withIpcErrorLogging(
      handlerOpts('runFlow'),
      async (options: iosTools.FlowRunOptions) => {
        return iosTools.runFlow(options);
      }
    )
  );

  // Run a flow with retry support
  ipcMain.handle(
    'ios:flow:runWithRetry',
    withIpcErrorLogging(
      handlerOpts('runFlowWithRetry'),
      async (options: iosTools.FlowRunWithRetryOptions) => {
        return iosTools.runFlowWithRetry(options);
      }
    )
  );

  // Run multiple flows in sequence
  ipcMain.handle(
    'ios:flow:runBatch',
    withIpcErrorLogging(
      handlerOpts('runFlows'),
      async (flowPaths: string[], options: Omit<iosTools.FlowRunOptions, 'flowPath'>) => {
        return iosTools.runFlows(flowPaths, options);
      }
    )
  );

  // Validate a flow file
  ipcMain.handle(
    'ios:flow:validate',
    withIpcErrorLogging(handlerOpts('validateFlow'), async (flowPath: string) => {
      return iosTools.validateFlow(flowPath);
    })
  );

  // Validate a flow file using Maestro CLI
  ipcMain.handle(
    'ios:flow:validateWithMaestro',
    withIpcErrorLogging(handlerOpts('validateFlowWithMaestro'), async (flowPath: string) => {
      return iosTools.validateFlowWithMaestro(flowPath);
    })
  );

  // ==========================================================================
  // Flow Result Formatting
  // ==========================================================================

  // Format flow result for agent output
  ipcMain.handle(
    'ios:flow:formatResult',
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
      handlerOpts('assertVisible'),
      async (options: iosTools.AssertVisibleOptions) => {
        return iosTools.assertVisible(options);
      }
    )
  );

  // Assert element is visible by identifier
  ipcMain.handle(
    'ios:assert:visibleById',
    withIpcErrorLogging(
      handlerOpts('assertVisibleById'),
      async (identifier: string, options: Omit<iosTools.AssertVisibleOptions, 'target'>) => {
        return iosTools.assertVisibleById(identifier, options);
      }
    )
  );

  // Assert element is visible by label
  ipcMain.handle(
    'ios:assert:visibleByLabel',
    withIpcErrorLogging(
      handlerOpts('assertVisibleByLabel'),
      async (label: string, options: Omit<iosTools.AssertVisibleOptions, 'target'>) => {
        return iosTools.assertVisibleByLabel(label, options);
      }
    )
  );

  // Assert element is visible by text
  ipcMain.handle(
    'ios:assert:visibleByText',
    withIpcErrorLogging(
      handlerOpts('assertVisibleByText'),
      async (text: string, options: Omit<iosTools.AssertVisibleOptions, 'target'>) => {
        return iosTools.assertVisibleByText(text, options);
      }
    )
  );

  // Assert element is NOT visible
  ipcMain.handle(
    'ios:assert:notVisible',
    withIpcErrorLogging(
      handlerOpts('assertNotVisible'),
      async (options: iosTools.AssertVisibleOptions) => {
        return iosTools.assertNotVisible(options);
      }
    )
  );

  // Assert no crash for app
  ipcMain.handle(
    'ios:assert:noCrash',
    withIpcErrorLogging(
      handlerOpts('assertNoCrash'),
      async (options: iosTools.AssertNoCrashOptions) => {
        return iosTools.assertNoCrash(options);
      }
    )
  );

  // Quick check if app has crashed
  ipcMain.handle(
    'ios:assert:hasCrashed',
    withIpcErrorLogging(
      handlerOpts('hasCrashed'),
      async (bundleId: string, udid: string, since: string) => {
        return iosTools.hasCrashed(bundleId, udid, new Date(since));
      }
    )
  );

  // Wait for app to not crash for duration
  ipcMain.handle(
    'ios:assert:waitForNoCrash',
    withIpcErrorLogging(
      handlerOpts('waitForNoCrash'),
      async (options: iosTools.AssertNoCrashOptions & { monitorDuration: number }) => {
        return iosTools.waitForNoCrash(options);
      }
    )
  );

  // Format verification result for agent
  ipcMain.handle(
    'ios:verify:formatResult',
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
      handlerOpts('runShipLoop'),
      async (options: iosTools.ShipLoopOptions) => {
        return iosTools.runShipLoop(options);
      }
    )
  );

  // Format ship loop result for agent output
  ipcMain.handle(
    'ios:shipLoop:formatResult',
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
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
    withIpcErrorLogging(
      handlerOpts('runTests'),
      async (options: iosTools.TestRunOptions) => {
        return iosTools.runTests(options);
      }
    )
  );

  // Run XCUITest UI tests
  ipcMain.handle(
    'ios:test:runUI',
    withIpcErrorLogging(
      handlerOpts('runUITests'),
      async (options: iosTools.TestRunOptions) => {
        return iosTools.runUITests(options);
      }
    )
  );

  // Parse test results from xcresult bundle
  ipcMain.handle(
    'ios:test:parseResults',
    withIpcErrorLogging(
      handlerOpts('parseTestResults'),
      async (resultBundlePath: string) => {
        return iosTools.parseTestResults(resultBundlePath);
      }
    )
  );

  // List available tests in a project
  ipcMain.handle(
    'ios:test:list',
    withIpcErrorLogging(
      handlerOpts('listTests'),
      async (projectPath: string, scheme: string) => {
        return iosTools.listTests(projectPath, scheme);
      }
    )
  );

  // ==========================================================================
  // XCUITest-based UI Inspection
  // ==========================================================================

  // Run XCUITest-based inspection (more detailed than simple inspect)
  ipcMain.handle(
    'ios:inspect:run',
    withIpcErrorLogging(
      handlerOpts('inspectWithXCUITest'),
      async (options: iosTools.XCUITestInspectOptions) => {
        return iosTools.inspectWithXCUITest(options);
      }
    )
  );

  // Find element in XCUITest inspection result
  // Takes the rootElement from XCUITestInspectResult and a query
  ipcMain.handle(
    'ios:inspect:findElement',
    withIpcErrorLogging(
      handlerOpts('inspectFindElement'),
      async (
        rootElement: iosTools.ElementNode,
        query: {
          identifier?: string;
          label?: string;
          type?: string;
          value?: string;
          containsText?: string;
        }
      ) => {
        // Convert ElementNode tree to UIElement tree for ui-analyzer functions
        const uiElement = convertElementNodeToUIElement(rootElement);
        const element = iosTools.findElement(uiElement, query);
        return { success: true, data: element };
      }
    )
  );

  // Get interactable elements from XCUITest inspection result
  ipcMain.handle(
    'ios:inspect:getInteractable',
    withIpcErrorLogging(
      handlerOpts('inspectGetInteractable'),
      async (rootElement: iosTools.ElementNode, visibleOnly?: boolean) => {
        // Convert ElementNode tree to UIElement tree for ui-analyzer functions
        const uiElement = convertElementNodeToUIElement(rootElement);
        const elements = iosTools.getInteractableElements(uiElement, visibleOnly);
        return { success: true, data: elements };
      }
    )
  );

  // Format XCUITest inspection result for agent
  ipcMain.handle(
    'ios:inspect:formatXCUITest',
    withIpcErrorLogging(
      handlerOpts('formatXCUITestInspect'),
      async (result: iosTools.XCUITestInspectResult, options?: iosTools.FormatOptions) => {
        // Convert XCUITestInspectResult to InspectResult for formatting
        const inspectResult = convertXCUITestToInspectResult(result);
        const formatted = iosTools.formatInspectForAgent(inspectResult, options);
        return { success: true, data: formatted };
      }
    )
  );

  // Detect accessibility issues in XCUITest inspection result
  ipcMain.handle(
    'ios:inspect:detectIssues',
    withIpcErrorLogging(
      handlerOpts('detectAccessibilityIssues'),
      async (rootElement: iosTools.ElementNode) => {
        // Convert ElementNode tree to UIElement tree for ui-analyzer functions
        const uiElement = convertElementNodeToUIElement(rootElement);
        const issues = iosTools.detectIssues(uiElement);
        return { success: true, data: issues };
      }
    )
  );

  // Summarize screen from XCUITest inspection result
  ipcMain.handle(
    'ios:inspect:summarizeScreen',
    withIpcErrorLogging(
      handlerOpts('summarizeScreen'),
      async (rootElement: iosTools.ElementNode) => {
        // Convert ElementNode tree to UIElement tree for ui-analyzer functions
        const uiElement = convertElementNodeToUIElement(rootElement);
        const summary = iosTools.summarizeScreen(uiElement);
        return { success: true, data: summary };
      }
    )
  );

  // ==========================================================================
  // Slash Command Handlers
  // ==========================================================================

  // Execute /ios.snapshot slash command
  ipcMain.handle(
    'ios:slashCommand:snapshot',
    withIpcErrorLogging(
      handlerOpts('executeSnapshotCommand'),
      async (commandText: string, sessionId: string) => {
        const { executeSnapshotCommand } = await import('../../slash-commands/ios-snapshot');
        return executeSnapshotCommand(commandText, sessionId);
      }
    )
  );

  // Execute /ios.inspect slash command
  ipcMain.handle(
    'ios:slashCommand:inspect',
    withIpcErrorLogging(
      handlerOpts('executeInspectCommand'),
      async (commandText: string, sessionId: string) => {
        const { executeInspectCommand } = await import('../../slash-commands/ios-inspect');
        return executeInspectCommand(commandText, sessionId);
      }
    )
  );

  // Execute /ios.run_flow slash command
  ipcMain.handle(
    'ios:slashCommand:runFlow',
    withIpcErrorLogging(
      handlerOpts('executeRunFlowCommand'),
      async (commandText: string, sessionId: string, cwd?: string) => {
        const { executeRunFlowCommand } = await import('../../slash-commands/ios-run-flow');
        return executeRunFlowCommand(commandText, sessionId, cwd);
      }
    )
  );

  // Execute /ios.tap slash command
  ipcMain.handle(
    'ios:slashCommand:tap',
    withIpcErrorLogging(
      handlerOpts('executeTapCommand'),
      async (commandText: string, sessionId: string, cwd?: string) => {
        const { executeTapCommand } = await import('../../slash-commands/ios-tap');
        return executeTapCommand(commandText, sessionId, cwd);
      }
    )
  );

  // Execute /ios.type slash command
  ipcMain.handle(
    'ios:slashCommand:type',
    withIpcErrorLogging(
      handlerOpts('executeTypeCommand'),
      async (commandText: string, sessionId: string, cwd?: string) => {
        const { executeTypeCommand } = await import('../../slash-commands/ios-type');
        return executeTypeCommand(commandText, sessionId, cwd);
      }
    )
  );

  // Execute /ios.scroll slash command
  ipcMain.handle(
    'ios:slashCommand:scroll',
    withIpcErrorLogging(
      handlerOpts('executeScrollCommand'),
      async (commandText: string, sessionId: string, cwd?: string) => {
        const { executeScrollCommand } = await import('../../slash-commands/ios-scroll');
        return executeScrollCommand(commandText, sessionId, cwd);
      }
    )
  );

  // Execute /ios.swipe slash command
  ipcMain.handle(
    'ios:slashCommand:swipe',
    withIpcErrorLogging(
      handlerOpts('executeSwipeCommand'),
      async (commandText: string, sessionId: string, cwd?: string) => {
        const { executeSwipeCommand } = await import('../../slash-commands/ios-swipe');
        return executeSwipeCommand(commandText, sessionId, cwd);
      }
    )
  );

  // ==========================================================================
  // Native Driver Actions
  // ==========================================================================

  // Execute tap action via native driver
  ipcMain.handle(
    'ios:action:tap',
    withIpcErrorLogging(
      handlerOpts('actionTap'),
      async (options: {
        bundleId: string;
        udid?: string;
        target: iosTools.NativeActionTarget;
        double?: boolean;
        long?: boolean;
        longDuration?: number;
        offsetX?: number;
        offsetY?: number;
        timeout?: number;
        screenshotDir?: string;
        debug?: boolean;
      }) => {
        const driver = iosTools.createNativeDriver({
          bundleId: options.bundleId,
          udid: options.udid,
          timeout: options.timeout,
          screenshotDir: options.screenshotDir,
          debug: options.debug,
        });

        // Choose the appropriate tap variant
        let action: iosTools.NativeActionRequest;
        if (options.double) {
          action = iosTools.nativeDoubleTap(options.target);
        } else if (options.long) {
          action = iosTools.nativeLongPress(options.target, options.longDuration ?? 1.0);
        } else {
          action = iosTools.nativeTap(options.target, {
            offsetX: options.offsetX,
            offsetY: options.offsetY,
          });
        }

        return driver.execute(action);
      }
    )
  );

  // Execute type action via native driver
  ipcMain.handle(
    'ios:action:type',
    withIpcErrorLogging(
      handlerOpts('actionType'),
      async (options: {
        bundleId: string;
        udid?: string;
        text: string;
        target?: iosTools.NativeActionTarget;
        clearFirst?: boolean;
        timeout?: number;
        screenshotDir?: string;
        debug?: boolean;
      }) => {
        const driver = iosTools.createNativeDriver({
          bundleId: options.bundleId,
          udid: options.udid,
          timeout: options.timeout,
          screenshotDir: options.screenshotDir,
          debug: options.debug,
        });

        const action = iosTools.nativeTypeText(options.text, {
          target: options.target,
          clearFirst: options.clearFirst,
        });

        return driver.execute(action);
      }
    )
  );

  // Execute scroll action via native driver
  ipcMain.handle(
    'ios:action:scroll',
    withIpcErrorLogging(
      handlerOpts('actionScroll'),
      async (options: {
        bundleId: string;
        udid?: string;
        direction?: iosTools.NativeSwipeDirection;
        distance?: number;
        target?: iosTools.NativeActionTarget;
        scrollToTarget?: iosTools.NativeActionTarget;
        maxAttempts?: number;
        timeout?: number;
        screenshotDir?: string;
        debug?: boolean;
      }) => {
        const driver = iosTools.createNativeDriver({
          bundleId: options.bundleId,
          udid: options.udid,
          timeout: options.timeout,
          screenshotDir: options.screenshotDir,
          debug: options.debug,
        });

        // Either scroll to a target element or scroll in a direction
        let action: iosTools.NativeActionRequest;
        if (options.scrollToTarget) {
          action = iosTools.nativeScrollTo(options.scrollToTarget, {
            direction: options.direction,
            maxAttempts: options.maxAttempts,
          });
        } else {
          action = iosTools.nativeScroll(options.direction || 'down', {
            target: options.target,
            distance: options.distance,
          });
        }

        return driver.execute(action);
      }
    )
  );

  // Execute swipe action via native driver
  ipcMain.handle(
    'ios:action:swipe',
    withIpcErrorLogging(
      handlerOpts('actionSwipe'),
      async (options: {
        bundleId: string;
        udid?: string;
        direction: iosTools.NativeSwipeDirection;
        target?: iosTools.NativeActionTarget;
        velocity?: iosTools.NativeSwipeVelocity;
        timeout?: number;
        screenshotDir?: string;
        debug?: boolean;
      }) => {
        const driver = iosTools.createNativeDriver({
          bundleId: options.bundleId,
          udid: options.udid,
          timeout: options.timeout,
          screenshotDir: options.screenshotDir,
          debug: options.debug,
        });

        const action = iosTools.nativeSwipe(options.direction, {
          target: options.target,
          velocity: options.velocity,
        });

        return driver.execute(action);
      }
    )
  );

  // Execute wait action via native driver
  ipcMain.handle(
    'ios:action:wait',
    withIpcErrorLogging(
      handlerOpts('actionWait'),
      async (options: {
        bundleId: string;
        udid?: string;
        target: iosTools.NativeActionTarget;
        waitForNotExist?: boolean;
        timeout?: number;
        screenshotDir?: string;
        debug?: boolean;
      }) => {
        const driver = iosTools.createNativeDriver({
          bundleId: options.bundleId,
          udid: options.udid,
          timeout: options.timeout,
          screenshotDir: options.screenshotDir,
          debug: options.debug,
        });

        const action = options.waitForNotExist
          ? iosTools.nativeWaitForNotExist(options.target, options.timeout)
          : iosTools.nativeWaitForElement(options.target, options.timeout);

        return driver.execute(action);
      }
    )
  );

  logger.debug(`${LOG_CONTEXT} iOS IPC handlers registered`);
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert ElementNode (from XCUITest inspection) to UIElement (for ui-analyzer).
 * This allows using the ui-analyzer functions with XCUITest inspection results.
 */
function convertElementNodeToUIElement(node: iosTools.ElementNode): iosTools.UIElement {
  return {
    type: node.type,
    identifier: node.identifier,
    label: node.label,
    value: node.value,
    placeholder: node.placeholderValue,
    frame: {
      x: node.frame.x,
      y: node.frame.y,
      width: node.frame.width,
      height: node.frame.height,
    },
    visible: node.isVisible,
    enabled: node.isEnabled,
    traits: node.traits,
    children: node.children.map(convertElementNodeToUIElement),
  };
}

/**
 * Convert XCUITestInspectResult to InspectResult for formatting.
 * This allows using the format functions with XCUITest inspection results.
 */
function convertXCUITestToInspectResult(result: iosTools.XCUITestInspectResult): iosTools.InspectResult {
  // Recursively convert ElementNode tree to UIElement tree
  const tree = convertElementNodeToUIElement(result.rootElement);

  // Flatten the tree to get all elements
  const elements: iosTools.UIElement[] = [];
  function collectElements(el: iosTools.UIElement) {
    elements.push(el);
    for (const child of el.children) {
      collectElements(child);
    }
  }
  collectElements(tree);

  return {
    id: result.id,
    timestamp: result.timestamp,
    simulator: result.simulator,
    tree,
    elements,
    stats: {
      totalElements: result.summary.totalElements,
      interactableElements: result.summary.interactableElements,
      buttons: result.summary.buttons,
      textFields: result.summary.textInputs,
      textElements: result.summary.textElements,
      images: result.summary.images,
    },
    screenshot: result.screenshotPath
      ? {
          path: result.screenshotPath,
          size: 0, // Size not available from XCUITest result
        }
      : undefined,
    artifactDir: result.artifactDir,
  };
}
