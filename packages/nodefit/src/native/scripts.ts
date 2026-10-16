/**
 * What a package's install scripts do, read from their text. npm runs
 * preinstall, install and postinstall in that order, and a package with a
 * binding.gyp but no install script gets "node-gyp rebuild" implicitly.
 */
export type ScriptMechanism =
  /** No install script at all. */
  | { kind: "none" }
  /** Only well-known scripts that never build anything (husky, core-js's banner…). */
  | { kind: "harmless"; script: string }
  | { kind: "prebuild-install"; script: string; fallback: boolean }
  | { kind: "node-pre-gyp"; script: string; fallback: boolean }
  | { kind: "install-artifact"; script: string; fallback: boolean }
  /** node-gyp-build (prebuildify): bundled binaries, compiling when none fits. */
  | { kind: "node-gyp-build"; script: string }
  /** A check of bundled binaries, then node-gyp when it fails (node-pty, deasync). */
  | { kind: "check-then-build"; script: string }
  /** node-gyp / cmake-js unconditionally. */
  | { kind: "compile"; script: string; tool: "node-gyp" | "cmake-js" }
  | { kind: "custom"; script: string };

const HOOKS = ["preinstall", "install", "postinstall"] as const;

/** The install-time scripts, joined as npm would run them. */
export function installScript(scripts: Record<string, string> | undefined, gypfile: boolean | undefined): string {
  const parts = HOOKS.map((h) => scripts?.[h]?.trim()).filter((s): s is string => Boolean(s));
  if (parts.length === 0 && gypfile !== false && gypfile !== undefined) return "node-gyp rebuild";
  return parts.join(" && ");
}

/**
 * Scripts that do nothing to native code. Matched per command, so
 * `is-ci || husky install` is harmless but `husky && node-gyp rebuild` is not.
 */
const HARMLESS: RegExp[] = [
  /^husky(\s+install)?(\s+\S+)?$/,
  /^is-ci$/,
  /^patch-package(\s.*)?$/,
  /^(npx\s+)?(opencollective|opencollective-postinstall)(\s+postinstall)?(\s*\|\|\s*(exit 0|true))?$/,
  /^node\s+-e\s+"try\{require\('\.\/postinstall'\)\}catch\(e\)\{\}"$/,
  /^echo\b.*$/,
  /^exit 0$/,
  /^true$/,
  /^:$/,
  /^node\s+\S*(opencollective|funding|thanks|banner|donate)\S*$/i,
];

/** Leading `cross-env A=1` / `A=1` assignments say nothing about what runs. */
function command(raw: string): string {
  return raw
    .trim()
    .replace(/^(cross-env\s+)?(\w+=\S*\s+)+/, "")
    .trim();
}

export function classifyScript(script: string): ScriptMechanism {
  if (!script) return { kind: "none" };
  const commands = script
    .split(/&&|\|\||;/)
    .map(command)
    .filter(Boolean);
  if (commands.length > 0 && commands.every((c) => HARMLESS.some((re) => re.test(c)))) {
    return { kind: "harmless", script };
  }

  const fallback = /\|\|/.test(script);
  if (/\bprebuild-install\b/.test(script)) return { kind: "prebuild-install", script, fallback };
  if (/\bnode-pre-gyp\s+install\b/.test(script)) {
    return { kind: "node-pre-gyp", script, fallback: /--fallback-to-build\b/.test(script) || fallback };
  }
  if (/\binstall-from-cache\b/.test(script)) return { kind: "install-artifact", script, fallback };
  if (/\bnode-gyp-build(-optional-packages)?\b/.test(script)) return { kind: "node-gyp-build", script };

  const compiles = commands.findIndex((c) => /^(node-gyp|cmake-js)\b/.test(c));
  if (compiles !== -1) {
    const tool = commands[compiles]?.startsWith("cmake-js") ? "cmake-js" : "node-gyp";
    // `check || node-gyp rebuild` builds only when the check fails, and the
    // check is usually "is there a bundled binary for this platform?".
    const alternatives = script.split("||").map((s) => s.trim());
    const buildsFirst = /^(\S+=\S*\s+)*(node-gyp|cmake-js)\b/.test(alternatives[0] ?? "");
    if (alternatives.length > 1 && !buildsFirst) return { kind: "check-then-build", script };
    return { kind: "compile", script, tool };
  }
  return { kind: "custom", script };
}
