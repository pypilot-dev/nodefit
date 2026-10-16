/** `nodefit` command line: doctor, check, pin, lsp. */
import { main } from "./cli/main";

// `nodefit doctor --json | head` closes the pipe early; that is not a failure.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

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
