import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseNote } from '../src/release-notes.js';

test('formats an approved release', () => {
  assert.equal(
    releaseNote({ version: '1.2.3', commit: 'abcdef0123456789', approvedBy: 'a human' }),
    'v1.2.3 (abcdef0) approved by a human',
  );
});

test('marks unapproved releases', () => {
  assert.equal(releaseNote({ version: '1.0.0', commit: '1234567' }), 'v1.0.0 (1234567) awaiting approval');
});

test('rejects malformed versions', () => {
  assert.throws(() => releaseNote({ version: 'latest', commit: '1234567' }), /Invalid version/);
});
