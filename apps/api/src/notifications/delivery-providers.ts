import webPush from 'web-push';
import { GoogleAuth } from 'google-auth-library';
import { connect } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import type { z } from 'zod';
import type { deviceRegistration } from '@ao/contracts/delivery';

type DeviceTarget = z.infer<typeof deviceRegistration>;
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
  receipt: { workspaceId: string; deliveryId: string; token: string };
}
export interface PushProvider {
  supports(platform: DeviceTarget['platform']): boolean;
  send(target: DeviceTarget, message: PushMessage): Promise<string>;
  readonly publicKey?: string;
}
export class PushError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly expired = false,
    readonly uncertain = false,
  ) {
    super(code);
  }
}
export function validatePushEndpoint(value: string) {
  const u = new URL(value);
  const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
  if (
    u.protocol !== 'https:' ||
    u.port ||
    u.username ||
    u.password ||
    u.hash ||
    !(allowed.includes(u.hostname) || u.hostname.endsWith('.notify.windows.com'))
  )
    throw new PushError('PUSH_ENDPOINT_NOT_ALLOWED');
}
class NotificationPushProvider implements PushProvider {
  readonly publicKey?: string;
  private readonly google?: GoogleAuth;
  constructor(
    private readonly options: {
      vapid?: { publicKey: string; privateKey: string; subject: string };
      fcm?: { projectId: string; credentials: { client_email: string; private_key: string } };
      apns?: {
        teamId: string;
        keyId: string;
        privateKey: string;
        topic: string;
        sandbox?: boolean;
      };
    },
  ) {
    if (options.vapid) this.publicKey = options.vapid.publicKey;
    if (options.fcm) {
      if (!/^[a-z][a-z0-9-]{4,62}$/.test(options.fcm.projectId))
        throw new Error('Invalid FCM project.');
      this.google = new GoogleAuth({
        credentials: options.fcm.credentials,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      });
    }
  }
  supports(platform: DeviceTarget['platform']) {
    return platform === 'android'
      ? Boolean(this.options.fcm)
      : platform === 'ios'
        ? Boolean(this.options.apns)
        : Boolean(this.options.vapid);
  }
  async send(target: DeviceTarget, message: PushMessage) {
    if (!this.supports(target.platform)) throw new PushError('PUSH_PROVIDER_UNAVAILABLE');
    if (target.subscription) {
      validatePushEndpoint(target.subscription.endpoint);
      try {
        await webPush.sendNotification(target.subscription, JSON.stringify(message), {
          TTL: 3600,
          urgency: 'normal',
          timeout: 10000,
          vapidDetails: this.options.vapid!,
        });
        return message.tag;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        throw new PushError(
          status === 404 || status === 410 ? 'PUSH_SUBSCRIPTION_EXPIRED' : 'PUSH_SEND_FAILED',
          status === 429 || Boolean(status && status >= 500),
          status === 404 || status === 410,
          !status,
        );
      }
    }
    if (target.platform === 'android') {
      const token = await this.google!.getAccessToken();
      let response: Response;
      try {
        response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${this.options.fcm!.projectId}/messages:send`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              message: {
                token: target.token,
                data: { payload: JSON.stringify(message) },
                android: { ttl: '3600s', collapse_key: message.tag },
              },
            }),
          },
        );
      } catch {
        throw new PushError('PUSH_OUTCOME_UNKNOWN', false, false, true);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PushError(
          'FCM_' + response.status,
          response.status === 429 || response.status >= 500,
          response.status === 404,
        );
      }
      const body = (await response.json()) as { name?: string };
      if (!body.name) throw new PushError('PUSH_OUTCOME_UNKNOWN', false, false, true);
      return body.name;
    }
    const apns = this.options.apns!;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: apns.keyId })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({ iss: apns.teamId, iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    const jwt =
      header +
      '.' +
      payload +
      '.' +
      sign('sha256', Buffer.from(header + '.' + payload), {
        key: createPrivateKey(apns.privateKey),
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url');
    if (!/^[0-9a-fA-F]{64,200}$/.test(target.token ?? ''))
      throw new PushError('APNS_TOKEN_INVALID', false, true);
    return new Promise<string>((resolve, reject) => {
      const client = connect(
        apns.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com',
      );
      client.on('error', () => {
        client.destroy();
        reject(new PushError('PUSH_OUTCOME_UNKNOWN', false, false, true));
      });
      client.setTimeout(10000, () => {
        client.destroy();
        reject(new PushError('PUSH_OUTCOME_UNKNOWN', false, false, true));
      });
      const request = client.request({
        ':method': 'POST',
        ':path': '/3/device/' + target.token,
        authorization: 'bearer ' + jwt,
        'apns-topic': apns.topic,
        'apns-push-type': 'alert',
        'apns-priority': '5',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'apns-collapse-id': message.tag,
      });
      request.on('response', (headers) => {
        const status = Number(headers[':status']);
        request.resume();
        if (status === 200) resolve(String(headers['apns-id'] ?? message.tag));
        else
          reject(new PushError('APNS_' + status, status === 429 || status >= 500, status === 410));
        client.close();
      });
      request.on('error', () => {
        client.destroy();
        reject(new PushError('PUSH_OUTCOME_UNKNOWN', false, false, true));
      });
      request.end(
        JSON.stringify({
          aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
          orbit: message,
        }),
      );
    });
  }
}
export function configuredPush(env: NodeJS.ProcessEnv): PushProvider {
  return new NotificationPushProvider({
    ...(env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY && env.WEB_PUSH_SUBJECT
      ? {
          vapid: {
            publicKey: env.WEB_PUSH_PUBLIC_KEY,
            privateKey: env.WEB_PUSH_PRIVATE_KEY,
            subject: env.WEB_PUSH_SUBJECT,
          },
        }
      : {}),
    ...(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY
      ? {
          fcm: {
            projectId: env.FCM_PROJECT_ID,
            credentials: {
              client_email: env.FCM_CLIENT_EMAIL,
              private_key: env.FCM_PRIVATE_KEY.replaceAll('\\n', '\n'),
            },
          },
        }
      : {}),
    ...(env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY && env.APNS_TOPIC
      ? {
          apns: {
            teamId: env.APNS_TEAM_ID,
            keyId: env.APNS_KEY_ID,
            privateKey: env.APNS_PRIVATE_KEY.replaceAll('\\n', '\n'),
            topic: env.APNS_TOPIC,
            sandbox: env.APNS_SANDBOX === 'true',
          },
        }
      : {}),
  });
}
