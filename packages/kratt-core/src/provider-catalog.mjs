/**
 * Canonical provider catalogue for the 5x workbench.
 * A catalogue entry is a product classification, not proof of account linkage.
 */
export const PROVIDER_CATALOG = Object.freeze([
  {id:"github",role:"source-control",defaultScope:"READ_ONLY",capabilities:["repository.read","branch.read","pull-request.read","workflow.read"],writeApprovalRequired:true},
  {id:"slack",role:"team-communication",defaultScope:"READ_ONLY",capabilities:["search.read","channel.read","thread.read"],writeApprovalRequired:true},
  {id:"tinyfish",role:"research-and-browser",defaultScope:"RESEARCH_ONLY",capabilities:["web-search","web-fetch","deep-research"],writeApprovalRequired:true},
  {id:"lovable",role:"app-builder",defaultScope:"READ_ONLY",capabilities:["project.read","file.read","preview.read"],writeApprovalRequired:true},
  {id:"data",role:"analytics",defaultScope:"READ_ONLY",capabilities:["metric-analysis","data-quality","reporting"],writeApprovalRequired:true},
  {id:"scispace",role:"scholarly-research",defaultScope:"RESEARCH_ONLY",capabilities:["paper-search","paper-fetch","evidence-extraction"],writeApprovalRequired:true},
  {id:"base44",role:"integration-hub",defaultScope:"READ_ONLY",capabilities:["app-list","app-status","preview.read"],writeApprovalRequired:true},
  {id:"linear",role:"project-management",defaultScope:"READ_ONLY",capabilities:["project.read","issue.read","document.read"],writeApprovalRequired:true},
  {id:"canva",role:"visual-design",defaultScope:"READ_ONLY",capabilities:["design-search","template-search","design-read"],writeApprovalRequired:true},
  {id:"template-creator",role:"template-registry",defaultScope:"LOCAL_WRITE",capabilities:["template.validate","template.render","template.register"],writeApprovalRequired:true}
].map(Object.freeze));
export function getProviderDefinition(id) {
  return PROVIDER_CATALOG.find(provider=>provider.id===id) ?? null;
}
export function providerInventory(adapters=[]) {
  const byProvider=new Map(adapters.map(adapter=>[adapter.provider,adapter]));
  return Object.freeze(PROVIDER_CATALOG.map(provider=>{
    const adapter=byProvider.get(provider.id);
    return Object.freeze({
      ...provider,
      state:adapter?.state ?? "DISCOVERED",
      verifiedAt:adapter?.verifiedAt ?? null,
      adapterId:adapter?.adapterId ?? null,
      writeEnabled:adapter?.state === "WRITE_ENABLED"
    });
  }));
}
