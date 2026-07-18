#!/usr/bin/env python3
"""Generate correlated demo data: docker-stats JSONL + two service logs.

Static mode (default): 30 minutes of history ending now.
Live mode (--live): keeps appending one telemetry sample / log lines per tick,
so the app's tail + follow mode can be exercised.

Usage: uv run generate_demo.py [--out DIR] [--live]
"""

import argparse
import math
import random
import time
from datetime import datetime, timezone
from pathlib import Path

random.seed(20260717)

SERVICES = ["c3_api", "c3_worker", "c3_redis"]

# spike windows (offset seconds from start, duration s, service, cause)
SPIKES = [
    (300, 45, "c3_api", "request burst"),
    (760, 60, "c3_worker", "batch job"),
    (1200, 30, "c3_api", "slow queries"),
    (1500, 50, "c3_worker", "memory pressure"),
]


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def spike_factor(t_off: float, svc: str) -> tuple[float, str | None]:
    for start, dur, s, cause in SPIKES:
        if s == svc and start <= t_off <= start + dur:
            x = (t_off - start) / dur
            return math.sin(x * math.pi), cause  # ramp up then down
    return 0.0, None


class Gen:
    def __init__(self, out: Path):
        self.out = out
        self.net_total = {s: [random.uniform(1e6, 5e6), random.uniform(1e6, 5e6)] for s in SERVICES}
        self.stats_f = open(out / "stats.jsonl", "a")
        self.api_f = open(out / "c3_api.log", "a")
        self.worker_f = open(out / "c3_worker.log", "a")

    def stats_tick(self, ts: float, t_off: float):
        for svc in SERVICES:
            f, cause = spike_factor(t_off, svc)
            base_cpu = {"c3_api": 6, "c3_worker": 10, "c3_redis": 3}[svc]
            cpu = base_cpu + random.uniform(-1.5, 1.5) + f * 70
            mem = {"c3_api": 22, "c3_worker": 30, "c3_redis": 12}[svc] + f * 35 + random.uniform(-1, 1)
            mem_gb = mem / 100 * 4
            rate = (2e4 + f * 4e6 + random.uniform(0, 1e4)) * 5  # bytes over 5s
            self.net_total[svc][0] += rate * 0.6
            self.net_total[svc][1] += rate * 0.4
            rx, tx = self.net_total[svc]
            entry = {
                "BlockIO": "0B / 0B",
                "CPUPerc": f"{max(cpu, 0.1):.2f}%",
                "ID": f"{abs(hash(svc)) % 10**12:012x}",
                "MemPerc": f"{max(mem, 0.5):.2f}%",
                "MemUsage": f"{mem_gb * 1024:.1f}MiB / 4GiB",
                "Name": f"{svc}.1.{abs(hash(svc)) % 10**8:08x}",
                "NetIO": f"{rx / 1e6:.3g}MB / {tx / 1e6:.3g}MB",
                "PIDs": str(random.randint(8, 24)),
                "timestamp": iso(ts),
            }
            import json

            self.stats_f.write(json.dumps(entry, separators=(",", ":")) + "\n")
        self.stats_f.flush()

    def log_tick(self, ts: float, t_off: float):
        routes = ["/api/orders", "/api/users", "/api/search", "/api/cart"]
        fa, cause_a = spike_factor(t_off, "c3_api")
        n = 1 + int(fa * 12)
        for i in range(n):
            r = random.choice(routes)
            lat = int(random.uniform(8, 40) * (1 + fa * 25))
            level = "ERROR" if (fa > 0.6 and random.random() < 0.3) else ("WARN" if lat > 300 else "INFO")
            msg = f"{level} http {r} status={'500' if level == 'ERROR' else '200'} latency_ms={lat}"
            if level == "ERROR":
                msg += f" err=\"upstream timeout ({cause_a})\""
            self.api_f.write(f"{iso(ts + i * 0.05)} {msg}\n")
        if random.random() < 0.4:
            self.api_f.write(f"{iso(ts + 0.9)} INFO healthcheck GET /health 200\n")
        self.api_f.flush()

        fw, cause_w = spike_factor(t_off, "c3_worker")
        if random.random() < 0.25 + fw:
            jid = random.randint(1000, 9999)
            if fw > 0.5:
                self.worker_f.write(f"{iso(ts)} WARN job {jid} slow, queue depth {int(20 + fw * 400)} ({cause_w})\n")
                if random.random() < 0.25:
                    self.worker_f.write(
                        f"{iso(ts + 0.4)} ERROR job {jid} failed: OutOfMemoryError\n"
                        f"    at worker.batch.process(batch.py:214)\n"
                        f"    at worker.main.run(main.py:88)\n"
                    )
            else:
                self.worker_f.write(f"{iso(ts)} INFO job {jid} done in {int(random.uniform(80, 900))}ms\n")
        self.worker_f.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).parent / "data"))
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--minutes", type=int, default=30)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for f in ("stats.jsonl", "c3_api.log", "c3_worker.log"):
        (out / f).unlink(missing_ok=True)

    g = Gen(out)
    duration = args.minutes * 60
    start = time.time() - duration
    for t_off in range(0, duration, 5):
        ts = start + t_off
        g.stats_tick(ts, t_off)
        for sub in range(5):
            g.log_tick(ts + sub, t_off + sub)
    print(f"wrote static history to {out}")

    if args.live:
        print("appending live ticks (Ctrl+C to stop)...")
        t_off = duration
        while True:
            time.sleep(5)
            ts = time.time()
            # loop the spike schedule so live mode keeps having events
            g.stats_tick(ts, t_off % 1800)
            for sub in range(5):
                g.log_tick(ts + sub, (t_off + sub) % 1800)
            t_off += 5


if __name__ == "__main__":
    main()
