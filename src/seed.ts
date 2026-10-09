import { Service } from './service.js';
import { localActor } from './auth.js';
import type { Store } from './store.js';
export async function seedLocal(store: Store) {
  if ((await store.list('project')).items.length) return;
  const s = new Service(store, localActor);
  await s.create(
    'project',
    {
      title: 'Committee handover',
      description: 'Bring club operations into one place.',
      status: 'Active',
    },
    'project-handover',
  );
  await s.create(
    'project',
    {
      title: 'Chilean Festival 2027',
      description: 'Date and venue to be confirmed.',
      status: 'Planning',
    },
    'project-festival',
  );
  await s.create(
    'project',
    {
      title: 'Escuela development',
      description: 'Programme planning and family enquiries.',
      status: 'Planning',
    },
    'project-escuela',
  );
  await s.create(
    'festival',
    {
      title: 'Chilean Festival 2027',
      projectId: 'project-festival',
      year: 2027,
    },
    'festival-2027',
  );
  await s.create(
    'task',
    {
      title: 'Catalogue the storage container',
      projectId: 'project-handover',
      ownerId: 'local-admin',
      priority: 'High',
      description:
        'Start with a zone-by-zone stocktake. Do not assume unknown quantities are zero.',
    },
    'task-stocktake',
  );
  await s.create(
    'task',
    {
      title: 'Agree the Festival venue shortlist',
      projectId: 'project-festival',
      priority: 'High',
    },
    'task-venue',
  );
  await s.create(
    'task',
    { title: 'Review the approved club logos', projectId: 'project-handover' },
    'task-logos',
  );
  await s.create(
    'location',
    { title: 'Storage container' },
    'location-container',
  );
  await s.create(
    'meeting',
    {
      title: 'Committee planning meeting',
      projectId: 'project-handover',
      agenda: 'Festival planning\nContainer stocktake\nEscuela enquiries',
    },
    'meeting-planning',
  );
}
