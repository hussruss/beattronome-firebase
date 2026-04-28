#!/bin/bash

# Seed Firestore with test feed data for Beattronome
# Usage: ./scripts/seed_feed_firestore.sh [project_id]
# Default project: beattronome-dev

PROJECT="${1:-beattronome-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/seed-data"

echo "🔥 Seeding Firestore for project: $PROJECT"
echo ""

# Check if firebase CLI is installed
if ! command -v firebase &> /dev/null; then
  echo "❌ Firebase CLI not found. Install with: npm install -g firebase-tools"
  exit 1
fi

echo "📝 Adding posts..."
for file in "$DATA_DIR/posts"/*.json; do
  doc_id=$(basename "$file" .json)
  if firebase firestore:set "posts/$doc_id" @"$file" --project="$PROJECT" > /dev/null 2>&1; then
    echo "  ✅ posts/$doc_id"
  else
    echo "  ⚠️  posts/$doc_id"
  fi
done

echo ""
echo "🎨 Adding banners..."
for file in "$DATA_DIR/banners"/*.json; do
  doc_id=$(basename "$file" .json)
  if firebase firestore:set "banners/$doc_id" @"$file" --project="$PROJECT" > /dev/null 2>&1; then
    echo "  ✅ banners/$doc_id"
  else
    echo "  ⚠️  banners/$doc_id"
  fi
done

echo ""
echo "✅ Test data seeded!"
echo ""
echo "📱 Event map test cases:"
echo "   post_paywall_upgrade      → FeedEventKind.paywall"
echo "   post_profile              → FeedEventKind.route"
echo "   post_rudiment_*           → FeedEventKind.rudiment"
echo "   post_pattern_*            → FeedEventKind.pattern"
echo "   post_session_*            → FeedEventKind.session"
echo "   banner_paywall_sale       → FeedEventKind.paywall"
echo "   banner_youtube            → FeedEventKind.route"
echo "   banner_promo_info         → FeedEventKind.noop"
echo ""
echo "📍 View: https://console.firebase.google.com/project/$PROJECT/firestore/data"
