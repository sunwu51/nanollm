import { resolveModelForRequest, type ServerConfig, type ModelConfig } from "../core/config.js";

/** Job targets are the text models in config.yaml. Wildcard entries still resolve but are not listed. */
export class JobModelCatalog {
  constructor(private config: () => ServerConfig) {}
  resolve(name: string): ModelConfig | undefined {
    const model = resolveModelForRequest(this.config(), name)?.model;
    return model && model.provider !== "openai-image" ? { ...model, name } : undefined;
  }
  list() {
    const options = this.config().models.filter(m => m.provider !== "openai-image" && !m.name.includes("*"))
      .map(m => ({ name: m.name, label: m.name, group: m.custom_provider ?? m.provider }));
    return { modelOptions: options };
  }
}
