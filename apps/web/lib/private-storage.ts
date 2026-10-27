'use client';
interface StoredRecord {
  id: string;
  scope: string;
  conversation: string;
  kind: 'draft' | 'outbox' | 'bootstrap';
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
  updated: number;
}
let opening: Promise<IDBDatabase> | undefined;
let epoch = 0;
function database() {
  if (!opening)
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('orbit-private-messaging', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('keys');
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('scope', 'scope');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = undefined;
        reject(request.error);
      };
      request.onblocked = () =>
        reject(new Error('Close other Orbit tabs to enable local message storage.'));
    });
  return opening;
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function committed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Local storage was interrupted.'));
    tx.onerror = () => reject(tx.error);
  });
}
async function encryptionKey(scope: string, generation: number) {
  const db = await database(),
    existing = (await result(db.transaction('keys').objectStore('keys').get(scope))) as
      CryptoKey | undefined;
  if (existing) return existing;
  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  if (generation !== epoch) throw new Error('Your messaging authority changed.');
  const tx = db.transaction('keys', 'readwrite'),
    store = tx.objectStore('keys'),
    saved = (await result(store.get(scope))) as CryptoKey | undefined;
  if (!saved) store.put(generated, scope);
  await committed(tx);
  return saved ?? generated;
}
function privateStorageChanged() {
  window.dispatchEvent(new Event('orbit:private-messaging'));
}
const writes = new Map<string, Promise<void>>();
export function writePrivate<T>(
  scope: string,
  kind: StoredRecord['kind'],
  id: string,
  conversation: string,
  value: T,
) {
  const record = scope + ':' + kind + ':' + id,
    generation = epoch;
  const task = (writes.get(record) ?? Promise.resolve())
    .catch(() => {})
    .then(() => persist(scope, kind, id, conversation, value, generation));
  writes.set(record, task);
  void task
    .finally(() => {
      if (writes.get(record) === task) writes.delete(record);
    })
    .catch(() => {});
  return task;
}
async function persist<T>(
  scope: string,
  kind: StoredRecord['kind'],
  id: string,
  conversation: string,
  value: T,
  generation: number,
) {
  if (generation !== epoch) throw new Error('Your messaging authority changed.');
  const key = await encryptionKey(scope, generation),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    recordId = `${scope}:${kind}:${id}`;
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(recordId) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const db = await database();
  if (generation !== epoch) throw new Error('Your messaging authority changed.');
  const tx = db.transaction('records', 'readwrite');
  tx.objectStore('records').put({
    id: recordId,
    scope,
    kind,
    conversation,
    iv,
    ciphertext,
    updated: Date.now(),
  } satisfies StoredRecord);
  await committed(tx);
  privateStorageChanged();
}
export async function readPrivate<T>(
  scope: string,
  kind: StoredRecord['kind'],
  id?: string,
): Promise<{ id: string; value: T; updated: number }[]> {
  const db = await database(),
    key = (await result(db.transaction('keys').objectStore('keys').get(scope))) as
      CryptoKey | undefined;
  if (!key) return [];
  const records = (
    id
      ? [
          await result(
            db.transaction('records').objectStore('records').get(`${scope}:${kind}:${id}`),
          ),
        ]
      : await result(db.transaction('records').objectStore('records').index('scope').getAll(scope))
  ) as (StoredRecord | undefined)[];
  return Promise.all(
    records
      .filter((r): r is StoredRecord => !!r && r.kind === kind)
      .map(async (row) => ({
        id: row.id.slice(`${scope}:${kind}:`.length),
        updated: row.updated,
        value: JSON.parse(
          new TextDecoder().decode(
            await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: row.iv, additionalData: new TextEncoder().encode(row.id) },
              key,
              row.ciphertext,
            ),
          ),
        ) as T,
      })),
  );
}
export async function removePrivate(scope: string, kind: StoredRecord['kind'], id: string) {
  const db = await database(),
    tx = db.transaction('records', 'readwrite');
  tx.objectStore('records').delete(`${scope}:${kind}:${id}`);
  await committed(tx);
  privateStorageChanged();
}
export async function clearPrivateConversation(scope: string, conversation: string) {
  epoch++;
  const db = await database(),
    tx = db.transaction('records', 'readwrite'),
    store = tx.objectStore('records'),
    request = store.index('scope').openCursor(scope);
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      const record = cursor.value as StoredRecord;
      if (record.conversation === conversation || record.kind === 'bootstrap') cursor.delete();
      cursor.continue();
    }
  };
  await committed(tx);
  privateStorageChanged();
}
export async function clearPrivateStorage() {
  epoch++;
  if (typeof indexedDB === 'undefined') return;
  const db = await database(),
    tx = db.transaction(['keys', 'records'], 'readwrite');
  tx.objectStore('keys').clear();
  tx.objectStore('records').clear();
  await committed(tx);
  privateStorageChanged();
}
export async function cacheBootstrap(boot: import('@ao/contracts').Bootstrap) {
  const scope = `${boot.workspace.id}:${boot.me.id}`;
  await writePrivate(scope, 'bootstrap', 'current', '', {
    version: 1,
    boot,
    verifiedAt: Date.now(),
  });
  const db = await database(),
    tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').put(scope, 'active-scope');
  await committed(tx);
}
export async function cachedBootstrap() {
  const db = await database(),
    scope = (await result(db.transaction('keys').objectStore('keys').get('active-scope'))) as
      string | undefined;
  if (!scope) return null;
  const [cached] = await readPrivate<{
    version: number;
    boot: import('@ao/contracts').Bootstrap;
    verifiedAt: number;
  }>(scope, 'bootstrap', 'current');
  return cached?.value.version === 1 && Date.now() - cached.value.verifiedAt < 86400000
    ? cached.value.boot
    : null;
}
