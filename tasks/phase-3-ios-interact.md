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

- [x] Create `src/main/ios-tools/xcuitest-driver/` directory
- [x] Create Swift action execution code
  - [x] `ActionRunner.swift` - main action executor
  - [x] `ActionTypes.swift` - action type definitions
  - [x] `ActionResult.swift` - result serialization

- [x] Implement action types in Swift
  - [x] `tap(identifier)` - tap element by identifier
  - [x] `tap(label)` - tap element by label
  - [x] `tap(x, y)` - tap at coordinates
  - [x] `doubleTap(target)` - double tap
  - [x] `longPress(target, duration)` - long press
  - [x] `type(text)` - type text into focused element
  - [x] `typeInto(identifier, text)` - type into specific element
  - [x] `clearText(identifier)` - clear text field
  - [x] `scroll(direction, distance)` - scroll view
  - [x] `scrollTo(identifier)` - scroll until element visible
  - [x] `swipe(direction)` - swipe gesture
  - [x] `pinch(scale)` - pinch gesture
  - [x] `rotate(angle)` - rotation gesture
  - [x] `waitForElement(identifier, timeout)` - wait for visibility
  - [x] `waitForNotExist(identifier, timeout)` - wait for disappear
  - Note: Swift files in `src/main/ios-tools/xcuitest-driver/` - ActionTypes.swift defines action types and targets, ActionResult.swift handles result serialization with JSON output markers, ActionRunner.swift implements the main action executor with element finding and gesture execution

### Native Driver Service

- [x] Create `src/main/ios-tools/native-driver.ts` - TypeScript wrapper
  - [x] Implement `NativeDriverOptions` interface
  - [x] Implement `tap(options)` - execute tap action
  - [x] Implement `type(options)` - execute type action
  - [x] Implement `scroll(options)` - execute scroll action
  - [x] Implement `swipe(options)` - execute swipe action
  - [x] Implement `waitFor(options)` - wait for element
  - [x] Implement `runActions(actions)` - batch execute actions (via executeAll)
  - [x] Target helpers: byId, byLabel, byText, byPredicate, byCoordinates, byType
  - [x] Action helpers: tap, doubleTap, longPress, typeText, clearText, scroll, scrollTo, swipe, pinch, rotate, waitForElement, waitForNotExist, assertExists, assertNotExists, assertEnabled, assertDisabled
  - [x] Convenience methods on NativeDriver class: tapById, tapByLabel, tapAt, type, typeInto, scrollDown, scrollUp, scrollToId, swipeDirection, waitFor, waitForGone, assertElementExists, assertElementNotExists
  - [x] Unit tests (66 tests) in `src/__tests__/main/ios-tools/native-driver.test.ts`
  - Note: Execution currently returns "not yet implemented" - full implementation requires building XCUITest project dynamically. Recommends using Maestro Mobile CLI (`/ios.run_flow`) for now.

### Slash Commands for Primitives

- [x] Create `src/main/slash-commands/ios-tap.ts`
  - [x] `/ios.tap <target>` - tap element
  - [x] Arguments:
    - `#identifier` - by accessibility ID
    - `"label text"` - by label
    - `x,y` - by coordinates
  - [x] Additional options: `--app`, `--simulator`, `--double`, `--long`, `--offset`, `--timeout`, `--debug`
  - [x] Registered IPC handler in `src/main/ipc/handlers/ios.ts`
  - [x] Exported from `src/main/slash-commands/index.ts`
  - [x] Unit tests (71 tests) in `src/__tests__/main/slash-commands/ios-tap.test.ts`
  - Note: Uses the NativeDriver from native-driver.ts. Currently returns "not yet implemented" since NativeDriver execution requires building XCUITest project dynamically. Recommends using Maestro Mobile CLI (`/ios.run_flow`) for actual interactions until NativeDriver is fully implemented.

