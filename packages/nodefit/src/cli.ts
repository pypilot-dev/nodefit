/** `nodefit` command line: doctor, check, pin, lsp. */
import { main } from "./cli/main";

main(process.argv.slice(2)).then(
  (code) => {
    // The language server keeps the process alive; it exits on its own.
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`nodefit: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 2;
  },
);
