# Phase 3: ios.interact - The Remote Finger

**Goal**: Enable the AI agent to drive the iOS UI - tapping, typing, scrolling, and navigating through screens.

**Deliverable**: Two interaction paths: (1) YAML-based flows via mobile-dev-inc Maestro Mobile, (2) Direct XCUITest primitives.

**Dependency**: Phase 0 (ios-tools), Phase 2 (ios.inspect for element targeting)

---

## Naming Convention: Avoiding Confusion

**IMPORTANT**: The mobile-dev-inc iOS testing tool is also called "Maestro" - same name as our app. To avoid confusion in code:

| External Tool | Our App |
|---------------|---------|
| "Maestro Mobile" or "MaestroMobile" | "Maestro" (unchanged) |
| `maestro-mobile-cli.ts` | N/A |
| `MaestroMobileFlow` | `AutoRunFlow` |
| `detectMaestroMobileCli()` | N/A |
| `runMaestroMobileFlow()` | N/A |

In comments/docs, always use "Maestro Mobile (mobile-dev-inc)" when referring to the external tool.

---

## Path A: Maestro Mobile Integration (Recommended First)

### Maestro Mobile CLI Detection & Setup

- [x] Create `src/main/ios-tools/maestro-cli.ts` - Maestro Mobile CLI wrapper
  - Note: Implemented as `maestro-cli.ts` (not `maestro-mobile-cli.ts`) to avoid confusion with our app name. See naming convention above.
  - [x] Implement `detectMaestroCli()` - find maestro binary
  - [x] Implement `getMaestroInfo()` - get installed version (includes version in MaestroInfo)
  - [x] Implement `isMaestroAvailable()` - quick availability check
  - [x] Implement `installMaestro()` - run installation if missing
    - [x] Support Homebrew installation: `brew tap mobile-dev-inc/tap && brew install maestro`
    - [x] Support curl installation via download and bash script
  - [x] Implement `validateMaestroSetup()` - check iOS driver works
  - [x] Unit tests in `src/__tests__/main/ios-tools/maestro-cli.test.ts` (18 tests)

### Flow Generation

- [x] Create `src/main/ios-tools/flow-generator.ts` - generate Maestro Mobile YAML
  - Note: Implemented as `flow-generator.ts` (not `mobile-flow-generator.ts`)
  - [x] Implement `FlowStep` union type with comprehensive action types:
    - TapStep, InputTextStep, ScrollStep, SwipeStep, ScreenshotStep
    - AssertVisibleStep, AssertNotVisibleStep, WaitForStep, WaitStep
    - LaunchAppStep, StopAppStep, OpenLinkStep, PressKeyStep
    - HideKeyboardStep, EraseTextStep, CopyTextStep
  - [x] Implement `generateFlow(steps, config)` - create YAML from steps
  - [x] Implement `generateFlowFile(steps, outputPath, config)` - save YAML to file
  - [x] Implement `generateFlowFromStrings(actions, config)` - parse shorthand actions
  - [x] Implement `parseActionString(actionString)` - parse "tap:Login" format
  - [x] Helper functions: tap, inputText, scroll, screenshotStep, assertVisible, etc.
  - [x] Unit tests in `src/__tests__/main/ios-tools/flow-generator.test.ts`

### Flow Execution

- [x] Create `src/main/ios-tools/flow-runner.ts` - execute Maestro Mobile flows
  - Note: Implemented as `flow-runner.ts` (not `mobile-flow-runner.ts`)
  - [x] Implement `FlowRunOptions` interface (udid, bundleId, flowPath, timeout, env, etc.)
  - [x] Implement `FlowRunResult` interface with:
    - passed, duration, flowPath, udid
    - totalSteps, passedSteps, failedSteps, skippedSteps
    - steps array with individual FlowStepResult
    - failureScreenshotPath, reportPath, rawOutput
  - [x] Implement `runFlow(options)` - execute a flow file
  - [x] Implement `runFlowWithRetry(options)` - retry support for flaky tests
  - [x] Implement `runFlows(flowPaths, options)` - batch execution
  - [x] Implement `validateFlow(flowPath)` - basic YAML validation
  - [x] Implement `validateFlowWithMaestro(flowPath)` - maestro validate command
  - [x] Auto-capture failure screenshots
  - [x] Timeout support via Promise.race
  - [x] Unit tests in `src/__tests__/main/ios-tools/flow-runner.test.ts`

