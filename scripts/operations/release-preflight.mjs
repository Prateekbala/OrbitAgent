import { readFile } from 'node:fs/promises';
import { verifyReleaseEvidence } from './release-evidence.mjs';
const required = [
  'PUBLIC_HOST',
  'DEPLOYMENT_REGION',
  'S3_BUCKET',
  'S3_REGION',
  'EVE_RUNTIME_URL',
  'EMAIL_FROM',
];
const issues = [];
for (const key of required) if (!process.env[key]) issues.push(key + ': missing');
for (const key of ['API_IMAGE', 'WEB_IMAGE', 'EDGE_IMAGE', 'SCANNER_IMAGE'])
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(process.env[key] ?? ''))
    issues.push(key + ': pin a scanned immutable digest');
if (process.env.EVE_RUNTIME_URL && !process.env.EVE_RUNTIME_URL.startsWith('https://'))
  issues.push('Runtime TLS qualification missing');
if (!['us', 'eu', 'in', 'ap'].includes(process.env.DEPLOYMENT_REGION))
  issues.push('Choose a specific qualified region');
if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(process.env.PUBLIC_HOST ?? ''))
  issues.push('Use an owned DNS hostname');
for (const item of [
  'BACKUP_RESTORE_EVIDENCE',
  'FAILOVER_EVIDENCE',
  'SECURITY_ASSESSMENT_EVIDENCE',
  'PROVIDER_ACCEPTANCE_EVIDENCE',
  'ACCESSIBILITY_ACCEPTANCE_EVIDENCE',
]) {
  if (!process.env[item]) {
    issues.push(item + ': independent release evidence missing');
    continue;
  }
  try {
    if (
      !process.env.RELEASE_EVIDENCE_KEY_FILE ||
      !/^[a-f0-9]{40,64}$/.test(process.env.RELEASE_REVISION ?? '')
    )
      throw new Error();
    await verifyReleaseEvidence(
      process.env[item],
      await readFile(process.env.RELEASE_EVIDENCE_KEY_FILE, 'utf8'),
      {
        kind: item,
        revision: process.env.RELEASE_REVISION,
        images: Object.fromEntries(
          ['API_IMAGE', 'WEB_IMAGE', 'EDGE_IMAGE', 'SCANNER_IMAGE'].map((k) => [k, process.env[k]]),
        ),
      },
    );
  } catch {
    issues.push(item + ': signed, current, artifact-bound evidence required');
  }
}
console.log(
  JSON.stringify(
    { configurationReady: issues.length === 0, issues, provisioned: false, launchApproved: false },
    null,
    2,
  ),
);
if (issues.length) process.exitCode = 1;
