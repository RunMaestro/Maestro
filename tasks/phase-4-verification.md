# Phase 4: Verification Primitives

**Goal**: Create stable, reusable verification assertions that make "prove it works" automatic in Auto Run documents.

**Deliverable**: Suite of `/ios.assert_*` and `/ios.wait_*` commands that wrap inspection and log checking into reliable assertions.

**Dependency**: Phase 1 (snapshot), Phase 2 (inspect), Phase 3 (interact)

---

## Core Verification Service

- [x] Create `src/main/ios-tools/verification.ts` - verification orchestration ✅ *Implemented with enhanced interfaces*
  - [x] Implement `VerificationOptions` interface ✅ *Implemented as `AssertionBaseOptions` with `PollingOptions` and `RetryPolicy`*
    ```typescript
    interface VerificationOptions {
      simulatorUdid: string;
      bundleId: string;
      timeout?: number;       // Max wait time (default: 10s)
      pollInterval?: number;  // Check interval (default: 500ms)
      retries?: number;       // Retry count on transient failures
    }
    ```
  - [x] Implement `VerificationResult` interface ✅ *Implemented with richer structure including `status`, `attempts[]`, `simulator` info, `artifacts`*
    ```typescript
    interface VerificationResult {
      passed: boolean;
      assertion: string;
      duration: number;
      attempts: number;
      evidence: {
        screenshot?: string;
        elementState?: ElementNode;
        logs?: string;
      };
      failureReason?: string;
      suggestions?: string[];
    }
    ```

---

## Element Visibility Assertions

### /ios.assert_visible

- [x] Create `src/main/ios-tools/assertions/visible.ts` ✅ *Fully implemented*
  - [x] Implement `assertVisible(target, options)` - verify element is visible ✅
  - [x] Check element exists in UI tree ✅
  - [x] Check element has non-zero frame ✅ *Via `visible` property check*
  - [x] Check element is not marked hidden ✅
  - [x] Return evidence (screenshot, element state) ✅ *Captures screenshots on failure/success, includes element details*

- [x] Create slash command `/ios.assert_visible` ✅ *IPC handler registered as `ios:assert:visible`*
  - [x] Arguments:
    - `<target>` - element identifier, label, or query ✅ *Supports `identifier`, `label`, `text`, `type`, `query`*
    - `--timeout <seconds>` - max wait time ✅ *Via `polling.timeout`*
    - `--app <bundleId>` - target app ✅ *Via `bundleId` option*
  - [x] Examples:
    - `/ios.assert_visible #login_button`
    - `/ios.assert_visible "Welcome"`
    - `/ios.assert_visible Button#submit --timeout 5`

### /ios.assert_not_visible

- [x] Create `src/main/ios-tools/assertions/not-visible.ts` ✅ *Implemented in visible.ts as `assertNotVisible`*
  - [x] Implement `assertNotVisible(target, options)` ✅
  - [x] Verify element is NOT in UI tree (or hidden) ✅
  - [x] Useful for verifying modals closed, loading done, etc. ✅

- [x] Create slash command `/ios.assert_not_visible` ✅ *IPC handler registered as `ios:assert:notVisible`*

### /ios.wait_for

- [x] Create `src/main/ios-tools/assertions/wait-for.ts` ✅ *Fully implemented with all convenience functions*
  - [x] Implement `waitFor(target, options)` - wait until element visible ✅
  - [x] Poll at intervals until element appears or timeout ✅ *Uses `pollUntil` from verification infrastructure*
  - [x] Return element state when found ✅ *Returns `WaitForData` with element details*

- [x] Create slash command `/ios.wait_for` ✅ *IPC handlers registered as `ios:wait:for`, `ios:wait:forNot`, etc.*
  - [x] Arguments:
    - `<target>` - element to wait for ✅ *Supports identifier, label, text, type, query*
    - `--timeout <seconds>` - max wait (default: 10) ✅ *Via `polling.timeout`*
  - [x] Examples:
    - `/ios.wait_for #home_screen` ✅ *Via `waitForById`*
    - `/ios.wait_for "Loading..." --not` (wait for disappear) ✅ *Via `waitForNot`, `waitForNotByText`*

---

## Text & Content Assertions

### /ios.assert_text

