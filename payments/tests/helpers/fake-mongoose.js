'use strict';
/**
 * TEST ONLY. A small in-memory stand-in for the parts of Mongoose the payments module uses.
 * It mimics the behaviours that matter for money code:
 *   - schema defaults, required / enum / min / custom validators, strict mode (unknown fields dropped)
 *   - unique indexes, including partialFilterExpression
 *   - atomic single-document findOneAndUpdate with $set / $inc / $push / $unset / $setOnInsert / upsert
 *   - sessions whose withTransaction() rolls everything back if the callback throws
 * It does NOT prove the real Mongoose query syntax is right - see tests/README note in the main README.
 */
const crypto = require('crypto');

const HEX24 = /^[0-9a-f]{24}$/i;

class ObjectId {
  constructor(v) {
    if (v instanceof ObjectId) this._hex = v._hex;
    else if (typeof v === 'string' && HEX24.test(v)) this._hex = v.toLowerCase();
    else this._hex = crypto.randomBytes(12).toString('hex');
  }
  toString() {
    return this._hex;
  }
  toJSON() {
    return this._hex;
  }
  equals(o) {
    return String(o) === this._hex;
  }
}

/* ------------------------------ value helpers ------------------------------ */

const isObj = (v) =>
  v !== null && typeof v === 'object' && !(v instanceof Date) && !(v instanceof ObjectId) && !Array.isArray(v);

function clone(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof ObjectId) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) {
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = clone(v[k]);
    return o;
  }
  return v;
}

// Normalise for equality: ObjectIds and 24-hex strings compare equal; dates by time; undefined == null.
function norm(v) {
  if (v instanceof ObjectId) return `o:${v}`;
  if (typeof v === 'string' && HEX24.test(v)) return `o:${v.toLowerCase()}`;
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (v === undefined) return null;
  return v;
}
const cmpVal = (v) => (v instanceof Date ? v.getTime() : v);

const getPath = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, val) {
  const parts = String(path).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(o[parts[i]])) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = val;
}
function unsetPath(obj, path) {
  const parts = String(path).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    o = o && o[parts[i]];
    if (!o) return;
  }
  delete o[parts[parts.length - 1]];
}

function merge(target, src) {
  for (const k of Object.keys(src)) {
    if (src[k] === undefined) continue;
    if (isObj(src[k]) && isObj(target[k])) merge(target[k], src[k]);
    else target[k] = clone(src[k]);
  }
  return target;
}

/* ------------------------------- filters ------------------------------- */

const isOpObject = (c) => isObj(c) && Object.keys(c).some((k) => k.startsWith('$'));

function matchValue(val, cond) {
  if (isOpObject(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      const present = val !== undefined && val !== null;
      switch (op) {
        case '$in':
          if (!arg.some((a) => norm(a) === norm(val))) return false;
          break;
        case '$nin':
          if (arg.some((a) => norm(a) === norm(val))) return false;
          break;
        case '$ne':
          if (norm(val) === norm(arg)) return false;
          break;
        case '$eq':
          if (norm(val) !== norm(arg)) return false;
          break;
        case '$gte':
          if (!(present && cmpVal(val) >= cmpVal(arg))) return false;
          break;
        case '$gt':
          if (!(present && cmpVal(val) > cmpVal(arg))) return false;
          break;
        case '$lte':
          if (!(present && cmpVal(val) <= cmpVal(arg))) return false;
          break;
        case '$lt':
          if (!(present && cmpVal(val) < cmpVal(arg))) return false;
          break;
        case '$exists':
          if ((val !== undefined) !== arg) return false;
          break;
        default:
          throw new Error(`fake-mongoose: unsupported query operator ${op}`);
      }
    }
    return true;
  }
  return norm(val) === norm(cond);
}

function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter || {})) {
    if (k === '$or') {
      if (!cond.some((f) => matches(doc, f))) return false;
    } else if (k === '$and') {
      if (!cond.every((f) => matches(doc, f))) return false;
    } else if (k.startsWith('$')) {
      throw new Error(`fake-mongoose: unsupported top-level operator ${k}`);
    } else if (!matchValue(getPath(doc, k), cond)) return false;
  }
  return true;
}

/* ------------------------------- schema ------------------------------- */

const isLeaf = (d) => typeof d === 'function' || (isObj(d) && typeof d.type === 'function');

