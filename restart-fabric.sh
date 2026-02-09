#!/bin/bash

# --- STEP 0: Ensure MongoDB is running ---
echo "Checking MongoDB..."
if [ ! "$(docker ps -q -f name=mongodb)" ]; then
    if [ "$(docker ps -aq -f name=mongodb)" ]; then
        echo "   Restarting existing MongoDB..."
        docker start mongodb
    else
        echo "   Starting new MongoDB with persistent volume..."
        docker run -d -p 27017:27017 --name mongodb -v mongo_data:/data/db mongo:latest
    fi
else
    echo "   MongoDB is already running."
fi

# --- STEP 1: Fix Windows Networking (WSL2 Bug) ---
echo "Requesting Windows Admin access to reset Network (Fixing 'winnat')..."
echo "Click 'Yes' on the popup window..."

# This command calls PowerShell as an Admin to restart the service
powershell.exe -Command "Start-Process powershell -Verb RunAs -ArgumentList 'net stop winnat; net start winnat'"

# Wait a few seconds for the network to reset
echo "Waiting 5 seconds for Windows network to come back..."
sleep 5

# --- STEP 2: Navigate to Test Network ---
echo "Navigate to Test Network..."
cd ../fabric-samples/test-network

# --- STEP 3: Reset Blockchain Network ---
echo "Taking down the old network..."
./network.sh down

echo "Starting new network and channel 'auditing-channel'..."
./network.sh up createChannel -c auditing-channel -ca -s couchdb

# --- STEP 4: Deploy Chaincode ---
echo "Deploying 'audit-cc' chaincode..."
./network.sh deployCC -ccn audit-cc -ccp ../asset-transfer-basic/chaincode-audit -ccl go -c auditing-channel

# --- STEP 5: Prepare Middleware ---
echo "Returning to Middleware folder..."
cd ../../audit-middleware

echo "Cleaning up old wallet and connection profile..."
rm -rf wallet
rm connection-org1.json

# --- STEP 6: Copy & Fix Connection Profile (WSL2 Specific) ---
echo "Copying new connection-org1.json..."
cp ../fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/connection-org1.json .

# CRITICAL FIX: Change 'localhost' to '127.0.0.1' to prevent Node.js connection errors in WSL
echo "Patching connection profile for WSL2..."
sed -i 's/localhost/127.0.0.1/g' connection-org1.json
sed -i 's/"url": "grpcs:\/\/127.0.0.1:/"url": "grpcs:\/\/localhost:/g' connection-org1.json
# Note: We only want to replace the CA/Peer addresses, not necessarily the protocol, 
# but usually a global replace of localhost -> 127.0.0.1 is safe for the SDK.
# If the line above causes issues, use this simpler version:
# sed -i 's/localhost/127.0.0.1/g' connection-org1.json

# --- STEP 7: Re-issue Credentials ---
echo "Enrolling Admin..."
node enrollAdmin.js

echo "Registering User..."
node registerUser.js

echo "DONE! Network restarted, Winnat reset, and Wallet refreshed."
echo "You can now run 'node server.js'"
