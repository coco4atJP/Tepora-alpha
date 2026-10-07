// Tepora's macOS helper: reads app windows through the Accessibility API and operates them.
// One JSON request per line on stdin, one JSON response per line on stdout:
//   {"id":1,"cmd":"observe","pid":123,"title":""} -> {"id":1,"ok":true,"result":{...}}
// Controls are pressed and values set through Accessibility actions where possible, so the app does not need to
// come to the front; keys, typing and coordinate clicks use synthetic events and bring the app forward first.
import Foundation
import AppKit
import ApplicationServices

setvbuf(stdout, nil, _IOLBF, 0)

struct HelperError: Error { let message: String; init(_ m: String) { message = m } }
var snapshots: [Int32: [AXUIElement]] = [:]
var windowFrames: [Int32: CGRect] = [:]

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}
func text(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s }
    if let a = v as? NSAttributedString { return a.string }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}
func flag(_ el: AXUIElement, _ name: String) -> Bool? { (attr(el, name) as? NSNumber)?.boolValue }
func element(_ v: AnyObject?) -> AXUIElement? {
    guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}
func frame(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute as String), let s = attr(el, kAXSizeAttribute as String),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &point); AXValueGetValue(s as! AXValue, .cgSize, &size)
    return CGRect(origin: point, size: size)
}
func actionNames(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    if AXUIElementCopyActionNames(el, &names) == .success, let a = names as? [String] { return a }
    return []
}
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }

let roles: [String: String] = [
    "AXButton": "button", "AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXPopUpButton": "combobox", "AXComboBox": "combobox",
    "AXTextField": "textbox", "AXTextArea": "textbox", "AXSecureTextField": "password", "AXLink": "link", "AXMenuItem": "menuitem",
    "AXMenuButton": "menubutton", "AXSlider": "slider", "AXIncrementor": "slider", "AXDisclosureTriangle": "disclosure",
    "AXCell": "cell", "AXRow": "row", "AXTab": "tab", "AXSwitch": "switch", "AXDateField": "date", "AXColorWell": "color",
    "AXSegmentedControl": "tab", "AXImage": "image"]

func requireTrust() throws {
    if !AXIsProcessTrusted() {
        throw HelperError("Accessibility permission is not granted. Open System Settings → Privacy & Security → Accessibility, allow the app that runs Tepora (Terminal or Tepora), then try again.")
    }
}
func appWindow(_ pid: Int32, _ title: String) throws -> AXUIElement {
    try requireTrust()
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 3.0)
    let windows = (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    if !title.isEmpty, let w = windows.first(where: { (text($0, kAXTitleAttribute as String) ?? "").contains(title) }) { return w }
    if let w = element(attr(app, kAXFocusedWindowAttribute as String)) { return w }
    if let w = element(attr(app, kAXMainWindowAttribute as String)) { return w }
    if let w = windows.first { return w }
    throw HelperError("The app has no open window. Open one first.")
}
func name(_ el: AXUIElement, role: String) -> String {
    for key in [kAXTitleAttribute as String, kAXDescriptionAttribute as String, "AXPlaceholderValue", kAXHelpAttribute as String] {
        if let s = text(el, key), !s.trimmingCharacters(in: .whitespaces).isEmpty { return s }
    }
    if let t = element(attr(el, kAXTitleUIElementAttribute as String)), let s = text(t, kAXValueAttribute as String) { return s }
    if role == "AXCell" || role == "AXRow" {
        for c in children(el) { if let s = text(c, kAXValueAttribute as String), !s.isEmpty { return s } }
    }
    return ""
}

