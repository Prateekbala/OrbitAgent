import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { realtimeBatch } from '@ao/contracts';
import { EventCursors } from '../src/messaging/cursors.js';
import type { Identity } from '../src/lib/policy.js';
const key = Buffer.alloc(32, 9).toString('base64');
const p: Identity = {
  workspaceId: randomUUID(),
  membershipId: randomUUID(),
  name: 'Viewer',
  kind: 'human',
  role: 'member',
};
describe('opaque realtime cursors', () => {
  it('preserves large positions across replicas without revealing a count or stable ciphertext', () => {
    const codec = new EventCursors(key),
      otherReplica = new EventCursors(key),
      position = '9223372036854775807';
    const first = codec.encode(position, p),
      second = codec.encode(position, p);
    expect(first).not.toBe(second);
    expect(first).not.toContain(position);
    expect(first).toHaveLength(51);
    expect(otherReplica.decode(first, p)).toBe(position);
    expect(codec.decode('0', p)).toBe('0');
  });
  it('rejects tampering, wrong audiences, wrong keys and plaintext positions', () => {
    const codec = new EventCursors(key),
      token = codec.encode('42', p);
    const tampered = token.slice(0, 15) + (token[15] === 'A' ? 'B' : 'A') + token.slice(16);
    expect(() => codec.decode(tampered, p)).toThrow('invalid');
    expect(() => codec.decode(token, { ...p, membershipId: randomUUID() })).toThrow('invalid');
    expect(() => codec.decode(token, { ...p, workspaceId: randomUUID() })).toThrow('invalid');
    expect(() => new EventCursors(Buffer.alloc(32, 8).toString('base64')).decode(token, p)).toThrow(
      'invalid',
    );
    for (const value of ['42', '1e9', '-1', token + 'A'])
      expect(() => codec.decode(value, p)).toThrow();
    expect(() => new EventCursors('weak')).toThrow('32-byte');
  });
  it('uses stable opaque event IDs and validates the browser envelope', () => {
    const codec = new EventCursors(key),
      raw = {
        cursor: '43',
        hasMore: false,
        events: [
          {
            id: '43',
            event_type: 'message.created',
            resource_id: randomUUID(),
            conversation_id: randomUUID(),
          },
        ],
      };
    const first = codec.batch(raw, p),
      second = new EventCursors(key).batch(raw, p);
    expect(first.events[0]?.id).toBe(second.events[0]?.id);
    expect(first.events[0]?.id).toHaveLength(43);
    expect(codec.batch(raw, { ...p, membershipId: randomUUID() }).events[0]?.id).not.toBe(
      first.events[0]?.id,
    );
    expect(realtimeBatch.parse(first)).toEqual(first);
  });
});
