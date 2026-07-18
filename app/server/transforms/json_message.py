# For JSON-formatted log lines, show "LEVEL logger: message" instead of raw JSON.
def transform(record):
    f = record["fields"]
    if not f:
        return record
    msg = f.get("msg") or f.get("message") or f.get("event")
    if msg:
        level = f.get("level") or f.get("severity") or ""
        logger = f.get("logger") or f.get("name") or ""
        prefix = " ".join(p for p in (str(level).upper(), logger) if p)
        record["text"] = f"{prefix}: {msg}" if prefix else str(msg)
    return record