func observe(_ pid: Int32, _ title: String, _ maxNodes: Int) throws -> [String: Any] {
    let win = try appWindow(pid, title)
    let wf = frame(win) ?? .zero
    windowFrames[pid] = wf
    var items: [[String: Any]] = [], refs: [AXUIElement] = [], lines: [String] = [], textSize = 0, visited = 0
    var queue: [(AXUIElement, Int)] = [(win, 0)]
    while !queue.isEmpty && visited < maxNodes {
        let (el, depth) = queue.removeFirst(); visited += 1
        let role = text(el, kAXRoleAttribute as String) ?? ""
        let subrole = text(el, kAXSubroleAttribute as String) ?? ""
        let acts = actionNames(el)
        if role == "AXStaticText" {
            if let s = text(el, kAXValueAttribute as String), !s.isEmpty, textSize < 4000 { lines.append(s); textSize += s.count }
        }
        var mapped = roles[role]
        if subrole == "AXSearchField" { mapped = "searchbox" }
        if mapped == nil && acts.contains("AXPress") && role != "AXStaticText" && role != "AXGroup" && role != "AXWindow" { mapped = "button" }
        if let r = mapped, role != "AXImage" || acts.contains("AXPress") {
            let f = frame(el) ?? .zero
            if f.width >= 1 && f.height >= 1 {
                var item: [String: Any] = ["ref": "a\(refs.count)", "role": r, "name": String(name(el, role: role).prefix(140)),
                                           "x": Int(f.midX - wf.minX), "y": Int(f.midY - wf.minY), "inView": wf.intersects(f)]
                if ["textbox", "password", "searchbox", "combobox", "slider", "date"].contains(r) {
                    let v = r == "password" ? ((text(el, kAXValueAttribute as String) ?? "").isEmpty ? "" : "••••") : (text(el, kAXValueAttribute as String) ?? "")
                    item["value"] = String(v.prefix(200))
                }
                if r == "checkbox" || r == "radio" || r == "switch" { item["checked"] = (attr(el, kAXValueAttribute as String) as? NSNumber)?.intValue == 1 }
                if flag(el, kAXSelectedAttribute as String) == true { item["selected"] = true }
                if flag(el, kAXEnabledAttribute as String) == false { item["disabled"] = true }
                if flag(el, kAXFocusedAttribute as String) == true { item["focused"] = true }
                if let ex = flag(el, kAXExpandedAttribute as String) { item["expanded"] = ex }
                items.append(item); refs.append(el)
            }
        }
        if depth < 40 && role != "AXMenuBar" { for c in children(el) { queue.append((c, depth + 1)) } }
    }
    snapshots[pid] = refs
    return ["title": text(win, kAXTitleAttribute as String) ?? "", "elements": items, "text": lines.joined(separator: "\n"),
            "frame": ["x": wf.minX, "y": wf.minY, "w": wf.width, "h": wf.height], "visited": visited]
}
func target(_ pid: Int32, _ ref: String) throws -> AXUIElement {
    guard ref.hasPrefix("a"), let i = Int(ref.dropFirst()), let list = snapshots[pid], i >= 0, i < list.count else {
        throw HelperError("Control \(ref) is not in the latest observation. Observe again.")
    }
    return list[i]
}
func activate(_ pid: Int32) {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return }
    if #available(macOS 14.0, *) { app.activate() } else { app.activate(options: [.activateIgnoringOtherApps]) }
    Thread.sleep(forTimeInterval: 0.25)
}
func clickAt(_ p: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}
func press(_ pid: Int32, _ ref: String) throws {
    let el = try target(pid, ref)
    for action in ["AXPress", "AXConfirm", "AXPick", "AXShowMenu"] where actionNames(el).contains(action) {
        if AXUIElementPerformAction(el, action as CFString) == .success { return }
    }
    guard let f = frame(el) else { throw HelperError("Control \(ref) cannot be pressed.") }
    activate(pid); clickAt(CGPoint(x: f.midX, y: f.midY))
}
let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32,
    "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "Enter": 36, "Return": 36, "Tab": 48, "Space": 49, "Backspace": 51,
    "Escape": 53, "Delete": 117, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121, "ArrowLeft": 123, "ArrowRight": 124,
    "ArrowDown": 125, "ArrowUp": 126, "F5": 96]
