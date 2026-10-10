import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Service, all } from '../src/service.js';
import { FileStore } from '../src/store.js';
import { localActor, authenticate } from '../src/auth.js';
import { handle } from '../src/api.js';
import { type Actor, type Entry, Problem } from '../src/model.js';
import { upload, download, removeFile } from '../src/files.js';
import { readFile } from 'node:fs/promises';

const setup = () => {
  const store = new FileStore();
  return { store, s: new Service(store, localActor) };
};
const act = (
  s: Service,
  e: Entry,
  action: string,
  data: unknown,
  key = randomUUID(),
) => s.command(e.kind, e.id, action, data, e.version, key);
const item = (s: Service) =>
  s.create('item', {
    title: 'Folding chairs',
    quantity: 10,
    location: 'Zone A',
    condition: 'Good',
    verified: true,
  });

test('movement audit identity is server-owned and an estimate never becomes verified stock', async () => {
  const { s } = setup();
  let e = await s.create('item', {
    title: 'Estimated stock',
    quantity: 100,
    location: 'Unknown',
    condition: 'Good',
  });
  const key = randomUUID();
  e = await act(
    s,
    e,
    'adjust',
    {
      location: 'Counted shelf',
      quantity: 3,
      condition: 'Good',
      reason: 'Physical count',
      by: 'forged-user',
      action: 'forged-action',
      id: 'forged-id',
    },
    key,
  );
  assert.equal(
    e.data.balances.reduce((n: number, b: any) => n + b.quantity, 0),
    3,
  );
  assert.equal(e.data.movements[0].by, localActor.id);
  assert.equal(e.data.movements[0].action, 'adjust');
  assert.equal(e.data.movements[0].id, key);
});

