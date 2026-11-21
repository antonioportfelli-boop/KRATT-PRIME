/**
 * KRATT PRIME — Linux Operations Intelligence v0.1.0
 *
 * Fixed-argument, read-only diagnostics. No shell, sudo, config writes,
 * service changes, package installs, process termination, or network probes.
 * Reported network metadata is sensitive and must not be auto-uploaded.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LINUX_OPERATIONS_VERSION = "0.1.0";

const command = (id, executable, args, purpose, dataClass = "SYSTEM_METADATA") =>
  Object.freeze({ id, executable, args: Object.freeze(args), purpose, dataClass });

export const LINUX_DIAGNOSTIC_COMMANDS = Object.freeze([
  command("ip.addresses", "ip", ["-j", "-br", "address"], "Enumerate interface addresses", "NETWORK_METADATA"),
  command("ip.link_stats", "ip", ["-s", "-j", "link", "show"], "Read interface state and counters", "NETWORK_METADATA"),
  command("ip.routes.v4", "ip", ["-j", "route", "show", "table", "all"], "Read IPv4 routing tables", "NETWORK_METADATA"),
  command("ip.routes.v6", "ip", ["-j", "-6", "route", "show", "table", "all"], "Read IPv6 routing tables", "NETWORK_METADATA"),
  command("ip.rules.v4", "ip", ["-j", "rule", "show"], "Read IPv4 policy-routing rules", "NETWORK_METADATA"),
  command("ip.rules.v6", "ip", ["-j", "-6", "rule", "show"], "Read IPv6 policy-routing rules", "NETWORK_METADATA"),
  command("ip.neighbours", "ip", ["-j", "neigh", "show"], "Read ARP/ND neighbour cache", "NETWORK_METADATA"),
  command("ip.route_get.v4", "ip", ["-j", "route", "get", "1.1.1.1"], "Resolve a sample IPv4 route; sends no packet", "NETWORK_METADATA"),
  command("ip.route_get.v6", "ip", ["-j", "-6", "route", "get", "2606:4700:4700::1111"], "Resolve a sample IPv6 route; sends no packet", "NETWORK_METADATA"),
  command("nmcli.general", "nmcli", ["--terse", "--fields", "RUNNING,STATE,CONNECTIVITY", "general", "status"], "Read NetworkManager daemon status", "NETWORK_METADATA"),
  command("nmcli.devices", "nmcli", ["--terse", "--fields", "DEVICE,TYPE,STATE", "device", "status"], "Read device states without connection names or SSIDs", "NETWORK_METADATA"),
  command("service.networkmanager", "systemctl", ["is-active", "NetworkManager"], "Read NetworkManager service state"),
  command("service.systemd_networkd", "systemctl", ["is-active", "systemd-networkd"], "Read systemd-networkd service state"),
  command("service.connman", "systemctl", ["is-active", "connman"], "Read ConnMan service state"),
  command("netctl.version", "netctl", ["--version"], "Detect Arch netctl tool without listing private profile names")
]);

export const LINUX_ACTION_POLICY = Object.freeze({
  // Read-only diagnostics.
  "ip.addresses.read": "READ_ONLY",
  "ip.routes.read": "READ_ONLY",
  "ip.route_get.read": "READ_ONLY",
  "ip.rules.read": "READ_ONLY",
  "ip.neighbours.read": "SENSITIVE_READ",
  "ip.link_stats.read": "SENSITIVE_READ",
  "networkmanager.status.read": "SENSITIVE_READ",
  "networkmanager.config.names.read": "SENSITIVE_READ",
  "os.release.read": "READ_ONLY",
  "package_manager.detect": "READ_ONLY",
  "editor.detect": "READ_ONLY",
  "manpage.read": "READ_ONLY",
  "tldr.read": "READ_ONLY",
  "history.read": "SENSITIVE_READ",
  "process.list": "SENSITIVE_READ",
  // Explicitly controlled changes.
  "editor.file.write": "LOCAL_WRITE",
  "shell.alias.persist": "LOCAL_WRITE",
  "cron.schedule.write": "LOCAL_WRITE",
  "file.redirect.append": "LOCAL_WRITE",
  "chmod.change": "PRIVILEGED",
  "networkmanager.dropin.write": "PRIVILEGED",
  "networkmanager.reload": "PRIVILEGED",
  "netctl.profile.start": "PRIVILEGED",
  "netctl.profile.stop": "PRIVILEGED",
  "netctl.profile.enable": "PRIVILEGED",
  "netctl.profile.disable": "PRIVILEGED",
  "netctl.profile.switch": "PRIVILEGED",
  "ip.address.add": "PRIVILEGED",
  "ip.address.delete": "PRIVILEGED",
  "ip.link.up": "PRIVILEGED",
  "ip.link.down": "PRIVILEGED",
  "ip.link.mtu": "PRIVILEGED",
  "ip.route.add": "PRIVILEGED",
  "ip.route.replace": "PRIVILEGED",
  "ip.route.delete": "PRIVILEGED",
  "ip.route.flush": "IRREVERSIBLE",
  "package.install": "PRIVILEGED",
  "package.upgrade": "PRIVILEGED",
  "package.remove": "IRREVERSIBLE",
  "package.purge": "IRREVERSIBLE",
  "process.kill": "PRIVILEGED",
  "window.xkill": "PRIVILEGED",
  "file.redirect.overwrite": "IRREVERSIBLE",
  "history.delete": "IRREVERSIBLE",
  "shell.command.execute": "IRREVERSIBLE"
});

export function classifyLinuxAction(actionId) {
  return LINUX_ACTION_POLICY[actionId] ?? "IRREVERSIBLE";
}

function defaultCommandAvailable(executable, env = process.env) {
  const dirs = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, executable), fs.constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

function readOsRelease(readFileSync = fs.readFileSync) {
  let raw;
  try {
    raw = readFileSync("/etc/os-release", "utf8");
  } catch {
    return null;
  }
  const allowed = new Set(["ID", "ID_LIKE", "VERSION_ID", "PRETTY_NAME"]);
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match || !allowed.has(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value.slice(0, 160);
  }
  return result;
}

function readNetworkManagerConfigMetadata(existsSync = fs.existsSync, readdirSync = fs.readdirSync) {
  const main = "/etc/NetworkManager/NetworkManager.conf";
  const dropin = "/etc/NetworkManager/conf.d";
  let dropins = [];
  try {
    dropins = readdirSync(dropin).filter(name => name.endsWith(".conf")).sort().slice(0, 100);
  } catch {
    // A missing or inaccessible directory is represented as an empty list.
  }
  return Object.freeze({
    mainConfigPresent: existsSync(main),
    dropInDirectoryPresent: existsSync(dropin),
    dropInFiles: Object.freeze(dropins),
    contentsRead: false,
    connectionProfilesRead: false
  });
}

function clip(value, limit = 32768) {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(0, limit) + "\n[TRUNCATED]" : text;
}

/**
 * Run the fixed allowlist only. Test seams (runner/commandAvailable) do not
 * expand the public command surface and must not be wired to user-supplied argv.
 */
