require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Gateway, Wallets } = require('fabric-network');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const crypto = require('crypto'); // Built-in Node.js cryptography library

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- CONSTANTS ---
const ENCRYPTION_KEY = crypto.createHash('sha256').update(String(process.env.FILE_ENCRYPTION_KEY)).digest('base64').substr(0, 32);
const ALGORITHM = 'aes-256-cbc';

// --- MOCK USER DB (Same as before) ---
const USERS = [
    { username: "sme01", password: "123", role: "SME", name: "Alpha Industries" },
    { username: "auditor01", password: "123", role: "AUDITOR", name: "Big 4 Audit Firm" }
];

// --- AUTH MIDDLEWARE (Same as before) ---
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

// --- HELPER: ENCRYPT FILE ---
function encryptFile(buffer) {
    const iv = crypto.randomBytes(16); // Generate random Initialization Vector
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    const result = Buffer.concat([iv, cipher.update(buffer), cipher.final()]);
    return result;
}

// --- HELPER: DECRYPT FILE ---
function decryptFile(buffer) {
    const iv = buffer.slice(0, 16); // Extract the IV from the beginning
    const encryptedText = buffer.slice(16);
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    const result = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
    return result;
}

// --- MULTER CONFIG (Memory Storage) ---
// CRITICAL CHANGE: We switch from 'diskStorage' to 'memoryStorage'.
// We need the file in RAM first so we can encrypt it BEFORE saving to disk.
const upload = multer({ storage: multer.memoryStorage() });

// --- BLOCKCHAIN CONNECTION (Same as before) ---
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

// 1. LOGIN
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = USERS.find(u => u.username === username && u.password === password);
    if (user) {
        const token = jwt.sign({ username: user.username, role: user.role }, process.env.JWT_SECRET);
        res.json({ token, role: user.role, name: user.name });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});

// 2. SUBMIT REPORT (With Encryption)
app.post('/api/audit', authenticateToken, upload.single('file'), async (req, res) => {
    if (req.user.role !== 'SME') return res.status(403).json({ error: "Unauthorized" });

    try {
        const { reportId, companyId, reportHash, period } = req.body;

        // --- ENCRYPTION STEP ---
        if (req.file) {
            const encryptedBuffer = encryptFile(req.file.buffer); // Encrypt the file in RAM
            const savePath = path.join('uploads', reportId);
            
            // Create uploads folder if not exists
            if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
            
            // Save the ENCRYPTED file to disk
            fs.writeFileSync(savePath, encryptedBuffer);
        }

        const { gateway, contract } = await connectToNetwork();
        console.log(`User ${req.user.username} submitted encrypted report ${reportId}`);
        await contract.submitTransaction('CreateAuditRecord', reportId, companyId, reportHash, period);
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
        const result = await contract.evaluateTransaction('GetAllAudits');
        await gateway.disconnect();
        res.status(200).json(JSON.parse(result.toString()));
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

// 5. DOWNLOAD FILE (With Decryption)
app.get('/api/audit/:id/download', authenticateToken, (req, res) => {
    const reportId = req.params.id;
    const filePath = path.join(__dirname, 'uploads', reportId);

    if (fs.existsSync(filePath)) {
        try {
            // Read encrypted file from disk
            const encryptedFile = fs.readFileSync(filePath);
            
            // --- DECRYPTION STEP ---
            const decryptedBuffer = decryptFile(encryptedFile);
            
            // Send decrypted file to user
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(decryptedBuffer);
        } catch (err) {
            console.error("Decryption failed:", err);
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