'use client';
import { useEffect, useState } from 'react';
import { BellRing, Mail, Monitor, Trash2 } from 'lucide-react';
import type { DeliveryPreferences } from '@ao/contracts/delivery';
import { api, post } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';

interface Device {
  id: string;
  name: string;
  platform: string;
  revoked_at: string | null;
  last_seen_at: string;
}
interface Delivery {
  id: string;
  channel: string;
  state: string;
  error_code: string | null;
  created_at: string;
  received_at: string | null;
}
export function NotificationDeliverySettings() {
  const [preferences, setPreferences] = useState<DeliveryPreferences | null>(null),
    [publicKey, setPublicKey] = useState<string | null>(null),
    [devices, setDevices] = useState<Device[]>([]),
    [history, setHistory] = useState<Delivery[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<{ preferences: DeliveryPreferences; publicKey: string | null }>(
        '/notification-delivery/preferences',
        { signal: controller.signal },
      ),
      api<Device[]>('/notification-delivery/devices', { signal: controller.signal }),
      api<Delivery[]>('/notification-delivery/history', { signal: controller.signal }),
    ])
      .then(([settings, registered, deliveries]) => {
        setPreferences(settings.preferences);
        setPublicKey(settings.publicKey);
        setDevices(registered);
        setHistory(deliveries);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load delivery settings.');
      });
    return () => controller.abort();
  }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update notification delivery.');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    await api('/notification-delivery/preferences', {
      method: 'PUT',
      body: JSON.stringify(preferences),
    });
    setSaved(true);
  };
  const enable = async () => {
    if (
      !publicKey ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    )
      throw new Error('Push is unavailable in this browser or has not been configured.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted')
      throw new Error('Allow notifications in your browser settings to enable push.');
    await navigator.serviceWorker.register('/orbit-sw.js');
    const registration = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(
      atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')),
      (character) => character.charCodeAt(0),
    );
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      }));
    const value = subscription.toJSON();
    const storageKey = 'orbit-push-client';
    let clientId = localStorage.getItem(storageKey);
    if (!clientId) {
      clientId = crypto.randomUUID();
      localStorage.setItem(storageKey, clientId);
    }
    await post('/notification-delivery/devices', {
      clientId,
      name: 'This browser',
      platform: 'browser',
      subscription: { endpoint: value.endpoint, keys: value.keys },
    });
    const next = { ...preferences!, push: true };
    await api('/notification-delivery/preferences', { method: 'PUT', body: JSON.stringify(next) });
    setPreferences(next);
    setDevices(await api<Device[]>('/notification-delivery/devices'));
    setSaved(true);
  };
  return (
    <section className="delivery-settings">
      <header>
        <BellRing size={20} />
        <div>
          <h3>Delivery & quiet hours</h3>
          <p className="muted">
            Control where notifications reach you. Push and email show a private-content-free prompt
            to open Orbit.
          </p>
        </div>
      </header>
      {preferences && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(save);
          }}
        >
          <label className="delivery-checkbox">
            <Input
              type="checkbox"
              checked={preferences.push}
              onChange={(event) => setPreferences({ ...preferences, push: event.target.checked })}
            />
            Push notifications
          </label>
          <Button
            variant="outline"
            type="button"
            disabled={busy || !publicKey}
            onClick={() => void run(enable)}
          >
            <Monitor size={16} />
            Enable on this browser
          </Button>
          {!publicKey && (
            <p className="muted">
              Web Push keys are not configured. In-app notifications remain available.
            </p>
          )}
          <label>
            <Mail size={16} />
            Email notifications
            <NativeSelect
              value={preferences.email}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  email: event.target.value as DeliveryPreferences['email'],
                })
              }
            >
              <option value="off">Off</option>
              <option value="immediate">Immediate</option>
              <option value="hourly">Hourly digest</option>
              <option value="daily">Daily digest at 9:00 AM</option>
            </NativeSelect>
          </label>
          <label>
            Timezone
            <Input
              value={preferences.timezone}
              onChange={(event) => setPreferences({ ...preferences, timezone: event.target.value })}
              placeholder="Asia/Kolkata"
            />
          </label>
          <label className="delivery-checkbox">
            <Input
              type="checkbox"
              checked={preferences.quietStart !== null}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  quietStart: event.target.checked ? 22 * 60 : null,
                  quietEnd: event.target.checked ? 8 * 60 : null,
                })
              }
            />
            Quiet hours
          </label>
          {preferences.quietStart !== null && (
            <div className="delivery-grid">
              {(['quietStart', 'quietEnd'] as const).map((field) => (
                <label key={field}>
                  {field === 'quietStart' ? 'From' : 'Until'}
                  <Input
                    type="time"
                    value={
                      String(Math.floor((preferences[field] ?? 0) / 60)).padStart(2, '0') +
                      ':' +
                      String((preferences[field] ?? 0) % 60).padStart(2, '0')
                    }
                    onChange={(event) => {
                      if (!event.target.value) return;
                      const [hour, minute] = event.target.value.split(':').map(Number);
                      setPreferences({ ...preferences, [field]: hour! * 60 + minute! });
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          <div className="delivery-grid">
            <label>
              Batch window (minutes)
              <Input
                type="number"
                min={0}
                max={60}
                value={preferences.batchMinutes}
                onChange={(event) =>
                  setPreferences({ ...preferences, batchMinutes: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Device routing
              <NativeSelect
                value={preferences.deviceRouting}
                onChange={(event) =>
                  setPreferences({
                    ...preferences,
                    deviceRouting: event.target.value as DeliveryPreferences['deviceRouting'],
                  })
                }
              >
                <option value="most_recent">Most recently registered device</option>
                <option value="all">All devices</option>
              </NativeSelect>
            </label>
          </div>
          <label>
            Priority
            <NativeSelect
              value={preferences.minimumPriority}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  minimumPriority: event.target.value as DeliveryPreferences['minimumPriority'],
                })
              }
            >
              <option value="normal">All eligible notifications</option>
              <option value="high">High priority only</option>
            </NativeSelect>
          </label>
          <label>
            Escalate high-priority push to email
            <NativeSelect
              value={preferences.escalationMinutes ?? ''}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  escalationMinutes: event.target.value ? Number(event.target.value) : null,
                })
              }
            >
              <option value="">Off</option>
              <option value="15">After 15 minutes unread</option>
              <option value="60">After one hour unread</option>
            </NativeSelect>
          </label>
          <p className="muted">
            Escalation respects quiet hours, muted sources, and your email preference.
          </p>
          <Button disabled={busy}>{busy ? 'Saving…' : 'Save delivery settings'}</Button>
          {saved && <p role="status">Delivery settings saved.</p>}
        </form>
      )}
      <h3>Registered devices</h3>
      <div className="delivery-devices">
        {devices.filter((device) => !device.revoked_at).length === 0 && (
          <p className="muted">No active devices registered.</p>
        )}
        {devices
          .filter((device) => !device.revoked_at)
          .map((device) => (
            <div key={device.id}>
              <span>
                <strong>{device.name}</strong>
                <small>
                  {device.platform} · {new Date(device.last_seen_at).toLocaleDateString()}
                </small>
              </span>
              <Button
                variant="ghost"
                aria-label={`Revoke ${device.name}`}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/notification-delivery/devices/${device.id}`, { method: 'DELETE' });
                    setDevices((rows) =>
                      rows.map((row) =>
                        row.id === device.id
                          ? { ...row, revoked_at: new Date().toISOString() }
                          : row,
                      ),
                    );
                  })
                }
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
      </div>
      <h3>Recent delivery history</h3>
      <div className="delivery-history">
        {!history.length && (
          <p className="muted">Delivery attempts and device receipts will appear here.</p>
        )}
        {history.slice(0, 20).map((delivery) => (
          <div key={delivery.id}>
            <span>
              {delivery.channel} · {new Date(delivery.created_at).toLocaleString()}
            </span>
            <strong>{delivery.state.replaceAll('_', ' ')}</strong>
            {delivery.error_code && <small>{delivery.error_code}</small>}
          </div>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
