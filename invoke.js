const { Gateway, Wallets } = require('fabric-network');
const fs = require('fs');
const path = require('path');

async function main() {
    try {
        // 1. Setup
        const ccpPath = path.resolve(__dirname, 'connection-org1.json');
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));
        const walletPath = path.join(process.cwd(), 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);

        // 2. Connect to Gateway
        const gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: 'appUser',
            discovery: { enabled: true, asLocalhost: true } 
        });

        // 3. Get the Channel and Contract
        // Note: We are now using 'audit-cc', not 'basic'
        const network = await gateway.getNetwork('auditing-channel');
        const contract = network.getContract('audit-cc');

        console.log('Connected to channel. Submitting transaction...');

        // 4. Submit Transaction (CreateAuditRecord)
        const reportId = `REP_${Date.now()}`;
        console.log(`Submitting Audit Record: ${reportId}`);

        // Arguments: ID, CompanyID, ReportHash, AuditPeriod
        await contract.submitTransaction('CreateAuditRecord', reportId, 'SME_SriLanka_01', 'hash_of_excel_file_123', 'Nov-2025');
        
        console.log(`Transaction has been submitted: Record ${reportId} created.`);

        // 5. Query to verify (ReadAuditRecord)
        // Note: Changed from 'ReadAsset' to 'ReadAuditRecord'
        const result = await contract.evaluateTransaction('ReadAuditRecord', reportId);
        console.log(`Query Result: ${result.toString()}`);

        // 6. Disconnect
        await gateway.disconnect();

    } catch (error) {
        console.error(`Failed to submit transaction: ${error}`);
        process.exit(1);
    }
}

main();