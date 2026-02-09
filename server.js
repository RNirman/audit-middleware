require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Gateway, Wallets } = require('fabric-network');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- 1. CONNECT TO MONGODB ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- 2. SEED DATABASE (One-time setup) ---
// This ensures you always have users to test with
const initDB = async () => {
    try {
        const count = await User.countDocuments();
        if (count === 0) {
            console.log("⚠️ No users found. Seeding database...");
            await User.create([
                { username: "admin", password: "admin123", role: "ADMIN", name: "System Administrator" },
                { username: "sme01", password: "123", role: "SME", name: "Alpha Industries", companyId: "SME_ALPHA" },
                { username: "auditor01", password: "123", role: "AUDITOR", name: "Big 4 Audit Firm" }
            ]);
            console.log("✅ Database seeded with default users.");
        }
    } catch (err) {
        console.error("Seeding failed:", err);
    }
};
initDB();

// --- CONSTANTS ---
const ENCRYPTION_KEY = crypto.createHash('sha256').update(String(process.env.FILE_ENCRYPTION_KEY)).digest('base64').substr(0, 32);
const ALGORITHM = 'aes-256-cbc';

// --- AUTH MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.status(401).json({ error: "Access Denied" });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid Token" });
        req.user = user;
        next();
    });
};

// --- CRYPTO HELPERS ---
function encryptFile(buffer) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    return Buffer.concat([iv, cipher.update(buffer), cipher.final()]);
}

function decryptFile(buffer) {
    const iv = buffer.slice(0, 16);
    const encryptedText = buffer.slice(16);
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]);
}

const upload = multer({ storage: multer.memoryStorage() });

// --- BLOCKCHAIN CONNECTION ---
async function connectToNetwork() {
    const walletPath = path.join(process.cwd(), 'wallet');
    const wallet = await Wallets.newFileSystemWallet(walletPath);
    const ccpPath = path.resolve(__dirname, 'connection-org1.json');
    const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));
    const gateway = new Gateway();
    await gateway.connect(ccp, { wallet, identity: 'appUser', discovery: { enabled: true, asLocalhost: true } });
    const network = await gateway.getNetwork('auditing-channel');
    const contract = network.getContract('audit-cc');
    return { gateway, contract };
}

// --- API ROUTES ---

// 1. LOGIN (UPDATED for MongoDB)
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Find user in DB
        const user = await User.findOne({ username });

        // Check password (Plain text for prototype)
        if (user && user.password === password) {
            const token = jwt.sign({
                username: user.username,
                role: user.role,
                companyId: user.companyId
            }, process.env.JWT_SECRET);

            res.json({ token, role: user.role, name: user.name });
        } else {
            res.status(401).json({ error: "Invalid credentials" });
        }
    } catch (error) {
        res.status(500).json({ error: "Login failed" });
    }
});

// 2. SUBMIT REPORT (Unchanged logic, just ensure imports match)
app.post('/api/audit', authenticateToken, upload.single('file'), async (req, res) => {
    if (req.user.role !== 'SME') return res.status(403).json({ error: "Unauthorized" });
    
    try {
        const { reportId, department, period } = req.body;

        // SECURITY FIX: Ignore the 'companyId' sent from frontend.
        // Instead, look up the REAL companyId from the database using the logged-in user.
        const user = await User.findOne({ username: req.user.username });
        const companyId = user.companyId; // <--- The Source of Truth

        if (!companyId) {
            return res.status(400).json({ error: "User has no Company ID assigned." });
        }

        // 3. Handle File Upload (Encryption)
        if (req.file) {
            const encryptedBuffer = encryptFile(req.file.buffer);
            const savePath = path.join('uploads', reportId);
            if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
            fs.writeFileSync(savePath, encryptedBuffer);
        }

        // 4. Submit to Blockchain
        const { gateway, contract } = await connectToNetwork();
        console.log(`User ${req.user.username} submitted report ${reportId}`);

        await contract.submitTransaction('CreateAuditRecord', reportId, companyId, department, reportHash, period);

        await gateway.disconnect();

        res.status(200).json({ message: 'Success', reportId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 3. GET AUDITS
app.get('/api/audits', authenticateToken, async (req, res) => {
    try {
        const { gateway, contract } = await connectToNetwork();
        const resultBuffer = await contract.evaluateTransaction('GetAllAudits');
        const allAudits = JSON.parse(resultBuffer.toString());
        await gateway.disconnect();

        // FILTERING LOGIC
        if (req.user.role === 'SME') {
            // SME only sees their own Company's reports
            // We need to look up the SME's CompanyID from the User DB first
            const user = await User.findOne({ username: req.user.username });
            const myAudits = allAudits.filter(a => a.companyId === user.companyId);
            return res.json(myAudits);
        }

        // Auditors/Admins see EVERYTHING
        res.json(allAudits);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. UPDATE STATUS
app.put('/api/audit/:id/status', authenticateToken, async (req, res) => {
    if (req.user.role !== 'AUDITOR') return res.status(403).json({ error: "Unauthorized" });
    try {
        const { status } = req.body;
        const reportId = req.params.id;
        const { gateway, contract } = await connectToNetwork();
        await contract.submitTransaction('VerifyAuditRecord', reportId, status);
        await gateway.disconnect();
        res.status(200).json({ message: `Status updated to ${status}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. DOWNLOAD
app.get('/api/audit/:id/download', authenticateToken, (req, res) => {
    const reportId = req.params.id;
    const filePath = path.join(__dirname, 'uploads', reportId);

    if (fs.existsSync(filePath)) {
        try {
            const encryptedFile = fs.readFileSync(filePath);
            const decryptedBuffer = decryptFile(encryptedFile);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(decryptedBuffer);
        } catch (err) {
            res.status(500).json({ error: "Failed to decrypt file." });
        }
    } else {
        res.status(404).json({ error: "File not found." });
    }
});

// 6. HISTORY
app.get('/api/audit/:id/history', authenticateToken, async (req, res) => {
    try {
        const reportId = req.params.id;
        const { gateway, contract } = await connectToNetwork();
        const result = await contract.evaluateTransaction('GetAuditHistory', reportId);
        await gateway.disconnect();
        res.status(200).json(JSON.parse(result.toString()));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// 7. CREATE NEW USER (Protected: Only ADMIN can call this)
app.post('/api/users', authenticateToken, async (req, res) => {
    // Security Check: Is the requester an Admin?
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: "Access Denied: Admin only." });
    }

    try {
        const { username, password, role, name, companyId } = req.body;

        // Check if user already exists
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "Username already exists" });

        // Create user
        await User.create({ username, password, role, name, companyId });

        console.log(`Admin ${req.user.username} created new user: ${username}`);
        res.status(201).json({ message: "User created successfully" });
    } catch (error) {
        res.status(500).json({ error: "Error creating user" });
    }
});

// 8. GET ALL USERS (Admin Only)
app.get('/api/users', authenticateToken, async (req, res) => {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Admin only" });

    try {
        // Return users but HIDE passwords!
        const users = await User.find({}, '-password');
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

// 9. DELETE USER (Admin Only)
app.delete('/api/users/:username', authenticateToken, async (req, res) => {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Admin only" });

    try {
        await User.deleteOne({ username: req.params.username });
        res.json({ message: "User deleted" });
    } catch (error) {
        res.status(500).json({ error: "Delete failed" });
    }
});