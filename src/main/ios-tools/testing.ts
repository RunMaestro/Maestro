/**
 * iOS Tools - Test Execution Operations
 *
 * Functions for running XCTest and XCUITest suites, parsing results,
 * and enumerating available tests in an Xcode project.
 */

import * as path from 'path';
import * as fs from 'fs';
import { IOSResult } from './types';
import { runXcodebuild, parseJson } from './utils';
import { logger } from '../utils/logger';
import { execFileNoThrow } from '../utils/execFile';

const LOG_CONTEXT = '[iOS-Testing]';

// =============================================================================
// Types
// =============================================================================

/**
 * Test run configuration options
 */
export interface TestRunOptions {
  /** Path to project or workspace */
  projectPath: string;
  /** Scheme to test */
  scheme: string;
  /** Destination - simulator UDID or destination string */
  destination?: string;
  /** Specific test classes to run (e.g., ["MyAppTests/testExample"]) */
  testClasses?: string[];
  /** Specific tests to skip */
  skipTests?: string[];
  /** Path to store .xcresult bundle */
  resultBundlePath?: string;
  /** Build configuration (default: Debug) */
  configuration?: 'Debug' | 'Release' | string;
  /** Derived data path override */
  derivedDataPath?: string;
  /** Whether to build before testing (default: true) */
  buildForTesting?: boolean;
  /** Maximum test run time in seconds */
  timeout?: number;
  /** Additional xcodebuild arguments */
  additionalArgs?: string[];
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables to pass to tests */
  testEnv?: Record<string, string>;
}

/**
 * Individual test case result
 */
export interface TestCaseResult {
  /** Test class name */
  className: string;
  /** Test method name */
  methodName: string;
  /** Full test identifier (className/methodName) */
  identifier: string;
  /** Test result status */
  status: 'passed' | 'failed' | 'skipped' | 'expected_failure';
  /** Duration in seconds */
  duration: number;
  /** Failure message if test failed */
  failureMessage?: string;
  /** File location of failure */
  failureLocation?: string;
  /** Performance metrics if any */
  performanceMetrics?: PerformanceMetric[];
}

/**
 * Performance metric from a test
 */
export interface PerformanceMetric {
  /** Metric name */
  name: string;
  /** Average value */
  average: number;
  /** Unit of measurement */
  unit: string;
  /** Individual measurements */
  measurements?: number[];
  /** Baseline value if set */
  baseline?: number;
  /** Max regression percentage */
  maxRegression?: number;
}

/**
 * Test suite result (grouping of test cases)
 */
export interface TestSuiteResult {
  /** Suite name (usually the test class) */
  name: string;
  /** Number of tests run */
  testCount: number;
  /** Number of tests passed */
  passedCount: number;
  /** Number of tests failed */
  failedCount: number;
  /** Number of tests skipped */
  skippedCount: number;
  /** Duration in seconds */
  duration: number;
  /** Individual test cases */
  testCases: TestCaseResult[];
}

/**
 * Complete test run result
 */
export interface TestRunResult {
  /** Whether all tests passed */
  success: boolean;
  /** Total number of tests run */
  totalTests: number;
  /** Number of tests passed */
  passedTests: number;
  /** Number of tests failed */
  failedTests: number;
  /** Number of tests skipped */
  skippedTests: number;
  /** Total duration in seconds */
  duration: number;
  /** Path to the .xcresult bundle */
  resultBundlePath?: string;
  /** Test suites */
  testSuites: TestSuiteResult[];
  /** Raw xcodebuild output (truncated if large) */
  rawOutput?: string;
  /** Build warnings */
  warnings: string[];
  /** Build/test errors */
  errors: string[];
  /** Destination used for tests */
  destination?: string;
}

/**
 * Test discovery result
 */
export interface TestInfo {
  /** Test class name */
  className: string;
  /** Test method names */
  methods: string[];
  /** Whether this is a UI test class */
  isUITest: boolean;
  /** Target the test belongs to */
  target: string;
}

/**
 * Parsed xcresult bundle information
 */
