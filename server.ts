import express from "express";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize database
let db: any;
try {
  const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/edureview.db' : 'edureview.db';
  // Copy initial DB if it exists and we're in production (Vercel)
  if (process.env.NODE_ENV === 'production' && !fs.existsSync(dbPath) && fs.existsSync('edureview.db')) {
    fs.copyFileSync('edureview.db', dbPath);
  }
  db = new Database(dbPath);
  console.log(`Database connected at ${dbPath}`);
} catch (error) {
  console.error("Failed to connect to database:", error);
  // Fallback to in-memory database if file-based fails
  console.log("Falling back to in-memory database...");
  db = new Database(':memory:');
}

// Initialize database schema
try {
  console.log("Initializing database schema...");
  db.exec(`
    CREATE TABLE IF NOT EXISTS initiatives (
      id TEXT PRIMARY KEY,
      title TEXT,
      author TEXT,
      unit TEXT,
      score REAL,
      detailedScores TEXT,
      date TEXT,
      analysisResult TEXT,
      aiRisk TEXT,
      similarity REAL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      fullName TEXT,
      role TEXT
    );

    CREATE TABLE IF NOT EXISTS grades (
      id TEXT PRIMARY KEY,
      initiativeId TEXT,
      judgeId TEXT,
      judgeName TEXT,
      score REAL,
      detailedScores TEXT,
      comment TEXT,
      date TEXT,
      FOREIGN KEY(initiativeId) REFERENCES initiatives(id),
      FOREIGN KEY(judgeId) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      apiKey TEXT,
      model TEXT
    );

    -- Insert default admin
    INSERT OR REPLACE INTO users (id, username, password, fullName, role)
    VALUES ('admin-1', 'admin', 'admin123', 'Quản trị viên', 'admin');
    
    -- Insert default judges
    INSERT OR REPLACE INTO users (id, username, password, fullName, role)
    VALUES ('judge-1', 'giamkhao1', '123', 'Nguyễn Văn A', 'judge');
    INSERT OR REPLACE INTO users (id, username, password, fullName, role)
    VALUES ('judge-2', 'giamkhao2', '123', 'Trần Thị B', 'judge');
  `);
  console.log("Database schema initialized successfully.");
} catch (error) {
  console.error("Failed to initialize database schema:", error);
}

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Auth API
app.post("/api/login", (req, res) => {
  const { username: rawUsername, password: rawPassword } = req.body;
  const username = (rawUsername || '').trim();
  const password = (rawPassword || '').trim();
  
  console.log(`Login attempt for username: ${username}`);
  const user = db.prepare("SELECT id, username, fullName, role FROM users WHERE username = ? AND password = ?").get(username, password);
  if (user) {
    console.log(`Login successful for: ${username}`);
    res.json(user);
  } else {
    console.log(`Login failed for: ${username}`);
    res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
  }
});

// Users API
app.get("/api/users", (req, res) => {
  const users = db.prepare("SELECT id, username, fullName, role FROM users").all();
  res.json(users);
});

app.post("/api/users", (req, res) => {
  try {
    const { id, username, password, fullName, role } = req.body;
    
    // Check if user exists to preserve password if not provided
    const existingUser = db.prepare("SELECT password FROM users WHERE id = ?").get(id);
    const finalPassword = (password && password.trim() !== "") ? password : (existingUser ? existingUser.password : password);

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO users (id, username, password, fullName, role)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, username, finalPassword, fullName, role);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save user" });
  }
});

app.delete("/api/users/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// Initiatives API
app.get("/api/initiatives", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM initiatives ORDER BY id DESC").all();
    const initiatives = rows.map((row: any) => {
      try {
        const grades = db.prepare("SELECT * FROM grades WHERE initiativeId = ?").all(row.id);
        return {
          ...row,
          detailedScores: row.detailedScores ? JSON.parse(row.detailedScores) : null,
          grades: grades.map((g: any) => {
            try {
              return {
                ...g,
                detailedScores: g.detailedScores ? JSON.parse(g.detailedScores) : {}
              };
            } catch (e) {
              console.error(`Error parsing grade scores for ${g.id}:`, e);
              return { ...g, detailedScores: {} };
            }
          })
        };
      } catch (e) {
        console.error(`Error processing initiative ${row.id}:`, e);
        return { ...row, detailedScores: {}, grades: [] };
      }
    });
    res.json(initiatives);
  } catch (error) {
    console.error("Failed to fetch initiatives:", error);
    res.status(500).json({ error: "Failed to fetch initiatives" });
  }
});

app.post("/api/initiatives", (req, res) => {
  try {
    const initiative = req.body;
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO initiatives (id, title, author, unit, score, detailedScores, date, analysisResult, aiRisk, similarity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      initiative.id,
      initiative.title,
      initiative.author,
      initiative.unit,
      initiative.score,
      JSON.stringify(initiative.detailedScores),
      initiative.date,
      initiative.analysisResult,
      initiative.aiRisk,
      initiative.similarity
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save initiative" });
  }
});

// Grades API
app.post("/api/grades", (req, res) => {
  try {
    const grade = req.body;
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO grades (id, initiativeId, judgeId, judgeName, score, detailedScores, comment, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      grade.id,
      grade.initiativeId,
      grade.judgeId,
      grade.judgeName,
      grade.score,
      JSON.stringify(grade.detailedScores),
      grade.comment,
      grade.date
    );

    // Recalculate initiative average score
    const allGrades = db.prepare("SELECT score FROM grades WHERE initiativeId = ?").all(grade.initiativeId);
    if (allGrades.length > 0) {
      const avg = allGrades.reduce((acc: number, curr: any) => acc + curr.score, 0) / allGrades.length;
      db.prepare("UPDATE initiatives SET score = ? WHERE id = ?").run(avg, grade.initiativeId);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to save grade" });
  }
});

app.delete("/api/initiatives/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM initiatives WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete initiative" });
  }
});

app.get("/api/settings", (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM settings WHERE id = 1").get();
    res.json(row || { apiKey: "", model: "gemini-3.1-pro-preview" });
  } catch (error) {
    console.error("Failed to fetch settings:", error);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

app.post("/api/settings", (req, res) => {
  try {
    const { apiKey, model } = req.body;
    db.prepare(`
      INSERT OR REPLACE INTO settings (id, apiKey, model)
      VALUES (1, ?, ?)
    `).run(apiKey, model);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// Vite middleware for development
async function setupVite() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production static serving
    const distPath = path.resolve(__dirname, "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.resolve(distPath, "index.html"));
      });
    }
  }
}

setupVite();

// Start server
const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

export default app;