### Slash Command: /ios.run_flow

- [x] Create `src/main/slash-commands/ios-run-flow.ts`
  - [x] Implement `/ios.run_flow <path>` - run a YAML flow file
  - [x] Implement `/ios.run_flow --inline "<steps>"` - run inline steps
  - [x] Arguments:
    - `--app <bundleId>` - target app
    - `--simulator <name|udid>` - target simulator
    - `--timeout <seconds>` - max execution time
    - `--screenshot-dir <path>` - output directory
    - `--retry <count>` - retry attempts on failure
    - `--continue` - continue on error
    - `--debug` - verbose output mode
  - [x] Show pass/fail with evidence (formatted markdown output)
  - [x] Registered IPC handler in `src/main/ipc/handlers/ios.ts`
  - [x] Added API surface in `src/main/preload.ts`
  - [x] Exported from `src/main/slash-commands/index.ts`
  - [x] Unit tests (45 tests) in `src/__tests__/main/slash-commands/ios-run-flow.test.ts`
  - Note: Real-time progress display requires additional integration with Claude Code agent output streaming

---

## Path B: Native XCUITest Driver (Advanced)

### XCUITest Action Runner

- [ ] Create `src/main/ios-tools/xcuitest-driver/` directory
- [ ] Create Swift action execution code
  - [ ] `ActionRunner.swift` - main action executor
  - [ ] `ActionTypes.swift` - action type definitions
  - [ ] `ActionResult.swift` - result serialization

- [ ] Implement action types in Swift
  - [ ] `tap(identifier)` - tap element by identifier
  - [ ] `tap(label)` - tap element by label
  - [ ] `tap(x, y)` - tap at coordinates
  - [ ] `doubleTap(target)` - double tap
  - [ ] `longPress(target, duration)` - long press
  - [ ] `type(text)` - type text into focused element
  - [ ] `typeInto(identifier, text)` - type into specific element
  - [ ] `clearText(identifier)` - clear text field
  - [ ] `scroll(direction, distance)` - scroll view
  - [ ] `scrollTo(identifier)` - scroll until element visible
  - [ ] `swipe(direction)` - swipe gesture
  - [ ] `pinch(scale)` - pinch gesture
  - [ ] `rotate(angle)` - rotation gesture
  - [ ] `waitForElement(identifier, timeout)` - wait for visibility
  - [ ] `waitForNotExist(identifier, timeout)` - wait for disappear

### Native Driver Service

- [ ] Create `src/main/ios-tools/native-driver.ts` - TypeScript wrapper
  - [ ] Implement `NativeDriverOptions` interface
  - [ ] Implement `tap(options)` - execute tap action
  - [ ] Implement `type(options)` - execute type action
  - [ ] Implement `scroll(options)` - execute scroll action
  - [ ] Implement `swipe(options)` - execute swipe action
  - [ ] Implement `waitFor(options)` - wait for element
  - [ ] Implement `runActions(actions)` - batch execute actions

### Slash Commands for Primitives

- [ ] Create `src/main/slash-commands/ios-tap.ts`
  - [ ] `/ios.tap <target>` - tap element
  - [ ] Arguments:
    - `#identifier` - by accessibility ID
    - `"label text"` - by label
    - `x,y` - by coordinates

- [ ] Create `src/main/slash-commands/ios-type.ts`
  - [ ] `/ios.type <text>` - type into focused element
  - [ ] `/ios.type --into <target> <text>` - type into specific element

- [ ] Create `src/main/slash-commands/ios-scroll.ts`
  - [ ] `/ios.scroll <direction>` - scroll up/down/left/right
  - [ ] `/ios.scroll --to <target>` - scroll until element visible

- [ ] Create `src/main/slash-commands/ios-swipe.ts`
  - [ ] `/ios.swipe <direction>` - swipe gesture

---

## Common Infrastructure

### Action Recording (Optional)

- [ ] Create `src/main/ios-tools/action-recorder.ts`
  - [ ] Implement `startRecording(options)` - begin recording actions
  - [ ] Implement `stopRecording()` - end recording, return flow
  - [ ] Convert recorded actions to Maestro Mobile YAML or native driver actions

