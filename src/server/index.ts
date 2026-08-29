import { openDb } from '../db/client.js';
import { createApp } from './app.js';

const db = openDb();
const app = createApp(db);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`workout-logger listening on http://localhost:${port}`);
});
