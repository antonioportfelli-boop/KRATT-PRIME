/**
 * KRATT PRIME — read-only adaptive host profiler.
 * Uses an already-collected diagnostics report; it does not run commands or mutate the host.
 */
const rows = value => Array.isArray(value) ? value : [];
const find = (report,id) => rows(report?.commands).find(x=>x.id===id) ?? null;
const output = (report,id) => {
  const item=find(report,id);
  return item?.state==="OK" && typeof item.stdout==="string" ? item.stdout.trim() : null;
};
const parseArray = text => {
  if(!text) return [];
  try { const parsed=JSON.parse(text); return Array.isArray(parsed)?parsed:[]; }
  catch { return []; }
};
const DISTRO_MANAGER = Object.freeze({
  debian:"apt-get",ubuntu:"apt-get",linuxmint:"apt-get",pop:"apt-get",
  fedora:"dnf",rhel:"dnf",centos:"dnf",rocky:"dnf",almalinux:"dnf",
  arch:"pacman",manjaro:"pacman",endeavouros:"pacman",
  opensuse:"zypper",opensuse_tumbleweed:"zypper",alpine:"apk",
  nixos:"nix",gentoo:"emerge",freebsd:"pkg"
});
function parseCpu(text) {
  if(!text) return {};
  try {
    const root=JSON.parse(text);
    const map=Object.create(null);
    for(const row of root.lscpu ?? []) {
      if(typeof row.field==="string" && typeof row.data==="string")
        map[row.field.replace(/:$/,"").toLowerCase()]=row.data;
    }
    return {
      architecture:map.architecture ?? null,
      model:map["model name"] ?? null,
      vendor:map["vendor id"] ?? null,
      onlineCount:Number(map["cpu(s)"]) || null,
      coresPerSocket:Number(map["core(s) per socket"]) || null
    };
  } catch { return {}; }
}
function parseMemory(text) {
  const line=String(text ?? "").split(/\r?\n/).find(row=>/^Mem:\s*/.test(row));
  if(!line) return null;
  const values=line.trim().split(/\s+/).slice(1).map(Number);
  return values.length>=6 && Number.isFinite(values[0]) && Number.isFinite(values[5])
    ? Object.freeze({totalBytes:values[0],availableBytes:values[5]}) : null;
}
function serviceState(report,id) {
  const item=find(report,id);
  if(!item) return "NOT_COLLECTED";
  if(item.state==="UNAVAILABLE") return "UNAVAILABLE";
  if(item.state==="OK") return "ACTIVE";
  if(item.state==="EXIT_NONZERO") {
    const value=String(item.stdout ?? "").trim().toUpperCase();
    if(["INACTIVE","FAILED","UNKNOWN"].includes(value)) return value;
  }
  return "UNKNOWN";
}
export function buildAdaptiveHostProfile(report) {
  if(!report || report.schemaVersion!=="0.1.0" ||
     report.state!=="COLLECTED_READ_ONLY" || report.platform!=="linux" ||
     !Array.isArray(report.commands))
    return {ok:false,reason:"LINUX_DIAGNOSTICS_REPORT_INVALID"};
  const os=report.osRelease && typeof report.osRelease==="object" ? report.osRelease : {};
  const osId=typeof os.ID==="string" ? os.ID.toLowerCase() : "unknown";
  const managers=rows(report.packageManagers).filter(x=>typeof x==="string");
  const expected=DISTRO_MANAGER[osId] ?? null;
  const preferred=expected && managers.includes(expected) ? expected :
    (!expected && managers.length===1 ? managers[0] : null);
  const cpu=parseCpu(output(report,"system.cpu.details"));
  const cpuCount=Number(output(report,"system.cpu_count")) || cpu.onlineCount || null;
  const kernel=output(report,"system.kernel");
  const ipv4=parseArray(output(report,"ip.routes.v4"));
  const ipv6=parseArray(output(report,"ip.routes.v6"));
  const addressRows=parseArray(output(report,"ip.addresses"));
  const interfaces=addressRows.slice(0,128).map(row=>Object.freeze({
    name:typeof row.ifname==="string"?row.ifname:"unknown",
    state:typeof row.operstate==="string"?row.operstate:"UNKNOWN",
    addressCount:Array.isArray(row.addr_info)?row.addr_info.length:0
  }));
  const networkManagers={
    networkManager:serviceState(report,"service.networkmanager"),
    systemdNetworkd:serviceState(report,"service.systemd_networkd"),
    connman:serviceState(report,"service.connman"),
    netctl:output(report,"netctl.version")?"INSTALLED_STATE_UNKNOWN":"NOT_DETECTED"
  };
  const active=Object.entries(networkManagers)
    .filter(([id,state])=>id!=="netctl" && state==="ACTIVE").map(([id])=>id);
  const review=[];
  if(active.length>1) review.push("MULTIPLE_NETWORK_MANAGERS_ACTIVE");
  if(!preferred) review.push("PACKAGE_MANAGER_SELECTION_UNRESOLVED");
  if(!kernel) review.push("KERNEL_IDENTITY_UNAVAILABLE");
  if(!interfaces.length) review.push("NETWORK_INTERFACE_SNAPSHOT_UNAVAILABLE");
  if(!ipv6.length) review.push("IPV6_ROUTE_TABLE_EMPTY_OR_UNOBSERVED");
  const profile={
    schemaVersion:"kratt-host-profile/v1",
    observedAt:typeof report.collectedAt==="string"?report.collectedAt:new Date().toISOString(),
    platform:"linux",
    distribution:{id:osId,version:os.VERSION_ID ?? null,name:os.PRETTY_NAME ?? null},
    kernel,architecture:cpu.architecture ?? "unknown",
    cpu:{onlineCount:cpuCount,model:cpu.model ?? null,vendor:cpu.vendor ?? null,coresPerSocket:cpu.coresPerSocket ?? null},
    memory:parseMemory(output(report,"system.memory")),
    packageManager:{detected:managers,preferred,selectionState:preferred?"MATCHED_TO_OS":"NEEDS_REVIEW"},
    editors:rows(report.editors),developerTools:rows(report.developerTools),
    network:{
      managers:networkManagers,activeManagers:active,
      managementState:active.length>1?"MULTIPLE_MANAGERS_REVIEW":active.length===1?"SINGLE_MANAGER_OBSERVED":"NO_ACTIVE_MANAGER_OBSERVED",
      interfaces,interfaceCount:interfaces.length,ipv4RouteCount:ipv4.length,ipv6RouteCount:ipv6.length,
      ipv4RouteLookup:find(report,"ip.route_get.v4")?.state ?? "NOT_COLLECTED",
      ipv6RouteLookup:find(report,"ip.route_get.v6")?.state ?? "NOT_COLLECTED",
      networkManagerConfig:report.networkManagerConfig ?? null
    },
    privacy:{classification:"NETWORK_METADATA",storage:"LOCAL_ONLY",exportRequiresApproval:true},
    evidence:{
      diagnosticsState:report.state,commandCount:report.commands.length,
      successfulCommands:report.commands.filter(x=>x.state==="OK").length,
      unavailableCommands:report.commands.filter(x=>x.state==="UNAVAILABLE").length
    }
  };
  return Object.freeze({
    ok:true,profile:Object.freeze(profile),
    readiness:review.length?"PARTIAL_REVIEW_REQUIRED":"OBSERVED_BASELINE_READY",
    reviewReasons:Object.freeze(review),
    automaticChangesEnabled:false
  });
}
export function createAdaptiveBootstrapPlan(profileResult) {
  if(!profileResult?.ok || !profileResult.profile) return {ok:false,reason:"HOST_PROFILE_REQUIRED"};
  const p=profileResult.profile;
  const checks=[
    {id:"host.identity",state:p.kernel?"OBSERVED":"MISSING"},
    {id:"package-manager.selection",state:p.packageManager.preferred?"OBSERVED":"REVIEW_REQUIRED"},
    {id:"network.manager.ownership",state:p.network.managementState==="SINGLE_MANAGER_OBSERVED"?"OBSERVED":"REVIEW_REQUIRED"},
    {id:"network.ipv4.routes",state:p.network.ipv4RouteCount>0?"OBSERVED":"MISSING"},
    {id:"network.ipv6.routes",state:p.network.ipv6RouteCount>0?"OBSERVED":"REVIEW_REQUIRED"},
    {id:"ebpf.toolchain",state:"NOT_TESTED"},
    {id:"runtime.backend.compatibility",state:"NOT_TESTED"}
  ];
  return Object.freeze({
    ok:true,schemaVersion:"kratt-bootstrap-plan/v1",
    state:profileResult.readiness==="PARTIAL_REVIEW_REQUIRED"?"REVIEW_REQUIRED":"PROPOSED",
    checks:Object.freeze(checks.map(Object.freeze)),
    actions:Object.freeze(["capture-host-baseline","confirm-network-manager-ownership",
      "verify-ipv4-ipv6-routing","inspect-ebpf-toolchain","benchmark-local-runtime-backends"]),
    policy:Object.freeze({default:"DENY",writeOperationsEnabled:false,approvalRequiredForChanges:true}),
    executionStarted:false,profileDigest:null
  });
}
