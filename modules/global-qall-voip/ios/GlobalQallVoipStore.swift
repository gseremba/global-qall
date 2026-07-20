import Foundation

internal enum GlobalQallVoipStore {
  static let tokenKey = "GlobalQallVoip.latestToken"
  static let pushKey = "GlobalQallVoip.latestPush"

  static let tokenNotification = Notification.Name("GlobalQallVoipTokenUpdated")
  static let pushNotification = Notification.Name("GlobalQallVoipPushReceived")

  static func saveToken(_ token: String) {
    UserDefaults.standard.set(token, forKey: tokenKey)
    NotificationCenter.default.post(
      name: tokenNotification,
      object: nil,
      userInfo: ["token": token]
    )
  }

  static func savePush(_ payload: [AnyHashable: Any]) {
    let json = sanitize(payload)
    UserDefaults.standard.set(json, forKey: pushKey)
    NotificationCenter.default.post(
      name: pushNotification,
      object: nil,
      userInfo: ["payload": json]
    )
  }

  static func latestToken() -> String? {
    UserDefaults.standard.string(forKey: tokenKey)
  }

  static func latestPush() -> [String: Any]? {
    UserDefaults.standard.dictionary(forKey: pushKey)
  }

  static func clearLatestPush() {
    UserDefaults.standard.removeObject(forKey: pushKey)
  }

  private static func sanitize(_ value: Any) -> Any {
    if let dictionary = value as? [AnyHashable: Any] {
      var result: [String: Any] = [:]
      for (key, item) in dictionary {
        result[String(describing: key)] = sanitize(item)
      }
      return result
    }

    if let array = value as? [Any] {
      return array.map(sanitize)
    }

    if JSONSerialization.isValidJSONObject(["value": value]) {
      return value
    }

    return String(describing: value)
  }
}
