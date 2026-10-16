import { relative, resolve } from "node:path";
import { analyze } from "../analyze";
import { checkPackage } from "../analyze/check";
import { pinVersion, releaseFor } from "../analyze/resolve";
import { loadEnvironment, loadInputs } from "../analyze/session";
import { readProject, writePin } from "../project";
import { VERSION } from "../version";
import { colorEnabled, colors } from "./color";
import { formatCheck, formatDoctor } from "./doctor";
import { toJson } from "./json";

const HELP = `nodefit ${VERSION}: the Node.js version every dependency supports

Usage:
  nodefit doctor [--path <dir>] [--json] [--prod] [--offline]
      Check the project against this machine's Node and every Node release.
  nodefit check <package[@range]> [--path <dir>] [--json] [--offline]
      Can this package install and run on the project's Node?
  nodefit pin [version] [--path <dir>]
      Write the recommended (or given) Node version to the project's pin file.
  nodefit lsp [--stdio]
      Run the language server (editors start this).

Options:
  --path <dir>   project directory (default: the current one)
  --json         print the result as JSON
  --prod         leave out packages only dev dependencies need
  --offline      use cached registry data only
  -v, --version  print nodefit's version
  -h, --help     print this help

Exit status: 0 no errors, 1 error findings, 2 nodefit itself failed.
`;

export interface Args {
  command?: string;
  positional: string[];
  path: string;
  json: boolean;
  prod: boolean;
  offline: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    positional: [],
    path: ".",
    json: false,
    prod: false,
    offline: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const [flag, inline] =
      a.startsWith("--") && a.includes("=")
        ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
        : [a, undefined];
    switch (flag) {
      case "--path": {
        const value = inline ?? argv[++i];
        if (!value) throw new UsageError("--path needs a directory");
        args.path = value;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--prod":
        args.prod = true;
        break;
      case "--offline":
        args.offline = true;
        break;
      // Transport flags belong to the language server, which reads them itself.
      case "--stdio":
      case "--node-ipc":
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      default:
        if (flag.startsWith("-") && !flag.startsWith("--socket") && !flag.startsWith("--clientProcessId")) {
          throw new UsageError(`unknown option ${flag}`);
        }
        if (!flag.startsWith("-")) {
          if (args.command === undefined) args.command = flag;
          else args.positional.push(flag);
        }
    }
  }
  return args;
}

export class UsageError extends Error {}

/** Runs one command; resolves to the exit status. */
export async function main(argv: string[]): Promise<number> {
  const out = (text: string) => process.stdout.write(text);
  const err = (text: string) => process.stderr.write(text);
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`nodefit: ${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.version) {
    out(`${VERSION}\n`);
    return 0;
  }
  if (args.help || !args.command) {
    out(HELP);
    return args.help ? 0 : 2;
  }

  const c = colors(!args.json && colorEnabled());
  const root = resolve(args.path);
  try {
    switch (args.command) {
      case "doctor": {
        const report = await analyze({
          ...(await loadInputs(root, { offline: args.offline })),
          includeDev: !args.prod,
        });
        out(args.json ? `${toJson(report)}\n` : formatDoctor(report, c));
        return report.findings.some((f) => f.severity === "error") ? 1 : 0;
      }
      case "check": {
        const spec = args.positional[0];
        if (!spec) throw new UsageError("check needs a package, e.g. `nodefit check sharp`");
        const environment = await loadEnvironment({ offline: args.offline });
        const project = await readProject(root).catch(() => undefined);
        const outcome = await checkPackage(spec, { ...environment, ...(project ? { project } : {}) });
        out(args.json ? `${toJson(outcome)}\n` : formatCheck(outcome, c));
        return outcome.severity === "error" ? 1 : 0;
      }
      case "pin": {
        const inputs = await loadInputs(root, { offline: args.offline });
        const report = await analyze({ ...inputs, includeDev: !args.prod });
        const wanted = args.positional[0]?.replace(/^v/, "");
        const version = wanted ?? (report.recommended ? pinVersion(inputs.index, report.recommended) : undefined);
        if (!version) {
          err(
            "nodefit: no Node release fits every dependency, so there is nothing to pin. Run `nodefit doctor` to see why.\n",
          );
          return 1;
        }
        const { file } = await writePin(inputs.project, version);
        // Relative only when it is shorter to read: a file under this directory.
        const near = relative(process.cwd(), file);
        out(`Pinned Node ${c.bold(version)} in ${c.cyan(near && !near.startsWith("..") ? near : file)}\n`);
        const release = wanted ? releaseFor(inputs.index, wanted) : undefined;
        if (release && !report.supported.has(release.version)) {
          err(c.yellow(`warning: Node ${wanted} is outside what every dependency supports (${report.supported}).\n`));
        }
        return 0;
      }
      case "lsp": {
        // vscode-languageserver picks its transport from argv; default to stdio.
        if (!process.argv.some((a) => a === "--stdio" || a === "--node-ipc" || a.startsWith("--socket"))) {
          process.argv.push("--stdio");
        }
        const { startServer } = await import("../lsp/server");
        startServer();
        return -1;
      }
      default:
        throw new UsageError(`unknown command \`${args.command}\``);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`nodefit: ${e.message}\n\n${HELP}`);
      return 2;
    }
    err(`nodefit: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
