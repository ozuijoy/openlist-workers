import app from "./index"
import { OpenListDB } from "./durable-objects/OpenListDB"

// Durable Object 類（DB_DRIVER=do 時使用），需在 wrangler.toml 聲明
// new_sqlite_classes = ["OpenListDB"] 與對應的 binding。
export { OpenListDB }

export default {
  fetch: app.fetch,
}
