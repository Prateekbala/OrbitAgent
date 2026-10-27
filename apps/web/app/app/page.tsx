import type { Metadata } from 'next';
import { Workspace } from '../../components/workspace';

export const metadata: Metadata = {
  title: 'Orbit — Your workspace',
  robots: { index: false, follow: false },
};

export default function WorkspacePage() {
  return <Workspace />;
}
