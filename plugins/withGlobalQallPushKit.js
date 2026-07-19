const fs = require("fs");
const path = require("path");
const {
  withAppDelegate,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require("@expo/config-plugins");

const MARKER = "GLOBAL_QALL_PUSHKIT_SPRINT_9_3_1";
const BRIDGING_HEADER = "GlobalQall-Bridging-Header.h";

function withVoipInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    const modes = new Set(cfg.modResults.UIBackgroundModes || []);
    modes.add("audio");
    modes.add("voip");
    modes.add("remote-notification");
    cfg.modResults.UIBackgroundModes = Array.from(modes);
    return cfg;
  });
}

function withVoipEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["aps-environment"] =
      cfg.modResults["aps-environment"] || "development";
    return cfg;
  });
}

function withVoipBridgingHeader(config) {
  config = withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const iosRoot = cfg.modRequest.platformProjectRoot;
      const projectName = cfg.modRequest.projectName;
      const projectDir = path.join(iosRoot, projectName);
      const headerPath = path.join(projectDir, BRIDGING_HEADER);

      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        headerPath,
        [
          "#import <PushKit/PushKit.h>",
          '#import "RNVoipPushNotificationManager.h"',
          '#import "RNCallKeep.h"',
          "",
        ].join("\n")
      );

      return cfg;
    },
  ]);

  config = withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    const relativeHeader = `${projectName}/${BRIDGING_HEADER}`;
    const configurations = project.pbxXCBuildConfigurationSection();

    for (const key of Object.keys(configurations)) {
      const entry = configurations[key];
      if (
        typeof entry !== "object" ||
        !entry.buildSettings ||
        !entry.buildSettings.PRODUCT_NAME
      ) {
        continue;
      }

      entry.buildSettings.SWIFT_OBJC_BRIDGING_HEADER =
        `"${relativeHeader}"`;
    }

    return cfg;
  });

  return config;
}

function injectSwift(contents) {
  if (contents.includes(MARKER)) return contents;

  let next = contents
    .replace(/^import RNVoipPushNotification\s*$/gm, "")
    .replace(/^import RNCallKeep\s*$/gm, "");

  if (!next.includes("import PushKit")) {
    next = next.replace("import Expo\n", "import Expo\nimport PushKit\n");
  }

  next = next.replace(
    /public class AppDelegate:\s*ExpoAppDelegate(?:,\s*PKPushRegistryDelegate)?\s*\{/,
    "public class AppDelegate: ExpoAppDelegate, PKPushRegistryDelegate {"
  );

  if (!next.includes("RNVoipPushNotificationManager.voipRegistration()")) {
    const launchPattern =
      /(public override func application\([\s\S]*?didFinishLaunchingWithOptions[\s\S]*?\{\s*)/;

    if (!launchPattern.test(next)) {
      throw new Error(
        "[GlobalQall PushKit] didFinishLaunchingWithOptions was not found."
      );
    }

    next = next.replace(
      launchPattern,
      `$1\n    // ${MARKER}: Register PushKit before React Native starts.\n    RNVoipPushNotificationManager.voipRegistration()\n`
    );
  }

  if (!next.includes(`// ${MARKER}\n  public func pushRegistry`)) {
    const lastBrace = next.lastIndexOf("}");
    if (lastBrace < 0) {
      throw new Error(
        "[GlobalQall PushKit] AppDelegate closing brace was not found."
      );
    }

    const methods = `
  // ${MARKER}
  public func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate pushCredentials: PKPushCredentials,
    for type: PKPushType
  ) {
    RNVoipPushNotificationManager.didUpdate(
      pushCredentials,
      forType: type.rawValue
    )
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didInvalidatePushTokenFor type: PKPushType
  ) {}

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let data = payload.dictionaryPayload

    guard
      let callId = data["call_id"] as? String,
      !callId.isEmpty
    else {
      completion()
      return
    }

    let handle =
      (data["handle"] as? String) ??
      (data["caller_qall_id"] as? String) ??
      "Global Qall"

    let callerName =
      (data["caller_name"] as? String) ??
      "Global Qall caller"

    let hasVideo =
      (data["has_video"] as? Bool) ??
      ((data["call_type"] as? String) == "video")

    RNVoipPushNotificationManager.didReceiveIncomingPush(
      with: payload,
      forType: type.rawValue
    )

    RNCallKeep.reportNewIncomingCall(
      callId,
      handle: handle,
      handleType: "generic",
      hasVideo: hasVideo,
      localizedCallerName: callerName,
      supportsHolding: true,
      supportsDTMF: true,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: data,
      withCompletionHandler: completion
    )
  }
`;

    next = next.slice(0, lastBrace) + methods + "\n" + next.slice(lastBrace);
  }

  return next;
}

function withVoipAppDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error(
        "[GlobalQall PushKit] Expo SDK 54 Swift AppDelegate expected."
      );
    }

    cfg.modResults.contents = injectSwift(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = function withGlobalQallPushKit(config) {
  config = withVoipInfoPlist(config);
  config = withVoipEntitlements(config);
  config = withVoipBridgingHeader(config);
  config = withVoipAppDelegate(config);
  return config;
};
