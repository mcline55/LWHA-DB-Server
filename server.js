const http = require("http");
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
});

const TOOLS = [
  { name: "list_tables", description: "List all tables in current database", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "describe_table", description: "Show table structure", inputSchema: { type: "object", properties: { table: { type: "string" } }, required: ["table"] } },
  { name: "mysql_query", description: "Execute a SELECT query", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
  { name: "mysql_execute", description: "Execute INSERT/UPDATE/DELETE", inputSchema: { type: "object", properties: { sql: { type: "string" }, params: { type: "array", items: { type: "string" } } }, required: ["sql"] } },
];

async function runTool(name, args) {
  const conn = await pool.getConnection();
  try {
    if (name === "list_tables") {
      const [rows] = await conn.query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()");
      return rows.map(r => Object.values(r)[0]).join("\n");
    } else if (name === "describe_table") {
      const [rows] = await conn.query("DESCRIBE ??", [args.table]);
      return JSON.stringify(rows, null, 2);
    } else if (name === "mysql_query") {
      const [rows] = await conn.query(args.sql);
      return JSON.stringify(rows, null, 2);
    } else if (name === "mysql_execute") {
      const [result] = await conn.execute(args.sql, args.params || []);
      return JSON.stringify({ affectedRows: result.affectedRows, insertId: result.insertId });
    }
    throw new Error("Unknown tool: " + name);
  } finally {
    conn.release();
  }
}

function handleSession(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*", "Connection": "keep-alive" });

  const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
  let initialized = false;

  req.on("data", async (chunk) => {
    let msg;
    try { msg = JSON.parse(chunk.toString()); } catch { return; }

    if (msg.method === "initialize") {
      initialized = true;
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "lwha-mysql", version: "1.0.0" } } });
    } else if (msg.method === "notifications/initialized") {
      // no response needed
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      try {
        const text = await runTool(msg.params.name, msg.params.arguments || {});
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: false } });
      } catch (e) {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: e.message }], isError: true } });
      }
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    return res.end();
  }
  if (req.url === "/sse" && req.method === "GET") return handleSession(req, res);
  if (req.url === "/sse" && req.method === "POST") return handleSession(req, res);
  res.writeHead(404); res.end();
});

server.listen(process.env.PORT || 3000, () => console.log("LWHA MySQL MCP running on port", process.env.PORT || 3000));
