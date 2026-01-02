# Phase 5: iOS Golden Path Playbooks

**Goal**: Create reusable, formalized playbook templates that turn common iOS development workflows into reliable, repeatable loops.

**Deliverable**: `iOS/` playbook set integrated with Maestro-Playbooks system.

**Dependency**: Phases 0-4 (full iOS tooling stack)

---

## Playbook Infrastructure

### Playbook Directory Structure

- [x] Create iOS playbook directory structure
  ```
  ~/.maestro/playbooks/iOS/
  ├── README.md
  ├── Feature-Ship-Loop/
  │   ├── playbook.yaml
  │   ├── README.md
  │   └── templates/
  ├── Regression-Check/
  │   ├── playbook.yaml
  │   ├── README.md
  │   └── baselines/
  ├── Crash-Hunt/
  │   ├── playbook.yaml
  │   └── README.md
  ├── Design-Review/
  │   ├── playbook.yaml
  │   └── README.md
  ├── Performance-Check/
  │   ├── playbook.yaml
  │   └── README.md
  └── Common/
      ├── flows/
      ├── screens/
      └── assertions/
  ```
  > Implemented via `ensurePlaybooksDirectory()` in playbook-loader.ts. Directory structure is created programmatically when the loader is initialized.

- [x] Create `src/main/ios-tools/playbook-loader.ts`
  - [x] Implement `loadPlaybook(name)` - load playbook configuration
  - [x] Implement `listPlaybooks()` - list available iOS playbooks
  - [x] Implement `validatePlaybook(config)` - validate playbook structure
  > Also implemented: `getPlaybookInfo()`, `playbookExists()`, `getPlaybookTemplatesDir()`, `getPlaybookBaselinesDir()`, and Common directory helpers.

---

## Playbook 1: Feature Ship Loop

**Purpose**: Iterate build → launch → navigate → assert → snapshot → loop until feature works.

### Configuration

- [x] Create `Feature-Ship-Loop/playbook.yaml`
  > Created at `~/.maestro/playbooks/iOS/Feature-Ship-Loop/playbook.yaml` with full YAML configuration including 5 inputs (project_path, scheme, simulator, target_screen, assertions), 4 variables (build_success, assertions_passed, iteration, max_iterations), and 9 steps implementing the build → launch → verify → iterate workflow. Also created README.md documentation with usage examples for both CLI and Auto Run integration.
  ```yaml
  name: iOS Feature Ship Loop
  description: Build, launch, verify, iterate until feature is complete
  version: 1.0.0

  inputs:
    project_path:
      description: Path to Xcode project/workspace
      required: true
    scheme:
      description: Build scheme name
      required: true
    simulator:
      description: Simulator to use
      default: "iPhone 15 Pro"
    target_screen:
      description: Screen to navigate to after launch
      required: false
    assertions:
      description: List of assertions to verify
      type: array
      required: true

  variables:
    build_success: false
    assertions_passed: false
    iteration: 0
    max_iterations: 10

  steps:
    - name: Build Project
      action: ios.build
      inputs:
        project: "{{ inputs.project_path }}"
        scheme: "{{ inputs.scheme }}"
        destination: "{{ inputs.simulator }}"
      on_failure:
        - action: report_build_errors
        - action: exit_loop
          reason: "Build failed - fix errors before continuing"

    - name: Launch App
      action: ios.launch
      inputs:
        simulator: "{{ inputs.simulator }}"
        bundle_id: "{{ outputs.build.bundle_id }}"

    - name: Wait for App Ready
      action: ios.wait_for
      inputs:
        target: "{{ inputs.launch_screen | default('#app_ready') }}"
        timeout: 30

    - name: Navigate to Target
      condition: "{{ inputs.target_screen }}"
      action: ios.run_flow
      inputs:
        steps: "{{ inputs.navigation_steps }}"

    - name: Run Assertions
      action: ios.verify_all
      inputs:
        assertions: "{{ inputs.assertions }}"
      store_as: verification_result

    - name: Capture Evidence
      action: ios.snapshot
      inputs:
        output_dir: "{{ artifacts_dir }}/iteration_{{ variables.iteration }}"

    - name: Check Completion
      condition: "{{ outputs.verification_result.all_passed }}"
      action: complete_loop
      message: "All assertions passed!"

    - name: Report Progress
      action: report_status
      inputs:
        passed: "{{ outputs.verification_result.passed_count }}"
        failed: "{{ outputs.verification_result.failed_count }}"
        evidence: "{{ outputs.snapshot }}"

    - name: Increment and Continue
      action: increment_iteration
      next: Build Project
  ```

