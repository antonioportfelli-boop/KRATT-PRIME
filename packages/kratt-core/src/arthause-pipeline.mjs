/** ARTHAUSE typed pipeline facade. Produces validated manifests, never renders or executes untrusted code. */
import { TemplateRegistry } from "./template-registry.mjs";
const safeId = value => typeof value === "string" && /^[a-z][a-z0-9._:-]{1,95}$/.test(value);
export class ArthausePipeline {
  #registry;
  constructor({ registry = new TemplateRegistry() } = {}) { this.#registry = registry; }
  registerTemplate(definition) { return this.#registry.register(definition); }
  listTemplates() { return this.#registry.list(); }
  prepare({ jobId, templateId, values, sourceRefs = [] } = {}) {
    if (!safeId(jobId) || typeof templateId !== "string" ||
        !Array.isArray(sourceRefs) || sourceRefs.length > 64 ||
        !sourceRefs.every(ref => typeof ref === "string" && /^source:[A-Za-z0-9._:-]{1,120}$/.test(ref)))
      return Object.freeze({ok:false,reason:"ARTHAUSE_JOB_INVALID",generationStarted:false});
    const rendered = this.#registry.render(templateId, values);
    if (!rendered.ok) return Object.freeze({ok:false,reason:rendered.reason,generationStarted:false});
    return Object.freeze({ok:true,manifest:Object.freeze({
      schemaVersion:"arthause-job/v1",jobId,templateId,templateVersion:rendered.result.templateVersion,
      payload:rendered.result,sourceRefs:Object.freeze([...sourceRefs]),status:"PREPARED",
      requiresPolicyApproval:true,generationStarted:false,externalTransferStarted:false
    })});
  }
}
