const { withPodfile } = require("@expo/config-plugins");

module.exports = function withFirebaseDisableSPM(config) {
  return withPodfile(config, (config) => {
    const setting = "$RNFirebaseDisableSPM = true";
    if (!config.modResults.contents.includes(setting)) {
      config.modResults.contents = `${setting}\n${config.modResults.contents}`;
    }
    return config;
  });
};
