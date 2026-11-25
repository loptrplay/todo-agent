import OpenAI from "openai";

export const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";

export function getModelClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
  return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
}

export function describeModelError(error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "DeepSeek 请求超时，请稍后重试。";
  if (error instanceof OpenAI.APIConnectionError) return "无法连接 DeepSeek，请检查网络后重试。";
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    if (status === 401 || status === 403)
      return "DeepSeek 认证失败，请检查本地 API Key 和访问权限。";
    if (status === 402) return "DeepSeek 余额不足，请检查账户余额。";
    if (status === 429) return "DeepSeek 请求过于频繁，请稍后再试。";
    if (status >= 500) return "DeepSeek 服务暂时异常，请稍后重试。";
    if (status === 400 || status === 422) return "DeepSeek 未接受当前请求，请检查模型配置。";
  }
  return "暂时无法完成 DeepSeek 请求，请稍后重试。";
}
