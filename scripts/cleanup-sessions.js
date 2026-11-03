const admin = require("firebase-admin");

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const DRY_RUN = process.env.CLEANUP_DRY_RUN === "true";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

if (!DATABASE_URL) throw new Error("Missing FIREBASE_DATABASE_URL");
if (!serviceAccountJson) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJson);
} catch {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL
});

function sessionCreatedAt(key, value) {
  if (Number.isFinite(Number(value && value.createdAt))) return Number(value.createdAt);
  const match = /^pink_(\d{13})_/.exec(key);
  return match ? Number(match[1]) : null;
}

function shouldDelete(key, value, now) {
  if (!value || typeof value !== "object") return false;
  const createdAt = sessionCreatedAt(key, value);
  const status = String(value.status || "").toLowerCase();
  const updatedAt = Number(value.updatedAt) || createdAt;

  if (status === "completed") {
    const completedAt = Number(value.completedAt) || updatedAt;
    return Number.isFinite(completedAt) && now - completedAt >= DAY;
  }
  if (status === "uploaded" || status === "received" || value.image || value.url) {
    const activityAt = status === "received"
      ? (Number(value.receivedAt) || updatedAt)
      : updatedAt;
    return Number.isFinite(activityAt) && now - activityAt >= 2 * HOUR;
  }
  if (!status || status === "waiting" || status === "expired") {
    return Number.isFinite(createdAt) && now - createdAt >= 10 * MINUTE;
  }
  return false;
}

async function main() {
  const sessionsRef = admin.database().ref("sessions");
  const snapshot = await sessionsRef.once("value");
  let scanned = 0;
  let eligible = 0;
  let deleted = 0;

  if (!snapshot.exists()) {
    console.log("QR cleanup: no sessions found.");
    return;
  }

  const keys = [];
  snapshot.forEach(child => {
    if (child.key && child.key.startsWith("pink_")) {
      scanned++;
      keys.push(child.key);
    }
  });

  if (DRY_RUN) {
    for (const key of keys) {
      if (shouldDelete(key, snapshot.child(key).val(), Date.now())) eligible++;
    }
    console.log("QR cleanup DRY RUN: scanned=" + scanned + ", eligible=" + eligible + ", deleted=0");
    return;
  }

  // Re-check each record inside a transaction so a concurrent upload/acknowledgement is not deleted.
  for (const key of keys) {
    const ref = sessionsRef.child(key);
    const result = await ref.transaction(current => {
      if (!shouldDelete(key, current, Date.now())) return;
      return null;
    }, undefined, false);
    if (result.committed && result.snapshot.val() === null) deleted++;
  }

  console.log("QR cleanup: scanned=" + scanned + ", deleted=" + deleted);
}

main()
  .then(() => admin.app().delete())
  .catch(async error => {
    console.error("QR cleanup failed:", error.message);
    try { await admin.app().delete(); } catch {}
    process.exitCode = 1;
  });
