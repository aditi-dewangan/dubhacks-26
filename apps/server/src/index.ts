import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { config } from "./config.ts";
import { setIo, type IoServer } from "./realtime/io.ts";
import { loadPreviousEvents } from "./realtime/log.ts";
import { registerSocketHandlers } from "./realtime/socket.ts";
import { routes } from "./routes.ts";

// Hackathon default: reflect any origin (the phone app may run on ngrok or a preview URL).
// Set CORS_ORIGINS to lock it down.
const origin = config.corsOrigins?.length && !config.corsOrigins.includes("*") ? config.corsOrigins : true;

const app = express();
app.use(cors({ origin }));
app.use(express.json({ limit: "100kb" }));
app.use(routes);

const httpServer = createServer(app);
const io: IoServer = new Server(httpServer, { cors: { origin } });
setIo(io);
registerSocketHandlers(io);

await loadPreviousEvents();
httpServer.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  console.log(`[server] phone app URL in QR codes: ${config.phoneAppUrl}`);
  if (config.devRoutes) console.log("[server] dev routes enabled");
});
