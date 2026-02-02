const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 1. CONFIGURATION
const SERVICE_ACCOUNT_KEY_PATH = './service-account-key.json';
const DATA_FILE_PATH = '../../assets/data/patterns.json';
const COLLECTION_NAME = 'patterns'; // Using a separate collection for patterns

async function uploadPatterns() {
    const projectId = process.argv[2];

    if (!projectId && !fs.existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
        console.error('Error: Please provide the project ID as an argument.');
        console.error('Usage: node upload_patterns.js <project-id>');
        process.exit(1);
    }

    if (fs.existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
        const serviceAccount = require(SERVICE_ACCOUNT_KEY_PATH);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Using Service Account Key.');
    } else {
        console.log(`Service account key not found. Trying ADC for project: ${projectId}...`);
        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            projectId: projectId
        });
    }

    const db = admin.firestore();

    try {
        const dataPath = path.join(__dirname, DATA_FILE_PATH);
        const patterns = JSON.parse(fs.readFileSync(dataPath));

        console.log(`Found ${patterns.length} patterns in JSON file.`);

        for (const pattern of patterns) {
            const id = pattern.id;
            await db.collection(COLLECTION_NAME).doc(id).set(pattern, { merge: true });
            console.log(`Uploaded pattern: ${pattern.name} (${id})`);
        }

        console.log(`Successfully uploaded to ${COLLECTION_NAME}.`);

    } catch (error) {
        console.error('Error uploading patterns:', error);
    } finally {
        process.exit(0);
    }
}

uploadPatterns();
