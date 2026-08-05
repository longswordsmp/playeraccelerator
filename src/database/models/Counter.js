'use strict';

/**
 * Atomic sequence generator.
 *
 * Ticket numbers, order numbers and review numbers must never collide, even
 * when two customers click "Create Ticket" in the same millisecond. A
 * `findOneAndUpdate` with `$inc` is atomic at the document level, which gives a
 * gap-free, race-free counter without transactions.
 */

const { Schema, model } = require('mongoose');

const counterSchema = new Schema(
  {
    /** Composite key: `${guildId}:${name}` */
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

/**
 * Reserve the next value in a sequence.
 * @param {string} guildId
 * @param {string} name e.g. 'ticket' | 'order' | 'review'
 * @returns {Promise<number>}
 */
counterSchema.statics.next = async function next(guildId, name) {
  const doc = await this.findOneAndUpdate(
    { _id: `${guildId}:${name}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return doc.seq;
};

/**
 * Read a sequence without consuming a value.
 * @param {string} guildId
 * @param {string} name
 */
counterSchema.statics.peek = async function peek(guildId, name) {
  const doc = await this.findById(`${guildId}:${name}`).lean();
  return doc?.seq ?? 0;
};

module.exports = model('Counter', counterSchema);
