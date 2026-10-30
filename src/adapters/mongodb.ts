import { stage, cancellation, driverClosed } from '../observability.js';
import mongodb from 'mongodb';
const { BSON } = mongodb;
import type { Document } from 'mongodb';
import type { Adapter } from './types.js';
import type { MongoQuery } from '../mongo.js';
import { abortable, networkHost } from './types.js';

export const execute: Adapter = async (raw, { config, password, signal, result }) => {
  const input = raw as MongoQuery;
  const host = config.mongoSrv ? config.host : networkHost(config.host, config.tls);
  const address = config.mongoSrv
    ? host
    : `${host.includes(':') ? `[${host}]` : host}:${config.port}`;
  // Credentials stay out of the URI, where topology/parse errors could otherwise echo them.
  const client = new mongodb.MongoClient(`mongodb${config.mongoSrv ? '+srv' : ''}://${address}`, {
    ...(config.user ? { auth: { username: config.user, password } } : {}),
    authSource: config.authSource || 'admin',
    ...(config.replicaSet ? { replicaSet: config.replicaSet } : {}),
    tls: config.tls,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
    serverSelectionTimeoutMS: Math.min(config.timeoutMs, 10000),
    connectTimeoutMS: Math.min(config.timeoutMs, 10000),
    socketTimeoutMS: config.timeoutMs,
    timeoutMS: config.timeoutMs,
    maxPoolSize: 1,
    minPoolSize: 0,
    retryReads: false,
    promoteLongs: false,
    promoteValues: true,
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= client.close());
  let cursor: { close(): Promise<void> } | undefined;
  let connecting: Promise<mongodb.MongoClient> | undefined;
  try {
    connecting = client.connect();
    await abortable(connecting, signal, () => {
      void close().catch(() => {});
    });
    signal.throwIfAborted();
    stage('execute');
    const db = client.db(config.database);
    const options = { maxTimeMS: config.timeoutMs, signal };
    if (typeof raw === 'object' && 'kind' in raw && raw.kind === 'metadata') {
      const filter =
        raw.input.action === 'describe'
          ? { name: raw.input.name }
          : {
              name: { $regex: (raw.input.name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') },
              ...(raw.input.type === 'view'
                ? { type: 'view' }
                : raw.input.type === 'collection' || raw.input.type === 'table'
                  ? { type: 'collection' }
                  : {}),
            };
      const stream =
        raw.section === 'indexes'
          ? db.collection(raw.input.name!).listIndexes({ ...options, batchSize: 32 })
          : db.listCollections(filter, {
              ...options,
              nameOnly: raw.input.action === 'search',
              authorizedCollections: true,
              batchSize: 32,
            });
      cursor = stream;
      result.fields(raw.section === 'objects' ? ['name', 'type'] : ['metadata']);
      let offset = 0,
        count = 0;
      // MongoDB listCollections has no server-side sort/skip. The cursor is bounded by the
      // invocation deadline; pagination follows server cursor order and makes no snapshot claim.
      for await (const document of stream) {
        if (raw.input.action === 'search' && offset++ < raw.input.offset) continue;
        const row =
          raw.section === 'objects'
            ? [document.name, document.type]
            : [BSON.EJSON.serialize(document, { relaxed: false })];
        if (!result.row(row)) break;
        if (raw.input.action === 'search' && ++count >= raw.input.limit + 1) break;
      }
      return;
    }
    const decode = (value: unknown): Document =>
      BSON.EJSON.deserialize(value as Document, { relaxed: false });
    const collection = db.collection(input.collection ?? '_unused');
    if (input.operation === 'count') {
      const count = await collection.countDocuments(decode(input.filter ?? {}), options);
      result.fields(['count']);
      result.row([count]);
      return;
    }
    const stream =
      input.operation === 'listCollections'
        ? db.listCollections(
            {},
            { ...options, nameOnly: true, authorizedCollections: true, batchSize: 32 },
          )
        : input.operation === 'find'
          ? collection
              .find(decode(input.filter ?? {}), {
                ...options,
                projection: input.projection,
                sort: input.sort,
                batchSize: 32,
              })
              .limit(Math.min(input.limit ?? config.maxRows, config.maxRows) + 1)
          : collection.aggregate(decode({ pipeline: input.pipeline }).pipeline, {
              ...options,
              allowDiskUse: false,
              batchSize: 32,
            });
    cursor = stream;
    result.fields(input.operation === 'listCollections' ? ['name'] : ['document']);
    for await (const document of stream) {
      const value =
        input.operation === 'listCollections'
          ? document.name
          : BSON.EJSON.serialize(document, { relaxed: false });
      if (!result.row([value])) break;
    }
  } finally {
    // A connect may create its topology after an early close (for example during SRV DNS).
    // Own that promise, then close again so no late topology or monitoring socket escapes.
    await connecting?.catch(() => {});
    await cursor?.close().catch(() => {});
    await closing?.catch(() => {});
    await client.close().then(
      () => driverClosed(),
      () => stage('cleanup-failed'),
    );
  }
};
