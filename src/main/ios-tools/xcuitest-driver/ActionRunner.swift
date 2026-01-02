import XCTest

/// Main action executor for XCUITest-based UI automation.
/// Executes actions on iOS UI elements and returns structured results.
///
/// This class is designed to be invoked from an XCUITest target and communicate
/// results back to TypeScript/Node.js via JSON output.

// MARK: - Action Runner

class ActionRunner {
    /// The application under test
    let app: XCUIApplication

    /// Default timeout for element operations (seconds)
    var defaultTimeout: TimeInterval = 10.0

    /// Whether to take screenshots on failure
    var screenshotOnFailure: Bool = true

    /// Directory for screenshots
    var screenshotDir: String?

    init(app: XCUIApplication) {
        self.app = app
    }

    /// Initialize with bundle identifier
    convenience init(bundleId: String) {
        let app = XCUIApplication(bundleIdentifier: bundleId)
        self.init(app: app)
    }

    // MARK: - Public API

    /// Execute a single action request
    func execute(_ request: ActionRequest) -> ActionResult {
        let startTime = Date()

        do {
            let result = try executeAction(request)
            return result
        } catch let error as ActionError {
            let duration = Int(Date().timeIntervalSince(startTime) * 1000)
            return ActionResult.failed(
                actionType: request.type,
                duration: duration,
                error: error.message,
                status: error.status
            )
        } catch {
            let duration = Int(Date().timeIntervalSince(startTime) * 1000)
            return ActionResult.failed(
                actionType: request.type,
                duration: duration,
                error: error.localizedDescription,
                status: .error
            )
        }
    }

    /// Execute multiple actions in sequence
    func executeAll(_ requests: [ActionRequest], stopOnFailure: Bool = true) -> BatchActionResult {
        var results: [ActionResult] = []

        for request in requests {
            let result = execute(request)
            results.append(result)

            if !result.success && stopOnFailure {
                break
            }
        }

        return BatchActionResult(results: results)
    }

    // MARK: - Action Execution

    private func executeAction(_ request: ActionRequest) throws -> ActionResult {
        let startTime = Date()

        switch request.type {
        case .tap:
            return try executeTap(request, startTime: startTime)

        case .doubleTap:
            return try executeDoubleTap(request, startTime: startTime)

        case .longPress:
            return try executeLongPress(request, startTime: startTime)

        case .typeText:
            return try executeTypeText(request, startTime: startTime)

        case .clearText:
            return try executeClearText(request, startTime: startTime)

        case .scroll:
            return try executeScroll(request, startTime: startTime)

        case .scrollTo:
            return try executeScrollTo(request, startTime: startTime)

        case .swipe:
            return try executeSwipe(request, startTime: startTime)

        case .pinch:
            return try executePinch(request, startTime: startTime)

        case .rotate:
            return try executeRotate(request, startTime: startTime)

        case .waitForElement:
            return try executeWaitForElement(request, startTime: startTime)

        case .waitForNotExist:
            return try executeWaitForNotExist(request, startTime: startTime)

        case .assertExists:
            return try executeAssertExists(request, startTime: startTime)

        case .assertNotExists:
            return try executeAssertNotExists(request, startTime: startTime)

        case .assertEnabled:
            return try executeAssertEnabled(request, startTime: startTime)

        case .assertDisabled:
            return try executeAssertDisabled(request, startTime: startTime)
        }
    }

    // MARK: - Tap Actions

