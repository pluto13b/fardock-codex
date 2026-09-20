// Metro emits the web bundle as a classic script. Resolve the CommonJS build
// so libsodium's Emscripten loader does not leak `import.meta` into that script.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

export default sodium;
