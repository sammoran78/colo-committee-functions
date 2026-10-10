import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Kind, Problem, assertWrite } from './model.js';
import type { Service } from './service.js';

const mimeTypes = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
let client: BlobServiceClient | undefined;
function container() {
  if (!client) {
    const connectionString =
      process.env.BLOB_STORAGE_CONNECTION_STRING ||
      process.env.BLOB_CONNECTION_STRING;
    if (connectionString)
      client = BlobServiceClient.fromConnectionString(connectionString);
    else if (process.env.BLOB_ACCOUNT_URL)
      client = new BlobServiceClient(
        process.env.BLOB_ACCOUNT_URL,
        new DefaultAzureCredential(),
      );
    else throw new Problem(503, 'File storage has not been configured.');
  }
  return client.getContainerClient(
    process.env.BLOB_CONTAINER_FILES || 'colo-files',
  );
}
const isLocal = () =>
  process.env.STORE_MODE === 'file' &&
  !process.env.WEBSITE_INSTANCE_ID &&
  process.env.NODE_ENV !== 'production';
export async function upload(
  service: Service,
  kind: Kind,
  id: string,
  request: Request,
) {
  if (!['document', 'asset', 'item', 'stocktake'].includes(kind))
    throw new Problem(
      400,
      'Files are supported for documents, brand assets, stocktakes and inventory items.',
    );
  const e = await service.get(kind, id);
  assertWrite(service.actor, e);
  const expected = Number(request.headers.get('if-match'));
  if (expected !== e.version)
    throw new Problem(409, 'This record changed. Refresh before uploading.');
  const type = request.headers.get('content-type')?.split(';')[0] || '';
  if (!mimeTypes.has(type))
    throw new Problem(400, 'Use PDF, PNG, JPEG, WebP, text, DOCX or XLSX.');
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new Problem(413, 'Files must be between 1 byte and 10 MB.');
  const fileId = randomUUID();
  const name = (request.headers.get('x-file-name') || 'file')
    .replace(/[^a-zA-Z0-9 ._-]/g, '_')
    .slice(0, 180);
  const path = `${kind}/${id}/${fileId}`;
  if (isLocal()) {
    const dir = resolve('.data/files', kind, id);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, fileId), bytes);
  } else
    await container()
      .getBlockBlobClient(path)
      .uploadData(bytes, { blobHTTPHeaders: { blobContentType: type } });
  e.data.files = [
    ...(e.data.files || []),
    {
      id: fileId,
      name,
      type,
      size: bytes.length,
      path,
      at: new Date().toISOString(),
      by: service.actor.id,
    },
  ];
  if (['document', 'asset'].includes(kind)) e.data.status = 'Draft';
  return service.save(e, expected, 'Uploaded file version');
}
export async function download(
  service: Service,
  kind: Kind,
  id: string,
  fileId: string,
  preview = false,
) {
  const e = await service.get(kind, id);
  const f = e.data.files?.find((x: any) => x.id === fileId);
  if (!f || f.removedAt) throw new Problem(404, 'File not found.');
  if (
    kind === 'asset' &&
    (e.data.status === 'Restricted' || !(await service.assetUsable(e)))
  )
    throw new Problem(
      403,
      'This asset is restricted or its photography consent is unavailable.',
    );
  const bytes = isLocal()
    ? await readFile(resolve('.data/files', kind, id, fileId))
    : await container().getBlobClient(f.path).downloadToBuffer();
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': f.type,
      'Content-Disposition': `${preview && ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'].includes(f.type) ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^a-zA-Z0-9 ._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function removeFile(
  service: Service,
  kind: Kind,
  id: string,
  fileId: string,
  expected: number,
) {
  let e = await service.get(kind, id);
  assertWrite(service.actor, e);
  if (e.version !== expected)
    throw new Problem(
      409,
      'This record changed. Refresh before removing a file.',
    );
  let f = e.data.files?.find((x: any) => x.id === fileId);
  if (!f) throw new Problem(404, 'File not found.');
  if (f.removedAt && !f.deletionPending) return e;
  if (!f.removedAt) {
    f.removedAt = new Date().toISOString();
    f.removedBy = service.actor.id;
    f.deletionPending = true;
    if (['document', 'asset'].includes(kind)) e.data.status = 'Draft';
    // Revoke access before deleting bytes. A failed concurrent write cannot delete a live attachment.
    e = await service.save(e, expected, 'Removed file: ' + f.name);
  }
  try {
    if (isLocal())
      await rm(resolve('.data/files', kind, id, fileId), { force: true });
    else await container().getBlobClient(f.path).deleteIfExists();
  } catch {
    throw new Problem(
      503,
      'The file is hidden, but storage cleanup failed. Refresh and retry cleanup.',
    );
  }
  // Re-read so concurrent catalogue edits are preserved; pending cleanup can safely be retried.
  e = await service.get(kind, id);
  f = e.data.files?.find((x: any) => x.id === fileId);
  if (!f?.deletionPending) return e;
  f.deletionPending = false;
  return service.save(e, e.version, 'Deleted stored file: ' + f.name);
}
