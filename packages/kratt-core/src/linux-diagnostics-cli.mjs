#!/usr/bin/env node
import { collectLinuxDiagnostics } from "./linux-operations.mjs";

const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === "--help")) {
  process.stderr.write("Usage: node packages/kratt-core/src/linux-diagnostics-cli.mjs [--help]\n");
  process.exitCode = 2;
} else if (args[0] === "--help") {
  process.stdout.write("Read-only Linux diagnostics. No sudo, writes, service changes or network probes. Output may contain private network metadata.\n");
} else {
  const report = collectLinuxDiagnostics();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.state === "UNSUPPORTED_PLATFORM") process.exitCode = 2;
}
