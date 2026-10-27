import { database } from '@ao/database';
import { IdentitySecrets } from '../../apps/api/src/identity/secrets.js';
import { rewrapCredentials } from '../../apps/api/src/governance/rotation.js';
if (!process.env.OPERATIONS_DATABASE_URL)
  throw new Error('Use the isolated operator database login.');
const db = await database({ url: process.env.OPERATIONS_DATABASE_URL });
try {
  console.log(
    JSON.stringify(
      await rewrapCredentials(
        db,
        IdentitySecrets.fromEnvironment(process.env),
        process.argv.includes('--apply'),
      ),
      null,
      2,
    ),
  );
} catch {
  console.error(
    'Credential rewrap failed; retain prior keys and inspect the credential inventory.',
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
