import { z } from 'zod';

export const kinds = [
  'project',
  'task',
  'meeting',
  'event',
  'festival',
  'budget',
  'contact',
  'family',
  'participant',
  'camp',
  'registration',
  'followup',
  'social',
  'document',
  'asset',
  'item',
  'location',
  'stocktake',
  'suggestion',
  'member',
] as const;
export type Kind = (typeof kinds)[number];
export type Group =
  'inventory' | 'work' | 'contacts' | 'content' | 'automation' | 'access';
export const groups: Record<Kind, Group> = {
  project: 'work',
  task: 'work',
  meeting: 'work',
  event: 'work',
  festival: 'work',
  budget: 'work',
  contact: 'contacts',
  family: 'contacts',
  participant: 'contacts',
  camp: 'contacts',
  registration: 'contacts',
  followup: 'contacts',
  social: 'content',
  document: 'content',
  asset: 'content',
  item: 'inventory',
  location: 'inventory',
  stocktake: 'inventory',
  suggestion: 'automation',
  member: 'access',
};
export const roles = [
  'admin',
  'committee',
  'festival',
  'communications',
  'escuela',
  'treasurer',
  'inventory',
  'contributor',
] as const;
export type Role = (typeof roles)[number];
export interface Actor {
  id: string;
  name: string;
  roles: Role[];
  projectIds: string[];
}
export interface Entry {
  id: string;
  kind: Kind;
  application: 'colo-committee';
  schemaVersion: 1;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  data: Record<string, any>;
  history: { at: string; by: string; action: string }[];
  receipts: Record<string, { action: string; result?: string }>;
  _etag?: string;
}
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const text = z.string().trim().max(10000);
const name = z.string().trim().min(1).max(200);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const optionalId = z.union([id, z.literal('')]).default('');
const day = z.union([z.iso.date(), z.literal('')]).default('');
const common = {
  title: name,
  description: text.default(''),
  projectId: optionalId,
  classification: z
    .enum(['internal', 'finance', 'escuela', 'restricted'])
    .default('internal'),
};
const plain = z.object(common).strict();
const balance = z.object({
  location: name,
  condition: z.enum(['Good', 'Needs repair', 'Unusable', 'Unknown']),
  quantity: z.number().int().nonnegative().max(1000000),
});
export const schemas: Record<Kind, z.ZodType> = {
  project: plain.extend({
    ownerId: optionalId,
    status: z
      .enum(['Planning', 'Active', 'Complete', 'Archived'])
      .default('Planning'),
    due: day,
  }),
  task: plain.extend({
    ownerId: optionalId,
    status: z
      .enum(['To do', 'In progress', 'Blocked', 'Done', 'Cancelled'])
      .default('To do'),
    priority: z.enum(['Low', 'Medium', 'High']).default('Medium'),
    due: day,
    checklist: z
      .array(z.object({ id, title: name, done: z.boolean() }))
      .max(100)
      .default([]),
    comments: z
      .array(z.object({ text, by: name, at: z.string() }))
      .max(200)
      .default([]),
    sourceId: optionalId,
  }),
  meeting: plain.extend({
    date: day,
    agenda: text.default(''),
    minutes: text.default(''),
    status: z.enum(['Draft', 'For review', 'Approved']).default('Draft'),
  }),
  event: plain.extend({
    date: day,
    location: text.default(''),
    confirmed: z.boolean().default(false),
  }),
  festival: plain.extend({
    year: z.number().int().min(1970).max(2200),
    date: day,
    location: text.default(''),
    confirmed: z.boolean().default(false),
  }),
  budget: plain.extend({
    category: z.enum(['Income', 'Expense']),
    amount: z.number().int().nonnegative().max(1000000000),
    basis: z.enum(['Forecast', 'Committed', 'Actual']),
    date: day,
  }),
  contact: plain.extend({
    email: z.union([z.email(), z.literal('')]).default(''),
    phone: z.string().max(40).default(''),
    type: z
      .enum(['Parent', 'Volunteer', 'Sponsor', 'Supplier', 'Other'])
      .default('Other'),
    language: z.enum(['English', 'Spanish']).default('English'),
  }),
  family: plain.extend({ guardianIds: z.array(id).max(20).default([]) }),
  participant: plain.extend({
    familyId: id,
    guardianIds: z.array(id).min(1).max(20),
    ageGroup: z.string().max(30).default(''),
    stage: z
      .enum(['Enquiry', 'Registered', 'Attended', 'Trial', 'Junior member'])
      .default('Enquiry'),
    participation: z.enum(['Unknown', 'Given', 'Withdrawn']).default('Unknown'),
    photography: z.enum(['Unknown', 'Given', 'Withdrawn']).default('Unknown'),
    marketing: z.enum(['Unknown', 'Given', 'Withdrawn']).default('Unknown'),
    consentNote: text.default(''),
  }),
  camp: plain.extend({
    date: day,
    capacity: z.number().int().min(1).max(10000),
    location: text.default(''),
    status: z.enum(['Planning', 'Open', 'Closed']).default('Planning'),
  }),
  registration: plain.extend({
    participantId: id,
    campId: id,
    status: z
      .enum(['Enquiry', 'Confirmed', 'Attended', 'Cancelled'])
      .default('Enquiry'),
  }),
  followup: plain.extend({
    participantId: optionalId,
    contactId: optionalId,
    ownerId: optionalId,
    due: day,
    status: z.enum(['Open', 'Done']).default('Open'),
  }),
  social: plain.extend({
    channel: z.enum(['Facebook', 'Instagram']),
    copyEn: text.default(''),
    copyEs: text.default(''),
    date: day,
    assetId: optionalId,
    status: z
      .enum(['Draft', 'In review', 'Approved', 'Published'])
      .default('Draft'),
    publishedUrl: z
      .union([z.url().startsWith('https://'), z.literal('')])
      .default(''),
  }),
  document: plain.extend({
    category: z.string().max(100).default('General'),
    status: z
      .enum(['Draft', 'For review', 'Approved', 'Superseded', 'Restricted'])
      .default('Draft'),
  }),
  asset: plain.extend({
    collection: z.enum(['Club', 'Festival', 'Escuela']).default('Club'),
    rights: text.default(''),
    participantIds: z.array(id).max(100).default([]),
    status: z
      .enum(['Draft', 'For review', 'Approved', 'Superseded', 'Restricted'])
      .default('Draft'),
  }),
  item: plain.extend({
    category: z.string().max(80).default('Unidentified'),
    tracking: z
      .enum(['Individual', 'Grouped', 'Consumable'])
      .default('Grouped'),
    unit: z.string().min(1).max(40).default('items'),
    location: z.string().max(200).default('Unknown'),
    quantity: z
      .number()
      .int()
      .nonnegative()
      .max(1000000)
      .nullable()
      .default(null),
    condition: z
      .enum(['Good', 'Needs repair', 'Unusable', 'Unknown'])
      .default('Unknown'),
    verified: z.boolean().default(false),
  }),
  location: plain.extend({ parentId: optionalId }),
  stocktake: plain.extend({
    zones: z.array(name).min(1).max(100),
    status: z
      .enum(['Draft', 'In progress', 'For review', 'Complete'])
      .default('Draft'),
  }),
  suggestion: plain.extend({
    reason: text,
    taskTitle: name,
    ownerId: optionalId,
    due: day,
    sourceId: optionalId,
    sourceKind: z.enum(kinds).optional(),
    sourceVersion: z.number().int().optional(),
  }),
  member: plain.extend({
    subject: name,
    issuer: z.url(),
    roles: z.array(z.enum(roles)).min(1),
    projectIds: z.array(id).max(100).default([]),
    active: z.boolean().default(true),
  }),
};
export const observationSchema = z
  .object({
    name,
    location: name,
    quantity: z.number().int().nonnegative().max(1000000).nullable(),
    condition: balance.shape.condition,
    unit: z.string().min(1).max(40),
    identified: z.boolean(),
    verified: z.boolean(),
  })
  .strict();