function buildDefaults(def) {
  const out = {};
  for (const [k, d] of Object.entries(def)) {
    if (isLeaf(d)) {
      if (isObj(d) && 'default' in d) {
        let v = typeof d.default === 'function' ? d.default() : clone(d.default);
        if (d.type === Date && typeof v === 'number') v = new Date(v);
        out[k] = v;
      }
    } else if (Array.isArray(d)) out[k] = [];
    else if (isObj(d)) {
      const sub = buildDefaults(d);
      if (Object.keys(sub).length) out[k] = sub;
    }
  }
  return out;
}

class Schema {
  constructor(def, options = {}) {
    this.def = def;
    this.options = options;
    this.methods = {};
    this.indexes = [];
    this.paths = new Set(Object.keys(def));
    const ts = options.timestamps;
    this.createdAt = !!ts && (ts === true || ts.createdAt !== false);
    this.updatedAt = !!ts && (ts === true || ts.updatedAt !== false);
    if (this.createdAt) this.paths.add('createdAt');
    if (this.updatedAt) this.paths.add('updatedAt');
    for (const [k, d] of Object.entries(def)) {
      if (isObj(d) && d.unique) this.indexes.push({ fields: { [k]: 1 }, options: { unique: true } });
    }
  }
  index(fields, options = {}) {
    this.indexes.push({ fields, options });
    return this;
  }
  hasPath(p) {
    return p === '_id' || this.paths.has(String(p).split('.')[0]);
  }
}
Schema.Types = { ObjectId };

const vErr = (msg) => {
  const e = new Error(msg);
  e.name = 'ValidationError';
  return e;
};

function validateDoc(data, def, prefix = '') {
  for (const [k, d] of Object.entries(def)) {
    const path = prefix + k;
    const val = data ? data[k] : undefined;
    if (isLeaf(d)) {
      const spec = typeof d === 'function' ? {} : d;
      if (spec.required && (val === undefined || val === null || val === '')) throw vErr(`${path} is required`);
      if (val === undefined || val === null) continue;
      if (spec.type === Number && (typeof val !== 'number' || Number.isNaN(val))) throw vErr(`${path}: cannot cast "${val}" to Number`);
      if (spec.enum && !spec.enum.includes(val)) throw vErr(`${path}: "${val}" is not a valid enum value`);
      if (spec.min !== undefined && typeof val === 'number' && val < spec.min) throw vErr(`${path}: ${val} is below minimum ${spec.min}`);
      if (spec.validate && !spec.validate.validator(val)) throw vErr(`${path}: ${spec.validate.message}`);
    } else if (Array.isArray(d)) {
      if (isObj(d[0]) && !isLeaf(d[0])) for (const item of val || []) validateDoc(item, d[0], `${path}.`);
    } else if (isObj(d)) {
      validateDoc(val, d, `${path}.`);
    }
  }
}

/* -------------------------------- store -------------------------------- */

const db = { docs: {} };
const coll = (name) => db.docs[name];

// Undo log: every write made WITH a session is recorded so a failed transaction can undo exactly its own
// writes (like real MongoDB). A write made without the session is not part of the transaction and is NOT undone.
function logUndo(session, name, id) {
  if (!session || !session._undo) return;
  const prev = coll(name).get(String(id));
  session._undo.push({ name, id: String(id), prev: prev === undefined ? undefined : clone(prev) });
}
function rollback(session) {
  for (const { name, id, prev } of session._undo.reverse()) {
    if (prev === undefined) coll(name).delete(id);
    else coll(name).set(id, prev);
  }
  session._undo = [];
}

function dupErr(name, idx) {
  const e = new Error(`E11000 duplicate key error collection: ${name} index: ${Object.keys(idx.fields).join('_')}`);
  e.code = 11000;
  e.name = 'MongoServerError';
  return e;
}

function assertUnique(name, data, schema, selfId) {
  for (const idx of schema.indexes) {
    if (!idx.options.unique) continue;
    const partial = idx.options.partialFilterExpression;
    if (partial && !matches(data, partial)) continue;
    const keys = Object.keys(idx.fields);
    for (const [id, other] of coll(name)) {
      if (selfId !== undefined && id === String(selfId)) continue;
      if (partial && !matches(other, partial)) continue;
      if (keys.every((k) => norm(getPath(other, k)) === norm(getPath(data, k)))) throw dupErr(name, idx);
    }
  }
}

/* -------------------------------- updates -------------------------------- */

