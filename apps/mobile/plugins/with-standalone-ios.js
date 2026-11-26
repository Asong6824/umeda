const { withEntitlementsPlist } = require('@expo/config-plugins');

// Incremental prebuild merges the previous entitlements before applying config.
// Remove retired account/push capabilities there too; preserve App Groups for
// incoming shares and widgets. Local notifications still use the native module.
module.exports = function withStandaloneIos(config) {
  return withEntitlementsPlist(config, mod => {
    delete mod.modResults['aps-environment'];
    delete mod.modResults['com.apple.developer.applesignin'];
    delete mod.modResults['com.apple.developer.usernotifications.communication'];
    return mod;
  });
};