- [x] Create `src/main/ios-tools/assertions/text.ts` ✅ *Implemented with comprehensive text matching*
  - [x] Implement `assertText(target, expected, options)` ✅
  - [x] Match modes: ✅
    - [x] Exact: text equals expected ✅
    - [x] Contains: text includes expected ✅
    - [x] Regex: text matches pattern ✅
    - [x] StartsWith / EndsWith ✅
  - [x] Support checking label OR value ✅ *Via `textProperty` option: 'label', 'value', or 'any' (default)*

- [x] Create slash command `/ios.assert_text` ✅ *IPC handlers registered:*
  - *`ios:assert:text` - main assertion*
  - *`ios:assert:textById` - by identifier*
  - *`ios:assert:textByLabel` - by label*
  - *`ios:assert:textContains` - contains mode*
  - *`ios:assert:textMatches` - regex mode*
  - *`ios:assert:textStartsWith` - startsWith mode*
  - *`ios:assert:textEndsWith` - endsWith mode*
  - [x] Arguments:
    - `<target>` - element to check ✅ *Supports identifier, label, text, type, query*
    - `<expected>` - expected text ✅
    - `--contains` - partial match ✅ *Via `matchMode: 'contains'`*
    - `--regex` - regex match ✅ *Via `matchMode: 'regex'`*
  - [x] Examples: ✅
    - `/ios.assert_text #username_label "John Doe"`
    - `/ios.assert_text #status --contains "Success"`
    - `/ios.assert_text #email --regex ".*@.*\.com"`

### /ios.assert_value

- [x] Create `src/main/ios-tools/assertions/value.ts` ✅ *Fully implemented*
  - [x] Implement `assertValue(target, expected, options)` ✅ *With full match mode support*
  - [x] Check element's value property (for text fields, etc.) ✅
  - [x] Useful for verifying form input state ✅
  - [x] Match modes: exact, contains, regex, startsWith, endsWith, empty, notEmpty ✅
  - [x] Convenience functions: assertValueById, assertValueByLabel, assertValueContains, assertValueMatches, assertValueStartsWith, assertValueEndsWith, assertValueEmpty, assertValueNotEmpty ✅

- [x] Create slash command `/ios.assert_value` ✅ *IPC handlers registered:*
  - *`ios:assert:value` - main assertion*
  - *`ios:assert:valueById` - by identifier*
  - *`ios:assert:valueByLabel` - by label*
  - *`ios:assert:valueContains` - contains mode*
  - *`ios:assert:valueMatches` - regex mode*
  - *`ios:assert:valueStartsWith` - startsWith mode*
  - *`ios:assert:valueEndsWith` - endsWith mode*
  - *`ios:assert:valueEmpty` - empty value check*
  - *`ios:assert:valueNotEmpty` - non-empty value check*

---

## State Assertions

### /ios.assert_enabled

- [x] Create `src/main/ios-tools/assertions/enabled.ts` ✅ *Fully implemented with polling support*
  - [x] Implement `assertEnabled(target, options)` ✅
  - [x] Verify element is enabled/interactable ✅
  - [x] Check isEnabled property ✅
  - [x] Convenience functions: `assertEnabledById`, `assertEnabledByLabel`, `assertEnabledByText` ✅

- [x] Create slash command `/ios.assert_enabled` ✅ *IPC handlers registered:*
  - *`ios:assert:enabled` - main assertion*
  - *`ios:assert:enabledById` - by identifier*
  - *`ios:assert:enabledByLabel` - by label*
  - *`ios:assert:enabledByText` - by text*

### /ios.assert_disabled

- [x] Create `src/main/ios-tools/assertions/enabled.ts` ✅ *Implemented in enabled.ts as `assertDisabled`*
  - [x] Implement `assertDisabled(target, options)` ✅
  - [x] Verify element is disabled ✅
  - [x] Convenience functions: `assertDisabledById`, `assertDisabledByLabel`, `assertDisabledByText` ✅

- [x] Create slash command `/ios.assert_disabled` ✅ *IPC handlers registered:*
  - *`ios:assert:disabled` - main assertion*
  - *`ios:assert:disabledById` - by identifier*
  - *`ios:assert:disabledByLabel` - by label*
  - *`ios:assert:disabledByText` - by text*

### /ios.assert_selected

- [ ] Create `src/main/ios-tools/assertions/selected.ts`
  - [ ] Implement `assertSelected(target, options)`
  - [ ] Check isSelected property
  - [ ] Useful for tabs, checkboxes, toggles

- [ ] Create slash command `/ios.assert_selected`

### /ios.assert_hittable

