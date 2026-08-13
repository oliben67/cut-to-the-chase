import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import { parseRedisArgv } from "./parse";
import { formatRedisReply, type RedisReply } from "./format";

export { parseRedisArgv } from "./parse";
export { formatRedisReply } from "./format";
export type { RedisReply } from "./format";

// Developer-only Redis CLI (Help > Developers > Redis CLI…, app.js's
// RENDERER_ACTIONS "redis-cli" entry calls openRedisCliDialog below) --
// sends raw commands to whichever target's internal Redis is currently
// active. See main.js's "redis-cli-run" handler: it just fetches the
// already-resolved serverHost/serverPort like every other post-connect
// request, so this never opens a new connection of its own.

const dlgRedisCli = $("dlg-redis-cli");
const redisCliOutput = $("redis-cli-output");
const redisCliInput = $("redis-cli-input") as HTMLInputElement;
const redisCliHistory: string[] = [];
let redisCliHistoryIdx = -1;

function redisCliPrint(text: string, cls?: string): void {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  redisCliOutput.appendChild(line);
  redisCliOutput.scrollTop = redisCliOutput.scrollHeight;
}

export async function runRedisCliCommand(rawLine: string): Promise<void> {
  const line = rawLine.trim();
  if (!line) return;
  redisCliHistory.push(line);
  redisCliHistoryIdx = redisCliHistory.length;
  redisCliPrint(`> ${line}`);
  // Client-side-only pseudo-command, matching real redis-cli -- never
  // actually sent to Redis.
  if (line.toLowerCase() === "clear") {
    redisCliOutput.textContent = "";
    return;
  }
  const argv = parseRedisArgv(line);
  if (!argv.length) return;
  try {
    const reply = (await window.cttc!.redisCliRun(argv)) as RedisReply;
    redisCliPrint(formatRedisReply(reply), reply?.type === "error" ? "error" : undefined);
  } catch (err) {
    redisCliPrint(`(error) ${(err as Error).message || err}`, "error");
  }
}

export async function openRedisCliDialog(): Promise<void> {
  const info = await window.cttc!.getConnectionInfo();
  $("redis-cli-target").textContent =
    info.connectionType === "local" ? "— local" : `— gateway: ${info.gatewayHost}`;
  dlgRedisCli.showModal();
  redisCliInput.focus();
}

$("redis-cli-run").onclick = () => {
  runRedisCliCommand(redisCliInput.value);
  redisCliInput.value = "";
  redisCliInput.focus();
};
redisCliInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    runRedisCliCommand(redisCliInput.value);
    redisCliInput.value = "";
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (redisCliHistoryIdx > 0) {
      redisCliHistoryIdx--;
      redisCliInput.value = redisCliHistory[redisCliHistoryIdx];
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (redisCliHistoryIdx < redisCliHistory.length - 1) {
      redisCliHistoryIdx++;
      redisCliInput.value = redisCliHistory[redisCliHistoryIdx];
    } else {
      redisCliHistoryIdx = redisCliHistory.length;
      redisCliInput.value = "";
    }
  }
});
$("redis-cli-clear").onclick = () => {
  redisCliOutput.textContent = "";
};
$("dlg-redis-cli-close").onclick = () => dlgRedisCli.close();
