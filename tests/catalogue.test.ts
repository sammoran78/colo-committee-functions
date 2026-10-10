import test from 'node:test';
import assert from 'node:assert/strict';
import { FileStore } from '../src/store.js';
import { Service } from '../src/service.js';
import { localActor } from '../src/auth.js';
import { validate } from '../src/model.js';
import { randomUUID } from 'node:crypto';

test('changing catalogue location merges stock buckets and preserves loans, totals and audit identity', async () => {
  const s = new Service(new FileStore(), localActor);
  let e = await s.create('item', {
    title: 'Chairs',
    quantity: 10,
    location: 'Zone A',
    condition: 'Good',
    verified: true,
  });
  const command = async (action: string, data: object) => {
    e = await s.command('item', e.id, action, data, e.version, randomUUID());
  };
  await command('checkout', {
    location: 'Zone A',
    quantity: 2,
    borrower: 'Club volunteer',
    due: '2026-12-01',
  });
  await command('adjust', {
    location: 'Zone A',
    quantity: 3,
    condition: 'Needs repair',
    reason: 'Physical count',
  });
  await command('transfer', {
    location: 'Zone A',
    destination: 'Zone B',
    quantity: 2,
    condition: 'Good',
    reason: 'Store equipment',
  });
  const data = validate('item', {
    title: 'Chairs',
    quantity: 10,
    location: 'Zone B',
    condition: 'Good',
    verified: true,
  });
  e = await s.update('item', e.id, data, e.version);
  assert.deepEqual(e.data.balances, [
    { location: 'Zone B', quantity: 8, condition: 'Good' },
    { location: 'Zone B', quantity: 3, condition: 'Needs repair' },
  ]);
  assert.equal(e.data.loans[0].outstanding, 2);
  assert.equal(e.data.movements.at(-1).quantity, 9);
  assert.equal(e.data.movements.at(-1).by, localActor.id);
  const version = e.version;
  await assert.rejects(
    s.update('item', e.id, { ...data, location: 'Zone C' }, version - 1),
    /changed/,
  );
  await assert.rejects(
    s.update('item', e.id, { ...data, quantity: 500 }, version),
    /movement or stocktake/,
  );
  assert.equal((await s.get('item', e.id)).data.location, 'Zone B');
});

test('project dates and staff approvals reject inconsistent input while legacy projects remain editable', () => {
  assert.equal(validate('project', { title: 'Legacy project' }).start, '');
  assert.throws(
    () =>
      validate('project', {
        title: 'Festival',
        start: '2027-02-01',
        due: '2027-01-01',
      }),
    /start date/,
  );
  assert.throws(
    () =>
      validate('member', {
        title: 'Volunteer',
        issuer: 'https://wordpress.example',
        subject: '9',
        roles: [],
        active: true,
      }),
    /at least one role/,
  );
  assert.deepEqual(
    validate('member', {
      title: 'Volunteer',
      issuer: 'https://wordpress.example',
      subject: '9',
      roles: [],
      active: false,
    }).roles,
    [],
  );
});