export function has(actor: Actor, ...allowed: Role[]) {
  return (
    actor.roles.includes('admin') ||
    actor.roles.some((r) => allowed.includes(r))
  );
}
export function canKind(actor: Actor, kind: Kind, write = false): boolean {
  if (kind === 'member') return has(actor, 'admin');
  if (kind === 'budget') return has(actor, 'treasurer');
  if (groups[kind] === 'contacts') return has(actor, 'escuela');
  if (groups[kind] === 'inventory')
    return write
      ? has(actor, 'inventory')
      : has(
          actor,
          'committee',
          'festival',
          'escuela',
          'inventory',
          'contributor',
        );
  if (kind === 'social')
    return write
      ? has(actor, 'communications')
      : has(actor, 'committee', 'communications', 'festival');
  if (kind === 'asset') return write ? has(actor, 'communications') : true;
  if (kind === 'suggestion')
    return has(
      actor,
      'committee',
      'festival',
      'inventory',
      'communications',
      'escuela',
    );
  return write ? has(actor, 'committee', 'festival', 'contributor') : true;
}
export function canRead(actor: Actor, e: Entry) {
  if (!canKind(actor, e.kind)) return false;
  const c = e.data.classification;
  if (c === 'finance' && !has(actor, 'treasurer')) return false;
  if (c === 'escuela' && !has(actor, 'escuela')) return false;
  if (c === 'restricted' && !has(actor, 'admin')) return false;
  const p = e.kind === 'project' ? e.id : e.data.projectId;
  if (
    p &&
    actor.projectIds.length &&
    !actor.projectIds.includes(p) &&
    !has(actor, 'admin')
  )
    return false;
  return true;
}
export function assertRead(actor: Actor, e: Entry) {
  if (!canRead(actor, e))
    throw new Problem(404, 'Record not found or unavailable.');
}
export function assertWrite(actor: Actor, e: Entry) {
  assertRead(actor, e);
  if (!canKind(actor, e.kind, true))
    throw new Problem(403, 'You do not have permission to change this record.');
}
export function validate(kind: Kind, data: unknown) {
  return schemas[kind].parse(data) as Record<string, any>;
}
