import { CLAUDE_SUBSCRIPTION_BASE_URL, resolveModelForRequest, type ServerConfig, type ModelConfig, type CustomProviderConfig } from "../core/config.js";
import { jobError } from "./jobs.js";

export class JobModelCatalog {
  private cache = new Map<string, { expires: number; models: string[]; error?: string }>();
  private pending = new Map<string, Promise<void>>();
  constructor(private config: () => ServerConfig, private fetchModels: (provider: CustomProviderConfig) => Promise<string[]>) {}
  resolve(name: string): ModelConfig | undefined {
    const config = this.config();
    const exact = resolveModelForRequest(config, name)?.model;
    if (!name.startsWith("subscription:") && exact && exact.provider !== "openai-image") return { ...exact, name };
    if (!name.startsWith("subscription:")) return;
    const parts = name.split(":");
    if (parts.length !== 3) return;
    let providerName: string, model: string;
    try { providerName = decodeURIComponent(parts[1]); model = decodeURIComponent(parts[2]); } catch { return; }
    if (!model || model.includes("*")) return;
    const provider = config.providers.find(p => p.name === providerName);
    if (!provider || !["openai-subscription", "claude-subscription"].includes(provider.provider)) return;
    const claude = provider.provider === "claude-subscription";
    return { name, model, provider: claude ? "anthropic" : "openai-responses", api_key: "",
      base_url: claude ? CLAUDE_SUBSCRIPTION_BASE_URL : "https://chatgpt.com/backend-api/codex",
      custom_provider: provider.name, ...(claude ? { claude_subscription_provider: provider.name } : { subscription_provider: provider.name }),
      provider_proxy: provider.proxy, ttfb_timeout: config.ttfb_timeout };
  }
  async list(refresh = false) {
    if (refresh) this.cache.clear();
    const config = this.config();
    const options = config.models.filter(m => m.provider !== "openai-image" && !m.name.includes("*")).map(m => ({ name: m.name, label: m.name, group: m.custom_provider ?? m.provider }));
    const errors: string[] = [];
    await Promise.all(config.providers.filter(p => ["openai-subscription", "claude-subscription"].includes(p.provider)).map(async provider => {
      const key = JSON.stringify([provider.name, provider.provider, provider.proxy]);
      if (!this.cache.has(key) || this.cache.get(key)!.expires <= Date.now()) {
        if (!this.pending.has(key)) this.pending.set(key, this.fetchModels(provider).then(models => {
          this.cache.set(key, { models, expires: Date.now() + 300000 });
        }).catch(error => { this.cache.set(key, { models: this.cache.get(key)?.models ?? [], error: jobError(error).message, expires: Date.now() + 30000 }); }).finally(() => { this.pending.delete(key); }));
        await this.pending.get(key);
      }
      const cached = this.cache.get(key)!;
      if (cached.error) errors.push(provider.name + ": " + cached.error);
      for (const model of cached.models) {
        if (config.models.some(m => m.custom_provider === provider.name && m.model === model && !m.name.includes("*"))) continue;
        const name = "subscription:" + encodeURIComponent(provider.name) + ":" + encodeURIComponent(model);
        options.push({ name, label: provider.name + " / " + model, group: provider.name });
      }
    }));
    return { modelOptions: options, modelErrors: errors };
  }
}
