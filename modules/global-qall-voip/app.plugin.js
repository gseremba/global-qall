const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');
const withGlobalQallVoip = require('./plugin/withGlobalQallVoip');

function withGlobalQallModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        'Podfile'
      );

      let podfile = fs.readFileSync(podfilePath, 'utf8');

      if (!podfile.includes('use_modular_headers!')) {
        const platformLine = /platform :ios[^\n]*\n/;

        if (platformLine.test(podfile)) {
          podfile = podfile.replace(
            platformLine,
            (match) => `${match}\nuse_modular_headers!\n`
          );
        } else {
          podfile = `use_modular_headers!\n\n${podfile}`;
        }

        fs.writeFileSync(podfilePath, podfile, 'utf8');
      }

      return config;
    },
  ]);
}

module.exports = function withGlobalQallVoipPlugin(config, props = {}) {
  config = withGlobalQallVoip(config, props);
  config = withGlobalQallModularHeaders(config);
  return config;
};