- [ ] Create `src/main/ios-tools/assertions/hittable.ts`
  - [ ] Implement `assertHittable(target, options)`
  - [ ] Verify element can receive tap events
  - [ ] Helps diagnose "why can't I tap this" issues

- [ ] Create slash command `/ios.assert_hittable`

---

## Log & Crash Assertions

### /ios.assert_no_crash

- [x] Create `src/main/ios-tools/assertions/no-crash.ts` ✅ *Fully implemented*
  - [x] Implement `assertNoCrash(bundleId, options)` ✅
  - [x] Check for new crash logs since last assertion ✅ *Uses `getCrashLogs` with `since` parameter*
  - [x] Check system log for crash indicators ✅ *Collects system logs on failure*
  - [x] Return crash details if found ✅ *Returns `CrashReport[]` with exception info*

- [x] Create slash command `/ios.assert_no_crash` ✅ *IPC handler registered as `ios:assert:noCrash`*
  - [x] Arguments:
    - `--app <bundleId>` - app to check ✅
    - `--since <timestamp>` - check since time ✅
  - [x] Examples:
    - `/ios.assert_no_crash --app com.example.myapp`

### /ios.assert_no_errors

- [ ] Create `src/main/ios-tools/assertions/no-errors.ts`
  - [ ] Implement `assertNoErrors(options)`
  - [ ] Scan recent logs for error patterns
  - [ ] Configurable error patterns
  - [ ] Return any errors found

- [ ] Create slash command `/ios.assert_no_errors`
  - [ ] Arguments:
    - `--pattern <regex>` - custom error pattern
    - `--since <timestamp>` - check since time
    - `--ignore <patterns>` - patterns to ignore

### /ios.assert_log_contains

- [ ] Create `src/main/ios-tools/assertions/log-contains.ts`
  - [ ] Implement `assertLogContains(pattern, options)`
  - [ ] Search recent logs for pattern
  - [ ] Useful for verifying API calls, analytics events

- [ ] Create slash command `/ios.assert_log_contains`
  - [ ] Examples:
    - `/ios.assert_log_contains "Login successful"`
    - `/ios.assert_log_contains --regex "API response: \d+"`

---

## Compound Assertions

### /ios.assert_screen

- [ ] Create `src/main/ios-tools/assertions/screen.ts`
  - [ ] Implement `assertScreen(screenName, options)`
  - [ ] Check multiple conditions that define a "screen"
  - [ ] Configurable screen definitions
  - [ ] Examples:
    ```yaml
    screens:
      login:
        elements:
          - "#email_field"
          - "#password_field"
          - "#login_button"
        not_visible:
          - "#loading_spinner"
      home:
        elements:
          - "#home_title"
          - "#profile_button"
    ```

- [ ] Create slash command `/ios.assert_screen`
  - [ ] Examples:
    - `/ios.assert_screen login`
    - `/ios.assert_screen home --timeout 10`

---

## Verification Result Formatting

- [x] Create `src/main/ios-tools/verification-formatter.ts` ✅ *Fully implemented*
  - [x] Implement `formatVerificationResult(result)` - agent-readable format ✅ *Returns markdown with status, timing, simulator info, attempts table, artifacts, type-specific data*
    ```
    ## Assertion Result

    **Assertion**: Element "#login_button" is visible
    **Status**: ✅ PASSED
    **Duration**: 0.8s
    **Attempts**: 1

    ### Evidence
    - Element found: Button "login_button" at (100, 500)
    - Screenshot: /path/to/screenshot.png

    ---

    **Assertion**: Element "#submit_button" is visible
    **Status**: ❌ FAILED
    **Duration**: 10.0s (timeout)
    **Attempts**: 20

    ### Failure Details
    Element "#submit_button" was not found in the UI tree.

    ### Suggestions
    - Did you mean "#send_button"? (Button, visible)
    - Check if the element has the correct identifier
    - The element may not have loaded yet - try increasing timeout

    ### Evidence
    - UI tree: 47 elements found
    - Screenshot: /path/to/failure_screenshot.png
    ```
  - [x] Implement `formatMultipleResults(results)` - summarize multiple assertions ✅ *Implemented as `formatVerificationBatch()`*

---

## IPC Handlers