### Implementation

- [x] Create `src/main/ios-tools/playbooks/feature-ship-loop.ts`
  - [x] Implement playbook executor
  - [x] Implement iteration tracking
  - [x] Implement progress reporting
  - [x] Implement exit conditions
  > Created comprehensive Feature Ship Loop executor (`feature-ship-loop.ts`) with full implementation including:
  > - `runFeatureShipLoop()` - main executor that iterates through build → launch → verify → snapshot cycles
  > - Iteration tracking via `FeatureShipLoopIterationResult` with timestamps, duration, and per-iteration assertion results
  > - Progress reporting via `onProgress` callback with phases: initializing, building, launching, navigating, verifying, capturing, reporting, complete/failed
  > - Exit conditions: `assertions_passed`, `max_iterations`, `build_failed`, `error`
  > - Support for dry run validation, configurable iteration delays, rebuild/relaunch options
  > - Result formatters: `formatFeatureShipLoopResult()` (markdown), `formatFeatureShipLoopResultAsJson()`, `formatFeatureShipLoopResultCompact()`
  > - 38 unit tests covering input validation, iteration tracking, progress reporting, exit conditions, assertion handling, dry run, formatting, simulator resolution, artifacts, and variables

---

## Playbook 2: Regression Check

**Purpose**: Run key flows, capture screenshots, compare against baselines.

### Configuration

- [x] Create `Regression-Check/playbook.yaml`
  > Created at `~/.maestro/playbooks/iOS/Regression-Check/playbook.yaml` with full YAML configuration including inputs (app_path, project_path, scheme, simulator, flows, baseline_dir, threshold, update_baselines, screenshot_after_each, fail_fast), variables (total_flows, flows_run, regressions_found, screenshots_compared, baseline_updates), and comprehensive steps for boot → build → install → launch → flow loop (reset, execute, capture, update/compare) → report generation. Also created README.md with CLI usage, Auto Run integration, flow file format, baseline directory structure, artifacts output, threshold guide, and CI/CD integration examples.
  ```yaml
  name: iOS Regression Check
  description: Run flows and compare screenshots against baselines
  version: 1.0.0

  inputs:
    flows:
      description: List of flow files to run
      type: array
      required: true
    baseline_dir:
      description: Directory containing baseline screenshots
      required: true
    threshold:
      description: Pixel difference threshold (0-1)
      default: 0.01

  steps:
    - name: Boot Simulator
      action: ios.boot_simulator
      inputs:
        simulator: "{{ inputs.simulator }}"

    - name: Install App
      action: ios.install
      inputs:
        app_path: "{{ inputs.app_path }}"

    - name: Run Each Flow
      loop: "{{ inputs.flows }}"
      as: flow
      steps:
        - action: ios.run_flow
          inputs:
            flow: "{{ flow }}"
            screenshot_after_each: true

        - action: ios.compare_screenshots
          inputs:
            current: "{{ outputs.run_flow.screenshots }}"
            baseline: "{{ inputs.baseline_dir }}/{{ flow.name }}"
            threshold: "{{ inputs.threshold }}"
          store_as: diff_result

        - action: record_diff
          inputs:
            flow: "{{ flow.name }}"
            diffs: "{{ outputs.diff_result }}"

    - name: Generate Report
      action: generate_regression_report
      inputs:
        all_diffs: "{{ collected.diffs }}"
        output: "{{ artifacts_dir }}/regression_report.html"
  ```

