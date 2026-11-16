const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Shared types and board rules live in ../server/types.ts.
config.watchFolders = [path.resolve(__dirname, "../server")];

module.exports = config;