    private func executeTap(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "Tap action requires a target")
        }

        let element = try findElement(target)
        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        // Verify element is hittable
        guard element.isHittable else {
            throw ActionError(
                status: .notHittable,
                message: "Element is not hittable",
                element: element
            )
        }

        // Perform tap with optional offset
        if let offsetX = request.offsetX, let offsetY = request.offsetY {
            let coordinate = element.coordinate(withNormalizedOffset: CGVector(dx: offsetX, dy: offsetY))
            coordinate.tap()
        } else {
            element.tap()
        }

        return ActionResult.succeeded(
            actionType: .tap,
            duration: duration,
            details: ActionDetails(element: ElementInfo(from: element))
        )
    }

    private func executeDoubleTap(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "DoubleTap action requires a target")
        }

        let element = try findElement(target)
        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        guard element.isHittable else {
            throw ActionError(status: .notHittable, message: "Element is not hittable", element: element)
        }

        element.doubleTap()

        return ActionResult.succeeded(
            actionType: .doubleTap,
            duration: duration,
            details: ActionDetails(element: ElementInfo(from: element))
        )
    }

    private func executeLongPress(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "LongPress action requires a target")
        }

        let element = try findElement(target)
        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        guard element.isHittable else {
            throw ActionError(status: .notHittable, message: "Element is not hittable", element: element)
        }

        let pressDuration = request.duration ?? 1.0
        element.press(forDuration: pressDuration)

        return ActionResult.succeeded(
            actionType: .longPress,
            duration: duration,
            details: ActionDetails(element: ElementInfo(from: element))
        )
    }

    // MARK: - Text Actions

    private func executeTypeText(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let text = request.text else {
            throw ActionError(status: .error, message: "TypeText action requires text")
        }

        // If target specified, find and tap it first
        if let target = request.target {
            let element = try findElement(target)

            guard element.isHittable else {
                throw ActionError(status: .notHittable, message: "Element is not hittable", element: element)
            }

            element.tap()

            // Clear if requested
            if request.clearFirst == true {
                clearTextInElement(element)
            }
        }

        // Type the text
        app.typeText(text)

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .typeText,
            duration: duration,
            details: ActionDetails(typedText: text)
        )
    }

    private func executeClearText(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "ClearText action requires a target")
        }

        let element = try findElement(target)

        guard element.isHittable else {
            throw ActionError(status: .notHittable, message: "Element is not hittable", element: element)
        }

        clearTextInElement(element)

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .clearText,
            duration: duration,
            details: ActionDetails(element: ElementInfo(from: element))
        )
    }

    /// Clear text from an element using select all + delete
    private func clearTextInElement(_ element: XCUIElement) {
        element.tap()

        // Try to select all using keyboard shortcut (may not work on all devices)
        // Then delete the selection
        if let value = element.value as? String, !value.isEmpty {
            // Triple tap to select all
            element.tap(withNumberOfTaps: 3, numberOfTouches: 1)

            // Delete selected text
            app.keys["delete"].tap()

            // Alternative: type delete for each character
            // This is more reliable but slower
            // for _ in value {
            //     app.keys["delete"].tap()
            // }
        }
    }

    // MARK: - Scroll Actions

    private func executeScroll(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        let direction = request.direction ?? .down
        let distance = request.distance ?? 0.5

        // Find scroll target or use first scroll view
        let scrollView: XCUIElement
        if let target = request.target {
            scrollView = try findElement(target)
        } else {
            // Find first scroll view, table, or collection view
            let scrollViews = app.scrollViews.allElementsBoundByIndex
            let tables = app.tables.allElementsBoundByIndex
            let collections = app.collectionViews.allElementsBoundByIndex

            if let first = scrollViews.first {
                scrollView = first
            } else if let first = tables.first {
                scrollView = first
            } else if let first = collections.first {
                scrollView = first
            } else {
                // Use the main window
                scrollView = app.windows.firstMatch
            }
        }

        // Perform scroll
        performScroll(on: scrollView, direction: direction, distance: distance)

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .scroll,
            duration: duration,
            details: ActionDetails(direction: direction.rawValue)
        )
    }

    private func executeScrollTo(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "ScrollTo action requires a target")
        }

        let direction = request.direction ?? .down
        let maxAttempts = request.maxAttempts ?? 10

        var attempts = 0

        while attempts < maxAttempts {
            // Check if element exists and is visible
            let element = try? findElement(target, timeout: 1.0)
            if let el = element, el.isHittable {
                let duration = Int(Date().timeIntervalSince(startTime) * 1000)
                return ActionResult.succeeded(
                    actionType: .scrollTo,
                    duration: duration,
                    details: ActionDetails(
                        element: ElementInfo(from: el),
                        scrollAttempts: attempts
                    )
                )
            }

            // Scroll in the specified direction
            let scrollView = app.scrollViews.firstMatch.exists
                ? app.scrollViews.firstMatch
                : app.windows.firstMatch

            performScroll(on: scrollView, direction: direction, distance: 0.5)
            attempts += 1

            // Small delay between scroll attempts
            Thread.sleep(forTimeInterval: 0.3)
        }

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)
        throw ActionError(
            status: .notFound,
            message: "Element not found after \(maxAttempts) scroll attempts"
        )
    }

    private func performScroll(on element: XCUIElement, direction: SwipeDirection, distance: Double) {
        let startOffset: CGVector
        let endOffset: CGVector

        switch direction {
        case .up:
            startOffset = CGVector(dx: 0.5, dy: 0.3)
            endOffset = CGVector(dx: 0.5, dy: 0.3 + distance)
        case .down:
            startOffset = CGVector(dx: 0.5, dy: 0.7)
            endOffset = CGVector(dx: 0.5, dy: 0.7 - distance)
        case .left:
            startOffset = CGVector(dx: 0.3, dy: 0.5)
            endOffset = CGVector(dx: 0.3 + distance, dy: 0.5)
        case .right:
            startOffset = CGVector(dx: 0.7, dy: 0.5)
            endOffset = CGVector(dx: 0.7 - distance, dy: 0.5)
        }

        let startCoordinate = element.coordinate(withNormalizedOffset: startOffset)
        let endCoordinate = element.coordinate(withNormalizedOffset: endOffset)

        startCoordinate.press(forDuration: 0.05, thenDragTo: endCoordinate)
    }

    // MARK: - Swipe Actions

    private func executeSwipe(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        let direction = request.direction ?? .up
        let velocity = request.velocity ?? .normal

        let element: XCUIElement
        if let target = request.target {
            element = try findElement(target)
        } else {
            element = app.windows.firstMatch
        }

        switch direction {
        case .up:
            element.swipeUp(velocity: velocity.value)
        case .down:
            element.swipeDown(velocity: velocity.value)
        case .left:
            element.swipeLeft(velocity: velocity.value)
        case .right:
            element.swipeRight(velocity: velocity.value)
        }

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .swipe,
            duration: duration,
            details: ActionDetails(direction: direction.rawValue)
        )
    }

    // MARK: - Gesture Actions

    private func executePinch(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        let scale = request.scale ?? 2.0
        let velocity = request.velocity ?? 1.0

        let element: XCUIElement
        if let target = request.target {
            element = try findElement(target)
        } else {
            element = app.windows.firstMatch
        }

        element.pinch(withScale: CGFloat(scale), velocity: CGFloat(velocity))

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .pinch,
            duration: duration
        )
    }

    private func executeRotate(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        let angle = request.angle ?? (.pi / 4)  // 45 degrees default
        let velocity = request.velocity ?? 1.0

        let element: XCUIElement
        if let target = request.target {
            element = try findElement(target)
        } else {
            element = app.windows.firstMatch
        }

        element.rotate(CGFloat(angle), withVelocity: CGFloat(velocity))

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .rotate,
            duration: duration
        )
    }

    // MARK: - Wait Actions

    private func executeWaitForElement(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "WaitForElement action requires a target")
        }

        let timeout = request.timeout ?? defaultTimeout

        let element = try findElement(target, timeout: timeout)

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .waitForElement,
            duration: duration,
            details: ActionDetails(element: ElementInfo(from: element))
        )
    }

    private func executeWaitForNotExist(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "WaitForNotExist action requires a target")
        }

        let timeout = request.timeout ?? defaultTimeout

        // Find element (without waiting)
        if let element = try? findElement(target, timeout: 0.5) {
            // Wait for it to disappear
            let predicate = NSPredicate(format: "exists == false")
            let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)

            let result = XCTWaiter.wait(for: [expectation], timeout: timeout)

            if result != .completed {
                let duration = Int(Date().timeIntervalSince(startTime) * 1000)
                throw ActionError(status: .timeout, message: "Element still exists after \(timeout)s")
            }
        }

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .waitForNotExist,
            duration: duration
        )
    }

    // MARK: - Assert Actions

    private func executeAssertExists(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "AssertExists action requires a target")
        }

        let timeout = request.timeout ?? 5.0
        let element = try findElement(target, timeout: timeout)

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .assertExists,
            duration: duration,
            details: ActionDetails(element: ElementInfo(from: element))
        )
    }

    private func executeAssertNotExists(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "AssertNotExists action requires a target")
        }

        // Try to find element (short timeout)
        if let element = try? findElement(target, timeout: 1.0) {
            if element.exists {
                throw ActionError(
                    status: .failed,
                    message: "Element unexpectedly exists",
                    element: element
                )
            }
        }

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .assertNotExists,
            duration: duration
        )
    }

    private func executeAssertEnabled(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "AssertEnabled action requires a target")
        }

        let element = try findElement(target)

        if !element.isEnabled {
            throw ActionError(status: .notEnabled, message: "Element is not enabled", element: element)
        }

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .assertEnabled,
            duration: duration,
            details: ActionDetails(element: ElementInfo(from: element))
        )
    }

    private func executeAssertDisabled(_ request: ActionRequest, startTime: Date) throws -> ActionResult {
        guard let target = request.target else {
            throw ActionError(status: .error, message: "AssertDisabled action requires a target")
        }

        let element = try findElement(target)

        if element.isEnabled {
            throw ActionError(status: .failed, message: "Element is unexpectedly enabled", element: element)
        }

        let duration = Int(Date().timeIntervalSince(startTime) * 1000)

        return ActionResult.succeeded(
            actionType: .assertDisabled,
            duration: duration,
            details: ActionDetails(element: ElementInfo(from: element))
        )
    }

    // MARK: - Element Finding

    /// Find an element based on target specification
    private func findElement(_ target: ActionTarget, timeout: TimeInterval? = nil) throws -> XCUIElement {
        let resolvedTimeout = timeout ?? target.timeout.map { TimeInterval($0) / 1000.0 } ?? defaultTimeout

        let query: XCUIElementQuery

        switch target.type {
        case .identifier:
            query = queryByIdentifier(target.value, elementType: target.elementType)

        case .label:
            query = queryByLabel(target.value, elementType: target.elementType)

        case .text:
            query = queryByText(target.value)

        case .predicate:
            query = queryByPredicate(target.value, elementType: target.elementType)

        case .coordinates:
            // For coordinates, return a special coordinate-based element
            return try elementAtCoordinates(target.value)

        case .type:
            query = queryByType(target.value, index: target.index)
        }

        // Get the element (with index if specified)
        let element: XCUIElement
        if let index = target.index, target.type != .type {
            let elements = query.allElementsBoundByIndex
            guard index < elements.count else {
                throw ActionError(
                    status: .notFound,
                    message: "Index \(index) out of bounds (found \(elements.count) elements)"
                )
            }
            element = elements[index]
        } else {
            element = query.firstMatch
        }

        // Wait for element to exist
        let exists = element.waitForExistence(timeout: resolvedTimeout)
        if !exists {
            // Try to find similar elements for suggestions
            let suggestions = findSimilarElements(target)
            throw ActionError(
                status: .notFound,
                message: "Element not found: \(target.value)",
                suggestions: suggestions
            )
        }

        return element
    }

    private func queryByIdentifier(_ identifier: String, elementType: String?) -> XCUIElementQuery {
        if let type = elementType, let xcType = XCUIElement.ElementType.from(string: type) {
            return app.descendants(matching: xcType).matching(identifier: identifier)
        }
        return app.descendants(matching: .any).matching(identifier: identifier)
    }

    private func queryByLabel(_ label: String, elementType: String?) -> XCUIElementQuery {
        let predicate = NSPredicate(format: "label == %@", label)
        if let type = elementType, let xcType = XCUIElement.ElementType.from(string: type) {
            return app.descendants(matching: xcType).matching(predicate)
        }
        return app.descendants(matching: .any).matching(predicate)
    }

    private func queryByText(_ text: String) -> XCUIElementQuery {
        // Search in static texts and text fields
        let predicate = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)
        return app.descendants(matching: .any).matching(predicate)
    }

    private func queryByPredicate(_ predicateString: String, elementType: String?) -> XCUIElementQuery {
        let predicate = NSPredicate(format: predicateString)
        if let type = elementType, let xcType = XCUIElement.ElementType.from(string: type) {
            return app.descendants(matching: xcType).matching(predicate)
        }
        return app.descendants(matching: .any).matching(predicate)
    }

    private func queryByType(_ typeString: String, index: Int?) -> XCUIElementQuery {
        guard let xcType = XCUIElement.ElementType.from(string: typeString) else {
            return app.descendants(matching: .any)
        }
        return app.descendants(matching: xcType)
    }

    private func elementAtCoordinates(_ coordinateString: String) throws -> XCUIElement {
        let parts = coordinateString.split(separator: ",")
        guard parts.count == 2,
              let x = Double(parts[0].trimmingCharacters(in: .whitespaces)),
              let y = Double(parts[1].trimmingCharacters(in: .whitespaces)) else {
            throw ActionError(status: .error, message: "Invalid coordinates format. Expected: x,y")
        }

        // Use coordinate on the app window
        let window = app.windows.firstMatch
        let normalizedX = x / window.frame.width
        let normalizedY = y / window.frame.height

        // Return the window since we'll use coordinates directly in tap
        // The actual coordinate is handled in the tap action
        return window
    }

    /// Find similar elements to help with "not found" errors
    private func findSimilarElements(_ target: ActionTarget) -> [String] {
        var suggestions: [String] = []

        // Get all interactable elements
        let buttons = app.buttons.allElementsBoundByIndex
        let textFields = app.textFields.allElementsBoundByIndex
        let staticTexts = app.staticTexts.allElementsBoundByIndex

        let allElements = buttons + textFields + staticTexts

        // Find elements with similar identifiers or labels
        for element in allElements.prefix(20) {
            let identifier = element.identifier
            let label = element.label

            if !identifier.isEmpty && identifier.lowercased().contains(target.value.lowercased()) {
                suggestions.append("id:\(identifier)")
            }
            if !label.isEmpty && label.lowercased().contains(target.value.lowercased()) {
                suggestions.append("label:\(label)")
            }
        }

        return Array(suggestions.prefix(5))
    }
}

