import { existsSync } from "node:fs";
import { resolve } from "node:path";

const helpers = [
  "native-bin/win32-x64/nanollm-oauth-transport.exe",
  "native-bin/linux-x64/nanollm-oauth-transport",
  "native-bin/darwin-arm64/nanollm-oauth-transport",
];
const missing = helpers.filter((path) => !existsSync(resolve(path)));

if (missing.length > 0) {
  console.error(`Refusing to publish an incomplete nanollm package. Missing:\n${missing.map((path) => `- ${path}`).join("\n")}\nUse the release workflow, which builds and packages every supported platform.`);
  process.exit(1);
}
