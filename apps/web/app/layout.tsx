import type { Metadata } from 'next';
import './globals.css';
import './workspace-theme.css';
import './appearance.css';
import './workspace-polish.css';
import './collaboration.css';
import './brand.css';
import './workspace-premium.css';
import { UiProviders } from '../components/ui/providers';
export const metadata: Metadata = {
  title: 'Orbit — A shared workspace for people and agents',
  description:
    'Bring conversations, tasks, projects, knowledge, and AI agents into one shared workspace. Keep the context, move work forward, and stay in control.',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <UiProviders>{children}</UiProviders>
      </body>
    </html>
  );
}