export function collectLinuxDiagnostics(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return Object.freeze({
      schemaVersion: LINUX_OPERATIONS_VERSION,
      state: "UNSUPPORTED_PLATFORM",
      platform,
      commands: Object.freeze([]),
      writesPerformed: false,
      privilegedOperationsPerformed: false
    });
  }

  const env = options.env ?? process.env;
  const commandAvailable = options.commandAvailable ?? ((name) => defaultCommandAvailable(name, env));
  const runner = options.runner ?? ((executable, args) => spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: 2000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    env: { ...env, LC_ALL: "C", NO_COLOR: "1" }
  }));

  const commands = LINUX_DIAGNOSTIC_COMMANDS.map(spec => {
    if (!commandAvailable(spec.executable)) {
      return Object.freeze({ id: spec.id, state: "UNAVAILABLE", purpose: spec.purpose, dataClass: spec.dataClass });
    }
    try {
      const result = runner(spec.executable, [...spec.args]);
      const state = result.error ? "ERROR" : result.status === 0 ? "OK" : "EXIT_NONZERO";
      return Object.freeze({
        id: spec.id,
        state,
        exitCode: Number.isInteger(result.status) ? result.status : null,
        stdout: clip(result.stdout),
        stderr: clip(result.stderr, 4096),
        purpose: spec.purpose,
        dataClass: spec.dataClass
      });
    } catch (error) {
      return Object.freeze({
        id: spec.id,
        state: "ERROR",
        exitCode: null,
        stderr: clip(error?.message ?? "Unknown diagnostic error", 4096),
        purpose: spec.purpose,
        dataClass: spec.dataClass
      });
    }
  });

  const available = name => {
    try { return commandAvailable(name); } catch { return false; }
  };
  const packageManagers = ["apt-get", "dnf", "yum", "pacman", "zypper", "apk", "pkg", "emerge", "brew", "snap", "flatpak", "nix"]
    .filter(available);
  const editors = ["nano", "micro", "vim", "vi"]
    .filter(available);
  const developerTools = ["bash", "shellcheck", "tmux", "man", "tldr"]
    .filter(available);

  return Object.freeze({
    schemaVersion: LINUX_OPERATIONS_VERSION,
    state: "COLLECTED_READ_ONLY",
    platform,
    osRelease: readOsRelease(options.readFileSync),
    packageManagers: Object.freeze(packageManagers),
    editors: Object.freeze(editors),
    developerTools: Object.freeze(developerTools),
    networkManagerConfig: readNetworkManagerConfigMetadata(options.existsSync, options.readdirSync),
    commands: Object.freeze(commands),
    privacy: Object.freeze({
      classification: "NETWORK_METADATA",
      mayContainPrivateIpAddresses: true,
      mayContainMacAddresses: true,
      autoUploadAllowed: false,
      exportRequiresApproval: true
    }),
    writesPerformed: false,
    privilegedOperationsPerformed: false
  });
}

export const LINUX_OPERATIONS_INVARIANTS = Object.freeze([
  "No shell interpreter or arbitrary command string is accepted.",
  "No sudo or privileged command is run by the diagnostics collector.",
  "No address, route, link, firewall, service, package, process, alias or cron state is modified.",
  "NetworkManager configuration contents and saved connection profiles are never read.",
  "History and full process command lines are never collected.",
  "Network metadata is local-only by default and is not uploaded automatically.",
  "Unknown operations default to IRREVERSIBLE and require separate policy review."
]);
