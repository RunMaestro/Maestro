import XCTest

/// Action type definitions for XCUITest-based UI automation.
/// These types define the actions that can be executed on iOS UI elements.
///
/// Designed to be JSON-deserializable for consumption from TypeScript/Node.js.

// MARK: - Action Types

/// Enum of all supported action types
enum ActionType: String, Codable {
    case tap
    case doubleTap
    case longPress
    case typeText
    case clearText
    case scroll
    case scrollTo
    case swipe
    case pinch
    case rotate
    case waitForElement
    case waitForNotExist
    case assertExists
    case assertNotExists
    case assertEnabled
    case assertDisabled
}

// MARK: - Target Types

/// How to identify the target element for an action
enum TargetType: String, Codable {
    case identifier   // Accessibility identifier
    case label        // Accessibility label
    case text         // Static text content
    case predicate    // NSPredicate format
    case coordinates  // x,y coordinates
    case type         // Element type + index
}

/// Target specification for an action
struct ActionTarget: Codable {
    /// How to find the target
    let type: TargetType

    /// The value to match (identifier string, label text, coordinates, etc.)
    let value: String

    /// Optional element type filter (e.g., "button", "textField")
    let elementType: String?

    /// Optional index when multiple elements match (0-based)
    let index: Int?

    /// Optional timeout for finding element (milliseconds)
    let timeout: Int?

    init(type: TargetType, value: String, elementType: String? = nil, index: Int? = nil, timeout: Int? = nil) {
        self.type = type
        self.value = value
        self.elementType = elementType
        self.index = index
        self.timeout = timeout
    }

    /// Create target from accessibility identifier
    static func byId(_ identifier: String, elementType: String? = nil) -> ActionTarget {
        ActionTarget(type: .identifier, value: identifier, elementType: elementType)
    }

    /// Create target from label
    static func byLabel(_ label: String, elementType: String? = nil) -> ActionTarget {
        ActionTarget(type: .label, value: label, elementType: elementType)
    }

    /// Create target from text content
    static func byText(_ text: String) -> ActionTarget {
        ActionTarget(type: .text, value: text)
    }

    /// Create target from coordinates
    static func byCoordinates(x: Double, y: Double) -> ActionTarget {
        ActionTarget(type: .coordinates, value: "\(x),\(y)")
    }

    /// Create target from NSPredicate
    static func byPredicate(_ predicate: String) -> ActionTarget {
        ActionTarget(type: .predicate, value: predicate)
    }
}

// MARK: - Direction Types

/// Direction for scroll and swipe actions
enum SwipeDirection: String, Codable {
    case up
    case down
    case left
    case right
}

/// Velocity for swipe gestures
enum SwipeVelocity: String, Codable {
    case slow
    case normal
    case fast

    var value: XCUIGestureVelocity {
        switch self {
        case .slow: return .slow
        case .normal: return .default
        case .fast: return .fast
        }
    }
}

// MARK: - Action Definitions

/// Base protocol for all actions
protocol Action: Codable {
    var actionType: ActionType { get }
}

/// Tap action - single tap on an element
struct TapAction: Action, Codable {
    let actionType = ActionType.tap
    let target: ActionTarget

    /// Optional offset from center (normalized 0-1)
    let offsetX: Double?
    let offsetY: Double?

    init(target: ActionTarget, offsetX: Double? = nil, offsetY: Double? = nil) {
        self.target = target
        self.offsetX = offsetX
        self.offsetY = offsetY
    }
}

/// Double tap action
struct DoubleTapAction: Action, Codable {
    let actionType = ActionType.doubleTap
    let target: ActionTarget

    init(target: ActionTarget) {
        self.target = target
    }
}

/// Long press action
struct LongPressAction: Action, Codable {
    let actionType = ActionType.longPress
    let target: ActionTarget

    /// Duration in seconds (default: 1.0)
    let duration: Double

    init(target: ActionTarget, duration: Double = 1.0) {
        self.target = target
        self.duration = duration
    }
}

/// Type text action - enters text into an element
struct TypeTextAction: Action, Codable {
    let actionType = ActionType.typeText

    /// Optional target (uses currently focused element if nil)
    let target: ActionTarget?

    /// Text to type
    let text: String

    /// Whether to clear existing text first
    let clearFirst: Bool

    init(text: String, target: ActionTarget? = nil, clearFirst: Bool = false) {
        self.target = target
        self.text = text
        self.clearFirst = clearFirst
    }
}

/// Clear text action - clears text from an element
struct ClearTextAction: Action, Codable {
    let actionType = ActionType.clearText
    let target: ActionTarget

    init(target: ActionTarget) {
        self.target = target
    }
}

/// Scroll action - scroll in a direction
struct ScrollAction: Action, Codable {
    let actionType = ActionType.scroll

    /// Target scrollable element (uses first scroll view if nil)
    let target: ActionTarget?

    /// Direction to scroll
    let direction: SwipeDirection

    /// Distance as percentage of screen (0.0-1.0, default: 0.5)
    let distance: Double

    init(direction: SwipeDirection, target: ActionTarget? = nil, distance: Double = 0.5) {
        self.target = target
        self.direction = direction
        self.distance = distance
    }
}

/// Scroll to element action - scroll until element is visible
struct ScrollToAction: Action, Codable {
    let actionType = ActionType.scrollTo

    /// Element to scroll to
    let target: ActionTarget

    /// Maximum scroll attempts (default: 10)
    let maxAttempts: Int

