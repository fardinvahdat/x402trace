import { handle } from "hono/vercel";
import { createDogfoodApp } from "../src/dogfood/app.js";
import { loadServerConfig } from "../src/dogfood/config.js";

export const config = { runtime: "nodejs" };

const app = createDogfoodApp(loadServerConfig());

export default handle(app);
