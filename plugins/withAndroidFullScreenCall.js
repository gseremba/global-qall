const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withAndroidFullScreenCall(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] || [];

    const permissionName = "android.permission.USE_FULL_SCREEN_INTENT";
    const exists = manifest["uses-permission"].some(
      (item) => item?.$?.["android:name"] === permissionName,
    );

    if (!exists) {
      manifest["uses-permission"].push({
        $: { "android:name": permissionName },
      });
    }

    const application = manifest.application?.[0];
    const activities = application?.activity || [];
    const mainActivity = activities.find((activity) =>
      (activity["intent-filter"] || []).some((filter) =>
        (filter.action || []).some(
          (action) => action?.$?.["android:name"] === "android.intent.action.MAIN",
        ),
      ),
    );

    if (mainActivity) {
      mainActivity.$ = mainActivity.$ || {};
      mainActivity.$["android:showWhenLocked"] = "true";
      mainActivity.$["android:turnScreenOn"] = "true";
    }

    return config;
  });
};
