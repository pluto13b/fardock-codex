const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Exclude Tauri Rust build artifacts from Metro's file watcher.
// Cargo writes/deletes transient files in src-tauri/target/debug/deps during
// `tauri dev`, which crashes Metro's fallback watcher on Windows with ENOENT.
config.resolver.blockList = [
  /[/\\]src-tauri[/\\]target[/\\].*/,
];

// `scripts/postinstall.cjs` normalizes Preact's exports to one CJS instance.
// Do not add a custom Metro resolver here: Expo 55's autolinking resolver owns
// this hook and composing the old upstream callback breaks package lookup.

// Enable inlineRequires for proper Skia and Reanimated loading
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/web/
// Without this, Skia throws "react-native-reanimated is not installed" error
// This is cross-platform compatible (iOS, Android, web)
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true, // Critical for @shopify/react-native-skia
  },
});

module.exports = config;
