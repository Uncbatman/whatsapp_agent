const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "chatbot.db");
const db = new Database(DB_PATH);

try {
  // Add the missing metadata_json column to conversation_state table
  db.prepare(
    "ALTER TABLE conversation_state ADD COLUMN metadata_json TEXT",
  ).run();
  console.log(
    "✅ Database patched successfully! 'metadata_json' column added.",
  );
} catch (error) {
  if (error.message.includes("duplicate column name")) {
    console.log("💡 The column already exists.");
  } else {
    console.error("❌ Error patching database:", error.message);
  }
} finally {
  db.close();
}
