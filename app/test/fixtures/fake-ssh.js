#!/usr/bin/env node
"use strict";
// Stand-in for the real `ssh` binary, used only by
// test/unit/ssh-tunnel.integration.test.js. Understands just enough of
// `ssh -N -L 127.0.0.1:LOCAL:127.0.0.1:REMOTE ... target` to be a faithful
// local-forward: it really binds LOCAL and really proxies bytes to REMOTE,
// so the integration test exercises real sockets end to end rather than
// mocking spawn() away.
//
// FAKE_SSH_BEHAVIOR env var selects what it does instead, for testing the
// failure paths:
//   forward (default) - real TCP proxy, as above
//   fail               - exit non-zero immediately, like a rejected auth
//   hang               - never open the port, never exit, until killed

const net = require("net");

const behavior = process.env.FAKE_SSH_BEHAVIOR || "forward";

if (behavior === "fail") {
  process.stderr.write("fake-ssh: Permission denied (publickey)\n");
  process.exit(255);
} else if (behavior === "hang") {
  // an interval (not stdin -- startTunnel spawns with stdio: "ignore", so
  // the child's stdin is /dev/null and would hit EOF immediately) is what
  // actually keeps the event loop, and the process, alive until killed.
  setInterval(() => {}, 1 << 30);
} else {
  const args = process.argv.slice(2);
  const spec = args[args.indexOf("-L") + 1]; // "127.0.0.1:LOCAL:127.0.0.1:REMOTE"
  const [, localPort, , remotePort] = spec.split(":");

  const srv = net.createServer((client) => {
    const upstream = net.connect(Number(remotePort), "127.0.0.1", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  srv.on("error", (err) => {
    process.stderr.write(`fake-ssh: bind failed: ${err.message}\n`);
    process.exit(1);
  });
  srv.listen(Number(localPort), "127.0.0.1");
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
