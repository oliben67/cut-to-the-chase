# Extract a log level (INFO/WARN/ERROR/...) into fields["level"].
"""Example transform: tag each record with its log level.

A transform module exposes one function:

    transform(record: dict) -> dict | list[dict] | None

record = {"ts": epoch_ms, "text": str, "fields": dict, "source": str}
Return the (mutated) record, a list of records to split one line into
several, or None to drop the line entirely.
"""

import re

LEVEL_RE = re.compile(r"\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|CRIT(?:ICAL)?|FATAL)\b", re.I)


def transform(record):
    m = LEVEL_RE.search(record["text"])
    if m:
        record["fields"]["level"] = m.group(1).upper()
    return record
