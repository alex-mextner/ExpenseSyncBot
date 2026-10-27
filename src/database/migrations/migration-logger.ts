// Logger shared by the migration modules; named 'schema' so log output is identical to when the
// migrations lived inside schema.ts.
import { createLogger } from '../../utils/logger.ts';

export const migrationLogger = createLogger('schema');