function subDef(schema, path) {
  let node = schema.def;
  for (const seg of String(path).split('.')) node = node && node[seg];
  return Array.isArray(node) ? node[0] : null;
}

function applyUpdate(data, update, schema, { inserting = false, strict = true } = {}) {
  const ok = (p) => !strict || schema.hasPath(p);
  for (const op of Object.keys(update)) {
    const args = update[op];
    switch (op) {
      case '$setOnInsert':
        if (!inserting) break;
      // falls through
      case '$set':
        for (const [p, v] of Object.entries(args)) if (ok(p) && v !== undefined) setPath(data, p, clone(v));
        break;
      case '$inc':
        for (const [p, v] of Object.entries(args)) if (ok(p)) setPath(data, p, (getPath(data, p) || 0) + v);
        break;
      case '$unset':
        for (const p of Object.keys(args)) if (ok(p)) unsetPath(data, p);
        break;
      case '$push':
        for (const [p, v] of Object.entries(args)) {
          if (!ok(p)) continue;
          const arr = getPath(data, p) || [];
          const sub = subDef(schema, p);
          arr.push(sub ? merge(buildDefaults(sub), clone(v)) : clone(v));
          setPath(data, p, arr);
        }
        break;
      default:
        throw new Error(`fake-mongoose: unsupported update operator ${op}`);
    }
  }
}

/* --------------------------------- queries --------------------------------- */

