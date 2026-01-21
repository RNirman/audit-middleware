require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Gateway, Wallets } = require('fabric-network');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- 1. MOCK USER DATABASE ---
// In a real system, this would be a MongoDB or SQL table.
// We map these application users to the Blockchain Identity "appUser"
const USERS = [
    { username: "sme01", password: "123", role: "SME", name: "Alpha Industries" },
    { username: "auditor01", password: "123", role: "AUDITOR", name: "Big 4 Audit Firm" }
];

// --- 2. SECURITY MIDDLEWARE ---
// This function acts as a guard. It checks if the request has a valid token.
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer TOKEN"

    if (token == null) return res.status(401).json({ error: "Access Denied: No Token" });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Access Denied: Invalid Token" });
        req.user = user; // Save the user info (username, role) into the request
        next();
    });
};

// --- 3. FILE STORAGE CONFIG ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // We will rename this properly inside the route
        cb(null, file.originalname); 
    }
});
const upload = multer({ storage: storage });

// --- 4. BLOCKCHAIN CONNECTION ---
async function connectToNetwork() {
    const walletPath = path.join(process.cwd(), 'wallet');
    const wallet = await Wallets.newFileSystemWallet(walletPath);
    
    const ccpPath = path.resolve(__dirname, 'connection-org1.json');
    const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));

    const gateway = new Gateway();
    await gateway.connect(ccp, {
        wallet,
        identity: 'appUser', // We use one Fabric identity for the prototype
        discovery: { enabled: true, asLocalhost: true }
    });

    const network = await gateway.getNetwork('auditing-channel');
    const contract = network.getContract('audit-cc');

    return { gateway, contract };
}

// --- 5. API ROUTES ---

// LOGIN ROUTE (Public - No Token Needed)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Find user in mock DB
    const user = USERS.find(u => u.username === username && u.password === password);
    
    if (user) {
        // Generate Token
        const token = jwt.sign({ username: user.username, role: user.role }, process.env.JWT_SECRET);
        res.json({ token, role: user.role, name: user.name });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});

// SUBMIT REPORT (Protected: Only logged in users)
app.post('/api/audit', authenticateToken, upload.single('file'), async (req, res) => {
    if (req.user.role !== 'SME') {
        return res.status(403).json({ error: "Only SMEs can submit reports" });
    }

    try {
        const { reportId, companyId, reportHash, period } = req.body;

        // Rename uploaded file
        if (req.file) {
            const oldPath = req.file.path;
            const newPath = path.join('uploads', reportId); 
            fs.renameSync(oldPath, newPath);
        }

        const { gateway, contract } = await connectToNetwork();
        
        console.log(`User ${req.user.username} is submitting report ${reportId}`);
        await contract.submitTransaction('CreateAuditRecord', reportId, companyId, reportHash, period);
        await gateway.disconnect();

        res.status(200).json({ message: 'Success', reportId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// GET ALL AUDITS (Protected)
app.get('/api/audits', authenticateToken, async (req, res) => {
    // Both SMEs and Auditors can see this, but you could restrict it if needed
    try {
        const { gateway, contract } = await connectToNetwork();
        const result = await contract.evaluateTransaction('GetAllAudits');
        await gateway.disconnect();
        res.status(200).json(JSON.parse(result.toString()));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// UPDATE STATUS (Protected: Only Auditors)
app.put('/api/audit/:id/status', authenticateToken, async (req, res) => {
    if (req.user.role !== 'AUDITOR') {
        return res.status(403).json({ error: "Only Auditors can approve/reject" });
    }

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

// DOWNLOAD FILE (Protected)
app.get('/api/audit/:id/download', authenticateToken, (req, res) => {
    const reportId = req.params.id;
    const filePath = path.join(__dirname, 'uploads', reportId);

    if (fs.existsSync(filePath)) {
        res.download(filePath, `Financial_Report_${reportId}.xlsx`);
    } else {
        res.status(404).json({ error: "File not found." });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});