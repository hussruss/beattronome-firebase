const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 1. CONFIGURATION
// Path to your Service Account Key JSON file
// Download from Firebase Console -> Project Settings -> Service accounts
const SERVICE_ACCOUNT_KEY_PATH = './service-account-key.json';

// Path to your data JSON file
const DATA_FILE_PATH = '../../assets/data/rudiments.json';

// Collection name in Firestore
const COLLECTION_NAME = 'rudiments';

async function uploadData() {
    // Get project ID from command line argument
    const projectId = process.argv[2];

    if (!projectId && !fs.existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
        console.error('Error: Please provide the project ID as an argument.');
        console.error('Usage: node upload.js <project-id>');
        process.exit(1);
    }

    // Initialize Firebase Admin
    // 1. Try Service Account Key
    if (fs.existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
        const serviceAccount = require(SERVICE_ACCOUNT_KEY_PATH);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Using Service Account Key.');
    } else {
        // 2. Try Application Default Credentials (ADC)
        // Requires running: gcloud auth application-default login
        console.log(`Service account key not found. Trying Application Default Credentials for project: ${projectId}...`);
        try {
            admin.initializeApp({
                credential: admin.credential.applicationDefault(),
                projectId: projectId // Explicitly set project ID
            });
            console.log('Using Application Default Credentials.');
        } catch (e) {
            console.error('Error initializing with ADC. Make sure you have run "gcloud auth application-default login" or provide a service-account-key.json.');
            process.exit(1);
        }
    }

    const db = admin.firestore();

    try {
        // Read data file
        const dataPath = path.join(__dirname, DATA_FILE_PATH);
        if (!fs.existsSync(dataPath)) {
            console.error(`Error: Data file not found at ${dataPath}`);
            process.exit(1);
        }

        const rawData = fs.readFileSync(dataPath);
        const rudiments = JSON.parse(rawData);

        if (!Array.isArray(rudiments)) {
            console.error('Error: JSON data must be an array of objects.');
            process.exit(1);
        }

        console.log(`Found ${rudiments.length} rudiments in JSON file.`);

        // Fetch existing document IDs to determine create vs update
        const existingDocs = await db.collection(COLLECTION_NAME).listDocuments();
        const existingIds = new Set(existingDocs.map(doc => doc.id));
        console.log(`Found ${existingIds.size} existing documents in Firestore.`);

        // Batch upload
        let batch = db.batch();
        let operationCount = 0;
        let totalUploaded = 0;
        let totalCreated = 0;
        let totalUpdated = 0;

        for (const rudiment of rudiments) {
            // Use existing ID or generate one
            const id = rudiment.id || db.collection(COLLECTION_NAME).doc().id;
            const docRef = db.collection(COLLECTION_NAME).doc(id);

            // Ensure ID is in the object
            if (!rudiment.id) {
                rudiment.id = id;
            }

            if (existingIds.has(id)) {
                // Update: remove rate and downloadCount to avoid overwriting them
                const updateData = { ...rudiment };
                delete updateData.rate;
                delete updateData.downloadCount;

                batch.set(docRef, updateData, { merge: true });
                totalUpdated++;
            } else {
                // Create: upload all data
                batch.set(docRef, rudiment);
                totalCreated++;
            }

            operationCount++;

            // Commit batch if limit reached (500)
            if (operationCount >= 499) {
                await batch.commit();
                totalUploaded += operationCount;
                console.log(`Committed batch of ${operationCount} operations.`);
                batch = db.batch();
                operationCount = 0;
            }
        }

        // Commit remaining
        if (operationCount > 0) {
            await batch.commit();
            totalUploaded += operationCount;
            console.log(`Committed final batch of ${operationCount} operations.`);
        }

        console.log(`Process complete:`);
        console.log(`- Total operations: ${totalUploaded}`);
        console.log(`- New documents created: ${totalCreated}`);
        console.log(`- Existing documents updated (preserving fields): ${totalUpdated}`);

        console.log(`Successfully uploaded ${totalUploaded} rudiments to ${COLLECTION_NAME}.`);

    } catch (error) {
        console.error('Error uploading data:', error);
    } finally {
        process.exit(0);
    }
}

uploadData();
