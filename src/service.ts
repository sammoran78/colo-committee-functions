import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type Actor,
  type Entry,
  type Kind,
  Problem,
  validate,
  canRead,
  canKind,
  assertRead,
  assertWrite,
  has,
  observationSchema,
} from './model.js';
import type { Store } from './store.js';
import { memberId } from './auth.js';

const now = () => new Date().toISOString();
export function fresh(
  kind: Kind,
  data: Record<string, any>,
  actor: Actor,
  id = kind + '-' + randomUUID(),
): Entry {
  return {
    id,
    kind,
    application: 'colo-committee',
    schemaVersion: 1,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    createdBy: actor.id,
    data,
    history: [{ at: now(), by: actor.id, action: 'Created' }],
    receipts: {},
  };
}
export async function all(store: Store, kind: Kind): Promise<Entry[]> {
  let cursor: string | undefined;
  const items: Entry[] = [];
  do {
    const p = await store.list(kind, cursor);
    items.push(...p.items);
    cursor = p.cursor;
    if (items.length > 5000)
      throw new Problem(
        422,
        'Narrow this operation; more than 5,000 records require a scoped query.',
      );
  } while (cursor);
  return items;
}
export class Service {
  constructor(
    public store: Store,
    public actor: Actor,
  ) {}
  async get(kind: Kind, id: string) {
    const e = await this.store.get(kind, id);
    if (!e) throw new Problem(404, 'Record not found.');
    assertRead(this.actor, e);
    return e;
  }
  async list(kind: Kind, cursor?: string) {
    if (!canKind(this.actor, kind))
      throw new Problem(403, 'This area is restricted.');
    const p = await this.store.list(kind, cursor);
    return { ...p, items: p.items.filter((e) => canRead(this.actor, e)) };
  }
  async people() {
    return (await all(this.store, 'member'))
      .filter((e) => e.data.active)
      .map((e) => ({
        id: e.id,
        name: e.data.title,
        projectIds: e.data.projectIds,
      }))
      .concat(
        this.actor.id === 'local-admin'
          ? [{ id: this.actor.id, name: this.actor.name, projectIds: [] }]
          : [],
      );
  }
  async references(kind: Kind, d: Record<string, any>) {
    if (d.projectId) await this.get('project', d.projectId);
    if (d.ownerId) {
      if (d.ownerId !== this.actor.id) {
        const member = await this.store.get('member', d.ownerId);
        if (!member?.data.active)
          throw new Problem(400, 'Select an active staff member.');
        const a: Actor = {
          id: member.id,
          name: member.data.title,
          roles: member.data.roles,
          projectIds: member.data.projectIds,
        };
        const check = fresh(kind, d, a);
        if (!canRead(a, check))
          throw new Problem(400, 'This assignee cannot access the record.');
      }
    }
    if (kind === 'family')
      for (const cid of d.guardianIds) await this.get('contact', cid);
    if (kind === 'participant') {
      const family = await this.get('family', d.familyId);
      if (
        d.guardianIds.some(
          (id: string) => !family.data.guardianIds.includes(id),
        )
      )
        throw new Problem(
          400,
          'Participant guardians must be linked to this family first.',
        );
      for (const cid of d.guardianIds) await this.get('contact', cid);
    }
    if (kind === 'registration') {
      const participant = await this.get('participant', d.participantId);
      if (
        ['Confirmed', 'Attended'].includes(d.status) &&
        participant.data.participation !== 'Given'
      )
        throw new Problem(
          409,
          'Record participation consent before confirming attendance.',
        );
      await this.get('camp', d.campId);
    }
    if (kind === 'followup') {
      if (d.participantId) await this.get('participant', d.participantId);
      if (d.contactId) await this.get('contact', d.contactId);
    }
    if (kind === 'social' && d.assetId) {
      const asset = await this.get('asset', d.assetId);
      if (asset.data.status !== 'Approved' || !(await this.assetUsable(asset)))
        throw new Problem(
          400,
          'Choose an approved asset with valid usage consent.',
        );
    }
  }
  async assetUsable(e: Entry) {
    for (const pid of e.data.participantIds || []) {
      const p = await this.store.get('participant', pid);
      if (!p || p.data.photography !== 'Given') return false;
    }
    return true;
  }
  async create(kind: Kind, input: unknown, id?: string) {
    if (!canKind(this.actor, kind, true))
      throw new Problem(403, 'You cannot create records in this area.');
    const data = validate(kind, input);
    if (kind === 'member') {
      id = memberId(data.issuer, data.subject);
      data.classification = 'restricted';
    }
    if (kind === 'budget') data.classification = 'finance';
    if (
      [
        'contact',
        'family',
        'participant',
        'camp',
        'registration',
        'followup',
      ].includes(kind)
    )
      data.classification = 'escuela';
    const e = fresh(kind, data, this.actor, id);
    assertWrite(this.actor, e);
    await this.references(kind, data);
    if (kind === 'task') data.comments = [];
    if (
      ['social', 'meeting', 'asset', 'document'].includes(kind) &&
      data.status !== 'Draft'
    )
      throw new Problem(400, 'New records start as drafts.');
    if (kind === 'item') {
      if (data.verified && data.quantity === null)
        throw new Problem(400, 'An unknown quantity cannot be verified.');
      if (
        data.tracking === 'Individual' &&
        data.quantity !== null &&
        data.quantity > 1
      )
        throw new Problem(400, 'An individual asset has quantity one at most.');
      data.balances =
        data.quantity === null
          ? []
          : [
              {
                location: data.location,
                condition: data.condition,
                quantity: data.quantity,
              },
            ];
      data.loans = [];
      data.movements = [];
    }
    if (kind === 'stocktake') {
      data.status = 'Draft';
      data.observations = [];
      data.completedZones = [];
    }
    if (kind === 'suggestion') data.status = 'New';
    return this.store.create(e);
  }
  async save(e: Entry, expected: number, action: string) {
    e.version = expected + 1;
    e.updatedAt = now();
    e.history.push({ at: e.updatedAt, by: this.actor.id, action });
    if (Buffer.byteLength(JSON.stringify(e)) > 1500000)
      throw new Problem(
        422,
        'This record needs archival before more history can be added. Contact the administrator.',
      );
    return this.store.replace(e, expected);
  }
  async update(kind: Kind, id: string, input: unknown, version: number) {
    const e = await this.get(kind, id);
    assertWrite(this.actor, e);
    if (e.version !== version)
      throw new Problem(409, 'This record changed. Refresh before saving.');
    const d = validate(kind, input);
    if (kind === 'member') d.classification = 'restricted';
    if (kind === 'budget') d.classification = 'finance';
    if (
      [
        'contact',
        'family',
        'participant',
        'camp',
        'registration',
        'followup',
      ].includes(kind)
    )
      d.classification = 'escuela';
    await this.references(kind, d);
    if (d.classification !== e.data.classification && !has(this.actor, 'admin'))
      throw new Problem(
        403,
        'Only an administrator may change classification.',
      );
    if (kind === 'member' && memberId(d.issuer, d.subject) !== id)
      throw new Problem(
        400,
        'Identity links are immutable. Create a new staff membership instead.',
      );
    if (
      kind === 'item' &&
      (d.quantity !== e.data.quantity ||
        d.condition !== e.data.condition ||
        d.verified !== e.data.verified ||
        d.tracking !== e.data.tracking ||
        d.unit !== e.data.unit)
    )
      throw new Problem(
        400,
        'Use an inventory movement or stocktake; balances and tracking cannot be overwritten.',
      );
    if (
      ['social', 'meeting', 'asset', 'document', 'stocktake'].includes(kind) &&
      d.status !== e.data.status
    )
      throw new Problem(400, 'Use the review action to change this status.');
    if (kind === 'social' && e.data.status === 'Published')
      throw new Problem(
        409,
        'Published records are locked. Create a new draft.',
      );
    if (
      kind === 'stocktake' &&
      e.data.status !== 'Draft' &&
      JSON.stringify(d.zones) !== JSON.stringify(e.data.zones)
    )
      throw new Problem(
        409,
        'Zones cannot be changed after a stocktake has started.',
      );
    if (kind === 'suggestion' && e.data.status !== 'New')
      throw new Problem(409, 'Only new proposals may be edited.');
    if (
      ['social', 'meeting', 'asset', 'document'].includes(kind) &&
      e.data.status === 'Approved'
    )
      d.status = kind === 'social' ? 'In review' : 'Draft';
    if (kind === 'task') {
      d.comments = e.data.comments;
      d.sourceId = e.data.sourceId;
    }
    if (kind === 'item' && d.location !== e.data.location) {
      const source = e.data.location;
      let moved = 0;
      const balances = e.data.balances || [];
      const merged: typeof balances = [];
      for (const b of balances) {
        const location = b.location === source ? d.location : b.location;
        if (b.location === source) moved += b.quantity;
        const bucket = merged.find(
          (x: any) => x.location === location && x.condition === b.condition,
        );
        if (bucket) bucket.quantity += b.quantity;
        else merged.push({ ...b, location });
      }
      e.data.balances = merged;
      e.data.movements.push({
        id: randomUUID(),
        action: 'transfer',
        at: now(),
        by: this.actor.id,
        location: source,
        destination: d.location,
        quantity: moved,
        reason: 'Storage location changed in item editor',
      });
    }
    if (kind === 'suggestion') {
      for (const key of ['sourceId', 'sourceKind', 'sourceVersion'])
        d[key] = e.data[key];
    }
    e.data = { ...e.data, ...d };
    assertWrite(this.actor, e);
    return this.save(e, version, 'Updated');
  }
  async command(
    kind: Kind,
    id: string,
    action: string,
    input: any,
    version: number,
    key: string,
  ) {
    const e = await this.get(kind, id);
    assertWrite(this.actor, e);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw new Problem(400, 'An idempotency key is required.');
    const signature =
      action +
      ':' +
      createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (e.receipts[key]) {
      if (e.receipts[key].action !== signature)
        throw new Problem(
          409,
          'This request key was already used for a different action.',
        );
      return e;
    }
    if (e.version !== version)
      throw new Problem(409, 'This record changed. Refresh before retrying.');
    if (kind === 'suggestion' && action === 'approve')
      return this.approveSuggestion(e, key, signature);
    if (kind === 'stocktake' && action === 'apply')
      return this.applyObservation(e, input, version, key, signature);
    const d = e.data;
    if (kind === 'item') this.inventory(e, action, input, key);
    else if (kind === 'stocktake') {
      if (d.status === 'Complete')
        throw new Problem(409, 'This stocktake is complete.');
      if (action === 'observe') {
        const obs = observationSchema.parse(input);
        if (!d.zones.includes(obs.location))
          throw new Problem(400, 'Select a zone in this stocktake.');
        d.observations.push({
          ...obs,
          id: 'obs-' + randomUUID(),
          status: 'Draft',
          by: this.actor.id,
          at: now(),
        });
        d.status = 'In progress';
      } else if (action === 'revise') {
        const { observationId, ...details } = input;
        const obs = d.observations.find((o: any) => o.id === observationId);
        if (!obs || obs.status !== 'Draft')
          throw new Problem(409, 'Only draft observations can be revised.');
        const revised = observationSchema.parse(details);
        if (!d.zones.includes(revised.location))
          throw new Problem(400, 'Select a session zone.');
        Object.assign(obs, revised);
      } else if (action === 'discard') {
        const obs = d.observations.find(
          (o: any) => o.id === input.observationId,
        );
        if (!obs || obs.status !== 'Draft')
          throw new Problem(409, 'Only a draft observation can be discarded.');
        obs.status = 'Discarded';
      } else if (action === 'zone') {
        const zone = z.string().parse(input.zone);
        if (!d.zones.includes(zone)) throw new Problem(400, 'Unknown zone.');
        d.completedZones = [...new Set([...d.completedZones, zone])];
      } else if (action === 'complete') {
        if (
          d.completedZones.length !== d.zones.length ||
          d.observations.some(
            (o: any) => !['Applied', 'Discarded'].includes(o.status),
          )
        )
          throw new Problem(
            409,
            'Review all observations and finish every zone first.',
          );
        d.status = 'Complete';
      } else throw new Problem(400, 'Unknown stocktake action.');
    } else if (kind === 'suggestion' && action === 'dismiss') {
      if (d.status !== 'New')
        throw new Problem(409, 'Only new suggestions can be dismissed.');
      d.status = 'Dismissed';
    } else if (kind === 'task' && action === 'comment') {
      const message = z.string().trim().min(1).max(5000).parse(input.text);
      d.comments.push({ text: message, by: this.actor.name, at: now() });
    } else if (kind === 'task' && action === 'checklist') {
      if (input.id) {
        const check = d.checklist.find((c: any) => c.id === input.id);
        if (!check) throw new Problem(404, 'Checklist item not found.');
        check.done = z.boolean().parse(input.done);
      } else
        d.checklist.push({
          id: randomUUID(),
          title: z.string().trim().min(1).max(200).parse(input.title),
          done: false,
        });
    } else if (['social', 'meeting', 'asset', 'document'].includes(kind)) {
      if (action === 'review' && ['Draft', 'In review'].includes(d.status))
        d.status = kind === 'social' ? 'In review' : 'For review';
      else if (action === 'approve') {
        if (d.status === 'Published')
          throw new Problem(409, 'Published records cannot be reapproved.');
        if (
          !has(
            this.actor,
            kind === 'social' || kind === 'asset'
              ? 'communications'
              : 'committee',
          )
        )
          throw new Problem(403, 'A reviewer must approve this record.');
        if (kind === 'social' && d.status !== 'In review')
          throw new Problem(409, 'Request review first.');
        if (kind === 'asset' && (!d.rights || !(await this.assetUsable(e))))
          throw new Problem(
            409,
            'Usage rights and participant photography consent must be confirmed.',
          );
        if (kind === 'social' && d.assetId) {
          const a = await this.get('asset', d.assetId);
          if (a.data.status !== 'Approved' || !(await this.assetUsable(a)))
            throw new Problem(
              409,
              'The linked asset is no longer approved for use.',
            );
          d.approvedAssetVersion = a.version;
        }
        d.status = 'Approved';
        d.reviewerId = this.actor.id;
        d.approvedAt = now();
      } else if (
        action === 'publish' &&
        kind === 'social' &&
        d.status === 'Approved'
      ) {
        const url = z.url().startsWith('https://').parse(input.url);
        if (d.assetId) {
          const a = await this.get('asset', d.assetId);
          if (
            a.version !== d.approvedAssetVersion ||
            a.data.status !== 'Approved' ||
            !(await this.assetUsable(a))
          )
            throw new Problem(
              409,
              'The asset changed; this post needs another review.',
            );
        }
        d.status = 'Published';
        d.publishedUrl = url;
        d.publishedAt = now();
      } else
        throw new Problem(
          409,
          'This action is unavailable in the current state.',
        );
    } else throw new Problem(400, 'Unknown action.');
    e.receipts[key] = { action: signature };
    return this.save(e, version, action);
  }
  inventory(e: Entry, action: string, input: any, key: string) {
    const d = e.data;
    const add = (location: string, condition: string, quantity: number) => {
      const b = d.balances.find(
        (x: any) => x.location === location && x.condition === condition,
      );
      if (b) b.quantity += quantity;
      else d.balances.push({ location, condition, quantity });
    };
    if (action === 'checkout') {
      const p = z
        .object({
          quantity: z.number().int().positive(),
          location: z.string().min(1),
          borrower: z.string().trim().min(1).max(200),
          due: z.iso.date(),
          event: z.string().max(200).default(''),
        })
        .parse(input);
      if (!d.verified)
        throw new Problem(409, 'Verify this item before issuing it.');
      if (d.tracking === 'Consumable')
        throw new Problem(400, 'Use consume for consumable items.');
      const b = d.balances.find(
        (x: any) => x.location === p.location && x.condition === 'Good',
      );
      if (!b || b.quantity < p.quantity)
        throw new Problem(
          409,
          'Not enough serviceable items at that location.',
        );
      b.quantity -= p.quantity;
      d.loans.push({
        id: 'loan-' + key,
        ...p,
        outstanding: p.quantity,
        issuedAt: now(),
      });
    } else if (action === 'return') {
      const p = z
        .object({
          loanId: z.string(),
          quantity: z.number().int().positive(),
          damaged: z.number().int().nonnegative(),
          location: z.string().min(1).max(200),
        })
        .parse(input);
      const loan = d.loans.find((l: any) => l.id === p.loanId);
      if (!loan || p.quantity > loan.outstanding || p.damaged > p.quantity)
        throw new Problem(
          409,
          'Return quantities exceed the outstanding loan.',
        );
      loan.outstanding -= p.quantity;
      add(p.location, 'Good', p.quantity - p.damaged);
      add(p.location, 'Needs repair', p.damaged);
    } else if (action === 'transfer') {
      const p = z
        .object({
          location: z.string().min(1),
          destination: z.string().min(1),
          condition: z.enum(['Good', 'Needs repair', 'Unusable', 'Unknown']),
          quantity: z.number().int().positive(),
          reason: z.string().min(3).max(1000),
        })
        .parse(input);
      if (p.location === p.destination)
        throw new Problem(400, 'Choose a different destination.');
      const b = d.balances.find(
        (x: any) => x.location === p.location && x.condition === p.condition,
      );
      if (!b || b.quantity < p.quantity)
        throw new Problem(409, 'Not enough stock at the source location.');
      b.quantity -= p.quantity;
      add(p.destination, p.condition, p.quantity);
    } else if (action === 'adjust') {
      const p = z
        .object({
          location: z.string().min(1).max(200),
          condition: z.enum(['Good', 'Needs repair', 'Unusable', 'Unknown']),
          quantity: z.number().int().nonnegative().max(1000000),
          reason: z.string().trim().min(3).max(1000),
        })
        .parse(input);
      // An initial unverified estimate must not become verified merely by counting a different bucket.
      if (!d.verified) d.balances = [];
      const b = d.balances.find(
        (x: any) => x.location === p.location && x.condition === p.condition,
      );
      if (b) b.quantity = p.quantity;
      else add(p.location, p.condition, p.quantity);
      d.verified = true;
    } else if (action === 'consume') {
      const p = z
        .object({
          location: z.string().min(1),
          quantity: z.number().int().positive(),
          reason: z.string().trim().min(3).max(1000),
        })
        .parse(input);
      if (d.tracking !== 'Consumable' || !d.verified)
        throw new Problem(400, 'Only verified consumables can be consumed.');
      const b = d.balances.find(
        (x: any) => x.location === p.location && x.condition === 'Good',
      );
      if (!b || b.quantity < p.quantity)
        throw new Problem(409, 'Not enough stock.');
      b.quantity -= p.quantity;
    } else throw new Problem(400, 'Unknown inventory action.');
    if (
      d.tracking === 'Individual' &&
      d.balances.reduce((n: number, b: any) => n + b.quantity, 0) +
        d.loans.reduce((n: number, l: any) => n + l.outstanding, 0) >
        1
    )
      throw new Problem(
        400,
        'An individually tracked asset can have quantity one only.',
      );
    d.movements.push({
      ...input,
      id: key,
      action,
      at: now(),
      by: this.actor.id,
    });
  }
  async applyObservation(
    e: Entry,
    input: any,
    version: number,
    key: string,
    signature: string,
  ) {
    const obs = e.data.observations.find(
      (o: any) => o.id === input.observationId,
    );
    if (!obs) throw new Problem(404, 'Observation not found.');
    if (!['Draft', 'Applying', 'Applied'].includes(obs.status))
      throw new Problem(409, 'This observation was discarded.');
    if (!obs.identified || !obs.verified || obs.quantity === null)
      throw new Problem(
        409,
        'Identify and verify the quantity before applying this observation.',
      );
    // Opening stock only. Existing stock adjustments use the explicit reasoned adjustment command.
    const itemId = 'item-' + obs.id;
    let item = await this.store.get('item', itemId);
    if (!item) {
      const duplicate = e.data.observations.some(
        (o: any) =>
          o.id !== obs.id &&
          o.status !== 'Discarded' &&
          o.name.toLowerCase() === obs.name.toLowerCase() &&
          o.location === obs.location,
      );
      if (duplicate)
        throw new Problem(
          409,
          'Possible duplicate observations in this zone. Reconcile or discard the duplicate before applying.',
        );
      const existing = (await all(this.store, 'item')).some(
        (i) => i.data.title.toLowerCase() === obs.name.toLowerCase(),
      );
      if (existing)
        throw new Problem(
          409,
          'An item with this name already exists. Use its verified adjustment, or give a distinct item a specific name.',
        );
      if (obs.status === 'Draft') {
        obs.status = 'Applying';
        e = await this.save(e, version, 'Claimed opening stock observation');
        version = e.version;
      }
      try {
        item = await this.create(
          'item',
          {
            title: obs.name,
            location: obs.location,
            quantity: obs.quantity,
            condition: obs.condition,
            unit: obs.unit,
            verified: true,
            projectId: e.data.projectId,
            classification: e.data.classification,
          },
          itemId,
        );
      } catch (err) {
        if (!(err instanceof Problem) || err.status !== 409) throw err;
        item = await this.store.get('item', itemId);
      }
    }
    if (
      !item ||
      (item.createdBy !== this.actor.id && item.data.title !== obs.name)
    )
      throw new Problem(409, 'The linked inventory record requires review.');
    const current = e.data.observations.find((o: any) => o.id === obs.id);
    current.status = 'Applied';
    current.itemId = itemId;
    e.receipts[key] = { action: signature, result: itemId };
    return this.save(e, version, 'Applied opening stock observation');
  }
  async approveSuggestion(e: Entry, key: string, signature: string) {
    const d = e.data;
    if (d.status === 'Completed') return e;
    if (!['New', 'Executing'].includes(d.status))
      throw new Problem(409, 'This suggestion cannot be approved.');
    const targetId = 'task-' + e.id;
    let task = await this.store.get('task', targetId);
    if (!task) {
      if (d.sourceId && d.sourceKind) {
        const source = await this.get(d.sourceKind, d.sourceId);
        if (source.version !== d.sourceVersion)
          throw new Problem(
            409,
            'Source information changed. Dismiss this suggestion and run a new review.',
          );
      }
      await this.references('task', { ...d, classification: d.classification });
      if (!canKind(this.actor, 'task', true))
        throw new Problem(403, 'Task creation permission is required.');
      if (d.status === 'New') {
        d.status = 'Executing';
        d.approvedBy = this.actor.id;
        d.approvedAt = now();
        e = await this.save(e, e.version, 'Approved task proposal');
      }
      try {
        task = await this.create(
          'task',
          {
            title: d.taskTitle,
            description: d.reason,
            projectId: d.projectId,
            ownerId: d.ownerId,
            due: d.due,
            sourceId: e.id,
            classification: d.classification,
          },
          targetId,
        );
      } catch (err) {
        if (!(err instanceof Problem) || err.status !== 409) throw err;
        task = await this.store.get('task', targetId);
      }
    }
    if (!task || task.data.sourceId !== e.id)
      throw new Problem(409, 'The target task does not match this proposal.');
    assertRead(this.actor, task);
    e.data.status = 'Completed';
    e.data.taskId = task.id;
    e.receipts[key] = { action: signature, result: task.id };
    return this.save(e, e.version, 'Created task from proposal');
  }
  async review() {
    if (!canKind(this.actor, 'suggestion', true))
      throw new Problem(403, 'You cannot run a review.');
    const sources = (await all(this.store, 'task')).filter(
      (e) =>
        canRead(this.actor, e) &&
        !e.data.ownerId &&
        !['Done', 'Cancelled'].includes(e.data.status),
    );
    let added = 0;
    for (const source of sources.slice(0, 30)) {
      const id = 'suggestion-' + source.id + '-' + source.version;
      if (await this.store.get('suggestion', id)) continue;
      await this.create(
        'suggestion',
        {
          title: 'Assign an owner: ' + source.data.title,
          taskTitle: 'Coordinate: ' + source.data.title,
          reason:
            'This open task has no allocated owner. Review responsibilities and allocate the follow-up.',
          projectId: source.data.projectId,
          classification: source.data.classification,
          sourceId: source.id,
          sourceKind: 'task',
          sourceVersion: source.version,
        },
        id,
      );
      added++;
    }
    return {
      added,
      mode: 'rules',
      message:
        'Rules-based review complete. No model or paid AI service was called.',
    };
  }
}
