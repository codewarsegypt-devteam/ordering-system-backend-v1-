import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { Server } from "socket.io";
import http from "http";
import { errorHandler } from "./middleware/errorHandler.js";
import {
  authRoutes,
  merchantsRoutes,
  branchesRoutes,
  tablesRoutes,
  usersRoutes,
  menusRoutes,
  categoriesRoutes,
  itemsRoutes,
  variantsRoutes,
  modifiersRoutes,
  publicRoutes,
  ordersRoutes,
  tableSessionsRoutes,
  kitchenRoutes,
  cashierRoutes,
  statsRoutes,
  tableServicesRoutes,
  currenciesRoutes,
} from "./routes/index.js";

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = new Set([
  "https://www.qrixa.net",
  "https://ordering-system-frontend-v1.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
]);

const corsOptions = {
  origin(origin, cb) {
    // Allow non-browser clients (Postman, curl) with no Origin header
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
};

const io = new Server(server, {
  cors: corsOptions,
});

app.set("io", io);

io.on("connection", (socket) => {
  console.log("a user connected", socket.id);
  socket.on("disconnect", () => {
    console.log("a user disconnected", socket.id);
  });
  socket.on("join:branch", (branchId) => {
    if (branchId) socket.join(`branch:${branchId}`);
  });
});

app.use(cors(corsOptions));
app.use(morgan("dev"));
app.use(express.json());

// Public
app.use("/auth", authRoutes);
app.use("/public", publicRoutes);
app.use("/orders", ordersRoutes);
app.use("/table-sessions", tableSessionsRoutes);

// Staff (auth required on routers)
app.use("/merchants", merchantsRoutes);
app.use("/branches", branchesRoutes);
app.use("/tables", tablesRoutes);
app.use("/users", usersRoutes);
app.use("/menus", menusRoutes);
app.use("/categories", categoriesRoutes);

app.use("/", variantsRoutes);
app.use("/", modifiersRoutes);
app.use("/", itemsRoutes);

app.use("/kitchen", kitchenRoutes);
app.use("/cashier", cashierRoutes);
app.use("/stats", statsRoutes);
app.use("/table-services", tableServicesRoutes);
app.use("/currencies", currenciesRoutes);

app.get("/health", (req, res) => res.json({ ok: true }));

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);

export default app;
export { server };