### Action Validation

- [ ] Create `src/main/ios-tools/action-validator.ts`
  - [ ] Implement `validateTarget(target, uiTree)` - check target exists
  - [ ] Implement `suggestAlternatives(target, uiTree)` - suggest similar elements
  - [ ] Implement `checkHittable(target, uiTree)` - verify element can receive taps

### Action Result Formatting

- [x] Create `src/main/ios-tools/action-formatter.ts` - format results for agent
  - [x] Implement `formatFlowResult(result, options)` - flow execution summary with:
    - Status (PASSED/FAILED), duration, step counts
    - Markdown table with metrics
    - Step-by-step results with checkmarks
    - Artifact paths (screenshots, reports)
    - Optional raw output inclusion
  - [x] Implement `formatFlowResultAsJson(result)` - JSON output for programmatic use
  - [x] Implement `formatFlowResultCompact(result)` - single-line summary
  - [x] Implement `formatBatchFlowResult(batchResult, options)` - multiple flow summary
  - [x] Implement `formatStepsTable(steps)` - markdown table of steps
  - [x] Implement `formatStatusBadge(result)` - GitHub-style status badge
  - [x] Implement `formatDuration(ms)` - human-readable duration
  - [x] Implement `formatProgressBar(passed, total)` - ASCII progress bar

### IPC Handlers

- [ ] Add interaction IPC handlers to `src/main/ipc/handlers/ios.ts`
  - [ ] Register `ios:flow:run` handler
  - [ ] Register `ios:flow:generate` handler
  - [ ] Register `ios:action:tap` handler
  - [ ] Register `ios:action:type` handler
  - [ ] Register `ios:action:scroll` handler
  - [ ] Register `ios:action:swipe` handler
  - [ ] Register `ios:action:wait` handler

### Auto Run Integration

- [ ] Add interaction actions to Auto Run
  - [ ] Example:
    ```yaml
    - action: ios.run_flow
      flow: login_flow.yaml
      store_as: login_result

    - action: assert
      condition: "login_result.success"
      message: "Login flow should complete successfully"

    - action: ios.tap
      target: "#settings_button"

    - action: ios.type
      into: "#search_field"
      text: "query text"
    ```

---

## Error Handling

- [ ] Handle "element not found" with suggestions
- [ ] Handle "element not hittable" with reason
- [ ] Handle "Maestro Mobile CLI not installed" with install instructions
- [ ] Handle timeout during flow execution
- [ ] Handle app crash during interaction
- [ ] Capture screenshot on failure automatically

## Testing

- [x] Write unit tests for flow-generator.ts - 67+ tests covering all step types and generation
- [x] Write unit tests for flow-runner.ts - batch execution, validation, retry logic
- [x] Write unit tests for maestro-cli.ts - 18 tests covering detection, installation, validation
- [ ] Write unit tests for action-validator.ts
- [ ] Write integration test with Maestro Mobile CLI
- [ ] Write integration test with native driver
- [ ] Test error cases (missing elements, timeouts)

## Documentation

- [ ] Document `/ios.run_flow` command
- [ ] Document primitive commands (`/ios.tap`, `/ios.type`, etc.)
- [ ] Document Maestro Mobile YAML format
- [ ] Document native driver Swift integration
- [ ] Provide example flows for common scenarios

## Acceptance Criteria

### Path A (Maestro Mobile CLI)
- [ ] `/ios.run_flow` executes YAML flows successfully
- [ ] Can generate flow YAML from step list
- [ ] Real-time execution progress shown
- [ ] Screenshots captured at each step
- [ ] Clear pass/fail result with evidence
- [ ] Suggestions provided on element not found

### Path B (Native Driver)
- [ ] `/ios.tap` can tap elements by ID, label, or coordinates
- [ ] `/ios.type` can input text into fields
- [ ] `/ios.scroll` can scroll to reveal elements
- [ ] Actions validate targets before execution
- [ ] Alternative element suggestions on failure

### Both Paths
- [ ] Works in Auto Run document steps
- [ ] Agent can navigate "golden path" flows
- [ ] Failure screenshots captured automatically
- [ ] Performance: single action < 2 seconds
