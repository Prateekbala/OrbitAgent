import { Bot } from 'lucide-react';
import { Card } from './ui/card';
export function Avatar({ name, agent = false }: { name: string; agent?: boolean }) {
  const words = name.trim().split(/\s+/);
  const initials =
    (words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => Array.from(word)[0] ?? '')
          .join('')
      : Array.from(name.trim()).slice(0, 2).join('')
    ).toLocaleUpperCase() || '?';
  const tone =
    Array.from(name).reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 4;
  return (
    <span className={`avatar ${agent ? 'agent-avatar' : `avatar-tone-${tone}`}`} aria-hidden="true">
      {agent ? <Bot size={18} /> : initials}
    </span>
  );
}
export function Empty({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Bot;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Card asChild>
      <div className="empty workspace-empty">
        <span className="empty-icon" aria-hidden="true">
          <Icon size={30} />
        </span>
        <h2>{title}</h2>
        <p>{description}</p>
        {action}
      </div>
    </Card>
  );
}
