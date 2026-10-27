'use client';
import { Input } from './ui/input';
import type { Bootstrap } from '@ao/contracts';
export function ConversationGrants({
  boot,
  name = 'conversationIds',
}: {
  boot: Bootstrap;
  name?: string;
}) {
  return (
    <fieldset>
      <legend>Allowed conversations</legend>
      {boot.channels
        .filter((c) => !c.archived_at)
        .map((c) => (
          <label key={c.id}>
            <Input type="checkbox" name={name} value={c.id} />
            {c.name}
          </label>
        ))}
    </fieldset>
  );
}
