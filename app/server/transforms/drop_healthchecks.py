# Drop noisy health-check / readiness-probe lines before they reach the UI.
import re

NOISE = re.compile(r"GET /(health|healthz|ready|live|ping)\b", re.I)


def transform(record):
    if NOISE.search(record["text"]):
        return None
    return record
