'use strict';

/**
 * Portfolio entry — a published case study for delivered work.
 */

const { Schema, model } = require('mongoose');

const portfolioSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    number: { type: Number, required: true },

    title: { type: String, required: true, maxlength: 150 },
    category: { type: String, required: true, index: true },
    description: { type: String, default: '', maxlength: 2000 },
    technologies: [{ type: String }],

    /** Media — first image becomes the embed image. */
    images: [{ type: String }],
    videoUrl: { type: String, default: '' },
    githubUrl: { type: String, default: '' },
    demoUrl: { type: String, default: '' },

    /** Attribution. */
    customerId: { type: String, default: '' },
    customerName: { type: String, default: '' },
    /** Publishing requires explicit customer consent when configured. */
    customerPermission: { type: Boolean, default: false },
    anonymised: { type: Boolean, default: false },

    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    orderNumber: { type: Number, default: null },

    completedAt: { type: Date, default: Date.now },
    addedBy: { type: String, default: '' },
    addedByName: { type: String, default: '' },

    featured: { type: Boolean, default: false, index: true },
    published: { type: Boolean, default: true, index: true },
    /** Lower sorts first in the showcase. */
    sortOrder: { type: Number, default: 0 },

    publishedChannelId: { type: String, default: '' },
    publishedMessageId: { type: String, default: '' },
    views: { type: Number, default: 0 },
  },
  { timestamps: true },
);

portfolioSchema.index({ guildId: 1, number: 1 }, { unique: true });
portfolioSchema.index({ guildId: 1, published: 1, featured: -1, sortOrder: 1, completedAt: -1 });

portfolioSchema.virtual('display').get(function display() {
  return `#${String(this.number).padStart(3, '0')}`;
});

/** Published entries in showcase order. */
portfolioSchema.statics.showcase = function showcase(guildId, { category, limit = 25 } = {}) {
  const query = { guildId, published: true };
  if (category) query.category = category;
  return this.find(query).sort({ featured: -1, sortOrder: 1, completedAt: -1 }).limit(limit).lean();
};

module.exports = model('Portfolio', portfolioSchema);
