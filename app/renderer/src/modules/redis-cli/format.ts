// Mirrors the shape server.py's _redis_type_reply() sends back over
// "redis-cli-run" -- a type-tagged reply so formatRedisReply() below can
// render it in real-redis-cli style without re-deriving type info from an
// already-flattened string.
export type RedisReply =
  | { type: "nil" }
  | { type: "integer"; value: number }
  | { type: "status"; value: string }
  | { type: "bulk"; value: string }
  | { type: "error"; value: string }
  | { type: "array"; value: RedisReply[] };

// Mirrors real redis-cli's own reply formatting. Note: the server side
// can't actually distinguish a RESP simple-string status reply from a
// bulk string once redis-py has decoded it -- "status" there is a small
// heuristic allow-list (OK/PONG/QUEUED), not a true protocol-level read
// (see server.py's _redis_type_reply).
export function formatRedisReply(reply: RedisReply): string {
  if (!reply || typeof reply !== "object") return String(reply);
  switch (reply.type) {
    case "nil":
      return "(nil)";
    case "integer":
      return `(integer) ${reply.value}`;
    case "status":
      return String(reply.value);
    case "bulk":
      return JSON.stringify(String(reply.value));
    case "error":
      return `(error) ${reply.value}`;
    case "array": {
      const items = reply.value || [];
      if (!items.length) return "(empty array)";
      // A nested array's own lines need to align under its "N) " prefix,
      // not just inherit a fixed indent -- the prefix's width varies with
      // the index's digit count (e.g. "10) " vs "1) "), so continuation
      // lines are indented to match this entry's own prefix, not the
      // child's unaware-of-nesting formatting.
      return items
        .map((item, i) => {
          const prefix = `${i + 1}) `;
          const formatted = formatRedisReply(item)
            .split("\n")
            .join("\n" + " ".repeat(prefix.length));
          return prefix + formatted;
        })
        .join("\n");
    }
    default:
      // Defensive only -- reply comes off the wire (main.js's fetch
      // response), so a malformed/unexpected type isn't actually
      // impossible the way the type above claims.
      return String((reply as { value?: unknown }).value);
  }
}
