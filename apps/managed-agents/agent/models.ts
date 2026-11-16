import { languageModel } from '@ao/models';
import { simulateStreamingMiddleware, wrapLanguageModel } from 'ai';
import { structuredReplyMiddleware } from './structured-reply.js';

export function selectedModel(id: string, maxProposals: number) {
  const model = languageModel(id);
  return id.startsWith('groq/') || id.startsWith('ollama/')
    ? wrapLanguageModel({
        model,
        middleware: [simulateStreamingMiddleware(), structuredReplyMiddleware(maxProposals)],
      })
    : model;
}