func key(_ pid: Int32, _ combo: String) throws {
    var parts = combo.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
    guard let last = parts.popLast() else { throw HelperError("keys is empty") }
    guard let code = keyCodes[last] ?? keyCodes[last.lowercased()] else { throw HelperError("Unknown key \(last)") }
    var flags: CGEventFlags = []
    for p in parts {
        switch p { case "Mod", "Meta", "Cmd", "Command": flags.insert(.maskCommand); case "Control", "Ctrl": flags.insert(.maskControl)
        case "Alt", "Option": flags.insert(.maskAlternate); case "Shift": flags.insert(.maskShift); default: throw HelperError("Unknown modifier \(p)") }
    }
    activate(pid)
    let src = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true), up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    down?.flags = flags; up?.flags = flags
    down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
}
func typeText(_ pid: Int32, _ s: String) {
    activate(pid)
    let src = CGEventSource(stateID: .hidSystemState)
    let units = Array(s.utf16)
    var i = 0
    while i < units.count {
        let chunk = Array(units[i..<min(i + 16, units.count)])
        let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true), up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
        chunk.withUnsafeBufferPointer { b in down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: b.baseAddress); up?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: b.baseAddress) }
        down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
        i += 16
    }
}
func setText(_ pid: Int32, _ ref: String, _ value: String) throws {
    let el = try target(pid, ref)
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString) == .success,
       (text(el, kAXValueAttribute as String) ?? "") == value { return }
    // Fields that do not take a value directly get it typed, after selecting what is there.
    try key(pid, "Mod+a"); typeText(pid, value)
}
func choose(_ pid: Int32, _ ref: String, _ option: String) throws {
    let el = try target(pid, ref)
    guard AXUIElementPerformAction(el, "AXPress" as CFString) == .success else { throw HelperError("\(ref) does not open a list.") }
    Thread.sleep(forTimeInterval: 0.3)
    var queue = children(el), seen = 0
    while !queue.isEmpty && seen < 400 {
        let c = queue.removeFirst(); seen += 1
        if text(c, kAXRoleAttribute as String) == "AXMenuItem", (text(c, kAXTitleAttribute as String) ?? "") == option {
            AXUIElementPerformAction(c, "AXPress" as CFString); return
        }
        queue.append(contentsOf: children(c))
    }
    AXUIElementPerformAction(el, "AXCancel" as CFString)
    throw HelperError("No option \"\(option)\" in \(ref).")
}
func scroll(_ pid: Int32, _ ref: String, _ dy: Int) throws {
    var start: AXUIElement? = ref.isEmpty ? nil : try target(pid, ref)
    if start == nil, let refs = snapshots[pid], let first = refs.first { start = first }
    var el = start
    while let e = el {
        if text(e, kAXRoleAttribute as String) == "AXScrollArea", let bar = element(attr(e, kAXVerticalScrollBarAttribute as String)),
           let v = (attr(bar, kAXValueAttribute as String) as? NSNumber)?.doubleValue {
            let next = max(0, min(1, v + Double(dy) / 2400))
            if AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success { return }
        }
        el = element(attr(e, kAXParentAttribute as String))
    }
    let wf = windowFrames[pid] ?? .zero
    activate(pid)
    let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0)
    ev?.location = CGPoint(x: wf.midX, y: wf.midY); ev?.post(tap: .cghidEventTap)
}
func windows() -> [[String: Any]] {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var out: [[String: Any]] = []
    for w in info where (w[kCGWindowLayer as String] as? Int) == 0 {
        guard let pid = w[kCGWindowOwnerPID as String] as? Int32 else { continue }
        let app = w[kCGWindowOwnerName as String] as? String ?? ""
        out.append(["pid": pid, "app": app, "title": w[kCGWindowName as String] as? String ?? "", "windowId": w[kCGWindowNumber as String] as? Int ?? 0, "active": pid == front])
    }
    return out
}
func screenshot(_ pid: Int32, _ title: String) throws -> [String: Any] {
    let win = try appWindow(pid, title)
    guard let wf = frame(win) else { throw HelperError("The window has no frame.") }
    windowFrames[pid] = wf
    let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    let match = info.first { w in
        guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, let b = w[kCGWindowBounds as String] as? [String: Double] else { return false }
        return abs((b["X"] ?? 0) - wf.minX) < 2 && abs((b["Y"] ?? 0) - wf.minY) < 2 && abs((b["Width"] ?? 0) - wf.width) < 2
    }
    guard let id = match?[kCGWindowNumber as String] as? Int else { throw HelperError("The window is not on screen.") }
    let file = NSTemporaryDirectory() + "tepora-\(UUID().uuidString).jpg"
    for (exe, args) in [("/usr/sbin/screencapture", ["-x", "-o", "-l\(id)", "-t", "jpg", file]), ("/usr/bin/sips", ["--resampleWidth", "\(Int(wf.width))", file, "--out", file])] {
        let p = Process(); p.executableURL = URL(fileURLWithPath: exe); p.arguments = args; p.standardOutput = nil; p.standardError = nil
        try p.run(); p.waitUntilExit()
    }
    defer { try? FileManager.default.removeItem(atPath: file) }
    guard let data = FileManager.default.contents(atPath: file), !data.isEmpty else {
        throw HelperError("The screenshot failed. Allow Screen Recording for the app that runs Tepora in System Settings → Privacy & Security.")
    }
    return ["base64": data.base64EncodedString(), "width": Int(wf.width), "height": Int(wf.height)]
}
func clickPoint(_ pid: Int32, _ x: Double, _ y: Double, _ title: String) throws {
    let win = try appWindow(pid, title)
    let wf = frame(win) ?? windowFrames[pid] ?? .zero
    activate(pid); clickAt(CGPoint(x: wf.minX + x, y: wf.minY + y))
}

func handle(_ req: [String: Any]) throws -> Any {
    let cmd = req["cmd"] as? String ?? ""
    let pid = Int32(req["pid"] as? Int ?? 0), ref = req["ref"] as? String ?? "", title = req["title"] as? String ?? ""
    switch cmd {
    case "status": return ["trusted": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess()]
    case "windows": return ["windows": windows()]
    case "observe": return try observe(pid, title, req["max"] as? Int ?? 1500)
    case "press": try press(pid, ref); return true
    case "click": try clickPoint(pid, req["x"] as? Double ?? 0, req["y"] as? Double ?? 0, title); return true
    case "setText": try setText(pid, ref, req["text"] as? String ?? ""); return true
    case "type": typeText(pid, req["text"] as? String ?? ""); return true
    case "choose": try choose(pid, ref, req["option"] as? String ?? ""); return true
    case "key": try key(pid, req["combo"] as? String ?? ""); return true
    case "scroll": try scroll(pid, ref, req["dy"] as? Int ?? 600); return true
    case "screenshot": return try screenshot(pid, title)
    default: throw HelperError("Unknown command \(cmd)")
    }
}
while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    let id = req["id"] ?? NSNull()
    var reply: [String: Any]
    do { reply = ["id": id, "ok": true, "result": try handle(req)] }
    catch let e as HelperError { reply = ["id": id, "ok": false, "error": e.message] }
    catch { reply = ["id": id, "ok": false, "error": String(describing: error)] }
    if let out = try? JSONSerialization.data(withJSONObject: reply), let s = String(data: out, encoding: .utf8) { print(s) }
}
