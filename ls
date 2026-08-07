warning: in the working copy of 'modules/global-qall-voip/app.plugin.js', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/modules/global-qall-voip/app.plugin.js b/modules/global-qall-voip/app.plugin.js[m
[1mindex 203a754..7ea72b8 100644[m
[1m--- a/modules/global-qall-voip/app.plugin.js[m
[1m+++ b/modules/global-qall-voip/app.plugin.js[m
[36m@@ -1 +1,41 @@[m
[31m-module.exports = require('./plugin/withGlobalQallVoip');[m
[32m+[m[32mconst { withDangerousMod } = require('@expo/config-plugins');[m
[32m+[m[32mconst fs = require('fs');[m
[32m+[m[32mconst path = require('path');[m
[32m+[m[32mconst withGlobalQallVoip = require('./plugin/withGlobalQallVoip');[m
[32m+[m
[32m+[m[32mfunction withGlobalQallModularHeaders(config) {[m
[32m+[m[32m  return withDangerousMod(config, [[m
[32m+[m[32m    'ios',[m
[32m+[m[32m    async (config) => {[m
[32m+[m[32m      const podfilePath = path.join([m
[32m+[m[32m        config.modRequest.platformProjectRoot,[m
[32m+[m[32m        'Podfile'[m
[32m+[m[32m      );[m
[32m+[m
[32m+[m[32m      let podfile = fs.readFileSync(podfilePath, 'utf8');[m
[32m+[m
[32m+[m[32m      if (!podfile.includes('use_modular_headers!')) {[m
[32m+[m[32m        const platformLine = /platform :ios[^\n]*\n/;[m
[32m+[m
[32m+[m[32m        if (platformLine.test(podfile)) {[m
[32m+[m[32m          podfile = podfile.replace([m
[32m+[m[32m            platformLine,[m
[32m+[m[32m            (match) => `${match}\nuse_modular_headers!\n`[m
[32m+[m[32m          );[m
[32m+[m[32m        } else {[m
[32m+[m[32m          podfile = `use_modular_headers!\n\n${podfile}`;[m
[32m+[m[32m        }[m
[32m+[m
[32m+[m[32m        fs.writeFileSync(podfilePath, podfile, 'utf8');[m
[32m+[m[32m      }[m
[32m+[m
[32m+[m[32m      return config;[m
[32m+[m[32m    },[m
[32m+[m[32m  ]);[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mmodule.exports = function withGlobalQallVoipPlugin(config, props = {}) {[m
[32m+[m[32m  config = withGlobalQallVoip(config, props);[m
[32m+[m[32m  config = withGlobalQallModularHeaders(config);[m
[32m+[m[32m  return config;[m
[32m+[m[32m};[m
