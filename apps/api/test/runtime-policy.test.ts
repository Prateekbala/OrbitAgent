import { it, expect } from 'vitest';
import { EveRuntime, parseModelPricing } from '../src/execution/runtime.js';
import { qualifyConfiguration } from '../src/execution/controls.js';
import { agentConfiguration } from '@ao/contracts/agents';
it('requires conservative model pricing and rejects reservations smaller than the bounded call cost', () => {
  const runtime = new EveRuntime('https://runtime.example.test', 'x'.repeat(32), {
    defaultModel: 'fixture/model',
    models: ['fixture/model'],
    pricing: parseModelPricing(
      '{"fixture/model":{"inputMicrosPerMillion":10000000,"outputMicrosPerMillion":100000000}}',
    ),
  });
  const configuration = agentConfiguration.parse({ instructions: 'Verify evidence.' });
  expect(runtime.requiredReservation(configuration)).toBe(1400000);
  expect(() => qualifyConfiguration(runtime, configuration)).toThrow('reservation');
  configuration.limits.reservationMicros = 1400000;
  expect(() => qualifyConfiguration(runtime, configuration)).not.toThrow();
  expect(() => parseModelPricing('{"key":"bad"}')).toThrow('AGENT_MODEL_PRICING_JSON');
});
