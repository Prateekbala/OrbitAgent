import type { Metadata } from 'next';
import { AuthEntry } from '../../components/auth-entry';

export const metadata: Metadata = {
  title: 'Create your workspace — Orbit',
  robots: { index: false, follow: false },
};

export default function SignUpPage() {
  return <AuthEntry register />;
}
