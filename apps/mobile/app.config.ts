import type { ExpoConfig } from 'expo/config';
const origin = process.env.EXPO_PUBLIC_ORBIT_ORIGIN ?? 'https://workspace.example.com';
const url = new URL(origin);
if (
  url.protocol !== 'https:' ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
)
  throw new Error('EXPO_PUBLIC_ORBIT_ORIGIN must be a pinned HTTPS origin.');
const config: ExpoConfig = {
  name: 'Orbit',
  slug: 'orbit-workspace',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  scheme: 'orbit-workspace',
  extra: { origin: url.origin },
  ios: {
    bundleIdentifier: 'so.orbit.workspace',
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription: 'Share video in calls you join.',
      NSMicrophoneUsageDescription: 'Share audio in calls you join.',
      NSPhotoLibraryUsageDescription: 'Choose files to attach to your conversations.',
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
    },
  },
  android: {
    package: 'so.orbit.workspace',
    allowBackup: false,
    permissions: ['CAMERA', 'RECORD_AUDIO', 'POST_NOTIFICATIONS'],
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ],
  },
  updates: { enabled: false },
};
export default config;
