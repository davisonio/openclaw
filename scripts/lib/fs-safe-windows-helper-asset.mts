import fs from "node:fs";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";

/** The fs-safe command runtime resolves this executable beside its bundled module. */
export function resolveFsSafeWindowsHelper(rootDir = process.cwd()): string {
  return fs.realpathSync(
    path.resolve(rootDir, "node_modules/@openclaw/fs-safe/dist/windows-security-helper.exe"),
  );
}

export function createFsSafeWindowsHelperAssetPlugin(
  rootDir = process.cwd(),
  fileName = "windows-security-helper.exe",
  recordInput?: (file: string) => void,
): TsdownPlugin {
  return {
    name: "openclaw:fs-safe-windows-helper",
    buildStart() {
      const source = resolveFsSafeWindowsHelper(rootDir);
      recordInput?.(source);
      this.addWatchFile(source);
      this.emitFile({ type: "asset", fileName, source: fs.readFileSync(source) });
    },
  };
}