// MARK: - Action Error

/// Error thrown during action execution
struct ActionError: Error {
    let status: ActionStatus
    let message: String
    let element: XCUIElement?
    let suggestions: [String]?

    init(status: ActionStatus, message: String, element: XCUIElement? = nil, suggestions: [String]? = nil) {
        self.status = status
        self.message = message
        self.element = element
        self.suggestions = suggestions
    }
}

// MARK: - Element Type Extension

extension XCUIElement.ElementType {
    /// Convert string to ElementType
    static func from(string: String) -> XCUIElement.ElementType? {
        switch string.lowercased() {
        case "button": return .button
        case "textfield", "text_field": return .textField
        case "securetextfield", "secure_text_field", "password": return .secureTextField
        case "statictext", "static_text", "text": return .staticText
        case "image": return .image
        case "switch", "toggle": return .switch
        case "slider": return .slider
        case "picker": return .picker
        case "datepicker", "date_picker": return .datePicker
        case "table": return .table
        case "cell": return .cell
        case "collectionview", "collection_view": return .collectionView
        case "scrollview", "scroll_view": return .scrollView
        case "navigationbar", "navigation_bar": return .navigationBar
        case "tabbar", "tab_bar": return .tabBar
        case "toolbar": return .toolbar
        case "alert": return .alert
        case "sheet": return .sheet
        case "searchfield", "search_field": return .searchField
        case "textview", "text_view": return .textView
        case "link": return .link
        case "menu": return .menu
        case "menuitem", "menu_item": return .menuItem
        case "webview", "web_view": return .webView
        case "window": return .window
        case "any": return .any
        default: return nil
        }
    }
}