    /// Direction to scroll when searching
    let direction: SwipeDirection

    init(target: ActionTarget, direction: SwipeDirection = .down, maxAttempts: Int = 10) {
        self.target = target
        self.direction = direction
        self.maxAttempts = maxAttempts
    }
}

/// Swipe action - swipe gesture
struct SwipeAction: Action, Codable {
    let actionType = ActionType.swipe

    /// Target element to swipe on (uses main window if nil)
    let target: ActionTarget?

    /// Direction to swipe
    let direction: SwipeDirection

    /// Velocity of swipe
    let velocity: SwipeVelocity

    init(direction: SwipeDirection, target: ActionTarget? = nil, velocity: SwipeVelocity = .normal) {
        self.target = target
        self.direction = direction
        self.velocity = velocity
    }
}

/// Pinch action - pinch gesture for zoom
struct PinchAction: Action, Codable {
    let actionType = ActionType.pinch
    let target: ActionTarget?

    /// Scale factor (>1 = zoom in, <1 = zoom out)
    let scale: Double

    /// Velocity of pinch
    let velocity: Double

    init(scale: Double, target: ActionTarget? = nil, velocity: Double = 1.0) {
        self.target = target
        self.scale = scale
        self.velocity = velocity
    }
}

/// Rotate action - rotation gesture
struct RotateAction: Action, Codable {
    let actionType = ActionType.rotate
    let target: ActionTarget?

    /// Rotation angle in radians
    let angle: Double

    /// Velocity of rotation
    let velocity: Double

    init(angle: Double, target: ActionTarget? = nil, velocity: Double = 1.0) {
        self.target = target
        self.angle = angle
        self.velocity = velocity
    }
}

/// Wait for element action - waits until element exists
struct WaitForElementAction: Action, Codable {
    let actionType = ActionType.waitForElement
    let target: ActionTarget

    /// Timeout in seconds (default: 10)
    let timeout: Double

    init(target: ActionTarget, timeout: Double = 10.0) {
        self.target = target
        self.timeout = timeout
    }
}

/// Wait for not exist action - waits until element disappears
struct WaitForNotExistAction: Action, Codable {
    let actionType = ActionType.waitForNotExist
    let target: ActionTarget

    /// Timeout in seconds (default: 10)
    let timeout: Double

    init(target: ActionTarget, timeout: Double = 10.0) {
        self.target = target
        self.timeout = timeout
    }
}

/// Assert exists action - verifies element exists
struct AssertExistsAction: Action, Codable {
    let actionType = ActionType.assertExists
    let target: ActionTarget

    /// Timeout for finding element (seconds)
    let timeout: Double

    init(target: ActionTarget, timeout: Double = 5.0) {
        self.target = target
        self.timeout = timeout
    }
}

/// Assert not exists action - verifies element does not exist
struct AssertNotExistsAction: Action, Codable {
    let actionType = ActionType.assertNotExists
    let target: ActionTarget

    init(target: ActionTarget) {
        self.target = target
    }
}

/// Assert enabled action - verifies element is enabled
struct AssertEnabledAction: Action, Codable {
    let actionType = ActionType.assertEnabled
    let target: ActionTarget

    init(target: ActionTarget) {
        self.target = target
    }
}

/// Assert disabled action - verifies element is disabled
struct AssertDisabledAction: Action, Codable {
    let actionType = ActionType.assertDisabled
    let target: ActionTarget

    init(target: ActionTarget) {
        self.target = target
    }
}

// MARK: - Action Request

/// A wrapper for any action that can be deserialized from JSON
struct ActionRequest: Codable {
    let type: ActionType
    let target: ActionTarget?

    // Common optional parameters
    let text: String?
    let duration: Double?
    let timeout: Double?
    let direction: SwipeDirection?
    let velocity: SwipeVelocity?
    let scale: Double?
    let angle: Double?
    let distance: Double?
    let maxAttempts: Int?
    let clearFirst: Bool?
    let offsetX: Double?
    let offsetY: Double?
}

// MARK: - Key Codes

/// Hardware keyboard key codes for special keys
enum KeyCode: String, Codable {
    case returnKey = "return"
    case delete = "delete"
    case escape = "escape"
    case tab = "tab"
    case space = "space"
    case upArrow = "up"
    case downArrow = "down"
    case leftArrow = "left"
    case rightArrow = "right"
    case home = "home"
    case end = "end"
    case pageUp = "pageUp"
    case pageDown = "pageDown"

    /// Get the XCUIKeyboardKey for this key code
    var xcuiKey: String {
        switch self {
        case .returnKey: return XCUIKeyboardKey.return.rawValue
        case .delete: return XCUIKeyboardKey.delete.rawValue
        case .escape: return XCUIKeyboardKey.escape.rawValue
        case .tab: return XCUIKeyboardKey.tab.rawValue
        case .space: return XCUIKeyboardKey.space.rawValue
        case .upArrow: return XCUIKeyboardKey.upArrow.rawValue
        case .downArrow: return XCUIKeyboardKey.downArrow.rawValue
        case .leftArrow: return XCUIKeyboardKey.leftArrow.rawValue
        case .rightArrow: return XCUIKeyboardKey.rightArrow.rawValue
        case .home: return XCUIKeyboardKey.home.rawValue
        case .end: return XCUIKeyboardKey.end.rawValue
        case .pageUp: return XCUIKeyboardKey.pageUp.rawValue
        case .pageDown: return XCUIKeyboardKey.pageDown.rawValue
        }
    }
}
