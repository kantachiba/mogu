const { onRequest } = require("firebase-functions/v2/https");
const app = require("./server");

// Vercel 向けの process.env.VERCEL も考慮しつつ、
// process.env 経由でFirebaseの構成を渡す。
exports.app = onRequest({ region: "asia-northeast1", memory: "512MB" }, app);