### Implementation

- [x] Create `src/main/ios-tools/playbooks/regression-check.ts`
  - [x] Implement flow runner
  - [x] Implement screenshot comparison
  - [x] Implement diff report generation
  - [x] Implement baseline update workflow
  > Created comprehensive Regression Check executor (`regression-check.ts`) with full implementation including:
  > - `runRegressionCheck()` - main executor that iterates through flows, captures screenshots, and compares against baselines
  > - Flow execution via `runFlow()` from flow-runner module with reset/launch/execute cycle
  > - Screenshot comparison using byte-level buffer comparison (placeholder for pixelmatch integration)
  > - HTML and JSON report generation with visual diff display
  > - Baseline update workflow (`update_baselines: true` mode)
  > - Progress reporting via `onProgress` callback with phases: initializing, building, installing, running_flow, capturing, comparing, updating_baseline, generating_report, complete/failed
  > - Result formatters: `formatRegressionCheckResult()` (markdown), `formatRegressionCheckResultAsJson()`, `formatRegressionCheckResultCompact()`
  > - 30 unit tests covering input validation, dry run, progress reporting, result structure, flow configuration, formatting, and variable tracking

---

## Playbook 3: Crash Hunt

**Purpose**: Launch app, perform semi-random navigation, detect and report crashes.

### Configuration

- [x] Create `Crash-Hunt/playbook.yaml`
  > Created at `~/.maestro/playbooks/iOS/Crash-Hunt/playbook.yaml` with full YAML configuration including inputs (app_path, project_path, scheme, bundle_id, simulator, duration, interaction_interval, max_depth, seed, action_weights, excluded_elements, capture_on_crash, reset_on_crash), variables (crashes_found, actions_performed, current_depth, start_time, elapsed_seconds, crash_detected), and comprehensive steps for boot → build → install → launch → log monitoring → random navigation loop (crash check, UI inspect, depth check, random action, record) → report generation. Also created README.md with CLI usage, Auto Run integration, crash detection patterns, reproducibility via seeds, and artifact structure.
  ```yaml
  name: iOS Crash Hunt
  description: Navigate randomly through app to find crashes
  version: 1.0.0

  inputs:
    duration:
      description: How long to run (seconds)
      default: 300
    interaction_interval:
      description: Seconds between interactions
      default: 2
    max_depth:
      description: Max navigation depth before reset
      default: 5

  steps:
    - name: Launch App
      action: ios.launch

    - name: Start Log Monitoring
      action: ios.start_log_watch
      inputs:
        patterns:
          - "CRASH"
          - "SIGABRT"
          - "assertion failed"
          - "fatal error"

    - name: Random Navigation Loop
      loop_until:
        timeout: "{{ inputs.duration }}"
        or: "{{ crash_detected }}"
      steps:
        - action: ios.inspect
          store_as: current_ui

        - action: choose_action
          inputs:
            ui_tree: "{{ outputs.current_ui }}"
            strategy: "weighted_random"
          store_as: next_action

        - action: execute_action
          inputs:
            action: "{{ outputs.next_action }}"

        - action: wait
          inputs:
            seconds: "{{ inputs.interaction_interval }}"

        - action: check_for_crash
          store_as: crash_check

        - condition: "{{ outputs.crash_check.crashed }}"
          action: record_crash
          inputs:
            screenshot: true
            logs: true
            steps_to_reproduce: "{{ collected.actions }}"

    - name: Generate Report
      action: generate_crash_report
      inputs:
        crashes: "{{ collected.crashes }}"
        duration: "{{ elapsed_time }}"
        actions_performed: "{{ collected.actions.length }}"
  ```

### Implementation

