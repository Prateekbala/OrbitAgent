import type { AgentConfiguration } from '@ao/contracts/agents';
const procedures = {
  planning:
    'Planning procedure v1: Break work into concrete steps, state dependencies, and define evidence required for completion. Separate recommendations from completed actions.',
  research:
    'Research procedure v1: Distinguish supplied facts from inference. Cite only sources present in context. Explicitly identify missing evidence; do not fabricate external research.',
  verification:
    'Verification procedure v1: Compare the result against each acceptance criterion and output contract. Report reproducible evidence and unresolved failures. Do not self-approve delegated work.',
} as const;
export function effectiveInstructions(
  configuration: AgentConfiguration,
  delegation: { contract?: string | undefined; stop?: string | undefined } = {},
) {
  return [
    configuration.instructions,
    ...configuration.skills.map((skill) => procedures[skill]),
    delegation.contract ? `Required output contract: ${delegation.contract}` : '',
    delegation.stop ? `Stop and report uncertainty when: ${delegation.stop}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
