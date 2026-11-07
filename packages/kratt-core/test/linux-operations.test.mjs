import test from "node:test";
import assert from "node:assert/strict";
import {
  LINUX_DIAGNOSTIC_COMMANDS,
  LINUX_OPERATIONS_INVARIANTS,
  classifyLinuxAction,
  collectLinuxDiagnostics
} from "../src/linux-operations.mjs";

test("diagnostic command catalog is a fixed read-only allowlist", () => {
  assert.ok(LINUX_DIAGNOSTIC_COMMANDS.length >= 10);
  for (const item of LINUX_DIAGNOSTIC_COMMANDS) {
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.executable, "string");
    assert.ok(Array.isArray(item.args));
    assert.ok(!item.args.includes("sudo"));
    assert.ok(!item.args.some(arg => /^(add|delete|del|flush|replace|up|down|restart|install|remove)$/i.test(arg)));
  }
  assert.ok(LINUX_OPERATIONS_INVARIANTS.some(x => x.includes("No shell interpreter")));
});

test("collector refuses unsupported platforms without invoking runner", () => {
  let invoked = false;
  const report = collectLinuxDiagnostics({
    platform: "darwin",
    runner: () => { invoked = true; }
  });
  assert.equal(report.state, "UNSUPPORTED_PLATFORM");
  assert.equal(report.writesPerformed, false);
  assert.equal(invoked, false);
});

test("collector invokes only fixed commands with shell-free runner", () => {
  const called = [];
  const report = collectLinuxDiagnostics({
    platform: "linux",
    env: { PATH: "" },
    commandAvailable: () => true,
    runner: (executable, args) => {
      called.push({ executable, args });
      return { status: 0, stdout: "{}", stderr: "", error: null };
    },
    readFileSync: () => 'ID="debian"\nVERSION_ID="13"\nPRETTY_NAME="Debian GNU/Linux"',
    existsSync: path => path.endsWith("NetworkManager.conf"),
    readdirSync: () => ["10-goliath.conf", "README.txt"]
  });

  assert.equal(report.state, "COLLECTED_READ_ONLY");
  assert.equal(report.writesPerformed, false);
  assert.equal(report.privilegedOperationsPerformed, false);
  assert.equal(report.osRelease.ID, "debian");
  assert.equal(report.osRelease.VERSION_ID, "13");
  assert.ok(Array.isArray(report.developerTools));
  assert.deepEqual(report.networkManagerConfig.dropInFiles, ["10-goliath.conf"]);
  assert.equal(report.networkManagerConfig.contentsRead, false);
  assert.equal(report.commands.length, LINUX_DIAGNOSTIC_COMMANDS.length);
  assert.equal(called.length, LINUX_DIAGNOSTIC_COMMANDS.length);
  assert.ok(called.every(call => call.executable !== "sh" && call.executable !== "bash"));
});

test("missing tools are represented as unavailable, not as success", () => {
  const report = collectLinuxDiagnostics({
    platform: "linux",
    commandAvailable: () => false,
    readFileSync: () => { throw new Error("not available"); },
    existsSync: () => false,
    readdirSync: () => { throw new Error("not available"); }
  });
  assert.ok(report.commands.every(item => item.state === "UNAVAILABLE"));
  assert.equal(report.osRelease, null);
});

test("nonzero command exits remain visible diagnostics", () => {
  const report = collectLinuxDiagnostics({
    platform: "linux",
    commandAvailable: () => true,
    runner: () => ({ status: 3, stdout: "", stderr: "inactive", error: null }),
    readFileSync: () => "",
    existsSync: () => false,
    readdirSync: () => []
  });
  assert.ok(report.commands.every(item => item.state === "EXIT_NONZERO"));
});

test("network metadata is marked non-exportable without approval", () => {
  const report = collectLinuxDiagnostics({
    platform: "linux",
    commandAvailable: () => false,
    readFileSync: () => "",
    existsSync: () => false,
    readdirSync: () => []
  });
  assert.equal(report.privacy.classification, "NETWORK_METADATA");
  assert.equal(report.privacy.autoUploadAllowed, false);
  assert.equal(report.privacy.exportRequiresApproval, true);
});

test("operation risk classes separate reads from side effects", () => {
  assert.equal(classifyLinuxAction("ip.routes.read"), "READ_ONLY");
  assert.equal(classifyLinuxAction("ip.neighbours.read"), "SENSITIVE_READ");
  assert.equal(classifyLinuxAction("networkmanager.dropin.write"), "PRIVILEGED");
  assert.equal(classifyLinuxAction("ip.route.flush"), "IRREVERSIBLE");
  assert.equal(classifyLinuxAction("unknown.shell.operation"), "IRREVERSIBLE");
});


test("capability probe failures degrade to unavailable instead of aborting collection", () => {
  const report = collectLinuxDiagnostics({
    platform: "linux",
    commandAvailable: () => { throw new Error("PATH probe failed"); },
    readFileSync: () => { throw new Error("os-release unavailable"); },
    existsSync: () => { throw new Error("filesystem probe failed"); },
    readdirSync: () => { throw new Error("directory probe failed"); }
  });

  assert.equal(report.state, "COLLECTED_READ_ONLY");
  assert.ok(report.commands.every(item => item.state === "UNAVAILABLE"));
  assert.deepEqual(report.packageManagers, []);
  assert.deepEqual(report.editors, []);
  assert.deepEqual(report.developerTools, []);
  assert.equal(report.networkManagerConfig.mainConfigPresent, false);
  assert.equal(report.networkManagerConfig.dropInDirectoryPresent, false);
  assert.deepEqual(report.networkManagerConfig.dropInFiles, []);
});

test("one command runner exception is isolated to its diagnostic record", () => {
  let calls = 0;
  const report = collectLinuxDiagnostics({
    platform: "linux",
    commandAvailable: () => true,
    runner: () => {
      calls += 1;
      if (calls === 1) throw new Error("simulated spawn failure");
      return { status: 0, stdout: "ok", stderr: "", error: null };
    },
    readFileSync: () => "",
    existsSync: () => false,
    readdirSync: () => []
  });

  assert.equal(report.state, "COLLECTED_READ_ONLY");
  assert.equal(report.commands[0].state, "ERROR");
  assert.match(report.commands[0].stderr, /simulated spawn failure/);
  assert.ok(report.commands.slice(1).every(item => item.state === "OK"));
  assert.equal(report.commands.length, LINUX_DIAGNOSTIC_COMMANDS.length);
});
