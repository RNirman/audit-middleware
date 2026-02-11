const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
    reportId: { type: String, required: true },
    senderName: { type: String, required: true },
    role: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Comment', commentSchema);