// Test backend launcher: behaves like `npx`. It runs the real server as a child on its own stdio,
// and also starts a grandchild that ignores stdin EOF — which is what leaks when only the launcher
// is killed. The grandchild's pid goes to $LAUNCHER_PID_FILE so a test can check it died.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("./fixture-server.js", import.meta.url));
spawn(process.execPath, [server], { stdio: "inherit" });

// Detached, because on Windows a node launcher's children otherwise share its job object and die
// with it — hiding the leak that `npx`'s cmd.exe launcher really has. It is still the launcher's
// child by parent pid, which is all the gateway's cleanup goes by.
const straggler = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  detached: true,
});
writeFileSync(process.env.LAUNCHER_PID_FILE!, String(straggler.pid));
