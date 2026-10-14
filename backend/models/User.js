import mongoose from 'mongoose';

export const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'police', 'hospital', 'ambulance'], required: true },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

export const Admin = mongoose.models.Admin || mongoose.model('Admin', userSchema, 'admins');
export const Police = mongoose.models.Police || mongoose.model('Police', userSchema, 'police');
export const Hospital = mongoose.models.Hospital || mongoose.model('Hospital', userSchema, 'hospitals');
export const Ambulance = mongoose.models.Ambulance || mongoose.model('Ambulance', userSchema, 'ambulances');

export function getModelByRole(role) {
  if (role === 'admin') return Admin;
  if (role === 'police') return Police;
  if (role === 'hospital') return Hospital;
  if (role === 'ambulance') return Ambulance;
  return null;
}

export const ALL_MODELS = [Admin, Police, Hospital, Ambulance];

const User = {
  schema: userSchema,
  Admin,
  Police,
  Hospital,
  Ambulance,
  getModelByRole,
  ALL_MODELS,

  async findOne(query = {}) {
    if (query.role && typeof query.role === 'string') {
      const model = getModelByRole(query.role);
      if (model) return model.findOne(query);
    }
    for (const Model of ALL_MODELS) {
      const doc = await Model.findOne(query);
      if (doc) return doc;
    }
    return null;
  },

  findById(id) {
    let selectFields = null;
    let isLean = false;

    const execute = async () => {
      for (const Model of ALL_MODELS) {
        let q = Model.findById(id);
        if (selectFields) q = q.select(selectFields);
        if (isLean) q = q.lean();
        const doc = await q;
        if (doc) return doc;
      }
      return null;
    };

    const chainable = {
      select(fields) {
        selectFields = fields;
        return chainable;
      },
      lean() {
        isLean = true;
        return chainable;
      },
      exec() {
        return execute();
      },
      then(onFulfilled, onRejected) {
        return execute().then(onFulfilled, onRejected);
      },
      catch(onRejected) {
        return execute().catch(onRejected);
      }
    };

    return chainable;
  },

  find(query = {}) {
    let isLean = false;
    let selectFields = null;

    const execute = async () => {
      if (query.role && typeof query.role === 'string') {
        const model = getModelByRole(query.role);
        if (!model) return [];
        let q = model.find(query);
        if (selectFields) q = q.select(selectFields);
        if (isLean) q = q.lean();
        return await q;
      }
      if (query.role && typeof query.role === 'object' && Array.isArray(query.role.$in)) {
        const results = [];
        for (const r of query.role.$in) {
          const model = getModelByRole(r);
          if (model) {
            let q = model.find(query);
            if (selectFields) q = q.select(selectFields);
            if (isLean) q = q.lean();
            const docs = await q;
            results.push(...docs);
          }
        }
        return results;
      }
      const results = [];
      for (const Model of ALL_MODELS) {
        let q = Model.find(query);
        if (selectFields) q = q.select(selectFields);
        if (isLean) q = q.lean();
        const docs = await q;
        results.push(...docs);
      }
      return results;
    };

    const chainable = {
      select(fields) {
        selectFields = fields;
        return chainable;
      },
      lean() {
        isLean = true;
        return chainable;
      },
      exec() {
        return execute();
      },
      then(onFulfilled, onRejected) {
        return execute().then(onFulfilled, onRejected);
      },
      catch(onRejected) {
        return execute().catch(onRejected);
      }
    };

    return chainable;
  },

  async exists(query = {}) {
    if (query.role && typeof query.role === 'string') {
      const model = getModelByRole(query.role);
      return model ? model.exists(query) : null;
    }
    for (const Model of ALL_MODELS) {
      const ex = await Model.exists(query);
      if (ex) return ex;
    }
    return null;
  },

  async create(doc) {
    if (Array.isArray(doc)) {
      return Promise.all(doc.map((d) => User.create(d)));
    }
    const model = getModelByRole(doc.role);
    if (!model) throw new Error(`Invalid role: ${doc.role}`);
    return model.create(doc);
  },

  async findOneAndUpdate(query = {}, update = {}, options = {}) {
    if (query.role && typeof query.role === 'string') {
      const model = getModelByRole(query.role);
      if (model) return model.findOneAndUpdate(query, update, options);
    }
    for (const Model of ALL_MODELS) {
      const found = await Model.findOne(query);
      if (found) {
        return Model.findOneAndUpdate(query, update, options);
      }
    }
    const role = update?.role || update?.$set?.role;
    if (role && typeof role === 'string') {
      const model = getModelByRole(role);
      if (model) return model.findOneAndUpdate(query, update, options);
    }
    return null;
  },

  async deleteMany(query = {}) {
    if (query.role && typeof query.role === 'string') {
      const model = getModelByRole(query.role);
      return model ? model.deleteMany(query) : { acknowledged: true, deletedCount: 0 };
    }
    let deletedCount = 0;
    for (const Model of ALL_MODELS) {
      const res = await Model.deleteMany(query);
      deletedCount += res.deletedCount || 0;
    }
    return { acknowledged: true, deletedCount };
  },

  async countDocuments(query = {}) {
    if (query.role && typeof query.role === 'string') {
      const model = getModelByRole(query.role);
      return model ? model.countDocuments(query) : 0;
    }
    let count = 0;
    for (const Model of ALL_MODELS) {
      count += await Model.countDocuments(query);
    }
    return count;
  }
};

export default User;