export interface XCResultInfo {
  /** Bundle path */
  path: string;
  /** When the result was created */
  created: Date;
  /** Overall status */
  status: 'succeeded' | 'failed' | 'mixed';
  /** Test plan run summaries */
  testSuites: TestSuiteResult[];
  /** Code coverage percentage if available */
  codeCoverage?: number;
  /** Destination info */
  destination?: {
    name: string;
    platform: string;
    osVersion: string;
  };
}

// =============================================================================
// Test Execution
// =============================================================================

/**
 * Run XCTest unit tests.
 *
 * @param options - Test run configuration
 * @returns Test run result with pass/fail status
 */
export async function runTests(options: TestRunOptions): Promise<IOSResult<TestRunResult>> {
  const startTime = Date.now();
  logger.info(`${LOG_CONTEXT} Running tests: ${options.projectPath} (scheme: ${options.scheme})`, LOG_CONTEXT);

  const projectArg = options.projectPath.endsWith('.xcworkspace')
    ? ['-workspace', options.projectPath]
    : ['-project', options.projectPath];

  const configuration = options.configuration || 'Debug';

  // Build the xcodebuild command arguments
  const args: string[] = [
    ...projectArg,
    '-scheme', options.scheme,
    '-configuration', configuration,
    '-sdk', 'iphonesimulator',
  ];

  // Add destination
  if (options.destination) {
    // Check if it's a UDID (looks like UUID) or a destination string
    if (options.destination.match(/^[A-F0-9-]{36}$/i)) {
      args.push('-destination', `id=${options.destination}`);
    } else {
      args.push('-destination', options.destination);
    }
  } else {
    // Default to any simulator
    args.push('-destination', 'platform=iOS Simulator,name=iPhone 15');
  }

  // Add result bundle path
  const resultPath = options.resultBundlePath || path.join(
    process.env.TMPDIR || '/tmp',
    `test-results-${Date.now()}.xcresult`
  );
  args.push('-resultBundlePath', resultPath);

  // Add derived data path if specified
  if (options.derivedDataPath) {
    args.push('-derivedDataPath', options.derivedDataPath);
  }

  // Add specific tests to run
  if (options.testClasses && options.testClasses.length > 0) {
    for (const test of options.testClasses) {
      args.push('-only-testing', test);
    }
  }

  // Add tests to skip
  if (options.skipTests && options.skipTests.length > 0) {
    for (const test of options.skipTests) {
      args.push('-skip-testing', test);
    }
  }

  // Add test action
  if (options.buildForTesting !== false) {
    args.push('test');
  } else {
    args.push('test-without-building');
  }

  // Add any additional arguments
  if (options.additionalArgs) {
    args.push(...options.additionalArgs);
  }

  const result = await runXcodebuild(args, options.cwd);
  const duration = (Date.now() - startTime) / 1000;

  // Parse warnings and errors from output
  const warnings = extractWarnings(result.stdout + '\n' + result.stderr);
  const errors = extractErrors(result.stdout + '\n' + result.stderr);

  // Try to parse test results from xcresult bundle
  let testSuites: TestSuiteResult[] = [];
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;

  if (fs.existsSync(resultPath)) {
    const parseResult = await parseTestResults(resultPath);
    if (parseResult.success && parseResult.data) {
      testSuites = parseResult.data.testSuites;
      totalTests = testSuites.reduce((sum, s) => sum + s.testCount, 0);
      passedTests = testSuites.reduce((sum, s) => sum + s.passedCount, 0);
      failedTests = testSuites.reduce((sum, s) => sum + s.failedCount, 0);
      skippedTests = testSuites.reduce((sum, s) => sum + s.skippedCount, 0);
    }
  } else {
    // Parse from output if xcresult not available
    const parsedOutput = parseTestOutputSummary(result.stdout + '\n' + result.stderr);
    totalTests = parsedOutput.total;
    passedTests = parsedOutput.passed;
    failedTests = parsedOutput.failed;
    skippedTests = parsedOutput.skipped;
  }

  const success = result.exitCode === 0 && failedTests === 0;

  logger.info(
    `${LOG_CONTEXT} Tests completed: ${passedTests}/${totalTests} passed, ${failedTests} failed in ${duration.toFixed(1)}s`,
    LOG_CONTEXT
  );

  return {
    success,
    data: {
      success,
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      duration,
      resultBundlePath: resultPath,
      testSuites,
      rawOutput: truncateOutput(result.stdout + '\n' + result.stderr),
      warnings,
      errors,
      destination: options.destination,
    },
    error: success ? undefined : `${failedTests} test(s) failed`,
    errorCode: success ? undefined : 'TEST_FAILED',
  };
}

