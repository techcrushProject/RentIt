// Runs once on first start of an empty data volume (mongosh, as the root user).
// Creates the least-privilege account the API uses: readWrite on one database only.
const dbName = process.env.MONGO_DB || "rentit";
const user = process.env.MONGO_APP_USER;
const pwd = process.env.MONGO_APP_PASSWORD;

if (!user || !pwd) {
  throw new Error("MONGO_APP_USER and MONGO_APP_PASSWORD must be set");
}

// Copying .env.example without editing it must not produce a database with known passwords.
const weak = (value) => !value || value.length < 16 || /change_?me|replace_?me|password/i.test(value);
if (weak(pwd) || weak(process.env.MONGO_INITDB_ROOT_PASSWORD)) {
  throw new Error("MONGO_APP_PASSWORD and MONGO_ROOT_PASSWORD must be real random values of at least 16 characters");
}

const appDb = db.getSiblingDB(dbName);
appDb.createUser({
  user,
  pwd,
  roles: [{ role: "readWrite", db: dbName }],
});

print(`[init] created app user "${user}" with readWrite on "${dbName}"`);
