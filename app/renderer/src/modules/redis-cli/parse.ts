// Splits a command line into argv the way redis-cli itself does: bare
// whitespace-separated tokens, 'single' or "double" quoted tokens taken
// literally (a backslash inside "..." escapes the next char), and a
// backslash outside quotes escaping the next char too.
export function parseRedisArgv(line: string): string[] {
  const argv: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let hasToken = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else if (c === quote) quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      hasToken = true;
    } else if (/\s/.test(c)) {
      if (hasToken) {
        argv.push(cur);
        cur = "";
        hasToken = false;
      }
    } else {
      cur += c === "\\" && i + 1 < line.length ? line[++i] : c;
      hasToken = true;
    }
  }
  if (hasToken) argv.push(cur);
  return argv;
}
