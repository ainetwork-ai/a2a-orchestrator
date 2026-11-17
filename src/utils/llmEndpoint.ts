/**
 * Where chat completions go and which credential belongs to that address.
 *
 * LLM_API_URL (with LLM_API_KEY) names a model service explicitly. Without it, a deployment on ainize uses the
 * gateway the platform gives every project (AINIZE_URL) with the project's own key (AINIZE_API_KEY), so no
 * separately run model service has to stay up for reports and chat to work.
 */
export interface LlmEndpoint { apiUrl?: string; apiKey?: string }

export function llmEndpoint(env: NodeJS.ProcessEnv = process.env): LlmEndpoint {
  if (env.LLM_API_URL) return { apiUrl: env.LLM_API_URL, apiKey: env.LLM_API_KEY || undefined };
  if (env.AINIZE_URL) {
    return { apiUrl: `${env.AINIZE_URL.replace(/\/+$/, "")}/v1/chat/completions`, apiKey: env.AINIZE_API_KEY || undefined };
  }
  return {};
}