- [x] Create `src/main/ios-tools/playbooks/crash-hunt.ts`
  - [x] Implement random action selection
  - [x] Implement crash detection
  - [x] Implement action recording
  - [x] Implement crash report generation
  > Created comprehensive Crash Hunt executor (`crash-hunt.ts`) with full implementation including:
  > - `runCrashHunt()` - main executor that performs semi-random UI navigation to discover crashes
  > - SeededRandom class for reproducible random action selection with configurable weights (tap: 60%, scroll: 20%, swipe: 10%, back: 10% by default)
  > - Crash detection via log streaming for patterns (CRASH, SIGABRT, SIGSEGV, SIGBUS, EXC_BAD_ACCESS, EXC_CRASH, assertion failed, fatal error, precondition failed, Terminating app due to uncaught exception)
  > - Action recording with RecordedAction tracking type, target, params, success, navigation, and depth
  > - Crash evidence capture including screenshot, console log, UI tree, and steps to reproduce
  > - HTML and JSON report generation with crash details and reproducibility info
  > - Progress reporting via `onProgress` callback with phases: initializing, building, installing, hunting, recovering, generating_report, complete/failed
  > - Result formatters: `formatCrashHuntResult()` (markdown), `formatCrashHuntResultAsJson()`, `formatCrashHuntResultCompact()`
  > - 39 unit tests covering input validation, execution, progress reporting, action recording, crash detection, dry run, result formatting, simulator resolution, max depth, excluded elements, and report generation

---

## Playbook 4: Design Review

**Purpose**: Capture screenshots of all screens for design review.

### Configuration

- [ ] Create `Design-Review/playbook.yaml`
  ```yaml
  name: iOS Design Review
  description: Capture all screens for design comparison
  version: 1.0.0

  inputs:
    navigation_map:
      description: Map of screens and how to reach them
      type: object
      required: true
    device_sizes:
      description: Simulators to capture on
      default:
        - "iPhone SE (3rd generation)"
        - "iPhone 15"
        - "iPhone 15 Pro Max"
        - "iPad Pro (12.9-inch)"

  steps:
    - loop: "{{ inputs.device_sizes }}"
      as: device
      steps:
        - action: ios.boot_simulator
          inputs:
            name: "{{ device }}"

        - loop: "{{ inputs.navigation_map }}"
          as: screen
          steps:
            - action: ios.run_flow
              inputs:
                steps: "{{ screen.navigation }}"

            - action: ios.screenshot
              inputs:
                output: "{{ artifacts_dir }}/{{ device }}/{{ screen.name }}.png"

            - action: ios.inspect
              inputs:
                output: "{{ artifacts_dir }}/{{ device }}/{{ screen.name }}.json"

    - action: generate_design_sheet
      inputs:
        screenshots: "{{ artifacts_dir }}"
        output: "{{ artifacts_dir }}/design_review.html"
  ```

---

## Playbook 5: Performance Check

**Purpose**: Measure app launch time, memory usage, frame rates.

### Configuration

- [ ] Create `Performance-Check/playbook.yaml`
  ```yaml
  name: iOS Performance Check
  description: Measure key performance metrics
  version: 1.0.0

  inputs:
    runs:
      description: Number of measurement runs
      default: 5
    measure_launch_time: true
    measure_memory: true
    measure_frame_rate: true
    flows:
      description: Flows to measure during
      type: array

  steps:
    - name: Cold Launch Measurements
      loop: "{{ range(inputs.runs) }}"
      steps:
        - action: ios.terminate_app
        - action: ios.clear_caches
        - action: measure_launch_time
          store_as: launch_time

    - name: Flow Performance
      loop: "{{ inputs.flows }}"
      as: flow
      steps:
        - action: start_measurements
          inputs:
            memory: "{{ inputs.measure_memory }}"
            frame_rate: "{{ inputs.measure_frame_rate }}"

        - action: ios.run_flow
          inputs:
            flow: "{{ flow }}"

        - action: stop_measurements
          store_as: flow_metrics

    - name: Generate Report
      action: generate_performance_report
      inputs:
        launch_times: "{{ collected.launch_times }}"
        flow_metrics: "{{ collected.flow_metrics }}"
  ```