class Query {
  constructor(fn) {
    this._fn = fn;
  }
  session() {
    return this;
  }
  sort(s) {
    this._sort = s;
    return this;
  }
  skip(n) {
    this._skip = n;
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  lean() {
    this._lean = true;
    return this;
  }
  _run() {
    return Promise.resolve().then(() => this._fn(this));
  }
  exec() {
    return this._run();
  }
  then(res, rej) {
    return this._run().then(res, rej);
  }
  catch(rej) {
    return this._run().catch(rej);
  }
}

/* --------------------------------- models --------------------------------- */

const mongoose = { models: {}, Types: { ObjectId }, Schema, __txUnsupported: false };

class Doc {
  constructor(data) {
    Object.assign(this, data);
  }
  get(path) {
    return getPath(this, path);
  }
  toObject() {
    return clone(this);
  }
  toJSON() {
    return this.toObject();
  }
  async save(opts = {}) {
    const M = this.constructor;
    const data = clone(this);
    if (M.schema.updatedAt) data.updatedAt = new Date();
    validateDoc(data, M.schema.def);
    assertUnique(M.modelName, data, M.schema, data._id);
    logUndo(opts.session, M.modelName, data._id);
    coll(M.modelName).set(String(data._id), data);
    if (data.updatedAt) this.updatedAt = data.updatedAt;
    return this;
  }
}

function insert(M, input, session) {
  const schema = M.schema;
  const data = buildDefaults(schema.def);
  const src = {};
  for (const [k, v] of Object.entries(input || {})) if (schema.hasPath(k)) src[k] = v; // strict mode
  merge(data, src);
  if (!data._id) data._id = new ObjectId();
  else if (typeof data._id === 'string') data._id = new ObjectId(data._id);
  const now = new Date();
  if (schema.createdAt) data.createdAt = now;
  if (schema.updatedAt) data.updatedAt = now;
  validateDoc(data, schema.def);
  assertUnique(M.modelName, data, schema);
  logUndo(session, M.modelName, data._id);
  coll(M.modelName).set(String(data._id), data);
  return new M(clone(data));
}

function model(name, schema) {
  if (!schema) {
    if (!mongoose.models[name]) {
      const e = new Error(`Schema hasn't been registered for model "${name}"`);
      e.name = 'MissingSchemaError';
      throw e;
    }
    return mongoose.models[name];
  }
  class M extends Doc {}
  Object.defineProperty(M, 'name', { value: name });
  M.modelName = name;
  M.schema = schema;
  for (const [k, fn] of Object.entries(schema.methods)) M.prototype[k] = fn;

  const rows = (filter) => [...coll(name)].map(([, d], i) => ({ d, i })).filter(({ d }) => matches(d, filter));

  M.create = async (docs, opts = {}) => {
    const arr = Array.isArray(docs) ? docs : [docs];
    const out = arr.map((d) => insert(M, d, opts.session));
    return Array.isArray(docs) ? out : out[0];
  };

  M.findOne = (filter) =>
    new Query(() => {
      const r = rows(filter)[0];
      return r ? new M(clone(r.d)) : null;
    });
  M.findById = (id) => M.findOne({ _id: id });

  M.find = (filter) =>
    new Query((q) => {
      let list = rows(filter);
      if (q._sort) {
        const keys = Object.entries(q._sort);
        list.sort((a, b) => {
          for (const [k, dir] of keys) {
            const x = cmpVal(getPath(a.d, k)) ?? -Infinity;
            const y = cmpVal(getPath(b.d, k)) ?? -Infinity;
            if (x < y) return -dir;
            if (x > y) return dir;
          }
          return keys[0][1] < 0 ? b.i - a.i : a.i - b.i; // stable tiebreak on insertion order
        });
      }
      if (q._skip) list = list.slice(q._skip);
      if (q._limit) list = list.slice(0, q._limit);
      return list.map(({ d }) => (q._lean ? clone(d) : new M(clone(d))));
    });

  M.countDocuments = (filter) => new Query(() => rows(filter).length);

  M.findOneAndUpdate = (filter, update, opts = {}) =>
    new Query(() => {
      const r = rows(filter)[0];
      if (!r) {
        if (!opts.upsert) return null;
        const seed = {};
        for (const [k, v] of Object.entries(filter || {})) {
          if (!k.startsWith('$') && !isOpObject(v)) setPath(seed, k, clone(v));
        }
        applyUpdate(seed, update, schema, { inserting: true });
        const created = insert(M, seed, opts.session);
        return opts.new ? created : null;
      }
      const id = String(r.d._id);
      const before = clone(r.d);
      const after = clone(r.d);
      applyUpdate(after, update, schema);
      if (schema.updatedAt) after.updatedAt = new Date();
      assertUnique(name, after, schema, id);
      logUndo(opts.session, name, id);
      coll(name).set(id, after);
      return new M(clone(opts.new ? after : before));
    });

  M.updateOne = (filter, update, opts = {}) =>
    new Query(() => {
      const r = rows(filter)[0];
      if (!r) return { matchedCount: 0, modifiedCount: 0 };
      const id = String(r.d._id);
      const after = clone(r.d);
      applyUpdate(after, update, schema, { strict: opts.strict !== false });
      if (schema.updatedAt) after.updatedAt = new Date();
      assertUnique(name, after, schema, id);
      logUndo(opts.session, name, id);
      coll(name).set(id, after);
      return { matchedCount: 1, modifiedCount: 1 };
    });

  M.deleteOne = (filter, opts = {}) =>
    new Query(() => {
      const r = rows(filter)[0];
      if (!r) return { deletedCount: 0 };
      logUndo(opts.session, name, r.d._id);
      coll(name).delete(String(r.d._id));
      return { deletedCount: 1 };
    });

  // Only the $match + single $group (_id: null) with $sum shape used by adminSummary
  M.aggregate = (pipeline) =>
    new Query(() => {
      let list = [...coll(name)].map(([, d]) => d);
      for (const stage of pipeline) {
        if (stage.$match) list = list.filter((d) => matches(d, stage.$match));
        else if (stage.$group) {
          if (!list.length) return [];
          const row = { _id: null };
          for (const [k, spec] of Object.entries(stage.$group)) {
            if (k === '_id') continue;
            const expr = spec.$sum;
            row[k] = list.reduce((s, d) => s + (typeof expr === 'number' ? expr : Number(getPath(d, expr.slice(1))) || 0), 0);
          }
          return [row];
        } else throw new Error('fake-mongoose: unsupported pipeline stage');
      }
      return list;
    });

  mongoose.models[name] = M;
  db.docs[name] = new Map();
  return M;
}

mongoose.model = model;
mongoose.isValidObjectId = (v) => v instanceof ObjectId || (typeof v === 'string' && HEX24.test(v));

mongoose.startSession = async () => {
  const session = {
    _undo: [],
    async withTransaction(fn) {
      if (mongoose.__txUnsupported) {
        const e = new Error('Transaction numbers are only allowed on a replica set member or mongos');
        e.code = 20;
        throw e;
      }
      session._undo = [];
      try {
        await fn(session);
      } catch (err) {
        rollback(session); // undo only the writes made with this session
        throw err;
      }
      session._undo = [];
    },
    endSession() {},
  };
  return session;
};

function reset() {
  for (const n of Object.keys(db.docs)) db.docs[n] = new Map();
  mongoose.__txUnsupported = false;
}

module.exports = { mongoose, ObjectId, reset };
