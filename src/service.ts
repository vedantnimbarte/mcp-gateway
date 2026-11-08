// `mcpgw service install|uninstall|status`: start the gateway when you log in, so clients never
// find it missing. Per user and without admin rights on every platform: a launchd agent on macOS,
// a systemd user unit on Linux, a hidden launcher in the Startup folder on Windows (Task
// Scheduler's logon trigger wants elevation). A login service inherits no shell, so secrets come
// from the .env beside the config, which `mcpgw start` reads.
import { join } from "node:path";

export interface ServicePlan {
  kind: "launchd" | "systemd" | "startup-folder";
  /** The file that makes it start at login. */
  file: string;
  content: string;
  /** Run after writing the file: start it now as well as at every login. */
  install: string[][];
  /** Run before deleting the file: stop it. */
  uninstall: string[][];
  log: string;
}

export interface ServiceInput {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
  uid?: number;
  node: string;
  cli: string;
  config: string;
  log: string;
  /** Lets two gateways (two configs) each have their own service. */
  name: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** systemd quoting: double quotes, with backslashes and quotes escaped. */
const sd = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function servicePlan(i: ServiceInput): ServicePlan {
  const args = [i.node, i.cli, "start", "--config", i.config, "--log", i.log];

  if (i.platform === "darwin") {
    const label = `dev.mcpgw.${i.name}`;
    const file = join(i.home, "Library", "LaunchAgents", `${label}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`;
    const domain = `gui/${i.uid ?? 501}`;
    return {
      kind: "launchd",
      file,
      content,
      install: [["launchctl", "bootstrap", domain, file]],
      uninstall: [["launchctl", "bootout", `${domain}/${label}`]],
      log: i.log,
    };
  }

  if (i.platform === "win32") {
    const startup = join(i.appData ?? join(i.home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const file = join(startup, `${i.name}.vbs`);
    // Run hidden (window style 0), without waiting: no console window at login.
    const line = args.map((a) => `""${a.replace(/"/g, '""""')}""`).join(" ");
    const content = `' Starts mcp-gateway at login, without a window. Written by mcpgw service install.\r\nCreateObject("WScript.Shell").Run "${line}", 0, False\r\n`;
    return {
      kind: "startup-folder",
      file,
      content,
      install: [["wscript.exe", file]],
      uninstall: [],
      log: i.log,
    };
  }

  const unit = `${i.name}.service`;
  const file = join(i.home, ".config", "systemd", "user", unit);
  const content = `[Unit]
Description=mcp-gateway (${i.config})
After=network-online.target

[Service]
ExecStart=${args.map(sd).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  return {
    kind: "systemd",
    file,
    content,
    install: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", unit],
    ],
    uninstall: [["systemctl", "--user", "disable", "--now", unit]],
    log: i.log,
  };
}
