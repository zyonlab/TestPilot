/** 从 baseUrl 猜方言。只认得出 Groq；别的都当 vLLM 一族的 OpenAI 兼容。 */
export function flavorOf(baseUrl: string, explicit?: "openai" | "groq"): "openai" | "groq" {
  if (explicit) return explicit;
  try {
    return new URL(baseUrl).hostname.endsWith("groq.com") ? "groq" : "openai";
  } catch {
    return "openai";
  }
}

