import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.resolve(root, "dist-ui");
const dest = path.resolve(root, "dist-ui-pack");

if (!fs.existsSync(src)) {
  console.error(`UI dist not found: ${src}\nRun: npm run build:ui -w @sloncord/moderation`);
  process.exit(1);
}

// electron-builder extraResources copies dist-ui; for dev packaged runs keep same folder name.
console.log(`UI ready at ${src}`);
