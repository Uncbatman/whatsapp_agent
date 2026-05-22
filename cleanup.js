const fs = require("fs");
const path = require("path");

const files = [
  path.join(__dirname, "chatbot.db"),
  path.join(__dirname, "chatbot.db-shm"),
  path.join(__dirname, "chatbot.db-wal"),
];

files.forEach((file) => {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log(`✅ Deleted: ${file}`);
  }
});

console.log("✅ Cleanup complete");
