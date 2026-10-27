import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { AppError } from './errors.js';
const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  excluded.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  excluded.addSubnet(address, prefix, 'ipv6');
function publicAddress(address: string) {
  return isIP(address) === 4
    ? !excluded.check(address, 'ipv4')
    : isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !excluded.check(address, 'ipv6');
}
export async function validatePublicEndpoint(value: string, hosts: string[], kind = 'ENDPOINT') {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, kind + '_INVALID', 'Use a valid HTTPS endpoint.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !hosts.includes(url.hostname.toLowerCase())
  )
    throw new AppError(
      400,
      kind + '_HOST_DENIED',
      'Use an HTTPS endpoint on an operator-approved host.',
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }).catch(() => {
      throw new AppError(400, kind + '_DNS_FAILED', 'The endpoint hostname could not be resolved.');
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AppError(
              400,
              kind + '_DNS_TIMEOUT',
              'The hostname could not be resolved within five seconds.',
            ),
          ),
        5000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
    throw new AppError(
      400,
      kind + '_ADDRESS_DENIED',
      'Endpoints must resolve only to public addresses.',
    );
  return { url, address: addresses[0]! };
}