---

## Common Components

### Shared Flows

- [ ] Create `Common/flows/login.yaml` - standard login flow
- [ ] Create `Common/flows/logout.yaml` - logout flow
- [ ] Create `Common/flows/navigate-to-settings.yaml`
- [ ] Create `Common/flows/clear-data.yaml`

### Shared Screen Definitions

- [ ] Create `Common/screens/standard-screens.yaml`
  ```yaml
  screens:
    splash:
      wait_for: "#splash_screen"
      timeout: 5

    login:
      elements:
        - "#email_field"
        - "#password_field"
        - "#login_button"

    home:
      elements:
        - "#home_title"
        - "#tab_bar"

    settings:
      elements:
        - "#settings_title"
        - "#profile_section"
  ```

### Shared Assertions

- [ ] Create `Common/assertions/standard-assertions.yaml`
  ```yaml
  assertions:
    app_launched:
      - ios.assert_no_crash
      - ios.assert_visible: "#app_ready"

    user_logged_in:
      - ios.assert_visible: "#home_screen"
      - ios.assert_not_visible: "#login_button"

    no_errors:
      - ios.assert_no_crash
      - ios.assert_no_errors
  ```

---

## Playbook Runner Integration

- [ ] Create `src/main/ios-tools/playbook-runner.ts`
  - [ ] Implement `runPlaybook(name, inputs)` - execute a playbook
  - [ ] Implement step execution engine
  - [ ] Implement variable resolution
  - [ ] Implement loop handling
  - [ ] Implement condition evaluation
  - [ ] Implement artifact collection
  - [ ] Implement progress reporting

### Slash Commands

- [ ] Create `/ios.playbook` slash command
  - [ ] `/ios.playbook list` - list available playbooks
  - [ ] `/ios.playbook run <name>` - run a playbook
  - [ ] `/ios.playbook info <name>` - show playbook details
  - [ ] Arguments:
    - `--inputs <json>` - provide inputs
    - `--dry-run` - validate without executing

### Auto Run Integration

- [ ] Enable playbooks in Auto Run documents
  ```markdown
  - [ ] Run regression check
    - ios.playbook: Regression-Check
      inputs:
        flows:
          - login_flow.yaml
          - purchase_flow.yaml
        baseline_dir: ./baselines
  ```

---

## IPC Handlers

- [ ] Add playbook IPC handlers to `src/main/ipc/handlers/ios.ts`
  - [ ] Register `ios:playbook:list` handler
  - [ ] Register `ios:playbook:run` handler
  - [ ] Register `ios:playbook:stop` handler
  - [ ] Register `ios:playbook:status` handler

---

## Testing

- [x] Write unit tests for playbook loader
  > 38 tests covering directory creation, playbook loading, validation, listing, and helper functions in `src/main/ios-tools/__tests__/playbook-loader.test.ts`
- [ ] Write unit tests for playbook runner
- [ ] Write integration tests for each playbook
- [ ] Test variable resolution
- [ ] Test loop handling
- [ ] Test error handling

## Documentation

- [ ] Document each playbook with examples
- [ ] Document playbook YAML syntax
- [ ] Document how to create custom playbooks
- [ ] Document common components usage

## Acceptance Criteria

- [ ] Feature Ship Loop can iterate through build/test cycles
- [ ] Regression Check captures and compares screenshots
- [ ] Crash Hunt detects and reports crashes
- [ ] Design Review captures all screens on multiple devices
- [ ] Performance Check measures key metrics
- [ ] Playbooks work in Auto Run documents
- [ ] Custom playbooks can be created
- [ ] Progress is reported during execution
- [ ] Artifacts are collected and organized