/**
 * Run XCUITest UI tests.
 * Convenience wrapper around runTests with UI-specific defaults.
 *
 * @param options - Test run configuration
 * @returns Test run result
 */
export async function runUITests(options: TestRunOptions): Promise<IOSResult<TestRunResult>> {
  logger.info(`${LOG_CONTEXT} Running UI tests: ${options.scheme}`, LOG_CONTEXT);

  // UI tests typically need a longer timeout
  return runTests({
    ...options,
    timeout: options.timeout || 600, // 10 minute default for UI tests
    additionalArgs: [
      ...(options.additionalArgs || []),
      // Enable UI test parallel execution on simulators if desired
    ],
  });
}

// =============================================================================
// Test Result Parsing
// =============================================================================

/**
 * Parse a .xcresult bundle to extract test results.
 *
 * @param resultBundlePath - Path to the .xcresult bundle
 * @returns Parsed result information
 */
export async function parseTestResults(resultBundlePath: string): Promise<IOSResult<XCResultInfo>> {
  logger.info(`${LOG_CONTEXT} Parsing test results: ${resultBundlePath}`, LOG_CONTEXT);

  if (!fs.existsSync(resultBundlePath)) {
    return {
      success: false,
      error: `Result bundle not found: ${resultBundlePath}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  // Use xcresulttool to get the action results
  const result = await execFileNoThrow(
    'xcrun',
    ['xcresulttool', 'get', '--format', 'json', '--path', resultBundlePath]
  );

  if (result.exitCode !== 0) {
    // Try the legacy format for older Xcode versions
    return parseTestResultsLegacy(resultBundlePath);
  }

  const parseResult = parseJson<XCResultRootObject>(result.stdout);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error,
      errorCode: 'PARSE_ERROR',
    };
  }

  const rootObject = parseResult.data!;

  // Extract test suites from actions
  const testSuites = await extractTestSuites(resultBundlePath, rootObject);

  // Determine overall status
  const status = testSuites.some(s => s.failedCount > 0)
    ? (testSuites.some(s => s.passedCount > 0) ? 'mixed' : 'failed')
    : 'succeeded';

  // Get bundle creation time
  const stats = fs.statSync(resultBundlePath);

  // Try to extract destination info
  let destination: XCResultInfo['destination'] | undefined;
  try {
    const destInfo = extractDestinationInfo(rootObject);
    if (destInfo) {
      destination = destInfo;
    }
  } catch {
    // Destination info is optional
  }

  return {
    success: true,
    data: {
      path: resultBundlePath,
      created: stats.mtime,
      status,
      testSuites,
      destination,
    },
  };
}

/**
 * Fallback parser for older xcresult format or when xcresulttool fails
 */
async function parseTestResultsLegacy(resultBundlePath: string): Promise<IOSResult<XCResultInfo>> {
  logger.info(`${LOG_CONTEXT} Trying legacy xcresult parsing`, LOG_CONTEXT);

  // Try to get test summaries using xcresulttool with older format
  const result = await execFileNoThrow(
    'xcrun',
    ['xcresulttool', 'get', 'test-results', 'tests', '--path', resultBundlePath, '--format', 'json']
  );

  if (result.exitCode !== 0) {
    // If both fail, return basic info from folder structure
    return {
      success: true,
      data: {
        path: resultBundlePath,
        created: fs.statSync(resultBundlePath).mtime,
        status: 'failed', // Assume failed if we can't parse
        testSuites: [],
      },
    };
  }

  // Parse the legacy format
  const parseResult = parseJson<LegacyTestResults>(result.stdout);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error,
      errorCode: 'PARSE_ERROR',
    };
  }

  const testSuites = parseLegacyTestSuites(parseResult.data!);
  const status = testSuites.some(s => s.failedCount > 0)
    ? (testSuites.some(s => s.passedCount > 0) ? 'mixed' : 'failed')
    : 'succeeded';

  return {
    success: true,
    data: {
      path: resultBundlePath,
      created: fs.statSync(resultBundlePath).mtime,
      status,
      testSuites,
    },
  };
}

// =============================================================================
// Test Discovery
// =============================================================================

/**
 * List available tests in a project for a given scheme.
 *
 * @param projectPath - Path to project or workspace
 * @param scheme - Scheme to enumerate tests for
 * @returns Array of test class information
 */
export async function listTests(
  projectPath: string,
  scheme: string
): Promise<IOSResult<TestInfo[]>> {
  logger.info(`${LOG_CONTEXT} Listing tests for scheme: ${scheme}`, LOG_CONTEXT);

  const projectArg = projectPath.endsWith('.xcworkspace')
    ? ['-workspace', projectPath]
    : ['-project', projectPath];

  // Use -showTestInfo to get test information
  const result = await runXcodebuild([
    ...projectArg,
    '-scheme', scheme,
    '-sdk', 'iphonesimulator',
    '-destination', 'platform=iOS Simulator,name=iPhone 15',
    '-showTestInfo',
    '-json',
  ]);

  if (result.exitCode !== 0) {
    // Fallback: Try to enumerate tests by building for testing and inspecting
    return listTestsByBuilding(projectPath, scheme);
  }

  const parseResult = parseJson<TestInfoResponse>(result.stdout);
  if (!parseResult.success) {
    return listTestsByBuilding(projectPath, scheme);
  }

  const testInfos: TestInfo[] = [];
  const response = parseResult.data!;

  if (response.testPlan?.testTargets) {
    for (const target of response.testPlan.testTargets) {
      for (const testClass of target.testClasses || []) {
        testInfos.push({
          className: testClass.name,
          methods: testClass.testMethods?.map(m => m.name) || [],
          isUITest: testClass.name.includes('UITest') || target.name?.includes('UITest') || false,
          target: target.name || 'Unknown',
        });
      }
    }
  }

  logger.info(`${LOG_CONTEXT} Found ${testInfos.length} test classes`, LOG_CONTEXT);

  return {
    success: true,
    data: testInfos,
  };
}

/**
 * Alternative test listing by building for testing
 */
async function listTestsByBuilding(
  projectPath: string,
  scheme: string
): Promise<IOSResult<TestInfo[]>> {
  logger.info(`${LOG_CONTEXT} Listing tests via build-for-testing`, LOG_CONTEXT);

  const projectArg = projectPath.endsWith('.xcworkspace')
    ? ['-workspace', projectPath]
    : ['-project', projectPath];

  // Build for testing to get the xctestrun file
  const result = await runXcodebuild([
    ...projectArg,
    '-scheme', scheme,
    '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator',
    'build-for-testing',
    '-dry-run',
  ]);

  // Parse test information from output
  const testInfos = parseTestsFromBuildOutput(result.stdout);

  return {
    success: true,
    data: testInfos,
  };
}

// =============================================================================
// Helper Functions - Output Parsing
// =============================================================================

/**
 * Extract warning messages from xcodebuild output.
 */
function extractWarnings(output: string): string[] {
  const warnings: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (line.includes(': warning:') || line.includes('⚠️')) {
      const match = line.match(/(?:warning:\s*)(.+)/i);
      if (match) {
        warnings.push(match[1].trim());
      } else {
        warnings.push(line.trim());
      }
    }
  }

  return [...new Set(warnings)]; // Deduplicate
}

/**
 * Extract error messages from xcodebuild output.
 */
function extractErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (line.includes(': error:') || line.includes('❌')) {
      const match = line.match(/(?:error:\s*)(.+)/i);
      if (match) {
        errors.push(match[1].trim());
      } else {
        errors.push(line.trim());
      }
    }
  }

  return [...new Set(errors)]; // Deduplicate
}

/**
 * Parse test summary from xcodebuild output
 */
function parseTestOutputSummary(output: string): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  // Look for patterns like:
  // "Executed 10 tests, with 2 failures (0 unexpected) in 5.123 (5.456) seconds"
  // "Test Suite 'All tests' passed at ..."
  const result = { total: 0, passed: 0, failed: 0, skipped: 0 };

  // Try to match the summary line
  const summaryMatch = output.match(
    /Executed (\d+) tests?, with (\d+) failures? \((\d+) unexpected\) in/
  );

  if (summaryMatch) {
    result.total = parseInt(summaryMatch[1], 10);
    result.failed = parseInt(summaryMatch[2], 10);
    result.passed = result.total - result.failed;
    return result;
  }

  // Count individual test results
  const passedMatches = output.match(/Test Case .+passed/g);
  const failedMatches = output.match(/Test Case .+failed/g);

  if (passedMatches) {
    result.passed = passedMatches.length;
  }
  if (failedMatches) {
    result.failed = failedMatches.length;
  }
  result.total = result.passed + result.failed;

  return result;
}

/**
 * Truncate output if too large
 */
function truncateOutput(output: string, maxLength: number = 50000): string {
  if (output.length <= maxLength) {
    return output;
  }
  return output.slice(0, maxLength) + '\n... [truncated]';
}

/**
 * Parse tests from build output
 */
function parseTestsFromBuildOutput(output: string): TestInfo[] {
  const testInfos: TestInfo[] = [];
  const lines = output.split('\n');

  // Look for test class patterns
  const classPattern = /Testing: (\w+Tests?)(?:\/(\w+))?/;

  for (const line of lines) {
    const match = line.match(classPattern);
    if (match) {
      const className = match[1];
      let existing = testInfos.find(t => t.className === className);

      if (!existing) {
        existing = {
          className,
          methods: [],
          isUITest: className.includes('UITest'),
          target: 'Unknown',
        };
        testInfos.push(existing);
      }

      if (match[2]) {
        existing.methods.push(match[2]);
      }
    }
  }

  return testInfos;
}

// =============================================================================
// Helper Functions - XCResult Parsing
// =============================================================================

/**
 * Root object from xcresulttool JSON output
 */
interface XCResultRootObject {
  _type?: { _name: string };
  actions?: {
    _values?: XCResultAction[];
  };
  metrics?: {
    testsCount?: { _value: string };
    testsFailedCount?: { _value: string };
  };
}

interface XCResultAction {
  _type?: { _name: string };
  schemeCommandName?: { _value: string };
  actionResult?: {
    testsRef?: { id: { _value: string } };
  };
  runDestination?: {
    displayName?: { _value: string };
    targetDeviceRecord?: {
      modelName?: { _value: string };
      operatingSystemVersion?: { _value: string };
    };
  };
}

interface LegacyTestResults {
  tests?: LegacyTestNode[];
}

interface LegacyTestNode {
  name?: string;
  identifier?: string;
  status?: string;
  duration?: number;
  subtests?: LegacyTestNode[];
}

interface TestInfoResponse {
  testPlan?: {
    testTargets?: Array<{
      name?: string;
      testClasses?: Array<{
        name: string;
        testMethods?: Array<{ name: string }>;
      }>;
    }>;
  };
}

/**
 * Extract test suites from xcresult root object
 */
async function extractTestSuites(
  resultPath: string,
  rootObject: XCResultRootObject
): Promise<TestSuiteResult[]> {
  const suites: TestSuiteResult[] = [];

  // Get the test reference ID from the action
  let testRefId: string | undefined;
  if (rootObject.actions?._values) {
    for (const action of rootObject.actions._values) {
      if (action.actionResult?.testsRef?.id?._value) {
        testRefId = action.actionResult.testsRef.id._value;
        break;
      }
    }
  }

  if (!testRefId) {
    // Try using xcresulttool to get test summaries directly
    const summaryResult = await execFileNoThrow(
      'xcrun',
      ['xcresulttool', 'get', 'test-results', 'summary', '--path', resultPath, '--format', 'json']
    );

    if (summaryResult.exitCode === 0) {
      const parsed = parseJson<{ testSummaries?: TestSummaryNode[] }>(summaryResult.stdout);
      if (parsed.success && parsed.data?.testSummaries) {
        return parseTestSummaryNodes(parsed.data.testSummaries);
      }
    }

    return suites;
  }

  // Export the test details using the reference ID
  const detailResult = await execFileNoThrow(
    'xcrun',
    ['xcresulttool', 'get', '--format', 'json', '--path', resultPath, '--id', testRefId]
  );

  if (detailResult.exitCode !== 0) {
    return suites;
  }

  const testDetails = parseJson<TestDetailsRoot>(detailResult.stdout);
  if (!testDetails.success || !testDetails.data) {
    return suites;
  }

  // Parse the test details into suites
  return parseTestDetails(testDetails.data);
}

interface TestSummaryNode {
  name?: string;
  duration?: number;
  status?: string;
  subtests?: TestSummaryNode[];
}

interface TestDetailsRoot {
  summaries?: {
    _values?: Array<{
      testableSummaries?: {
        _values?: Array<{
          name?: { _value: string };
          tests?: { _values?: TestNode[] };
        }>;
      };
    }>;
  };
}

interface TestNode {
  _type?: { _name: string };
  name?: { _value: string };
  identifier?: { _value: string };
  duration?: { _value: string };
  testStatus?: { _value: string };
  subtests?: { _values?: TestNode[] };
  summaryRef?: { id: { _value: string } };
}

function parseTestDetails(root: TestDetailsRoot): TestSuiteResult[] {
  const suites: TestSuiteResult[] = [];

  const summaries = root.summaries?._values;
  if (!summaries) return suites;

  for (const summary of summaries) {
    const testableSummaries = summary.testableSummaries?._values;
    if (!testableSummaries) continue;

    for (const testable of testableSummaries) {
      const tests = testable.tests?._values;
      if (!tests) continue;

      for (const testNode of tests) {
        const suite = parseTestNode(testNode);
        if (suite) {
          suites.push(suite);
        }
      }
    }
  }

  return suites;
}

function parseTestNode(node: TestNode, _parentName = ''): TestSuiteResult | null {
  const name = node.name?._value || 'Unknown';

  // Check if this is a test case (leaf node) or a suite (has subtests)
  if (!node.subtests?._values || node.subtests._values.length === 0) {
    // This is a test case, not a suite
    return null;
  }

  const testCases: TestCaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const subtest of node.subtests._values) {
    if (subtest.subtests?._values && subtest.subtests._values.length > 0) {
      // Nested suite, recurse
      const nestedSuite = parseTestNode(subtest, name);
      if (nestedSuite) {
        testCases.push(...nestedSuite.testCases);
        passedCount += nestedSuite.passedCount;
        failedCount += nestedSuite.failedCount;
        skippedCount += nestedSuite.skippedCount;
      }
    } else {
      // Test case
      const status = mapTestStatus(subtest.testStatus?._value);
      const methodName = subtest.name?._value || 'unknown';
      const duration = parseFloat(subtest.duration?._value || '0');

      testCases.push({
        className: name,
        methodName,
        identifier: `${name}/${methodName}`,
        status,
        duration,
      });

      switch (status) {
        case 'passed':
          passedCount++;
          break;
        case 'failed':
          failedCount++;
          break;
        case 'skipped':
          skippedCount++;
          break;
      }
    }
  }

  const totalDuration = testCases.reduce((sum, tc) => sum + tc.duration, 0);

  return {
    name,
    testCount: testCases.length,
    passedCount,
    failedCount,
    skippedCount,
    duration: totalDuration,
    testCases,
  };
}

function mapTestStatus(status?: string): TestCaseResult['status'] {
  switch (status?.toLowerCase()) {
    case 'success':
    case 'passed':
      return 'passed';
    case 'failure':
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'expected failure':
    case 'expectedfailure':
      return 'expected_failure';
    default:
      return 'skipped';
  }
}

function parseTestSummaryNodes(nodes: TestSummaryNode[]): TestSuiteResult[] {
  const suites: TestSuiteResult[] = [];

  for (const node of nodes) {
    if (node.subtests && node.subtests.length > 0) {
      const suite = parseSummaryNodeAsSuite(node);
      if (suite) {
        suites.push(suite);
      }
    }
  }

  return suites;
}

function parseSummaryNodeAsSuite(node: TestSummaryNode): TestSuiteResult | null {
  const name = node.name || 'Unknown';
  const testCases: TestCaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const subtest of node.subtests || []) {
    if (subtest.subtests && subtest.subtests.length > 0) {
      // Nested suite
      const nested = parseSummaryNodeAsSuite(subtest);
      if (nested) {
        testCases.push(...nested.testCases);
        passedCount += nested.passedCount;
        failedCount += nested.failedCount;
        skippedCount += nested.skippedCount;
      }
    } else {
      // Test case
      const status = mapTestStatus(subtest.status);
      testCases.push({
        className: name,
        methodName: subtest.name || 'unknown',
        identifier: `${name}/${subtest.name || 'unknown'}`,
        status,
        duration: subtest.duration || 0,
      });

      switch (status) {
        case 'passed':
          passedCount++;
          break;
        case 'failed':
          failedCount++;
          break;
        case 'skipped':
          skippedCount++;
          break;
      }
    }
  }

  return {
    name,
    testCount: testCases.length,
    passedCount,
    failedCount,
    skippedCount,
    duration: node.duration || 0,
    testCases,
  };
}

function parseLegacyTestSuites(results: LegacyTestResults): TestSuiteResult[] {
  if (!results.tests) return [];

  const suites: TestSuiteResult[] = [];

  for (const test of results.tests) {
    const suite = parseLegacyTestNode(test);
    if (suite) {
      suites.push(suite);
    }
  }

  return suites;
}

function parseLegacyTestNode(node: LegacyTestNode): TestSuiteResult | null {
  const name = node.name || 'Unknown';

  if (!node.subtests || node.subtests.length === 0) {
    return null;
  }

  const testCases: TestCaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const subtest of node.subtests) {
    if (subtest.subtests && subtest.subtests.length > 0) {
      const nested = parseLegacyTestNode(subtest);
      if (nested) {
        testCases.push(...nested.testCases);
        passedCount += nested.passedCount;
        failedCount += nested.failedCount;
        skippedCount += nested.skippedCount;
      }
    } else {
      const status = mapTestStatus(subtest.status);
      testCases.push({
        className: name,
        methodName: subtest.name || 'unknown',
        identifier: subtest.identifier || `${name}/${subtest.name || 'unknown'}`,
        status,
        duration: subtest.duration || 0,
      });

      switch (status) {
        case 'passed':
          passedCount++;
          break;
        case 'failed':
          failedCount++;
          break;
        case 'skipped':
          skippedCount++;
          break;
      }
    }
  }

  return {
    name,
    testCount: testCases.length,
    passedCount,
    failedCount,
    skippedCount,
    duration: node.duration || 0,
    testCases,
  };
}

function extractDestinationInfo(rootObject: XCResultRootObject): XCResultInfo['destination'] | undefined {
  if (!rootObject.actions?._values) return undefined;

  for (const action of rootObject.actions._values) {
    const dest = action.runDestination;
    if (dest) {
      return {
        name: dest.displayName?._value || 'Unknown',
        platform: 'iOS Simulator',
        osVersion: dest.targetDeviceRecord?.operatingSystemVersion?._value || 'Unknown',
      };
    }
  }

  return undefined;
}
