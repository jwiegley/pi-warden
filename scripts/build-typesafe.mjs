// The fork dependency is a pinned source archive; Nix supplies an already-built copy.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../node_modules/pi-typesafe/", import.meta.url);
if (existsSync(new URL("tsconfig.build.json", root))) {
  execFileSync("npm", ["run", "build", "--prefix", fileURLToPath(root)], { stdio: "inherit" });
}