test('private files retain versions and downloads enforce record access', async () => {
  const { s, store } = setup();
  const old = { ...process.env };
  try {
    process.env.STORE_MODE = 'file';
    process.env.NODE_ENV = 'development';
    delete process.env.WEBSITE_INSTANCE_ID;
    let e = await s.create('document', {
      title: 'Private test document',
      classification: 'restricted',
    });
    const req = (version: number, text: string) =>
      new Request('http://localhost/api/files', {
        method: 'POST',
        headers: {
          'if-match': String(version),
          'content-type': 'text/plain',
          'x-file-name': 'test.txt',
        },
        body: text,
      });
    e = await upload(s, 'document', e.id, req(e.version, 'Version one'));
    e = await upload(s, 'document', e.id, req(e.version, 'Version two'));
    assert.equal(e.data.files.length, 2);
    const response = await download(s, 'document', e.id, e.data.files[0].id);
    assert.equal(await response.text(), 'Version one');
    assert.match(
      response.headers.get('content-disposition') || '',
      /^attachment;/,
    );
    assert.match(
      (
        await download(s, 'document', e.id, e.data.files[0].id, true)
      ).headers.get('content-disposition') || '',
      /^inline;/,
    );
    const staff = new Service(store, {
      id: 'staff',
      name: 'Staff',
      roles: ['contributor'],
      projectIds: [],
    });
    await assert.rejects(
      download(staff, 'document', e.id, e.data.files[0].id),
      /unavailable/,
    );
    await assert.rejects(
      upload(s, 'document', e.id, req(1, 'Stale write')),
      /changed/,
    );
    await assert.rejects(
      removeFile(staff, 'document', e.id, e.data.files[0].id, e.version),
      /not found|unavailable/,
    );
    const fileId = e.data.files[0].id;
    await assert.rejects(removeFile(s, 'document', e.id, fileId, 1), /changed/);
    assert.equal(
      await (await download(s, 'document', e.id, fileId)).text(),
      'Version one',
    );
    e = await removeFile(s, 'document', e.id, fileId, e.version);
    assert.ok(e.data.files[0].removedAt);
    assert.equal(e.data.files[0].deletionPending, false);
    await assert.rejects(
      download(s, 'document', e.id, fileId),
      /File not found/,
    );
    await assert.rejects(readFile(`.data/files/document/${e.id}/${fileId}`), {
      code: 'ENOENT',
    });
    const version = e.version;
    assert.equal(
      (await removeFile(s, 'document', e.id, fileId, version)).version,
      version,
    );
    assert.equal(
      await (await download(s, 'document', e.id, e.data.files[1].id)).text(),
      'Version two',
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test('file cleanup can be retried after a concurrent edit without restoring access', async (t) => {
  const { s, store } = setup();
  const old = { ...process.env };
  try {
    process.env.STORE_MODE = 'file';
    process.env.NODE_ENV = 'development';
    process.env.AUTH_MODE = 'development';
    delete process.env.WEBSITE_INSTANCE_ID;
    let e = await s.create('item', { title: 'Photographed item' });
    e = await upload(
      s,
      'item',
      e.id,
      new Request('http://localhost/api/files', {
        method: 'POST',
        headers: {
          'if-match': String(e.version),
          'content-type': 'image/png',
          'x-file-name': 'item.png',
        },
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=',
          'base64',
        ),
      }),
    );
    const file = e.data.files[0];
    const endpoint = `http://localhost/api/files/item/${e.id}/${file.id}`;
    const preview = await handle(new Request(endpoint + '?preview=1'), store);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const missingVersion = await handle(
      new Request(endpoint + '/remove', { method: 'POST' }),
      store,
    );
    assert.equal(missingVersion.status, 428);
    const replace = store.replace.bind(store);
    t.mock.method(store, 'replace', async (value: Entry, expected: number) => {
      if (
        value.data.files?.[0].removedAt &&
        value.data.files[0].deletionPending === false
      )
        throw new Problem(409, 'Concurrent catalogue edit');
      return replace(value, expected);
    });
    await assert.rejects(
      removeFile(s, 'item', e.id, file.id, e.version),
      /Concurrent catalogue/,
    );
    let current = await s.get('item', e.id);
    assert.equal(current.data.files[0].deletionPending, true);
    assert.equal((await handle(new Request(endpoint), store)).status, 404);
    t.mock.restoreAll();
    const retry = await handle(
      new Request(endpoint + '/remove', {
        method: 'POST',
        headers: { 'if-match': String(current.version) },
      }),
      store,
    );
    assert.equal(retry.status, 200);
    current = await retry.json();
    assert.equal(current.data.files[0].deletionPending, false);
    assert.equal((await handle(new Request(endpoint), store)).status, 404);
  } finally {
    t.mock.restoreAll();
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test('concurrent checkouts cannot overdraw stock and retries are idempotent', async () => {
  const { s } = setup();
  let e = await item(s);
  const key = randomUUID();
  const data = {
    quantity: 7,
    location: 'Zone A',
    borrower: 'Volunteer',
    due: '2027-01-20',
  };
  const attempts = await Promise.allSettled([
    act(s, e, 'checkout', data, key),
    act(s, e, 'checkout', data),
  ]);
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
  e = await s.get('item', e.id);
  assert.equal(e.data.balances[0].quantity, 3);
  assert.equal(e.data.loans.length, 1);
  const successfulKey = e.data.movements[0].id;
  const replay = await s.command(
    'item',
    e.id,
    'checkout',
    data,
    1,
    successfulKey,
  );
  assert.equal(replay.version, e.version);
  await assert.rejects(
    act(s, e, 'checkout', { ...data, quantity: 4 }),
    /Not enough/,
  );
  await assert.rejects(
    act(s, e, 'checkout', { ...data, quantity: 1 }, successfulKey),
    /different action/,
  );
});

test('partial damaged returns and transfers conserve stock', async () => {
  const { s } = setup();
  let e = await item(s);
  e = await act(s, e, 'checkout', {
    quantity: 6,
    location: 'Zone A',
    borrower: 'Volunteer',
    due: '2027-01-20',
  });
  e = await act(s, e, 'return', {
    loanId: e.data.loans[0].id,
    quantity: 4,
    damaged: 1,
    location: 'Zone B',
  });
  assert.equal(e.data.loans[0].outstanding, 2);
  assert.equal(
    e.data.balances.reduce((n: number, b: any) => n + b.quantity, 0),
    8,
  );
  e = await act(s, e, 'transfer', {
    location: 'Zone B',
    destination: 'Repair shelf',
    condition: 'Needs repair',
    quantity: 1,
    reason: 'Needs repair',
  });
  assert.equal(
    e.data.balances.find((b: any) => b.location === 'Repair shelf').quantity,
    1,
  );
  await assert.rejects(
    act(s, e, 'return', {
      loanId: e.data.loans[0].id,
      quantity: 3,
      damaged: 0,
      location: 'Zone A',
    }),
    /exceed/,
  );
});

test('unknown inventory cannot be checked out; individual stock cannot be inflated', async () => {
  const { s } = setup();
  const e = await s.create('item', { title: 'Unknown crate' });
  assert.equal(e.data.quantity, null);
  assert.deepEqual(e.data.balances, []);
  await assert.rejects(
    act(s, e, 'checkout', {
      quantity: 1,
      location: 'Unknown',
      borrower: 'Volunteer',
      due: '2027-01-20',
    }),
    /Verify/,
  );
  const single = await s.create('item', {
    title: 'Generator',
    tracking: 'Individual',
    quantity: 1,
    verified: true,
    condition: 'Good',
  });
  await assert.rejects(
    act(s, single, 'adjust', {
      location: 'Unknown',
      quantity: 2,
      condition: 'Good',
      reason: 'Counted again',
    }),
    /quantity one/,
  );
});

test('stocktake requires identification and verification, applies once and completes only reviewed zones', async () => {
  const { s, store } = setup();
  let e = await s.create('stocktake', {
    title: 'Opening stocktake',
    zones: ['Zone A'],
  });
  const observation = {
    name: 'Football cones',
    location: 'Zone A',
    quantity: null,
    condition: 'Good',
    unit: 'items',
    identified: false,
    verified: false,
  };
  e = await act(s, e, 'observe', observation);
  const observationId = e.data.observations[0].id;
  await assert.rejects(
    act(s, e, 'apply', { observationId }),
    /Identify and verify/,
  );
  await assert.rejects(act(s, e, 'complete', {}), /Review all/);
  e = await act(s, e, 'revise', {
    ...observation,
    observationId,
    quantity: 20,
    identified: true,
    verified: true,
  });
  const key = randomUUID();
  e = await act(s, e, 'apply', { observationId }, key);
  e = await s.command('stocktake', e.id, 'apply', { observationId }, 1, key);
  assert.equal((await all(store, 'item')).length, 1);
  assert.equal(e.data.observations[0].status, 'Applied');
  e = await act(s, e, 'zone', { zone: 'Zone A' });
  e = await act(s, e, 'complete', {});
  assert.equal(e.data.status, 'Complete');
});

test('roles, classifications and project scope are enforced server-side', async () => {
  const { s, store } = setup();
  const project = await s.create('project', { title: 'Private project' });
  const task = await s.create('task', {
    title: 'Scoped task',
    projectId: project.id,
  });
  const finance = await s.create('document', {
    title: 'Finance',
    classification: 'finance',
  });
  const actor: Actor = {
    id: 'staff',
    name: 'Staff',
    roles: ['contributor'],
    projectIds: ['another-project'],
  };
  const restricted = new Service(store, actor);
  await assert.rejects(restricted.get('task', task.id), /unavailable/);
  await assert.rejects(restricted.get('document', finance.id), /unavailable/);
  await assert.rejects(restricted.list('participant'), /restricted/);
  await assert.rejects(
    restricted.create('member', { title: 'Promote me' }),
    /cannot create/,
  );
  const inventory = new Service(store, {
    ...actor,
    roles: ['inventory'],
    projectIds: [],
  });
  const e = await item(s);
  await inventory.get('item', e.id);
  await assert.rejects(
    inventory.create('task', { title: 'Task' }),
    /cannot create/,
  );
});

test('reviewed content becomes draft after editing and consent is checked again at publication', async () => {
  const { s } = setup();
  const contact = await s.create('contact', { title: 'Parent' });
  const family = await s.create('family', {
    title: 'Family',
    guardianIds: [contact.id],
  });
  let child = await s.create('participant', {
    title: 'Child',
    familyId: family.id,
    guardianIds: [contact.id],
    photography: 'Given',
  });
  let asset = await s.create('asset', {
    title: 'Camp photo',
    rights: 'Permission recorded',
    participantIds: [child.id],
  });
  asset = await act(s, asset, 'approve', {});
  let post = await s.create('social', {
    title: 'Camp story',
    channel: 'Facebook',
    assetId: asset.id,
  });
  post = await act(s, post, 'review', {});
  post = await act(s, post, 'approve', {});
  child = await s.update(
    'participant',
    child.id,
    { ...child.data, photography: 'Withdrawn' },
    child.version,
  );
  await assert.rejects(
    act(s, post, 'publish', { url: 'https://example.org/post' }),
    /another review/,
  );
  let doc = await s.create('document', { title: 'Minutes' });
  doc = await act(s, doc, 'review', {});
  doc = await act(s, doc, 'approve', {});
  const { reviewerId, approvedAt, ...editable } = doc.data;
  doc = await s.update(
    'document',
    doc.id,
    { ...editable, description: 'Correction' },
    doc.version,
  );
  assert.equal(doc.data.status, 'Draft');
});

test('proposal approval creates one task and stale evidence is rejected', async () => {
  const { s, store } = setup();
  const source = await s.create('task', { title: 'Unassigned work' });
  await s.review();
  await s.review();
  const suggestions = await all(store, 'suggestion');
  assert.equal(suggestions.length, 1);
  await Promise.allSettled([
    act(s, suggestions[0], 'approve', {}),
    act(s, suggestions[0], 'approve', {}),
  ]);
  const completed = await s.get('suggestion', suggestions[0].id);
  assert.equal(completed.data.status, 'Completed');
  assert.equal((await all(store, 'task')).length, 2);
  const second = await s.create('suggestion', {
    title: 'Stale proposal',
    reason: 'Evidence',
    taskTitle: 'Follow up',
    sourceKind: 'task',
    sourceId: source.id,
    sourceVersion: source.version,
  });
  await s.update(
    'task',
    source.id,
    { ...source.data, title: 'Changed work' },
    source.version,
  );
  await assert.rejects(
    act(s, second, 'approve', {}),
    /Source information changed/,
  );
});

test('HTTP rejects unknown origins and malformed writes; production cannot bypass login', async () => {
  const { store } = setup();
  const old = { ...process.env };
  try {
    process.env.AUTH_MODE = 'development';
    process.env.STORE_MODE = 'file';
    process.env.NODE_ENV = 'development';
    delete process.env.WEBSITE_INSTANCE_ID;
    let r = await handle(
      new Request('http://localhost/api/me', {
        headers: { origin: 'https://evil.example' },
      }),
      store,
    );
    assert.equal(r.status, 403);
    r = await handle(
      new Request('http://localhost/api/me', {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:5173' },
      }),
      store,
    );
    assert.equal(r.status, 204);
    assert.equal(
      r.headers.get('access-control-allow-origin'),
      'http://localhost:5173',
    );
    r = await handle(
      new Request('http://localhost/api/records/item', {
        method: 'POST',
        body: 'null',
      }),
      store,
    );
    assert.equal(r.status, 400);
    process.env.NODE_ENV = 'production';
    await assert.rejects(authenticate(new Headers(), store), /not permitted/);
    process.env.AUTH_MODE = 'oidc';
    process.env.AUTH_ISSUER = 'https://identity.example';
    process.env.AUTH_AUDIENCE = 'api';
    process.env.AUTH_JWKS_URI = 'https://identity.example/keys';
    await assert.rejects(authenticate(new Headers(), store), /Sign in/);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
