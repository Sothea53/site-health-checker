// Drop-in replacement for Cloudflare Workers KV, backed by MongoDB instead
// of SQLite (ServerAvatar's Node stack only provisions MongoDB, not MySQL).
// Same get / put / list / delete shape as the SQLite version, so server.js
// needed zero changes to switch over.

import { MongoClient, Binary } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/site_health_checker';

const client = new MongoClient(MONGODB_URI, {
  // Fail fast and clearly instead of the driver's 30s default — given how
  // much time went into chasing silent hangs on the Cloudflare version, a
  // misconfigured MONGODB_URI here should surface as a quick, obvious error
  // on the very first request, not a half-minute stall.
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
});

// Lazily connect once, memoized — every kv method awaits this before touching
// the collection, so callers don't need to know about connection state.
let initPromise = null;
function getCollection() {
  if (!initPromise) {
    initPromise = (async () => {
      await client.connect();
      const col = client.db().collection('kv');
      // TTL index: a document is removed once its `expiresAt` (an absolute
      // Date) is in the past. Documents with no expiresAt field are never
      // touched by this index — MongoDB skips indexing missing fields.
      // expireAfterSeconds: 0 means "expire exactly at expiresAt", not
      // "N seconds after insert" — we compute the absolute date ourselves
      // in put() from the caller's relative expirationTtl.
      await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      return col;
    })();
  }
  return initPromise;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const kv = {
  // opts: { type: 'arrayBuffer' } to get a Buffer back instead of a string
  async get(key, opts = {}) {
    const col = await getCollection();
    const doc = await col.findOne({ _id: key });
    if (!doc) return null;

    // Duck-type via _bsontype rather than `instanceof Binary` — if the
    // mongodb driver bundles its own internal copy of the bson package
    // (common with nested npm dependency trees), our imported Binary class
    // can be a different reference than the one actually used to construct
    // this value, silently failing instanceof even though it IS binary
    // data. That failure mode is exactly what corrupted screenshots: it
    // fell through to treating raw image bytes as a string, producing a
    // garbled byte-array text dump instead of a real image.
    const isBinary = !!(doc.value && doc.value._bsontype === 'Binary');
    if (opts.type === 'arrayBuffer') {
      return isBinary ? Buffer.from(doc.value.buffer) : Buffer.from(String(doc.value), 'utf-8');
    }
    return isBinary ? Buffer.from(doc.value.buffer).toString('utf-8') : doc.value;
  },

  // opts: { expirationTtl: seconds }
  async put(key, value, opts = {}) {
    const col = await getCollection();
    const isBinary = Buffer.isBuffer(value);
    const storedValue = isBinary ? new Binary(value) : String(value);

    const setFields = { value: storedValue };
    const unsetFields = {};
    if (opts.expirationTtl) {
      setFields.expiresAt = new Date(Date.now() + opts.expirationTtl * 1000);
    } else {
      // Clear any TTL a previous put() on this key might have set
      unsetFields.expiresAt = '';
    }

    const update = { $set: setFields };
    if (Object.keys(unsetFields).length) update.$unset = unsetFields;
    await col.updateOne({ _id: key }, update, { upsert: true });
  },

  async delete(key) {
    const col = await getCollection();
    await col.deleteOne({ _id: key });
  },

  // opts: { prefix }
  async list(opts = {}) {
    const col = await getCollection();
    const prefix = opts.prefix || '';
    // Anchored prefix regex on _id — Mongo can use the default _id index
    // for this (range-scan on a prefix-anchored regex), so this stays fast
    // even as report/screenshot history grows.
    const docs = await col
      .find({ _id: { $regex: `^${escapeRegex(prefix)}` } }, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .toArray();
    return { keys: docs.map((d) => ({ name: d._id })) };
  },
};

export default kv;
