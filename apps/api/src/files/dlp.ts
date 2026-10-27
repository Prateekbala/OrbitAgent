import { readFile, stat } from 'node:fs/promises';
import type { Sql } from '@ao/database';
import { dlpPolicy, defaultDlpPolicy } from '@ao/contracts/file-governance';
import type { z } from 'zod';
import { AppError } from '../lib/errors.js';
export async function currentDlp(db: Sql, workspace: string) {
  const [row] = await db.query(
    'SELECT policy,version FROM file_dlp_policies WHERE workspace_id=$1',
    [workspace],
  );
  return dlpPolicy.parse(
    row ? { ...(row.policy as object), version: row.version } : defaultDlpPolicy,
  );
}
export async function inspectDlp(path: string, name: string, policy: z.infer<typeof dlpPolicy>) {
  const findings: { detector: string; count: number }[] = [];
  if (!policy.enabled) return { status: 'uninspected' as const, version: policy.version, findings };
  let text: string | undefined;
  if (
    (await stat(path)).size <= 2 * 1024 * 1024 &&
    /\.(txt|md|csv|json|ya?ml|log|xml|html?|[cm]?js|tsx?|py|sh|env|pem|key)$/i.test(name)
  ) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
      if (text.includes('\0')) text = undefined;
    } catch {}
  }
  if (text === undefined)
    return {
      status: policy.requireInspection ? ('blocked' as const) : ('uninspected' as const),
      version: policy.version,
      findings: [{ detector: 'unsupported_content', count: 1 }],
    };
  const rules = {
    private_key: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    aws_key: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    credit_card: /\b(?:\d[ -]?){13,19}\b/g,
    ssn: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  };
  for (const detector of policy.detectors) {
    let count = 0;
    for (const match of text.matchAll(rules[detector])) {
      if (detector === 'credit_card' && !luhn(match[0])) continue;
      if (++count >= 100) break;
    }
    if (count) findings.push({ detector, count });
  }
  return {
    status: findings.length ? ('blocked' as const) : ('clean' as const),
    version: policy.version,
    findings,
  };
}
function luhn(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || /^([0-9])\1+$/.test(digits)) return false;
  let total = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}
export async function requireDlp(db: Sql, workspace: string, file: Record<string, unknown>) {
  const p = await currentDlp(db, workspace);
  if (
    p.enabled &&
    (Number(file.dlp_policy_version) !== p.version ||
      file.dlp_status === 'blocked' ||
      (p.requireInspection && file.dlp_status !== 'clean'))
  )
    throw new AppError(
      403,
      'DLP_BLOCKED',
      'This file requires a successful inspection under the current data policy.',
    );
}
