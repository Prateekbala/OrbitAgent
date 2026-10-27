import { timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';
import type { AuthFn } from 'eve/channels/auth';
const verify: AuthFn<Request> = async (request) => {
  const secret = process.env.EVE_SERVICE_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!secret || !supplied || secret.length < 32) return null;
  const expected = Buffer.from(secret),
    actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return {
    attributes: {},
    authenticator: 'orbit-service',
    principalId: 'orbit-control-plane',
    principalType: 'service',
  };
};
export default eveChannel({ auth: verify });