- [x] Create `src/main/slash-commands/ios-type.ts`
  - [x] `/ios.type <text>` - type into focused element
  - [x] `/ios.type --into <target> <text>` - type into specific element
  - [x] Arguments:
    - `--into, -i <target>` - target element to type into (#identifier or "label")
    - `--app, -a <bundleId>` - target app (required)
    - `--simulator, -s <name|udid>` - target simulator
    - `--clear, -c` - clear existing text before typing
    - `--timeout <ms>` - element wait timeout (default: 10000)
    - `--debug` - verbose output mode
  - [x] Registered IPC handler in `src/main/ipc/handlers/ios.ts`
  - [x] Exported from `src/main/slash-commands/index.ts`
  - [x] Unit tests (66 tests) in `src/__tests__/main/slash-commands/ios-type.test.ts`
  - Note: Uses the NativeDriver from native-driver.ts. Currently returns "not yet implemented" since NativeDriver execution requires building XCUITest project dynamically. Recommends using Maestro Mobile CLI (`/ios.run_flow`) for actual interactions until NativeDriver is fully implemented.

- [x] Create `src/main/slash-commands/ios-scroll.ts`
  - [x] `/ios.scroll <direction>` - scroll up/down/left/right
  - [x] `/ios.scroll --to <target>` - scroll until element visible
  - [x] Arguments:
    - `--to, -t <target>` - target element to scroll to (#identifier or "label")
    - `--app, -a <bundleId>` - target app (required)
    - `--simulator, -s <name|udid>` - target simulator
    - `--distance <n>` - scroll distance (0.0-1.0, default: 0.5)
    - `--attempts <n>` - max scroll attempts when targeting element (default: 10)
    - `--in <target>` - scroll within a specific container
    - `--timeout <ms>` - element wait timeout (default: 10000)
    - `--debug` - verbose output mode
  - [x] Registered IPC handler in `src/main/ipc/handlers/ios.ts`
  - [x] Exported from `src/main/slash-commands/index.ts`
  - [x] Unit tests (104 tests) in `src/__tests__/main/slash-commands/ios-scroll.test.ts`
  - Note: Uses the NativeDriver from native-driver.ts. Currently returns "not yet implemented" since NativeDriver execution requires building XCUITest project dynamically. Recommends using Maestro Mobile CLI (`/ios.run_flow`) for actual interactions until NativeDriver is fully implemented.

- [x] Create `src/main/slash-commands/ios-swipe.ts`
  - [x] `/ios.swipe <direction>` - swipe gesture
  - [x] Arguments:
    - `--app, -a <bundleId>` - target app (required)
    - `--simulator, -s <name|udid>` - target simulator
    - `--velocity, -v <slow|normal|fast>` - swipe velocity (default: normal)
    - `--from <target>` - start swipe from specific element (#identifier or "label")
    - `--timeout <ms>` - element wait timeout (default: 10000)
    - `--debug` - verbose output mode
  - [x] Registered IPC handler in `src/main/ipc/handlers/ios.ts`
  - [x] Exported from `src/main/slash-commands/index.ts`
  - [x] Unit tests (93 tests) in `src/__tests__/main/slash-commands/ios-swipe.test.ts`
  - Note: Uses the NativeDriver from native-driver.ts. Currently returns "not yet implemented" since NativeDriver execution requires building XCUITest project dynamically. Recommends using Maestro Mobile CLI (`/ios.run_flow`) for actual interactions until NativeDriver is fully implemented.

---

## Common Infrastructure

### Action Recording (Optional)

- [x] Create `src/main/ios-tools/action-recorder.ts`
  - [x] Implement `startRecording(options)` - begin recording actions
  - [x] Implement `stopRecording()` - end recording, return flow
  - [x] Convert recorded actions to Maestro Mobile YAML or native driver actions
  - Note: Implemented with full session management (start, stop, pause, resume, cancel), individual action recording (tap, doubleTap, longPress, type, scroll, swipe, launchApp, terminateApp, screenshot), and conversion to both Maestro YAML flows and native driver actions. Includes 63 unit tests. Exported with "Action" prefix to avoid conflicts with video recording functions (e.g., `startActionRecording`, `stopActionRecording`).

### Action Validation

- [x] Create `src/main/ios-tools/action-validator.ts`
  - [x] Implement `validateTarget(target, uiTree)` - check target exists
  - [x] Implement `suggestAlternatives(target, uiTree)` - suggest similar elements
  - [x] Implement `checkHittable(target, uiTree)` - verify element can receive taps
  - Note: Full implementation with target finding (by identifier, label, text, predicate, coordinates, type), validation options (requireVisible, requireEnabled, checkHittable), fuzzy string matching for suggestions using Levenshtein distance, hittability checks (visibility, enabled, size, obscured elements, off-screen detection), and convenience functions (validateForAction, targetExists, getElementCenter). Includes 63 unit tests. Exported from index.ts.

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

- [x] Add interaction IPC handlers to `src/main/ipc/handlers/ios.ts`
  - [x] Register `ios:flow:run` handler
  - [x] Register `ios:flow:generate` handler
  - [x] Register `ios:action:tap` handler
  - [x] Register `ios:action:type` handler
  - [x] Register `ios:action:scroll` handler
  - [x] Register `ios:action:swipe` handler
  - [x] Register `ios:action:wait` handler
  - Note: All handlers implemented in `src/main/ipc/handlers/ios.ts`. Flow handlers (`ios:flow:run`, `ios:flow:generate`) were already implemented; Native driver action handlers (`ios:action:tap`, `ios:action:type`, `ios:action:scroll`, `ios:action:swipe`, `ios:action:wait`) added with full support for all action variants (double tap, long press, scroll-to-element, wait for not exist, etc.). 20 new unit tests added to `src/__tests__/main/ipc/handlers/ios.test.ts` covering all action handlers.

### Auto Run Integration

- [x] Add interaction actions to Auto Run
  - [x] `ios.run_flow` - Execute Maestro YAML flows with retry, timeout, env vars support
  - [x] `ios.tap` - Tap elements by #identifier, "label", or x,y coordinates; supports double-tap and long-press
  - [x] `ios.type` - Type text into focused element or specific target; supports clear-first
  - [x] `ios.scroll` - Scroll in direction or scroll-to-element; supports container scrolling
  - [x] `ios.swipe` - Swipe gestures with velocity control; supports starting from specific element
  - [x] `assert` - Condition checking with truthy/falsy evaluation; supports negation with `not: true`
  - [x] Exported all actions from `src/cli/services/playbook-actions/actions/index.ts`
  - [x] Unit tests: 95 new tests in `ios-interaction-actions.test.ts` (50 tests) and `assert-action.test.ts` (45 tests)
  - [x] Example usage:
    ```yaml
    - action: ios.run_flow
      inputs:
        flow: login_flow.yaml
        app: com.example.myapp
      store_as: login_result

    - action: assert
      inputs:
        condition: "{{ variables.login_result.passed }}"
        message: "Login flow should complete successfully"

    - action: ios.tap
      inputs:
        target: "#settings_button"
        app: com.example.myapp

    - action: ios.type
      inputs:
        into: "#search_field"
        text: "query text"
        app: com.example.myapp
    ```

---

## Error Handling

- [x] Handle "element not found" with suggestions
  - Note: Implemented in `src/main/ios-tools/interaction-errors.ts` with `createElementNotFoundError()`. Integrates with `action-validator.ts` to generate suggestions from the UI tree using fuzzy string matching (Levenshtein distance) on identifiers, labels, and text. Suggestions are sorted by similarity score (0-100) and formatted in markdown tables with alternative targets.
- [x] Handle "element not hittable" with reason
  - Note: Implemented `createElementNotHittableError()` in `interaction-errors.ts`. Maps `NotHittableReason` from action-validator to specific error codes (`ELEMENT_OBSCURED`, `ELEMENT_OFF_SCREEN`, `ELEMENT_NOT_VISIBLE`, `ELEMENT_NOT_ENABLED`, `ELEMENT_ZERO_SIZE`). Includes element position info and suggested remediation actions.
- [x] Handle "Maestro Mobile CLI not installed" with install instructions
  - Note: Implemented `createMaestroNotInstalledError()` with default Homebrew (`brew tap mobile-dev-inc/tap && brew install maestro`) and curl installation instructions. Custom instructions can be provided.
- [x] Handle timeout during flow execution
  - Note: Implemented `createFlowTimeoutError()` which includes flow path, timeout value in ms, and automatically suggests doubling the timeout value. Screenshot path can be included. The flow-runner already had timeout support via `Promise.race`.
- [x] Handle app crash during interaction
  - Note: Implemented `createInteractionAppCrashedError()` (exported with prefix to avoid conflict with inspect-errors). Includes bundle ID, optional crash type (e.g., EXC_BAD_ACCESS) and crash message, plus screenshot path.
- [x] Capture screenshot on failure automatically
  - Note: Already implemented in `flow-runner.ts` (`captureOnFailure` option, default: true). The `FlowRunResult` includes `failureScreenshotPath`. The interaction-errors module supports `screenshotPath` in all error types. All error formatting functions (`formatInteractionError`, `formatInteractionErrorAsJson`) include screenshot paths when present.

## Testing

- [x] Write unit tests for flow-generator.ts - 67+ tests covering all step types and generation
- [x] Write unit tests for flow-runner.ts - batch execution, validation, retry logic
- [x] Write unit tests for maestro-cli.ts - 18 tests covering detection, installation, validation
- [x] Write unit tests for native-driver.ts - 66 tests covering target helpers, action helpers, driver class, convenience methods
- [x] Write unit tests for action-validator.ts - 63 tests covering validateTarget, suggestAlternatives, checkHittable, validateForAction, targetExists, getElementCenter, and edge cases
- [x] Write integration test with Maestro Mobile CLI - 54 tests in `src/__tests__/integration/maestro-cli.integration.test.ts`
  - Tests CLI detection, version validation, installation instructions
  - Tests flow generation (step helpers, action string parsing, YAML generation, file writing)
  - Tests flow validation (basic validation, Maestro CLI validation)
  - Tests flow execution (simple flows, failure screenshots, env vars, auto-detect simulator, retry, batch execution)
  - Tests performance (CLI detection < 5s, flow generation < 100ms)
  - Gracefully skips tests when Maestro CLI or simulators are unavailable
  - Run with: `npm run test:integration -- src/__tests__/integration/maestro-cli.integration.test.ts`
- [x] Write integration test with native driver
  - 88 tests in `src/__tests__/integration/native-driver.integration.test.ts`
  - Tests target helpers (byId, byLabel, byText, byPredicate, byCoordinates, byType) with edge cases
  - Tests action helpers (tap, doubleTap, longPress, typeText, clearText, scroll, scrollTo, swipe, pinch, rotate, wait, assert)
  - Tests NativeDriver class (creation, initialization, auto-select simulator, batch execution)
  - Tests convenience methods (tapById, tapByLabel, tapAt, type, typeInto, scrollDown, scrollUp, swipeDirection, waitFor, assertElementExists)
  - Tests performance (target/action creation < 100ms, driver init < 5s)
  - Tests error handling (initialization failure, error structure, batch failures)
  - Tests type safety (action types, target types, direction types, velocity types)
  - Gracefully handles "not yet implemented" state (execution requires XCUITest project building)
  - Run with: `npm run test:integration -- src/__tests__/integration/native-driver.integration.test.ts`
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
