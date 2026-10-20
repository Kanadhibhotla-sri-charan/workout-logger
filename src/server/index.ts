import { openDb } from '../db/client.js';
import { createApp } from './app.js';
import { startCalorieSync } from '../services/calorieTrackerSync.js';

const db = openDb();
const app = createApp(db);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`workout-logger listening on http://localhost:${port}`);
  // Calorie Tracker sync: on only when CALORIE_SYNC_TOKEN is set.
  const sync = startCalorieSync(db);
  console.log(sync ? '[calorie-sync] on' : '[calorie-sync] off (no CALORIE_SYNC_TOKEN)');
});
