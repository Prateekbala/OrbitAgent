import { OAuth2Client, type Credentials } from 'google-auth-library';
import { AppError } from '../lib/errors.js';
export interface CalendarEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  start?: { date?: string };
  end?: { date?: string };
  extendedProperties?: { private?: Record<string, string> };
}
interface CalendarPage {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}
export interface CalendarProvider {
  authorization(state: string, challenge: string): string;
  exchange(code: string, verifier: string): Promise<Credentials>;
  changes(
    credentials: Credentials,
    sync: string | null,
    page: string | null,
  ): Promise<{ data: CalendarPage; credentials: Credentials }>;
  write(
    credentials: Credentials,
    event: CalendarEvent,
    etag: string | null,
    remove: boolean,
  ): Promise<{ data: CalendarEvent; credentials: Credentials }>;
}
export class CalendarProviderError extends Error {
  constructor(readonly status: number) {
    super('Calendar provider request failed.');
  }
}
export class GoogleCalendarProvider implements CalendarProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirect: string,
  ) {}
  private client(credentials?: Credentials) {
    const client = new OAuth2Client(this.clientId, this.clientSecret, this.redirect);
    if (credentials) client.setCredentials(credentials);
    return client;
  }
  authorization(state: string, challenge: string) {
    return this.client().generateAuthUrl({
      scope: ['https://www.googleapis.com/auth/calendar.events.owned'],
      access_type: 'offline',
      prompt: 'consent select_account',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256' as import('google-auth-library').CodeChallengeMethod,
    });
  }
  async exchange(code: string, verifier: string) {
    const { tokens } = await this.client()
      .getToken({ code, codeVerifier: verifier })
      .catch(() => {
        throw new AppError(
          502,
          'CALENDAR_AUTHORIZATION_FAILED',
          'Google could not complete calendar authorization. Start a new connection request.',
        );
      });
    if (!tokens.refresh_token)
      throw new AppError(
        400,
        'CALENDAR_CONSENT_REQUIRED',
        'Grant offline calendar access to enable synchronization.',
      );
    return tokens;
  }
  private async request<T>(
    credentials: Credentials,
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    etag?: string | null,
  ) {
    const client = this.client(credentials);
    try {
      const response = await client.request<T>({
        url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events' + path,
        method,
        ...(body ? { data: body } : {}),
        ...(etag ? { headers: { 'If-Match': etag } } : {}),
        timeout: 10000,
        retry: false,
      });
      return { data: response.data, credentials: client.credentials };
    } catch (error) {
      const response = (
        error as {
          response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } };
        }
      ).response;
      const reason = response?.data?.error?.errors?.[0]?.reason;
      const status = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(
        reason ?? '',
      )
        ? 429
        : Number(response?.status ?? 0);
      throw new CalendarProviderError(status);
    }
  }
  changes(credentials: Credentials, sync: string | null, page: string | null) {
    const q = new URLSearchParams({
      maxResults: '100',
      showDeleted: 'true',
      fields:
        'items(id,etag,status,summary,start/date,extendedProperties/private),nextPageToken,nextSyncToken',
    });
    if (sync) q.set('syncToken', sync);
    if (page) q.set('pageToken', page);
    return this.request<CalendarPage>(credentials, '?' + q, 'GET');
  }
  async write(
    credentials: Credentials,
    event: CalendarEvent,
    etag: string | null,
    remove: boolean,
  ) {
    const path = '/' + encodeURIComponent(event.id);
    if (remove) {
      try {
        const response = await this.request(credentials, path, 'DELETE', undefined, etag);
        return { data: { id: event.id, status: 'cancelled' }, credentials: response.credentials };
      } catch (error) {
        if (error instanceof CalendarProviderError && [404, 410].includes(error.status))
          return { data: { id: event.id, status: 'cancelled' }, credentials };
        throw error;
      }
    }
    if (etag) return this.request<CalendarEvent>(credentials, path, 'PATCH', event, etag);
    try {
      return await this.request<CalendarEvent>(credentials, '', 'POST', event);
    } catch (error) {
      if (!(error instanceof CalendarProviderError) || error.status !== 409) throw error;
      const found = await this.request<CalendarEvent>(credentials, path, 'GET');
      if (
        found.data.summary !== event.summary ||
        found.data.start?.date !== event.start?.date ||
        found.data.extendedProperties?.private?.orbitTask !==
          event.extendedProperties?.private?.orbitTask ||
        found.data.extendedProperties?.private?.orbitWorkspace !==
          event.extendedProperties?.private?.orbitWorkspace
      )
        throw new CalendarProviderError(412);
      return found;
    }
  }
}
