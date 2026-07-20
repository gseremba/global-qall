import ExpoModulesCore
import Foundation

public final class GlobalQallVoipModule: Module {
  private var tokenObserver: NSObjectProtocol?
  private var pushObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("GlobalQallVoip")

    Events("onVoipToken", "onVoipPush")

    OnStartObserving {
      self.installObservers()
    }

    OnStopObserving {
      self.removeObservers()
    }

    Function("getVoipToken") { () -> String? in
      GlobalQallVoipStore.latestToken()
    }

    Function("getInitialVoipPush") { () -> [String: Any]? in
      GlobalQallVoipStore.latestPush()
    }

    Function("clearInitialVoipPush") {
      GlobalQallVoipStore.clearLatestPush()
    }
  }

  private func installObservers() {
    guard tokenObserver == nil, pushObserver == nil else { return }

    tokenObserver = NotificationCenter.default.addObserver(
      forName: GlobalQallVoipStore.tokenNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard let token = notification.userInfo?["token"] as? String else { return }
      self?.sendEvent("onVoipToken", ["token": token])
    }

    pushObserver = NotificationCenter.default.addObserver(
      forName: GlobalQallVoipStore.pushNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard let payload = notification.userInfo?["payload"] as? [String: Any] else { return }
      self?.sendEvent("onVoipPush", ["payload": payload])
    }
  }

  private func removeObservers() {
    if let tokenObserver {
      NotificationCenter.default.removeObserver(tokenObserver)
      self.tokenObserver = nil
    }
    if let pushObserver {
      NotificationCenter.default.removeObserver(pushObserver)
      self.pushObserver = nil
    }
  }
}
