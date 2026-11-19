// Nullable native Claude categories and safe selected-credential attribution; historical rows remain unknown.
import type { Migration } from './types';

export const nativeCacheUsageMigration: Migration = {
  name: '058_ai_usage_native_cache',
  up(db) {
    db.exec(
      'ALTER TABLE ai_usage_events ADD COLUMN fresh_input_tokens INTEGER CHECK (fresh_input_tokens IS NULL OR fresh_input_tokens >= 0)',
    );
    db.exec(
      'ALTER TABLE ai_usage_events ADD COLUMN cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0)',
    );
    db.exec('ALTER TABLE ai_usage_events ADD COLUMN credential_id TEXT');
  },
};
