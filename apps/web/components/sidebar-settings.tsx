'use client';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { useEffect, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import type { SidebarPreferences } from '@ao/contracts/personal';
import { api } from '../lib/api';
export function SidebarSettings({
  boot,
  onChanged,
}: {
  boot: Bootstrap;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState<SidebarPreferences | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<SidebarPreferences>('/sidebar', { signal: controller.signal })
      .then(setValue)
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load sidebar.');
      });
    return () => controller.abort();
  }, [boot.workspace.id, boot.me.id]);
  if (!value) return <p>{error || 'Loading sidebar preferences…'}</p>;
  function move(section: string, index: number, direction: number) {
    setValue((v) => {
      if (!v) return v;
      return {
        ...v,
        sections: v.sections.map((s) => {
          if (s.id !== section) return s;
          const ids = [...s.conversationIds],
            to = index + direction;
          if (to < 0 || to >= ids.length) return s;
          [ids[index], ids[to]] = [ids[to]!, ids[index]!];
          return { ...s, conversationIds: ids };
        }),
      };
    });
  }
  return (
    <Card asChild>
      <section className="settings-card sidebar-customization" aria-label="Sidebar customization">
        <h2>Your sidebar</h2>
        <p>Organize conversations into sections and choose what appears in your sidebar.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void api<{ version: number }>('/sidebar', {
              method: 'PUT',
              body: JSON.stringify(value),
            })
              .then(async (result) => {
                setValue((v) => (v ? { ...v, version: result.version } : v));
                await onChanged();
              })
              .catch((e) => setError(e instanceof Error ? e.message : 'Unable to save sidebar.'))
              .finally(() => setBusy(false));
          }}
        >
          {value.sections.map((section, index) => (
            <Card key={section.id} asChild>
              <article className="personal-message-card">
                <label>
                  Section name
                  <Input
                    maxLength={40}
                    required
                    value={section.name}
                    onChange={(event) =>
                      setValue((v) =>
                        v
                          ? {
                              ...v,
                              sections: v.sections.map((s) =>
                                s.id === section.id ? { ...s, name: event.target.value } : s,
                              ),
                            }
                          : v,
                      )
                    }
                  />
                </label>
                <Button
                  variant="outline"
                  type="button"
                  disabled={index === 0}
                  onClick={() =>
                    setValue((v) => {
                      if (!v) return v;
                      const sections = [...v.sections];
                      [sections[index - 1], sections[index]] = [
                        sections[index]!,
                        sections[index - 1]!,
                      ];
                      return { ...v, sections };
                    })
                  }
                >
                  Move section up
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() =>
                    setValue((v) =>
                      v ? { ...v, sections: v.sections.filter((s) => s.id !== section.id) } : v,
                    )
                  }
                >
                  Remove section
                </Button>
                {section.conversationIds.map((id, i) => (
                  <div className="sidebar-setting-row" key={id}>
                    <span>
                      {boot.channels.find((c) => c.id === id)?.name ?? 'Unavailable conversation'}
                    </span>
                    <Button
                      variant="outline"
                      type="button"
                      disabled={i === 0}
                      onClick={() => move(section.id, i, -1)}
                    >
                      Move conversation up
                    </Button>
                    <Button
                      variant="outline"
                      type="button"
                      disabled={i === section.conversationIds.length - 1}
                      onClick={() => move(section.id, i, 1)}
                    >
                      Move conversation down
                    </Button>
                  </div>
                ))}
              </article>
            </Card>
          ))}
          <Button
            variant="outline"
            type="button"
            disabled={value.sections.length >= 30}
            onClick={() =>
              setValue((v) =>
                v
                  ? {
                      ...v,
                      sections: [
                        ...v.sections,
                        { id: crypto.randomUUID(), name: 'New section', conversationIds: [] },
                      ],
                    }
                  : v,
              )
            }
          >
            Add sidebar section
          </Button>
          <details>
            <summary>Assign and hide conversations</summary>
            {boot.channels.map((channel) => (
              <div className="sidebar-setting-row" key={channel.id}>
                <span>{channel.name}</span>
                <label>
                  Section for {channel.name}
                  <NativeSelect
                    aria-label={`Section for ${channel.name}`}
                    value={
                      value.sections.find((s) => s.conversationIds.includes(channel.id))?.id ?? ''
                    }
                    onChange={(event) =>
                      setValue((v) =>
                        v
                          ? {
                              ...v,
                              sections: v.sections.map((s) => ({
                                ...s,
                                conversationIds: [
                                  ...s.conversationIds.filter((id) => id !== channel.id),
                                  ...(s.id === event.target.value ? [channel.id] : []),
                                ],
                              })),
                            }
                          : v,
                      )
                    }
                  >
                    <option value="">Default section</option>
                    {value.sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  <Input
                    type="checkbox"
                    checked={value.hiddenIds.includes(channel.id)}
                    onChange={(event) =>
                      setValue((v) =>
                        v
                          ? {
                              ...v,
                              hiddenIds: event.target.checked
                                ? [...v.hiddenIds, channel.id]
                                : v.hiddenIds.filter((id) => id !== channel.id),
                            }
                          : v,
                      )
                    }
                  />
                  Hide {channel.name}
                </label>
              </div>
            ))}
          </details>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <Button className="primary" disabled={busy}>
            Save sidebar preferences
          </Button>
        </form>
      </section>
    </Card>
  );
}