- [ ] Add verification IPC handlers to `src/main/ipc/handlers/ios.ts`
  - [x] Register `ios:assert:visible` handler ✅
  - [x] Register `ios:assert:notVisible` handler ✅
  - [x] Register `ios:assert:text` handler ✅ *All text assertion variants registered (text, textById, textByLabel, textContains, textMatches, textStartsWith, textEndsWith)*
  - [x] Register `ios:assert:value` handler ✅ *All value assertion variants registered (value, valueById, valueByLabel, valueContains, valueMatches, valueStartsWith, valueEndsWith, valueEmpty, valueNotEmpty)*
  - [x] Register `ios:assert:enabled` handler ✅ *All enabled assertion variants registered (enabled, enabledById, enabledByLabel, enabledByText)*
  - [x] Register `ios:assert:disabled` handler ✅ *All disabled assertion variants registered (disabled, disabledById, disabledByLabel, disabledByText)*
  - [ ] Register `ios:assert:hittable` handler
  - [x] Register `ios:assert:noCrash` handler ✅
  - [ ] Register `ios:assert:noErrors` handler
  - [ ] Register `ios:assert:logContains` handler
  - [ ] Register `ios:assert:screen` handler
  - [x] Register `ios:wait:for` handler ✅ *Registered along with all convenience variants (forById, forByLabel, forByText, forNot, etc.)*

---

## Auto Run Integration

- [ ] Add all assertions to Auto Run step types
  - [ ] Example Auto Run document:
    ```markdown
    # Feature: User Login

    ## Tasks

    - [ ] Navigate to login screen
      - ios.tap: "#login_nav_button"
      - ios.wait_for: "#login_screen"

    - [ ] Verify login form elements
      - ios.assert_visible: "#email_field"
      - ios.assert_visible: "#password_field"
      - ios.assert_visible: "#login_button"
      - ios.assert_disabled: "#login_button"  # Should be disabled initially

    - [ ] Fill and submit form
      - ios.type: { into: "#email_field", text: "test@example.com" }
      - ios.type: { into: "#password_field", text: "password123" }
      - ios.assert_enabled: "#login_button"  # Should enable after input
      - ios.tap: "#login_button"

    - [ ] Verify successful login
      - ios.wait_for: "#home_screen"
      - ios.assert_visible: "#welcome_message"
      - ios.assert_text: { element: "#welcome_message", contains: "Welcome" }
      - ios.assert_no_crash: {}
    ```

---

## Retry & Flakiness Handling

- [x] Create `src/main/ios-tools/retry-policy.ts` ✅ *Implemented as part of `verification.ts`*
  - [x] Implement configurable retry strategies ✅ *Via `RetryPolicy` interface*
  - [x] Exponential backoff for transient failures ✅ *`exponentialBackoff` with `backoffMultiplier`*
  - [x] Distinguish flaky vs. hard failures ✅ *Via `withRetry()` function*
  - [x] Log retry attempts for debugging ✅ *Logger output on each attempt*

---

## Error Handling

- [x] Handle element not found with helpful suggestions ✅ *Implemented in `errors.ts` with `ELEMENT_NOT_FOUND` error code and hint*
- [x] Handle timeout with captured state ✅ *`createTimeoutResult()` captures duration and attempts*
- [x] Handle app crash during assertion ✅ *`assertNoCrash` detects and reports crashes with details*
- [x] Handle simulator not responding ✅ *`SIMULATOR_NOT_BOOTED` error with troubleshooting hints*
- [x] Provide actionable failure messages ✅ *`ERROR_MESSAGES` map provides title + hint for all error codes*

## Testing

- [ ] Write unit tests for each assertion type
- [ ] Write integration tests with sample app
- [ ] Test timeout behavior
- [ ] Test retry logic
- [ ] Test compound assertions

## Documentation

- [ ] Document each assertion command
- [ ] Provide examples for common patterns
- [ ] Document timeout and retry configuration
- [ ] Document screen definition format

## Acceptance Criteria

- [ ] All `/ios.assert_*` commands work reliably *(partial - visible, not-visible, no-crash implemented)*
- [ ] `/ios.wait_for` polls until element appears or timeout *(implemented via `assertVisible` with polling)*
- [x] Assertions provide clear pass/fail with evidence ✅
- [x] Failed assertions include suggestions ✅ *Error messages include hints*
- [x] No crash detection works with crash log scanning ✅
- [ ] Log assertions can search recent logs *(not yet implemented)*
- [ ] Screen assertions check multiple conditions *(not yet implemented)*
- [ ] Auto Run documents can use all assertions *(partial - core assertions available)*
- [x] Agent can use assertions to "prove" feature works ✅ *Via IPC handlers and verification formatter*
