import Foundation

/// Result types for action execution.
/// These structures are serialized to JSON for consumption by TypeScript/Node.js.

// MARK: - Output Markers

/// Markers for extracting JSON from mixed output
enum ActionOutputMarker {
    static let start = "===MAESTRO_ACTION_RESULT_START==="
    static let end = "===MAESTRO_ACTION_RESULT_END==="
}

// MARK: - Result Types

/// Status of action execution
enum ActionStatus: String, Codable {
    case success
    case failed
    case timeout
    case notFound
    case notHittable
    case notEnabled
    case error
}

/// Result of a single action execution
struct ActionResult: Codable {
    /// Whether the action succeeded
    let success: Bool

    /// Status code for the action
    let status: ActionStatus

    /// Type of action that was executed
    let actionType: ActionType

    /// Duration of the action in milliseconds
    let duration: Int

    /// Error message if failed
    let error: String?

    /// Additional details about the action
    let details: ActionDetails?

    /// Timestamp when action completed
    let timestamp: String

    init(
        success: Bool,
        status: ActionStatus,
        actionType: ActionType,
        duration: Int,
        error: String? = nil,
        details: ActionDetails? = nil
    ) {
        self.success = success
        self.status = status
        self.actionType = actionType
        self.duration = duration
        self.error = error
        self.details = details

        let formatter = ISO8601DateFormatter()
        self.timestamp = formatter.string(from: Date())
    }

    /// Create a success result
    static func succeeded(
        actionType: ActionType,
        duration: Int,
        details: ActionDetails? = nil
    ) -> ActionResult {
        ActionResult(
            success: true,
            status: .success,
            actionType: actionType,
            duration: duration,
            details: details
        )
    }

    /// Create a failure result
    static func failed(
        actionType: ActionType,
        duration: Int,
        error: String,
        status: ActionStatus = .failed,
        details: ActionDetails? = nil
    ) -> ActionResult {
        ActionResult(
            success: false,
            status: status,
            actionType: actionType,
            duration: duration,
            error: error,
            details: details
        )
    }

    /// Create a timeout result
    static func timedOut(
        actionType: ActionType,
        duration: Int,
        target: String
    ) -> ActionResult {
        ActionResult(
            success: false,
            status: .timeout,
            actionType: actionType,
            duration: duration,
            error: "Timeout waiting for element: \(target)"
        )
    }

    /// Create a not found result
    static func elementNotFound(
        actionType: ActionType,
        duration: Int,
        target: String,
        suggestions: [String]? = nil
    ) -> ActionResult {
        ActionResult(
            success: false,
            status: .notFound,
            actionType: actionType,
            duration: duration,
            error: "Element not found: \(target)",
            details: suggestions != nil ? ActionDetails(suggestions: suggestions) : nil
        )
    }

    /// Create a not hittable result
    static func notHittable(
        actionType: ActionType,
        duration: Int,
        target: String,
        reason: String? = nil
    ) -> ActionResult {
        var error = "Element not hittable: \(target)"
        if let reason = reason {
            error += " (\(reason))"
        }
        return ActionResult(
            success: false,
            status: .notHittable,
            actionType: actionType,
            duration: duration,
            error: error
        )
    }
}

// MARK: - Action Details

/// Additional details about action execution
struct ActionDetails: Codable {
    /// Element that was acted upon
    let element: ElementInfo?

    /// Suggestions for similar elements (on not found)
    let suggestions: [String]?

    /// Text that was typed
    let typedText: String?

    /// Number of scroll attempts made
    let scrollAttempts: Int?

    /// Direction of scroll/swipe
    let direction: String?

    /// Screenshot path if captured
    let screenshotPath: String?

    init(
        element: ElementInfo? = nil,
        suggestions: [String]? = nil,
        typedText: String? = nil,
        scrollAttempts: Int? = nil,
        direction: String? = nil,
        screenshotPath: String? = nil
    ) {
        self.element = element
        self.suggestions = suggestions
        self.typedText = typedText
        self.scrollAttempts = scrollAttempts
        self.direction = direction
        self.screenshotPath = screenshotPath
    }
}

