const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, required: true, enum: ['SME', 'AUDITOR'] },
    name: { type: String, required: true },
    companyId: { type: String }
});

module.exports = mongoose.model('User', userSchema);