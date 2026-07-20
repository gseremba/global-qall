const {
  withEntitlementsPlist,
  withInfoPlist,
} = require('expo/config-plugins');

function withGlobalQallVoip(config) {
  config = withEntitlementsPlist(config, (config) => {
    config.modResults['aps-environment'] = config.modResults['aps-environment'] || 'development';
    return config;
  });

  config = withInfoPlist(config, (config) => {
    const existing = Array.isArray(config.modResults.UIBackgroundModes)
      ? config.modResults.UIBackgroundModes
      : [];

    config.modResults.UIBackgroundModes = Array.from(
      new Set([...existing, 'voip', 'remote-notification', 'audio'])
    );

    return config;
  });

  return config;
}

module.exports = withGlobalQallVoip;
