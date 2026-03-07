import app, { server } from "./app.js";
import { verifySupabaseConnection } from "./db_connection.js";

const PORT = Number(process.env.PORT) || 3001;

verifySupabaseConnection().then((r) => {
  if (!r.ok) console.warn("Supabase:", r.error);
});

server.listen(PORT, () => {
  console.log(`Smart Menu & Ordering API listening on http://localhost:${PORT}`);
});
