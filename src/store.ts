import { CosmosClient, type Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { groups, type Entry, type Group, type Kind, Problem } from './model.js';

export interface Page {
  items: Entry[];
  cursor?: string;
}
export interface Store {
  get(kind: Kind, id: string): Promise<Entry | undefined>;
  list(kind: Kind, cursor?: string): Promise<Page>;
  create(e: Entry): Promise<Entry>;
  replace(e: Entry, expected: number): Promise<Entry>;
}
export class FileStore implements Store {
  private records = new Map<string, Entry>();
  private chain = Promise.resolve();
  constructor(private file?: string) {}
  async load() {
    if (this.file) {
      try {
        const entries: Entry[] = JSON.parse(await readFile(this.file, 'utf8'));
        entries.forEach((e) => this.records.set(e.kind + ':' + e.id, e));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return this;
  }
  async get(kind: Kind, id: string) {
    return structuredClone(this.records.get(kind + ':' + id));
  }
  async list(kind: Kind, cursor?: string) {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Problem(400, 'Invalid cursor.');
    const all = [...this.records.values()].filter((e) => e.kind === kind);
    return {
      items: structuredClone(all.slice(offset, offset + 100)),
      cursor: all.length > offset + 100 ? String(offset + 100) : undefined,
    };
  }
  private async persist() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(
      this.file + '.tmp',
      JSON.stringify([...this.records.values()]),
      'utf8',
    );
    await rename(this.file + '.tmp', this.file);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  async create(e: Entry) {
    return this.serial(async () => {
      const k = e.kind + ':' + e.id;
      if (this.records.has(k)) throw new Problem(409, 'Record already exists.');
      this.records.set(k, structuredClone(e));
      try {
        await this.persist();
      } catch (err) {
        this.records.delete(k);
        throw err;
      }
      return structuredClone(e);
    });
  }
  async replace(e: Entry, expected: number) {
    return this.serial(async () => {
      const k = e.kind + ':' + e.id;
      const old = this.records.get(k);
      if (!old || old.version !== expected)
        throw new Problem(409, 'This record changed. Refresh before saving.');
      this.records.set(k, structuredClone(e));
      try {
        await this.persist();
      } catch (err) {
        this.records.set(k, old);
        throw err;
      }
      return structuredClone(e);
    });
  }
}
export class CosmosStore implements Store {
  private client: CosmosClient;
  private containers: Record<Group, Container>;
  constructor() {
    if (process.env.COSMOS_INVENTORY_PARTITION_KEY_PATH !== '/id')
      throw new Error(
        'Set COSMOS_INVENTORY_PARTITION_KEY_PATH=/id for the existing inventory container.',
      );
    const endpoint = process.env.COSMOS_ENDPOINT;
    if (!endpoint) throw new Error('COSMOS_ENDPOINT is required.');
    this.client = new CosmosClient(
      process.env.COSMOS_KEY
        ? { endpoint, key: process.env.COSMOS_KEY }
        : { endpoint, aadCredentials: new DefaultAzureCredential() },
    );
    const db = this.client.database(
      process.env.COSMOS_DATABASE_ID || 'phd-helper',
    );
    this.containers = Object.fromEntries(
      ['inventory', 'work', 'contacts', 'content', 'automation', 'access'].map(
        (g) => [
          g,
          db.container(
            process.env['COSMOS_CONTAINER_' + g.toUpperCase()] || 'colo-' + g,
          ),
        ],
      ),
    ) as Record<Group, Container>;
  }
  private c(kind: Kind) {
    return this.containers[groups[kind]];
  }
  async get(kind: Kind, id: string) {
    try {
      const { resource } = await this.c(kind).item(id, id).read<Entry>();
      return resource?.application === 'colo-committee' &&
        resource.kind === kind
        ? resource
        : undefined;
    } catch (e) {
      if ((e as { code?: number }).code === 404) return;
      throw e;
    }
  }
  async list(kind: Kind, cursor?: string) {
    const result = await this.c(kind)
      .items.query<Entry>(
        {
          query:
            'SELECT * FROM c WHERE c.application = @app AND c.kind = @kind',
          parameters: [
            { name: '@app', value: 'colo-committee' },
            { name: '@kind', value: kind },
          ],
        },
        { maxItemCount: 100, continuationToken: cursor },
      )
      .fetchNext();
    return { items: result.resources, cursor: result.continuationToken };
  }
  async create(e: Entry) {
    try {
      const { resource } = await this.c(e.kind).items.create(e);
      return resource as Entry;
    } catch (err) {
      if ((err as { code?: number }).code === 409)
        throw new Problem(409, 'Record already exists.');
      throw err;
    }
  }
  async replace(e: Entry, expected: number) {
    const old = await this.get(e.kind, e.id);
    if (!old || old.version !== expected)
      throw new Problem(409, 'This record changed. Refresh before saving.');
    try {
      const { _etag, ...body } = e;
      const { resource } = await this.c(e.kind)
        .item(e.id, e.id)
        .replace(body, {
          accessCondition: { type: 'IfMatch', condition: old._etag! },
        });
      return resource as Entry;
    } catch (err) {
      if ((err as { code?: number }).code === 412)
        throw new Problem(409, 'This record changed. Refresh before saving.');
      throw err;
    }
  }
}
let singleton: Promise<Store> | undefined;
export function getStore() {
  return (singleton ??= (async () => {
    if (process.env.STORE_MODE === 'file') {
      if (
        process.env.WEBSITE_INSTANCE_ID ||
        process.env.NODE_ENV === 'production'
      )
        throw new Error('File storage is disabled in Azure and production.');
      return new FileStore(
        resolve(process.env.LOCAL_DATA_FILE || '.data/club.json'),
      ).load();
    }
    return new CosmosStore();
  })());
}