/// Basic element information
struct ElementInfo: Codable {
    let type: String
    let identifier: String?
    let label: String?
    let value: String?
    let frame: FrameInfo?
    let isEnabled: Bool
    let isHittable: Bool

    init(from element: XCUIElement) {
        self.type = String(describing: element.elementType)
        self.identifier = element.identifier.isEmpty ? nil : element.identifier
        self.label = element.label.isEmpty ? nil : element.label
        self.value = element.value as? String
        self.frame = FrameInfo(from: element.frame)
        self.isEnabled = element.isEnabled
        self.isHittable = element.isHittable
    }
}

/// Frame information for element
struct FrameInfo: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(from rect: CGRect) {
        self.x = Double(rect.origin.x)
        self.y = Double(rect.origin.y)
        self.width = Double(rect.size.width)
        self.height = Double(rect.size.height)
    }
}

// MARK: - Batch Result

/// Result of executing multiple actions
struct BatchActionResult: Codable {
    /// Whether all actions succeeded
    let allPassed: Bool

    /// Total number of actions
    let totalActions: Int

    /// Number of successful actions
    let passedActions: Int

    /// Number of failed actions
    let failedActions: Int

    /// Total duration in milliseconds
    let totalDuration: Int

    /// Individual action results
    let results: [ActionResult]

    /// Timestamp when batch completed
    let timestamp: String

    init(results: [ActionResult]) {
        self.results = results
        self.totalActions = results.count
        self.passedActions = results.filter { $0.success }.count
        self.failedActions = results.count - self.passedActions
        self.allPassed = self.failedActions == 0
        self.totalDuration = results.reduce(0) { $0 + $1.duration }

        let formatter = ISO8601DateFormatter()
        self.timestamp = formatter.string(from: Date())
    }
}

// MARK: - Output Writer

/// Writes action results to stdout/file with markers
enum ActionOutputWriter {
    /// Write a single result to stdout with markers
    static func writeToStdout(_ result: ActionResult) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        do {
            let data = try encoder.encode(result)
            if let json = String(data: data, encoding: .utf8) {
                print(ActionOutputMarker.start)
                print(json)
                print(ActionOutputMarker.end)
            }
        } catch {
            print(ActionOutputMarker.start)
            print("""
            {
                "success": false,
                "status": "error",
                "error": "Failed to encode result: \(error.localizedDescription)"
            }
            """)
            print(ActionOutputMarker.end)
        }
    }

    /// Write a batch result to stdout with markers
    static func writeToStdout(_ result: BatchActionResult) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        do {
            let data = try encoder.encode(result)
            if let json = String(data: data, encoding: .utf8) {
                print(ActionOutputMarker.start)
                print(json)
                print(ActionOutputMarker.end)
            }
        } catch {
            print(ActionOutputMarker.start)
            print("""
            {
                "allPassed": false,
                "error": "Failed to encode batch result: \(error.localizedDescription)"
            }
            """)
            print(ActionOutputMarker.end)
        }
    }

    /// Write a result to a file
    static func writeToFile(_ result: ActionResult, path: String) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        do {
            let data = try encoder.encode(result)
            try data.write(to: URL(fileURLWithPath: path))
        } catch {
            // Write error to stdout
            writeError("Failed to write result to \(path): \(error.localizedDescription)")
        }
    }

    /// Write an error message
    static func writeError(_ message: String) {
        print(ActionOutputMarker.start)
        print("""
        {
            "success": false,
            "status": "error",
            "error": "\(message.replacingOccurrences(of: "\"", with: "\\\""))"
        }
        """)
        print(ActionOutputMarker.end)
    }
}

// MARK: - XCUIElement Extension for ElementInfo

import XCTest

extension XCUIElement {
    /// Get element type as string
    var elementTypeString: String {
        String(describing: self.elementType).replacingOccurrences(of: "XCUIElement.ElementType.", with: "")
    }
}
