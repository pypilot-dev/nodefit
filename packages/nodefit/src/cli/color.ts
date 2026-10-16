/** ANSI styles, or identity functions when colour is off. */
export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

export function colors(enabled: boolean): Colors {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/**
 * Colour only on a terminal, and never when NO_COLOR is set (no-color.org).
 * FORCE_COLOR turns it on for CI logs that render ANSI.
 */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout, env = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY) && env.TERM !== "dumb";
}
