import ExpoModulesCore
import Foundation
import PushKit
import UIKit

public final class GlobalQallVoipAppDelegateSubscriber: 
  ExpoAppDelegateSubscriber, 
  PKPushRegistryDelegate {
  private var registry: PKPushRegistry?

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    registerForVoipPushes()
    return true
  }

  private func registerForVoipPushes() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let registry = PKPushRegistry(queue: .main)
      registry.delegate = self
      registry.desiredPushTypes = [.voIP]
      self.registry = registry
    }
  }

  @objc public func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate pushCredentials: PKPushCredentials,
    for type: PKPushType
  ) {
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    GlobalQallVoipStore.saveToken(token)
    GlobalQallVoipNativeBridge.forwardUpdatedCredentials(pushCredentials, forType: type)
  }

  @objc public func pushRegistry(
    _ registry: PKPushRegistry,
    didInvalidatePushTokenFor type: PKPushType
  ) {
    GlobalQallVoipStore.saveToken("")
  }

  @objc public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let data = payload.dictionaryPayload
    GlobalQallVoipStore.savePush(data)
    GlobalQallVoipNativeBridge.forwardIncomingPayload(payload, forType: type)

    let uuid = normalizedUUID(data["uuid"] as? String)
    let handle = stringValue(data["handle"] ?? data["callerId"] ?? data["caller_id"], fallback: "Unknown")
    let callerName = stringValue(data["callerName"] ?? data["caller_name"], fallback: handle)
    let hasVideo = boolValue(data["hasVideo"] ?? data["has_video"] ?? data["callType"])

    GlobalQallVoipNativeBridge.reportIncomingCall(
      withUUID: uuid,
      handle: handle,
      callerName: callerName,
      hasVideo: hasVideo,
      payload: GlobalQallVoipStore.latestPush() ?? [:],
      completion: completion
    )
  }

  private func normalizedUUID(_ candidate: String?) -> String {
    if let candidate, UUID(uuidString: candidate) != nil {
      return candidate.lowercased()
    }
    return UUID().uuidString.lowercased()
  }

  private func stringValue(_ value: Any?, fallback: String) -> String {
    guard let value else { return fallback }
    let output = String(describing: value)
    return output.isEmpty ? fallback : output
  }

  private func boolValue(_ value: Any?) -> Bool {
    if let boolean = value as? Bool { return boolean }
    if let number = value as? NSNumber { return number.boolValue }
    let text = String(describing: value ?? "").lowercased()
    return text == "true" || text == "1" || text == "video"
  }
}
