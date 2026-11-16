export const defaultAgentModel = 'groq/openai/gpt-oss-120b';
export const defaultAgentPricing = JSON.stringify({
  [defaultAgentModel]: { inputMicrosPerMillion: 150000, outputMicrosPerMillion: 600000 },
});
