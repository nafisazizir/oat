import { PROFILE_LIMITS as DB_LIMITS } from '@oat/db';
import { describe, expect, it } from 'vitest';

import { parseVocabulary, PROFILE_LIMITS } from './profile';

describe('profile contract', () => {
  it('uses the database limits (the client copy stays in sync)', () => {
    expect(PROFILE_LIMITS).toEqual(DB_LIMITS);
  });

  it('parses one term per line or comma', () => {
    expect(parseVocabulary('Brightsmile\n DentaCore , Mei Lin\n\n,')).toEqual([
      'Brightsmile',
      'DentaCore',
      'Mei Lin',
    ]);
    expect(parseVocabulary('   ')).toEqual([]);
  });
});
