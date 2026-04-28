#!/usr/bin/env node

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const projectId = process.argv[2] || 'beattronome-dev';

admin.initializeApp({ projectId });
const db = admin.firestore();

async function seedCollection(collectionName) {
  const dir = path.join(__dirname, `seed-data/${collectionName}`);

  if (!fs.existsSync(dir)) {
    console.log(`⚠️  Directory not found: ${dir}`);
    return;
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  console.log(`\n📝 Seeding ${collectionName}...`);

  for (const file of files) {
    const docId = path.basename(file, '.json');
    const filePath = path.join(dir, file);

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      await db.collection(collectionName).doc(docId).set(data);
      console.log(`  ✅ ${collectionName}/${docId}`);
    } catch (error) {
      console.log(`  ❌ ${collectionName}/${docId} - ${error.message}`);
    }
  }
}

async function main() {
  console.log(`🔥 Seeding Firestore for project: ${projectId}\n`);

  try {
    await seedCollection('posts');
    await seedCollection('banners');

    console.log('\n✅ Seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
